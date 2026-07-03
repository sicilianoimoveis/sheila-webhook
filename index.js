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

// --- CONTROLE DE DADOS ---
const FILE_PATH = '/app/dados/historico.json';
const LEADS_INDEX_PATH = '/app/dados/leads_index.json';
let historicos = {};
let leadsIndex = {};

function obterHistorico(sender) {
    if (!historicos[sender]) return [];

    // Converte o formato simples {role, text} para o formato técnico da API
    // Isso garante que o Gemini receba a conversa exatamente como ele entende
    return historicos[sender].map(m => ({
        role: m.role,
        parts: [{ text: m.text }] 
    }));
}

function salvarHistorico(sender, conversa) {
    // Limpamos apenas a estrutura técnica desnecessária, mas mantemos TODAS as mensagens
    const conversaLimpa = conversa.map(m => ({
        role: m.role,
        text: m.parts && m.parts[0] ? m.parts[0].text : (m.text || "")
    }));

    historicos[sender] = conversaLimpa;

    // Grava tudo no disco
    fs.promises.writeFile(FILE_PATH, JSON.stringify(historicos, null, 0))
        .catch(err => console.error("Erro ao salvar histórico:", err));
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
app.get('/chat/:sender', (req, res) => {
    const { sender } = req.params;
    const { token } = req.query;
    if (token !== process.env.CHAT_ACCESS_TOKEN) return res.status(403).send("Acesso negado.");

    const leadInfo = leadsIndex[sender] || { nome: "Lead Sem Nome" };
    const nomeLead = leadInfo.nome;

    // Pegamos a lista simples {role, text}
    const conversa = historicos[sender] || [];

    // Filtramos usando m.text, que é como agora está salvo no JSON
    const mensagensFiltradas = conversa.filter(m => 
        m.text && 
        !m.text.includes("CONSULTA DE IMÓVEL") && 
        !m.text.includes("O nome deste cliente é")
    );

    let html = `<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>body{font-family:sans-serif;background:#e5ddd5;margin:0;padding:0;}.header{background:#fff;padding:20px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.1);}.header img{width:80px;height:auto;margin-bottom:10px;}.lead-info{background:#fff;padding:15px;text-align:center;margin-bottom:10px;}.msg{padding:10px 15px;margin:5px 10px;border-radius:8px;max-width:85%;position:relative;font-size:14px;word-wrap:break-word;}.user{background:#dcf8c6;margin-left:auto;text-align:right;}.model{background:#ffffff;margin-right:auto;}.time{font-size:10px;color:#999;margin-top:5px;display:block;}</style></head><body>
    <div class="header"><img src="https://img.apre.me/M7UtVktPLcjSy00sSk8sKc7LVMhPz8-RL07NyUyzzVSztDQwtU0GAA.jpeg" alt="Logo"><div style="font-weight:bold; color:#333;">Atendido pela Sheila</div></div>
    <div class="lead-info"><strong>Cliente:</strong> ${nomeLead}<br><small>${sender}</small><br><a href="https://wa.me/${sender}" style="color:#075e54;">Enviar WhatsApp</a></div>
    ${mensagensFiltradas.map(m => `<div class="msg ${m.role}">${m.text}<span class="time">${new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit'})}</span></div>`).join('')}</body></html>`;

    res.send(html);
});
app.get('/leads', (req, res) => {
    if (req.query.token !== process.env.CHAT_ACCESS_TOKEN) return res.status(403).send("Acesso negado.");
    res.json(Object.values(leadsIndex).sort((a, b) => new Date(b.ultimaInteracao) - new Date(a.ultimaInteracao)));
});

app.post('/webhook', async (req, res) => {
   if (process.env.SHEILA_PAUSADA === 'true') {
        console.log("LOG_DEBUG: Sheila pausada pela variável de ambiente.");
        return res.sendStatus(200); 
    }    
    
    const msgData = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msgData) return res.sendStatus(200);
    
    const sender = msgData.from;
    
    // --- LÓGICA DE DEFINIÇÃO DO NOME ---
    const nomeMeta = req.body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name;
    const nomeAtual = leadsIndex[sender]?.nome;

    // Prioridade: 1º Nome que já temos, 2º Nome da Meta, 3º "Cliente"
    const nomeParaSalvar = (nomeAtual && nomeAtual !== "Lead Sem Nome") ? nomeAtual : (nomeMeta || "Cliente");

    // Atualiza o índice com o nome decidido
    atualizarIndiceLeads(sender, nomeParaSalvar, "WhatsApp");
    // --- FIM DA LÓGICA ---

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
                    "description": "Consulta dados técnicos (rua, suites, vagas, features) pelo código ou URL.", 
                    "parameters": { "type": "object", "properties": { "termo_de_busca": { "type": "string" } }, "required": ["termo_de_busca"] } 
                },
                {
                    "name": "buscar_imoveis_filtros",
                    "description": "Busca imóveis com filtros detalhados de intenção, bairro, tipo, orçamento e características.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "intencao": { 
                                "type": "string", 
                                "description": "A intenção do cliente: use exatamente 'compra' ou 'aluguel'." 
                            },
                            "tipo": { 
                                "type": "string", 
                                "description": "O tipo do imóvel: 'apartamento', 'cobertura', 'casa', 'studio', 'sala comercial', 'casa em condominio', 'loja', 'imovel comercial' ou 'predio comercial'." 
                            },
                            "bairro": { "type": "string", "description": "O bairro de preferência do cliente." },
                            "quartos": { "type": "number", "description": "Número mínimo de quartos desejado." },
                            "vaga": { "type": "boolean", "description": "Se o imóvel precisa ter vaga de garagem (true para sim, false para não)." },
                            "precoMax": { "type": "number", "description": "Valor máximo que o cliente pretende pagar." },
                            "extras": { 
                                "type": "array", 
                                "items": { "type": "string" }, 
                                "description": "Lista de características extras (ex: 'varanda', 'suíte', 'lazer completo')." 
                            }
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
            console.log("LOG_DEBUG: A Sheila decidiu chamar a função:", functionCall.name);
            console.log("LOG_DEBUG: Argumentos definidos pela Sheila:", JSON.stringify(functionCall.args));
            console.log("LOG_DEBUG: Quantidade total de imóveis no cache:", cacheImoveis?.length || 0);

            if (functionCall.name === "iniciar_captacao") {
                if (!leadsIndex[sender]) {
                    atualizarIndiceLeads(sender, null, "WhatsApp"); 
                }
                
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
                }
                const v = (campo) => (campo && typeof campo === 'object' ? campo._ : campo) || 'Não informado';
                const feat = imovel?.Features?.Feature ? (Array.isArray(imovel.Features.Feature) ? imovel.Features.Feature.join(', ') : imovel.Features.Feature) : "Nenhuma característica extra informada.";
                const enderecoReal = imovel && imovel.Location ? (Array.isArray(imovel.Location) ? imovel.Location[0].Address : imovel.Location.Address) : "Não informado";
                let dados = imovel ? `ID: ${imovel.ListingID}, Preço: R$ ${v(imovel.Details.ListPrice)}, Rua: ${v(enderecoReal)}, Suítes: ${v(imovel.Details.Suites)}, Vagas: ${v(imovel.Details.Garage)}, Bairro: ${v(imovel.Location.Neighborhood)}, Features: ${feat}, Descrição: ${v(imovel.Details.Description)}` : "Imóvel não localizado.";
                
                conversa.push({ "role": "user", "parts": [{ "text": `CONSULTA DE IMÓVEL: ${dados}. USE APENAS ESTAS INFORMAÇÕES TÉCNICAS. NÃO INVENTE DADOS.` }] });
                const respFinal = await axios.post(url, { "systemInstruction": { "parts": [{ "text": process.env.SYSTEM_PROMPT }] }, "contents": conversa });
                const texto = respFinal.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (texto) { 
                    await enviarMensagem(sender, texto); 
                    conversa.push({ "role": "model", "parts": [{ "text": texto }] });
                    salvarHistorico(sender, conversa); 
                }
            } 
            else if (functionCall.name === "buscar_imoveis_filtros") {
                console.log("Filtros recebidos:", functionCall.args);
                
                const normalize = (str) => {
                    if (!str) return "";
                    return String(str).toLowerCase()
                        .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
                        .replace(/[-\s]/g, "");
                };

                const mapaTipos = {
                    "apartamento": "residential/apartment",
                    "cobertura": "residential/penthouse",
                    "casa": "residential/home",
                    "studio": "residential/flat",
                    "sala comercial": "commercial/office",
                    "casa em condominio": "residential/condo",
                    "loja": "commercial/loja",
                    "imovel comercial": "commercial/business",
                    "predio comercial": "commercial/business"
                };

                const mapaIntencao = {
                    "compra": "forsale",
                    "venda": "forsale",
                    "aluguel": "forrent",
                    "locacao": "forrent"
                };

                console.log("LOG_DEBUG: Entrou na função buscar_imoveis_filtros");
                const { intencao, bairro, quartos, precoMax, tipo, vaga, extras } = functionCall.args;

                const filtra = (i, modoExato) => {
                    const v = (campo) => (campo && typeof campo === 'object' ? (campo._ || String(campo)) : String(campo));
                    
                    const bairroImovel = normalize(v(i.Location?.Neighborhood));
                    const tipoImovelXML = normalize(v(i.Details?.PropertyType));
                    const transacaoXML = normalize(v(i.TransactionType));
                    const descricao = normalize(v(i.Details?.Description));
                    const precoImovel = parseFloat(v(i.Details?.ListPrice)) || 0;
                    const qteQuartos = parseInt(v(i.Details?.Bedrooms)) || 0;

                    const nIntencaoBusca = mapaIntencao[normalize(intencao)] || normalize(intencao);
                    const nTipoBusca = mapaTipos[normalize(tipo)] || normalize(tipo);

                    const matchBairro = !bairro || bairroImovel.includes(normalize(bairro));
                    const matchIntencao = !intencao || transacaoXML.includes(nIntencaoBusca);
                    const matchTipo = !tipo || tipoImovelXML.includes(nTipoBusca) || descricao.includes(normalize(tipo));
                    const matchPreco = !precoMax || (precoImovel <= precoMax);
                    const matchVaga = (vaga === undefined || vaga === null) || (!!i.Details?.ParkingSpaces === vaga);
                    
                    const matchQuartos = !quartos || (modoExato ? (qteQuartos === quartos) : (qteQuartos >= quartos));

                    const features = Array.isArray(i.Details?.Features?.Feature) 
                        ? i.Details.Features.Feature.map(f => normalize(f)).join(' ') 
                        : normalize(v(i.Details?.Features?.Feature));
                        
                    const matchExtras = !extras || extras.every(extra => 
                        descricao.includes(normalize(extra)) || features.includes(normalize(extra))
                    );
                    
                    return matchBairro && matchIntencao && matchTipo && matchQuartos && matchPreco && matchVaga && matchExtras;
                };

                let resultados = cacheImoveis.filter(i => filtra(i, true));

                if (resultados.length === 0 && quartos) {
                    resultados = cacheImoveis.filter(i => filtra(i, false));
                }

                resultados = resultados.slice(0, 3);
                console.log("LOG_DEBUG: Imóveis encontrados após filtro:", resultados.length);

                if (resultados.length > 0) {
                    await enviarMensagem(sender, "Encontrei estas opções para você:");
                    
                    for (const i of resultados) {
                        const dados = `Título: ${i.Title}, Descrição: ${i.Details?.Description}, Preço: ${i.Details?.ListPrice?._ || i.Details?.ListPrice}, Link: ${i.DetailViewUrl}`;
                        
                        // --- AJUSTE ANTI-LOOPING: Cria o comando de injeção técnica ---
                        const comandoInjecaoFiltro = { 
                            "role": "user", 
                            "parts": [{ "text": `Apresente este imóvel: ${dados}. Use a DIRETRIZ DE APRESENTAÇÃO.` }] 
                        };
                        
                        const payloadLocal = [...conversa, comandoInjecaoFiltro];

                        try {
                            const respFinal = await axios.post(url, { 
                                "systemInstruction": { "parts": [{ "text": process.env.SYSTEM_PROMPT }] }, 
                                "contents": payloadLocal 
                            });
                            const texto = respFinal.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                            if (texto) {
                                await enviarMensagem(sender, texto);
                                // --- AJUSTE ANTI-LOOPING: Amarra o par técnico + resposta no histórico ---
                                conversa.push(comandoInjecaoFiltro);
                                conversa.push({ "role": "model", "parts": [{ "text": texto }] });
                            } else {
                                await enviarMensagem(sender, `*${i.Title}*\n💰 R$ ${i.Details?.ListPrice?._ || i.Details?.ListPrice}\n🔗 ${i.DetailViewUrl}`);
                            }
                        } catch (e) {
                            console.error("Erro na chamada da IA:", e);
                            await enviarMensagem(sender, `*${i.Title}*\n💰 R$ ${i.Details?.ListPrice?._ || i.Details?.ListPrice}\n🔗 ${i.DetailViewUrl}`);
                        }
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                    salvarHistorico(sender, conversa);
                } else {
                    const msg = "Não encontrei imóveis com essas características agora. Gostaria que eu passasse seu contato para o nosso corretor buscar algo personalizado?";
                    await enviarMensagem(sender, msg);
                    conversa.push({ "role": "model", "parts": [{ "text": msg }] });
                    salvarHistorico(sender, conversa);
                }
            }

        } else {
            // --- CORREÇÃO DO FLUXO DE TEXTO PURO: Faz ela responder conversas normais ---
            const textoRespostaPura = contentResponse?.parts?.[0]?.text;
            
            if (textoRespostaPura) {
                console.log("LOG_DEBUG: Resposta puramente textual gerada pela Sheila.");
                
                await enviarMensagem(sender, textoRespostaPura);
                conversa.push({ "role": "model", "parts": [{ "text": textoRespostaPura }] });
                salvarHistorico(sender, conversa);
            } else {
                console.log("LOG_DEBUG: Resposta vazia recebida da API do Gemini.");
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
        conversa.push({ role: "system", parts: [{ text: `O nome deste cliente é ${name}.` }] });
        conversa.push({ role: "model", parts: [{ text: `Olá ${name}, recebemos sua solicitação para o imóvel: ${link}.` }] });
        await enviarTemplateLead(celular, name, link);
        salvarHistorico(celular, conversa); 
        atualizarIndiceLeads(celular, name, origin_desc?.name, false, building_id);
        res.status(200).send("Lead processado");
    } catch (error) { console.error("Erro lead:", error.message); res.status(500).send("Erro"); }
});

