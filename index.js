require('dotenv').config();
const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs'); 
const path = require('path');

const basicAuth = (req, res, next) => {
    const auth = { login: "thiagosheila", password: "Ts@171412" }; 
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

    if (login && password && login === auth.login && password === auth.password) {
        return next();
    }
    res.set('WWW-Authenticate', 'Basic realm="Acesso Restrito"');
    res.status(401).send('Acesso não autorizado.');
};

const app = express();
app.use(express.json());

const ORIGENS = {
    "whatsapp_direto": "5159",
    "instagram": "7328",
    "imovelweb": "7329",
    "chaves_na_mao": "7330",
    "vivareal": "7331",
    "zap": "7332",
    "lead4sales": "7333"
};

// --- GERENCIAMENTO XML ---
let cacheImoveis = [];
async function atualizarBaseImoveis() {
    try {
        const response = await axios.get('https://sicilianoimoveis.com.br/exportar/sheila');
        const parser = new xml2js.Parser({ explicitArray: false });
        const result = await parser.parseStringPromise(response.data);
        cacheImoveis = Array.isArray(result.ListingDataFeed.Listings.Listing) 
            ? result.ListingDataFeed.Listings.Listing 
            : [result.ListingDataFeed.Listings.Listing];
        console.log("LOG_DEBUG: Base de imóveis atualizada. Total:", cacheImoveis.length);
    } catch (error) { console.error("Erro XML:", error.message); }
}
atualizarBaseImoveis();
setInterval(atualizarBaseImoveis, 86400000);

// --- FUNÇÕES AUXILIARES DE EXTRAÇÃO XML ---
const v = (campo) => {
    if (campo === null || campo === undefined) return '';
    if (Array.isArray(campo)) campo = campo[0];
    if (typeof campo === 'object') {
        return campo._ !== undefined ? String(campo._).trim() : '';
    }
    return String(campo).trim();
};

// NOVO: Extrai endereço ignorando NÚMERO e COMPLEMENTO por segurança
const obterEnderecoSeguro = (imovel) => {
    const loc = imovel?.Location;
    if (!loc) return "Não informado";
    
    const rua = v(loc.Address);
    const bairro = v(loc.Neighborhood);
    const cidade = v(loc.City);
    
    let parts = [];
    if (rua) parts.push(rua);
    if (bairro) parts.push(bairro);
    if (cidade) parts.push(cidade);
    
    return parts.length > 0 ? parts.join(' - ') : "Não informado";
};

const obterFeatures = (imovel) => {
    const featObj = imovel?.Details?.Features?.Feature;
    if (!featObj) return "Nenhuma cadastrada";
    
    const extrairTexto = (item) => {
        if (!item) return '';
        if (typeof item === 'object') return item._ !== undefined ? String(item._).trim() : '';
        return String(item).trim();
    };

    if (Array.isArray(featObj)) {
        return featObj.map(extrairTexto).filter(Boolean).join(', ');
    }
    return extrairTexto(featObj);
};

const obterPrecosFormatados = (imovel) => {
    const pVenda = parseFloat(v(imovel?.Details?.ListPrice)) || 0;
    const pLocacao = parseFloat(v(imovel?.Details?.RentalPrice)) || 0;
    const condo = parseFloat(v(imovel?.Details?.PropertyAdministrationFee)) || 0;
    const iptu = parseFloat(v(imovel?.Details?.YearlyTax)) || 0;
    
    let pVendaStr = pVenda > 0 ? `R$ ${pVenda.toLocaleString('pt-BR')}` : 'Não disponível';
    let pLocacaoStr = pLocacao > 0 ? `R$ ${pLocacao.toLocaleString('pt-BR')}` : 'Não disponível';
    let condoStr = condo > 0 ? `R$ ${condo.toLocaleString('pt-BR')}` : 'Não informado';
    let iptuStr = iptu > 0 ? `R$ ${iptu.toLocaleString('pt-BR')}` : 'Não informado';
    
    return { venda: pVendaStr, locacao: pLocacaoStr, condominio: condoStr, iptu: iptuStr, pVenda, pLocacao };
};

