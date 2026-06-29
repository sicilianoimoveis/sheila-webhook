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

function atualizarIndiceLeads(sender, nome, origem, statusCRM = false) {
    if (!leadsIndex[sender]) leadsIndex[sender] = {};
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
    const msgData = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msgData) return res.sendStatus(200);
    const sender = msgData.from;
    atualizarIndiceLeads(sender, null, "WhatsApp");
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
                { "name": "buscar_imovel", "description": "Consulta dados técnicos (rua, suites, vagas, features) pelo código ou URL.", "parameters": { "type": "object", "properties": { "termo_de_busca": { "type": "string" } }, "required": ["termo_de_busca"] } },
                { "name": "qualificar_lead", "description": "Chame ao perceber interesse claro em visita ou falar com corretor. Sempre extraia o nome do cliente da conversa.", "parameters": { "type": "object", "properties": { "interesse": { "type": "string" }, "nome": { "type": "string" } }, "required": ["interesse", "nome"] } }
            ]}]
        };
        const response = await axios.post(url, payloadInicial);
        const contentResponse = response.data?.candidates?.[0]?.content;
        const functionCall = contentResponse?.parts?.[0]?.functionCall;

        if (functionCall) {
            if (functionCall.name === "qualificar_lead") {
                let origemIdentificada = referral?.includes("instagram") ? "instagram" : "whatsapp_direto";
                const nomeDoCliente = functionCall.args.nome || "Cliente";
                const linkEspelho = `https://webhook-siciliano-production.up.railway.app/chat/${sender}?token=${process.env.CHAT_ACCESS_TOKEN}`;
                await axios.post('https://api.apresenta.me/webhook/integration/5099/ab72a9ac29cc5dba9a32eeb37f45461e', {
                    nome: nomeDoCliente, celular: sender, origem: ORIGENS[origemIdentificada], mensagem: "Atendimento realizado pela Sheila", observacoes: `Resumo: ${functionCall.args.interesse}\nLink da conversa: ${linkEspelho}`
                });
                atualizarIndiceLeads(sender, nomeDoCliente);
                const msg = "Perfeito, acabei de encaminhar seu interesse para nossa equipe de corretores!";
                conversa.push({ "role": "model", "parts": [{ "text": msg }] });
                await enviarMensagem(sender, msg);
                salvarHistorico(sender, conversa); 
            } else if (functionCall.name === "buscar_imovel") {
                const termo = functionCall.args.termo_de_busca;
                const imovel = cacheImoveis.find(i => String(i.ListingID) === String(termo) || (i.DetailViewUrl && i.DetailViewUrl.includes(termo)));
                const v = (campo) => (campo && typeof campo === 'object' ? campo._ : campo) || 'Não informado';
                const feat = imovel?.Features?.Feature ? (Array.isArray(imovel.Features.Feature) ? imovel.Features.Feature.join(', ') : imovel.Features.Feature) : "Nenhuma característica extra informada.";
                const enderecoReal = imovel && imovel.Location ? (Array.isArray(imovel.Location) ? imovel.Location[0].Address : imovel.Location.Address) : "Não informado";
                let dados = imovel ? `ID: ${imovel.ListingID}, Preço: R$ ${v(imovel.Details.ListPrice)}, Rua: ${v(enderecoReal)}, Suítes: ${v(imovel.Details.Suites)}, Vagas: ${v(imovel.Details.Garage)}, Bairro: ${v(imovel.Location.Neighborhood)}, Features: ${feat}, Descrição: ${v(imovel.Details.Description)}` : "Imóvel não localizado.";
                conversa.push({ "role": "user", "parts": [{ "text": `CONSULTA DE IMÓVEL: ${dados}. USE APENAS ESTAS INFORMAÇÕES TÉCNICAS. NÃO INVENTE DADOS.` }] });
                const respFinal = await axios.post(url, { "systemInstruction": { "parts": [{ "text": process.env.SYSTEM_PROMPT }] }, "contents": conversa });
                const texto = respFinal.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                if (texto) { 
                    conversa.push({ "role": "model", "parts": [{ "text": texto }] }); 
                    await enviarMensagem(sender, texto); 
                    salvarHistorico(sender, conversa); 
                }
            }
        } else if (contentResponse?.parts?.[0]?.text) {
            conversa.push({ "role": "model", "parts": [{ "text": contentResponse.parts[0].text }] });
            await enviarMensagem(sender, contentResponse.parts[0].text);
            salvarHistorico(sender, conversa); 
        }
    } catch (error) { console.error("Erro Webhook:", error.message); }
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
        atualizarIndiceLeads(celular, name, origin_desc?.name);
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

// --- INICIALIZAÇÃO BLINDADA E TOLERANTE A FALHAS ---
const PORT = process.env.PORT || 8080;

app.listen(PORT, '0.0.0.0', () => {
    console.log(`LOG_DEBUG: Servidor online na porta ${PORT}`);

    // Função de carregamento com verificação de existência e "retry"
    const carregarDados = async () => {
        try {
            // Garante que o diretório existe
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

    // Tenta carregar os dados agora e repete em 5 segundos caso o volume ainda esteja sendo montado
    carregarDados();
    setTimeout(carregarDados, 5000); 
});