app.get('/central', basicAuth, (req, res) => {
    const caminhoHtml = path.join(__dirname, 'central.html');
    fs.readFile(caminhoHtml, 'utf8', (err, data) => {
        if (err) {
            console.error("Erro ao ler central.html em:", caminhoHtml, err);
            return res.status(500).send("Erro ao carregar central: arquivo não encontrado.");
        }
        const htmlComToken = data.replace('SEU_TOKEN_AQUI', process.env.CHAT_ACCESS_TOKEN || '');
        res.send(htmlComToken);
    });
});
app.post('/enviar-crm/:sender', async (req, res) => {
    const { sender } = req.params;
    const { token } = req.query;
    if (token !== process.env.CHAT_ACCESS_TOKEN) return res.status(403).send("Acesso negado.");

    const lead = leadsIndex[sender];
    if (!lead) return res.status(404).send("Lead não encontrado.");

    try {
        const linkEspelho = `https://webhook-siciliano-production.up.railway.app/chat/${sender}?token=${process.env.CHAT_ACCESS_TOKEN}`;
        await axios.post('https://api.apresenta.me/webhook/integration/5099/ab72a9ac29cc5dba9a32eeb37f45461e', {
            nome: lead.nome, 
            celular: sender, 
            origem: ORIGENS[lead.origem] || "5159", 
            mensagem: "Envio manual via Central de Leads", 
            observacoes: `Lead enviado manualmente.\nLink da conversa: ${linkEspelho}`
        });

        // Atualiza o status
        lead.enviadoParaCRM = true;
        atualizarIndiceLeads(sender, lead.nome, lead.origem);

        res.status(200).send("Lead enviado com sucesso!");
    } catch (error) {
        console.error("Erro no envio manual:", error.message);
        res.status(500).send("Erro ao enviar para CRM.");
    }
});
// --- MONITORAMENTO AUTOMÁTICO DE LEADS (CAPTAÇÃO E REENGAJAMENTO) ---
async function monitorarLeads() {
    const agora = new Date();
    
    for (const sender in leadsIndex) {
        const lead = leadsIndex[sender];
        if (lead.enviadoParaCRM) continue; // Pula se já foi enviado

        const ultimaInteracao = new Date(lead.ultimaInteracao);
        const diffHoras = (agora - ultimaInteracao) / (1000 * 60 * 60);

        // 1. Lógica de CAPTAÇÃO (Timeout de 2 horas sem endereço)
        if (lead.categoria === 'captacao' && diffHoras >= 2) {
            console.log(`LOG_DEBUG: Timeout de captação para ${sender}. Encaminhando.`);
            await forcarEnvioCRM(sender, "Encaminhamento automático: Lead de captação não forneceu endereço em 2h.");
            continue;
        }

        // 2. Lógica de REENGAJAMENTO (24 horas sem resposta do cliente)
        if (diffHoras >= 24) {
            console.log(`LOG_DEBUG: Reengajando lead inativo: ${sender}`);
            const msgReengajamento = "Oi! Notei que não tivemos retorno. Ainda tem interesse no imóvel ou precisa de ajuda com algo mais específico?";
            await enviarMensagem(sender, msgReengajamento);
            
            // Adiciona ao histórico para o Gemini saber que enviamos
            const conversa = historicos[sender] || [];
            conversa.push({ "role": "model", "parts": [{ "text": msgReengajamento }] });
            salvarHistorico(sender, conversa);
            
            lead.ultimaInteracao = agora.toISOString(); // Atualiza para não repetir o envio em 30 min
        }
    }
}