// --- FUNÇÕES DE ENVIO ---
async function enviarMensagem(para, texto) {
    const url = `https://graph.facebook.com/v25.0/1110417002164010/messages`;
    try {
        await axios.post(url, { messaging_product: 'whatsapp', to: para, type: 'text', text: { body: texto } },
        { headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` } });
    } catch (error) { console.error('Erro ao enviar:', error.message); }
}

async function enviarTemplateLead(para, nome, linkImovel) {
    const url = `https://graph.facebook.com/v25.0/1110417002164010/messages`;
    const payload = {
        messaging_product: "whatsapp",
        to: para,
        type: "template",
        template: {
            name: "contato_lead",
            language: { code: "pt_BR" },
            components: [{ type: "body", parameters: [{ type: "text", text: nome }, { type: "text", text: linkImovel }] }]
        }
    };
    await axios.post(url, payload, { headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` } });
}

async function enviarTemplateReengajamento(para, nome) {
    const url = `https://graph.facebook.com/v25.0/1110417002164010/messages`;
    const payload = {
        messaging_product: "whatsapp",
        to: para,
        type: "template",
        template: {
            name: "rengajamento",
            language: { code: "pt_BR" },
            components: [{ type: "body", parameters: [{ type: "text", text: nome }] }]
        }
    };
    await axios.post(url, payload, { headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` } });
}

// --- CONTROLE DE DADOS ---
const FILE_PATH = '/app/dados/historico.json';
const LEADS_INDEX_PATH = '/app/dados/leads_index.json';
let historicos = {};
let leadsIndex = {};

function obterHistorico(sender) {
    if (!historicos[sender]) return [];
    return historicos[sender].map(m => ({
        role: m.role,
        parts: Array.isArray(m.parts) ? m.parts : [{ text: m.text || "" }]
    }));
}

function salvarHistorico(sender, conversa) {
    historicos[sender] = conversa.map(m => ({ role: m.role, parts: m.parts }));
    fs.writeFileSync(FILE_PATH, JSON.stringify(historicos, null, 2));
}

function atualizarIndiceLeads(sender, nome, origem, statusCRM = false, imovelId = null) {
    if (!leadsIndex[sender]) leadsIndex[sender] = { imoveisInteresse: [] };
    if (!leadsIndex[sender].imoveisInteresse) leadsIndex[sender].imoveisInteresse = [];
    
    if (imovelId && !leadsIndex[sender].imoveisInteresse.includes(imovelId)) {
        leadsIndex[sender].imoveisInteresse.push(imovelId);
    }

    leadsIndex[sender] = {
        ...leadsIndex[sender],
        sender: sender,
        nome: nome || leadsIndex[sender]?.nome || "Lead Sem Nome",
        origem: origem || leadsIndex[sender]?.origem || "WhatsApp",
        ultimaInteracao: new Date().toISOString(),
        enviadoParaCRM: statusCRM || leadsIndex[sender]?.enviadoParaCRM || false
    };
    fs.promises.writeFile(LEADS_INDEX_PATH, JSON.stringify(leadsIndex, null, 2)).catch(console.error);
}

// --- ROTAS ---
app.get('/limpar-historico/:sender', async (req, res) => {
    const { sender } = req.params;
    if (historicos[sender]) {
        historicos[sender] = [];
        try {
            await fs.promises.writeFile(FILE_PATH, JSON.stringify(historicos, null, 2));
            res.send(`Histórico de ${sender} limpo.`);
        } catch (err) { res.status(500).send("Erro ao salvar arquivo."); }
    } else {
        res.status(404).send("Cliente não encontrado.");
    }
});

app.get('/chat/:sender', (req, res) => {
    const { sender } = req.params;
    const { token } = req.query;
    if (token !== process.env.CHAT_ACCESS_TOKEN) return res.status(403).send("Acesso negado.");

    const leadInfo = leadsIndex[sender] || { nome: "Lead Sem Nome" };
    const nomeLead = leadInfo.nome;
    const conversa = historicos[sender] || [];

    const mensagensFiltradas = conversa.filter(m => {
        const txt = m.parts && m.parts[0] ? m.parts[0].text : (m.text || "");
        return txt && !txt.includes("DADOS TÉCNICOS PARA CONSULTA") && !txt.includes("O nome deste cliente é");
    });

    let html = `<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>body{font-family:sans-serif;background:#e5ddd5;margin:0;padding:0;}.header{background:#fff;padding:20px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.1);}.header img{width:80px;height:auto;margin-bottom:10px;}.lead-info{background:#fff;padding:15px;text-align:center;margin-bottom:10px;}.msg{padding:10px 15px;margin:5px 10px;border-radius:8px;max-width:85%;position:relative;font-size:14px;word-wrap:break-word;}.user{background:#dcf8c6;margin-left:auto;text-align:right;}.model{background:#ffffff;margin-right:auto;}.time{font-size:10px;color:#999;margin-top:5px;display:block;}</style></head><body>
    <div class="header"><img src="https://img.apre.me/M7UtVktPLcjSy00sSk8sKc7LVMhPz8-RL07NyUyzzVSztDQwtU0GAA.jpeg" alt="Logo"><div style="font-weight:bold; color:#333;">Atendido pela Sheila</div></div>
    <div class="lead-info"><strong>Cliente:</strong> ${nomeLead}<br><small>${sender}</small><br><a href="https://wa.me/${sender}" style="color:#075e54;">Enviar WhatsApp</a></div>
    ${mensagensFiltradas.map(m => {
        const text = m.parts && m.parts[0] ? m.parts[0].text : (m.text || "");
        return `<div class="msg ${m.role}">${text}<span class="time">${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit'})}</span></div>`;
    }).join('')}</body></html>`;

    res.send(html);
});

app.get('/leads', (req, res) => {
    if (req.query.token !== process.env.CHAT_ACCESS_TOKEN) return res.status(403).send("Acesso negado.");
    res.json(Object.values(leadsIndex).sort((a, b) => new Date(b.ultimaInteracao) - new Date(a.ultimaInteracao)));
});

app.post('/webhook', async (req, res) => {
   if (process.env.SHEILA_PAUSADA === 'true') {
        return res.sendStatus(200); 
    }    
    
    const msgData = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msgData) return res.sendStatus(200);
    
    const sender = msgData.from;
    const nomeMeta = req.body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name;
    const nomeAtual = leadsIndex[sender]?.nome;
    const nomeParaSalvar = (nomeAtual && nomeAtual !== "Lead Sem Nome") ? nomeAtual : (nomeMeta || "Cliente");

    atualizarIndiceLeads(sender, nomeParaSalvar, "WhatsApp");

    const textoCliente = msgData.text?.body;
    const conversa = obterHistorico(sender);
    const referral = msgData?.referral?.source_url;

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`;
        conversa.push({ "role": "user", "parts": [{ "text": textoCliente }] });

        const payloadInicial = {
            "systemInstruction": { "parts": [{ "text": process.env.SYSTEM_PROMPT || "Você é a Sheila, corretora da Siciliano Imóveis." }] },
            "contents": conversa,
            "tools": [{ "functionDeclarations": [
                { 
                    "name": "iniciar_captacao", 
                    "description": "Chamar quando o cliente expressar desejo de vender, alugar ou anunciar o próprio imóvel.", 
                    "parameters": { "type": "object", "properties": {}, "required": [] } 
                },
                { 
                    "name": "processar_captacao", 
                    "description": "Use para registrar o endereço ou localização quando o cliente fornecer durante a captação.", 
                    "parameters": { 
                        "type": "object", 
                        "properties": { "endereco": { "type": "string", "description": "O endereço do imóvel" } }, 
                        "required": ["endereco"] 
                    } 
                },
                { 
                    "name": "buscar_imovel", 
                    "description": "Consulta dados técnicos completos de um imóvel (valores de venda/locação, rua sem número, suites, vagas, features) pelo código ou URL.", 
                    "parameters": { "type": "object", "properties": { "termo_de_busca": { "type": "string" } }, "required": ["termo_de_busca"] } 
                },
                {
                    "name": "buscar_imoveis_filtros",
                    "description": "Busca imóveis com filtros detalhados de intenção, bairro, tipo, orçamento e características.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "intencao": { "type": "string", "description": "A intenção do cliente: use exatamente 'compra' ou 'aluguel'." },
                            "tipo": { "type": "string", "description": "O tipo do imóvel: 'apartamento', 'cobertura', etc." },
                            "bairro": { "type": "string", "description": "O bairro de preferência do cliente." },
                            "quartos": { "type": "number", "description": "Número mínimo de quartos desejado." },
                            "vaga": { 
                                "type": "integer", 
                                "description": "Quantidade de vagas. Se o cliente apenas disser 'quero com vaga', envie 1. Se definir quantidade (ex: 2), envie o número exato. Se não mencionar, não envie este campo." 
                            },
                            "precoVendaMax": { "type": "number", "description": "Valor máximo para compra." },
                            "precoLocacaoMax": { "type": "number", "description": "Valor máximo para aluguel." },
                            "extras": { "type": "array", "items": { "type": "string" }, "description": "Lista de características extras." }
                        },
                        "required": ["intencao"]
                    }
                },
                { 
                    "name": "qualificar_lead", 
                    "description": "Chame ao perceber interesse claro em visita ou falar com corretor. Sempre extraia o nome do cliente da conversa.", 
                    "parameters": { "type": "object", "properties": { "interesse": { "type": "string" }, "nome": { "type": "string" } }, "required": ["interesse", "nome"] } 
                }
            ]}]
        };

        const response = await axios.post(url, payloadInicial);
        const contentResponse = response.data?.candidates?.[0]?.content;
        const functionCall = contentResponse?.parts?.[0]?.functionCall;

        if (functionCall) {
            console.log("LOG_DEBUG: A Sheila chamou a função:", functionCall.name);

            if (functionCall.name === "iniciar_captacao") {
                if (!leadsIndex[sender]) atualizarIndiceLeads(sender, null, "WhatsApp"); 
                leadsIndex[sender].categoria = 'captacao';
                leadsIndex[sender].ultimaInteracao = new Date().toISOString();
                fs.promises.writeFile(LEADS_INDEX_PATH, JSON.stringify(leadsIndex, null, 2)).catch(console.error);
                
                const resposta = "Entendido! Para que nossa equipe de captação avalie seu imóvel, qual o endereço completo dele?";
                await enviarMensagem(sender, resposta);
                conversa.push({ "role": "model", "parts": [{ "text": resposta }] });
                salvarHistorico(sender, conversa);
            }
            else if (functionCall.name === "processar_captacao") {
                const { endereco } = functionCall.args;
                leadsIndex[sender].categoria = 'processado'; 
                leadsIndex[sender].ultimaInteracao = new Date().toISOString();
                fs.promises.writeFile(LEADS_INDEX_PATH, JSON.stringify(leadsIndex, null, 2)).catch(console.error);
                
                const resposta = "Perfeito, anotei o endereço! Vou passar essas informações para nossa equipe de captação entrar em contato com você em breve.";
                await enviarMensagem(sender, resposta);
                conversa.push({ "role": "model", "parts": [{ "text": resposta }] });
                salvarHistorico(sender, conversa);
            }      
            else if (functionCall.name === "qualificar_lead") {
                let origemIdentificada = referral?.includes("instagram") ? "instagram" : "whatsapp_direto";
                const nomeDoCliente = functionCall.args.nome || "Cliente";
                const listaImoveis = leadsIndex[sender]?.imoveisInteresse?.join(', ') || "Nenhum imóvel vinculado";
                const linkEspelho = `https://webhook-siciliano-production.up.railway.app/chat/${sender}?token=${process.env.CHAT_ACCESS_TOKEN}`;
                
                await axios.post('https://api.apresenta.me/webhook/integration/5099/ab72a9ac29cc5dba9a32eeb37f45461e', {
                    nome: nomeDoCliente, 
                    celular: sender, 
                    origem: ORIGENS[origemIdentificada], 
                    mensagem: "Atendimento realizado pela Sheila", 
                    observacoes: `Resumo: ${functionCall.args.interesse}\nImóveis: ${listaImoveis}\nLink da conversa: ${linkEspelho}`
                });

                atualizarIndiceLeads(sender, nomeDoCliente);
                const msg = "Perfeito, acabei de encaminhar seu interesse para nossa equipe de corretores!";
                await enviarMensagem(sender, msg);
                conversa.push({ "role": "model", "parts": [{ "text": msg }] });
                salvarHistorico(sender, conversa); 
            } 
            else if (functionCall.name === "buscar_imovel") {
                const termo = functionCall.args.termo_de_busca;
                const imovel = cacheImoveis.find(i => String(i.ListingID) === String(termo) || (i.DetailViewUrl && i.DetailViewUrl.includes(termo)));
                
                if (imovel) {
                    atualizarIndiceLeads(sender, null, null, false, imovel.ListingID);
                    const enderecoSeguro = obterEnderecoSeguro(imovel);
                    const features = obterFeatures(imovel);
                    const precos = obterPrecosFormatados(imovel);
                    const desc = v(imovel.Details?.Description);
                    
                    // Texto corrido sem formatação de lista para respeitar o SYSTEM_PROMPT
                    let dados = `DADOS TÉCNICOS PARA CONSULTA INTERNA: ID ${imovel.ListingID}, Título: ${imovel.Title}, Venda: ${precos.venda}, Locação: ${precos.locacao}, Condomínio: ${precos.condominio}, IPTU: ${precos.iptu}, Endereço permitido (NÃO informe número/complemento): ${enderecoSeguro}, Quartos: ${v(imovel.Details?.Bedrooms)}, Suítes: ${v(imovel.Details?.Suites)}, Vagas: ${v(imovel.Details?.Garage)}, Extras: ${features}, Descrição: ${desc}. Link: ${imovel.DetailViewUrl}. Lembre-se: aplique rigorosamente as diretrizes do seu SYSTEM PROMPT ao responder (resumo curto, texto corrido, sem listas).`;

                    conversa.push({ "role": "user", "parts": [{ "text": dados }] });
                } else {
                    conversa.push({ "role": "user", "parts": [{ "text": `CONSULTA DE IMÓVEL: O imóvel "${termo}" não foi localizado no catálogo.` }] });
                }
                
                const respFinal = await axios.post(url, { "systemInstruction": { "parts": [{ "text": process.env.SYSTEM_PROMPT }] }, "contents": conversa });
                const texto = respFinal.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (texto) { 
                    await enviarMensagem(sender, texto); 
                    conversa.push({ "role": "model", "parts": [{ "text": texto }] });
                    salvarHistorico(sender, conversa); 
                }
            } 
            else if (functionCall.name === "buscar_imoveis_filtros") {
                const normalize = (str) => {
                    if (!str) return "";
                    return String(str).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[-\s]/g, "");
                };

                const mapaTipos = {
                    "apartamento": "residential/apartment", "cobertura": "residential/penthouse",
                    "casa": "residential/home", "studio": "residential/flat",
                    "sala comercial": "commercial/office", "casa em condominio": "residential/condo",
                    "loja": "commercial/loja", "imovel comercial": "commercial/business",
                    "predio comercial": "commercial/business"
                };

                const mapaIntencao = {
                    "compra": "forsale", "venda": "forsale", "aluguel": "forrent", "locacao": "forrent"
                };

                const { intencao, bairro, quartos, precoVendaMax, precoLocacaoMax, tipo, vaga, extras } = functionCall.args;
                const precoMax = precoVendaMax || precoLocacaoMax || 0;
                
                // Trata a vaga recebida corretamente (seja 1 conceptual ou quantidade exata)
                const nVagasPedido = parseInt(vaga);
                const buscaIntencao = normalize(intencao || "");
                const isVenda = buscaIntencao.includes("compra") || buscaIntencao.includes("venda") || buscaIntencao.includes("sale");
                const isLocacao = buscaIntencao.includes("aluguel") || buscaIntencao.includes("locacao") || buscaIntencao.includes("rent");
                
                const filtra = (i, modoExato) => {
                    const bairroImovel = normalize(v(i.Location?.Neighborhood));
                    const tipoImovelXML = normalize(v(i.Details?.PropertyType));
                    const transacaoXML = normalize(v(i.TransactionType));
                    const descricao = normalize(v(i.Details?.Description));
                    const pV = parseFloat(v(i.Details?.ListPrice)) || 0;
                    const pL = parseFloat(v(i.Details?.RentalPrice)) || 0;
                    const qteQuartos = parseInt(v(i.Details?.Bedrooms)) || 0;

                    const nIntencaoBusca = mapaIntencao[normalize(intencao)] || normalize(intencao);
                    const nTipoBusca = mapaTipos[normalize(tipo)] || normalize(tipo);

                    const matchBairro = !bairro || bairroImovel.includes(normalize(bairro));
                    const matchIntencao = !intencao || (isVenda && transacaoXML.includes("sale")) || (isLocacao && transacaoXML.includes("rent"));
                    const matchTipo = !tipo || tipoImovelXML.includes(nTipoBusca) || descricao.includes(normalize(tipo));
                    
                    let matchPreco = true;
                    if (precoMax > 0) {
                        if (isVenda) matchPreco = (pV > 0 && pV <= precoMax);
                        else if (isLocacao) matchPreco = (pL > 0 && pL <= precoMax);
                    }

                    const nVagasXML = parseInt(v(i.Details?.Garage)) || 0;
                    // Se nVagasPedido for NaN (undefined ou invalido), a condição é true (ignora filtro)
                    const matchVaga = isNaN(nVagasPedido) ? true : (modoExato ? (nVagasXML === nVagasPedido) : (nVagasXML >= nVagasPedido));
                    const matchQuartos = !quartos || (modoExato ? (qteQuartos === quartos) : (qteQuartos >= quartos));

                    const features = Array.isArray(i.Details?.Features?.Feature) 
                        ? i.Details.Features.Feature.map(f => normalize(f)).join(' ') 
                        : normalize(v(i.Details?.Features?.Feature));
                        
                    const matchExtras = !extras || extras.every(extra => descricao.includes(normalize(extra)) || features.includes(normalize(extra)));
                    
                    return matchBairro && matchIntencao && matchTipo && matchQuartos && matchPreco && matchVaga && matchExtras;
                };
                
                let resultados = cacheImoveis.filter(i => filtra(i, true));
                if (resultados.length === 0) resultados = cacheImoveis.filter(i => filtra(i, false));
                resultados = resultados.slice(0, 3);

               if (resultados.length > 0) {
                    await enviarMensagem(sender, "Encontrei estas opções para você:");
                    
                    // 1. Variável para acumular o contexto técnico das opções sugeridas
                    let contextoOpcoes = `INFORMAÇÃO INTERNA DA SHEILA - DADOS DOS IMÓVEIS SUGERIDOS NA BUSCA:\n`;

                    for (const i of resultados) {
                        const precos = obterPrecosFormatados(i);
                        const enderecoSeguro = obterEnderecoSeguro(i);
                        const features = obterFeatures(i);
                        const desc = v(i.Details?.Description);
                        
                        // 2. Adiciona a ficha técnica do imóvel na memória invisível
                        contextoOpcoes += `- Referência Link: ${i.DetailViewUrl}\n  ID: ${i.ListingID}\n  Venda: ${precos.venda} | Locação: ${precos.locacao}\n  Endereço permitido (sem número): ${enderecoSeguro}\n  Quartos: ${v(i.Details?.Bedrooms)} | Suítes: ${v(i.Details?.Suites)} | Vagas: ${v(i.Details?.Garage)}\n  Extras: ${features}\n\n`;

                        const dados = `Título: ${i.Title}, Descrição: ${desc}, Preço Venda: ${precos.venda}, Preço Locação: ${precos.locacao}, Link: ${i.DetailViewUrl}`;
                        const payloadLocal = [...conversa, { 
                            "role": "user", 
                            "parts": [{ "text": `Apresente este imóvel: ${dados}. Respeite rigorosamente as regras do seu SYSTEM PROMPT para apresentação de imóveis.` }] 
                        }];

                        try {
                            const respFinal = await axios.post(url, { 
                                "systemInstruction": { "parts": [{ "text": process.env.SYSTEM_PROMPT }] }, 
                                "contents": payloadLocal 
                            });
                            const texto = respFinal.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                            if (texto) {
                                await enviarMensagem(sender, texto);
                                conversa.push({ "role": "model", "parts": [{ "text": texto }] });
                            } else {
                                const precoDisplay = (precos.pLocacao > 0) ? `${precos.locacao} (Locação)` : `${precos.venda} (Venda)`;
                                await enviarMensagem(sender, `*${i.Title}*\n💰 ${precoDisplay}\n🔗 ${i.DetailViewUrl}`);
                            }
                        } catch (e) {
                            console.error("Erro na chamada da IA:", e);
                            const precoDisplay = (precos.pLocacao > 0) ? `${precos.locacao} (Locação)` : `${precos.venda} (Venda)`;
                            await enviarMensagem(sender, `*${i.Title}*\n💰 ${precoDisplay}\n🔗 ${i.DetailViewUrl}`);
                        }
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                    
                    // 3. Injeta o contexto acumulado no histórico para as próximas perguntas do cliente
                    contextoOpcoes += `DIRETRIZ: Se o cliente perguntar detalhes (como rua, vagas ou suítes) sobre "o de 750 mil" ou "o primeiro da lista", consulte estritamente os dados acima. NUNCA invente ruas.`;
                    conversa.push({ "role": "user", "parts": [{ "text": contextoOpcoes }] });
                    
                    salvarHistorico(sender, conversa);
                } else {
                    const msg = "Não encontrei imóveis com essas características agora. Gostaria que eu passasse seu contato para o nosso corretor buscar algo personalizado?";
                    await enviarMensagem(sender, msg);
                    conversa.push({ "role": "model", "parts": [{ "text": msg }] });
                    salvarHistorico(sender, conversa);
                }
            }
        } else {
            const textoRespostaPura = contentResponse?.parts?.[0]?.text;
            if (textoRespostaPura) {
                await enviarMensagem(sender, textoRespostaPura);
                conversa.push({ "role": "model", "parts": [{ "text": textoRespostaPura }] });
                salvarHistorico(sender, conversa);
            }
        }
    } catch (error) { 
        console.error("Erro Webhook:", error.message); 
    }
    res.sendStatus(200);
});

app.post('/webhook-lead', async (req, res) => {
    const { name, phone, building_id, origin_desc } = req.body;
    const celular = phone ? phone.replace(/\D/g, '') : null;
    if (!name || !celular || !building_id) return res.status(400).send("Dados incompletos.");
    
    try {
        const imovel = cacheImoveis.find(i => String(i.ListingID) === String(building_id));
        const link = imovel ? imovel.DetailViewUrl : "consulte em nosso site";
        const conversa = obterHistorico(celular);
        
        if (imovel) {
            const enderecoSeguro = obterEnderecoSeguro(imovel);
            const features = obterFeatures(imovel);
            const precos = obterPrecosFormatados(imovel);
            const desc = v(imovel.Details?.Description);
            
            // Texto corrido sem formatação e sem diretrizes adicionais para evitar conflitos
            const contextoOculto = `DADOS TÉCNICOS PARA CONSULTA INTERNA DA SHEILA: O cliente ${name} quer informações deste imóvel. ID ${imovel.ListingID}, Venda: ${precos.venda}, Locação: ${precos.locacao}, Condomínio: ${precos.condominio}, IPTU: ${precos.iptu}, Endereço permitido (NÃO informe número/complemento, é proibido): ${enderecoSeguro}, Quartos: ${v(imovel.Details?.Bedrooms)}, Suítes: ${v(imovel.Details?.Suites)}, Vagas: ${v(imovel.Details?.Garage)}, Características Extras: ${features}, Descrição Completa: ${desc}. Lembre-se: aja estritamente de acordo com o seu SYSTEM PROMPT (sem usar listas, formato humanizado).`;
            
            conversa.push({ role: "user", parts: [{ text: contextoOculto }] });
        } else {
            conversa.push({ role: "user", parts: [{ text: `O nome deste cliente é ${name}. Ele se interessou no imóvel de ID ${building_id}, mas os dados não estão no cache.` }] });
        }

        conversa.push({ role: "model", parts: [{ text: `Olá ${name}, recebemos sua solicitação para o imóvel: ${link}.` }] });
        await enviarTemplateLead(celular, name, link);
        salvarHistorico(celular, conversa); 
        atualizarIndiceLeads(celular, name, origin_desc?.name, false, building_id);
        
        res.status(200).send("Lead processado com contexto seguro injetado.");
    } catch (error) { res.status(500).send("Erro"); }
});

app.get('/central', basicAuth, (req, res) => {
    const caminhoHtml = path.join(__dirname, 'central.html');
    fs.readFile(caminhoHtml, 'utf8', (err, data) => {
        if (err) return res.status(500).send("Erro ao carregar central: arquivo não encontrado.");
        res.send(data.replace('SEU_TOKEN_AQUI', process.env.CHAT_ACCESS_TOKEN || ''));
    });
});

app.post('/enviar-crm/:sender', async (req, res) => {
    const { sender } = req.params;
    if (req.query.token !== process.env.CHAT_ACCESS_TOKEN) return res.status(403).send("Acesso negado.");

    const lead = leadsIndex[sender];
    if (!lead) return res.status(404).send("Lead não encontrado.");

    try {
        const linkEspelho = `https://webhook-siciliano-production.up.railway.app/chat/${sender}?token=${process.env.CHAT_ACCESS_TOKEN}`;
        await axios.post('https://api.apresenta.me/webhook/integration/5099/ab72a9ac29cc5dba9a32eeb37f45461e', {
            nome: lead.nome, celular: sender, origem: ORIGENS[lead.origem] || "5159", 
            mensagem: "Envio manual via Central de Leads", observacoes: `Lead enviado manualmente.\nLink da conversa: ${linkEspelho}`
        });

        lead.enviadoParaCRM = true;
        atualizarIndiceLeads(sender, lead.nome, lead.origem);
        res.status(200).send("Lead enviado com sucesso!");
    } catch (error) { res.status(500).send("Erro ao enviar para CRM."); }
});

// --- MONITORAMENTO AUTOMÁTICO DE LEADS ---
async function monitorarLeads() {
    const agora = new Date();
    for (const sender in leadsIndex) {
        const lead = leadsIndex[sender];
        if (lead.enviadoParaCRM) continue; 

        const diffHoras = (agora - new Date(lead.ultimaInteracao)) / (1000 * 60 * 60);

        if (lead.categoria === 'captacao' && diffHoras >= 2) {
            await forcarEnvioCRM(sender, "Encaminhamento automático: Lead de captação não forneceu endereço em 2h.");
            continue;
        }

        if (diffHoras >= 24) {
            const nomeLead = leadsIndex[sender]?.nome || "cliente";
            await enviarTemplateReengajamento(sender, nomeLead);
            const conversa = historicos[sender] || [];
            conversa.push({ "role": "model", "parts": [{ "text": `Oi ${nomeLead}! Notei que não tivemos retorno. Ainda tem interesse no imóvel ou precisa de ajuda com algo mais específico?` }] });
            salvarHistorico(sender, conversa);
            lead.ultimaInteracao = agora.toISOString(); 
        }
    }
}
setInterval(monitorarLeads, 1800000);

async function forcarEnvioCRM(sender, obs) {
    const lead = leadsIndex[sender];
    try {
        await axios.post('https://api.apresenta.me/webhook/integration/5099/ab72a9ac29cc5dba9a32eeb37f45461e', {
            nome: lead.nome || "Cliente", celular: sender, origem: ORIGENS[lead.origem] || "5159",
            mensagem: "Encaminhamento automático", observacoes: `Sheila: ${obs}\nLink da conversa: https://webhook-siciliano-production.up.railway.app/chat/${sender}?token=${process.env.CHAT_ACCESS_TOKEN}`
        });
        lead.enviadoParaCRM = true;
        fs.promises.writeFile(LEADS_INDEX_PATH, JSON.stringify(leadsIndex, null, 2)).catch(console.error);
    } catch (err) {}
}

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => {
    console.log(`LOG_DEBUG: Servidor online na porta ${PORT}`);
    const carregarDados = async () => {
        try {
            const dir = path.dirname(FILE_PATH);
            if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
            if (fs.existsSync(FILE_PATH)) historicos = JSON.parse(await fs.promises.readFile(FILE_PATH, 'utf8'));
            if (fs.existsSync(LEADS_INDEX_PATH)) leadsIndex = JSON.parse(await fs.promises.readFile(LEADS_INDEX_PATH, 'utf8'));
        } catch (e) {}
    };
    carregarDados();
    setTimeout(carregarDados, 5000); 
});