// Executa a verificação a cada 30 minutos (1.800.000 ms)
setInterval(monitorarLeads, 1800000);

// Função auxiliar para forçar o envio ao CRM
async function forcarEnvioCRM(sender, obs) {
    const lead = leadsIndex[sender];
    try {
        const linkEspelho = `https://webhook-siciliano-production.up.railway.app/chat/${sender}?token=${process.env.CHAT_ACCESS_TOKEN}`;
        await axios.post('https://api.apresenta.me/webhook/integration/5099/ab72a9ac29cc5dba9a32eeb37f45461e', {
            nome: lead.nome || "Cliente",
            celular: sender,
            origem: ORIGENS[lead.origem] || "5159",
            mensagem: "Encaminhamento automático",
            observacoes: `Sheila: ${obs}\nLink da conversa: ${linkEspelho}`
        });
        lead.enviadoParaCRM = true;
        fs.promises.writeFile(LEADS_INDEX_PATH, JSON.stringify(leadsIndex, null, 2)).catch(console.error);
    } catch (err) {
        console.error("Erro ao forçar envio ao CRM:", err.message);
    }
}

// --- INICIALIZAÇÃO BLINDADA E TOLERANTE A FALHAS ---
const PORT = process.env.PORT || 8080;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`LOG_DEBUG: Servidor online na porta ${PORT}`);

    const carregarDados = async () => {
        try {
            const dir = path.dirname(FILE_PATH);
            if (!fs.existsSync(dir)) {
                console.log("LOG_DEBUG: Diretório de dados não encontrado, criando...");
                fs.mkdirSync(dir, { recursive: true });
            }

            if (fs.existsSync(FILE_PATH)) {
                const data = await fs.promises.readFile(FILE_PATH, 'utf8');
                historicos = JSON.parse(data);
                console.log("LOG_DEBUG: historicos.json carregado.");
            }

            if (fs.existsSync(LEADS_INDEX_PATH)) {
                const data = await fs.promises.readFile(LEADS_INDEX_PATH, 'utf8');
                leadsIndex = JSON.parse(data);
                console.log("LOG_DEBUG: leads_index.json carregado.");
            }
        } catch (e) {
            console.error("LOG_DEBUG: Erro na carga dos dados (não fatal):", e.message);
        }
    };

    carregarDados();
    setTimeout(carregarDados, 5000); 
});
