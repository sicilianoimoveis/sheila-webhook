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

// Carga Sob Demanda (Lazy Loading) para evitar SIGTERM
async function carregarDados() {
    try {
        if (fs.existsSync(FILE_PATH)) historicos = JSON.parse(await fs.promises.readFile(FILE_PATH, 'utf8'));
        if (fs.existsSync(LEADS_INDEX_PATH)) leadsIndex = JSON.parse(await fs.promises.readFile(LEADS_INDEX_PATH, 'utf8'));
    } catch (e) { console.error("Erro carga:", e.message); }
}

function obterHistorico(sender) {
    if (!historicos[sender]) return [];
    return historicos[sender].map(m => ({ role: m.role, parts: [{ text: m.text }] }));
}

function salvarHistorico(sender, conversa) {
    const conversaLimpa = conversa.map(m => ({ role: m.role, text: m.parts && m.parts[0] ? m.parts[0].text : (m.text || "") }));
    historicos[sender] = conversaLimpa;
    fs.promises.writeFile(FILE_PATH, JSON.stringify(historicos, null, 0)).catch(err => console.error(err));
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
app.get('/chat/:sender', async (req, res) => {
    await carregarDados(); // Carrega antes de exibir
    const { sender } = req.params;
    const { token } = req.query;
    if (token !== process.env.CHAT_ACCESS_TOKEN) return res.status(403).send("Acesso negado.");
    const leadInfo = leadsIndex[sender] || { nome: "Lead Sem Nome" };
    const conversa = historicos[sender] || [];
    const mensagensFiltradas = conversa.filter(m => m.text && !m.text.includes("CONSULTA DE IMÓVEL") && !m.text.includes("O nome deste cliente é"));

    let html = `<html><body><div class="header">Atendido pela Sheila</div><div class="lead-info"><strong>Cliente:</strong> ${leadInfo.nome}<br><small>${sender}</small></div>${mensagensFiltradas.map(m => `<div class="msg ${m.role}">${m.text}</div>`).join('')}</body></html>`;
    res.send(html);
});

app.get('/leads', async (req, res) => {
    await carregarDados();
    if (req.query.token !== process.env.CHAT_ACCESS_TOKEN) return res.status(403).send("Acesso negado.");
    res.json(Object.values(leadsIndex).sort((a, b) => new Date(b.ultimaInteracao) - new Date(a.ultimaInteracao)));
});

app.post('/webhook', async (req, res) => {
    await carregarDados();
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
        const response = await axios.post(url, {
            "systemInstruction": { "parts": [{ "text": process.env.SYSTEM_PROMPT || "Você é a Sheila, corretora da Siciliano Imóveis." }] },
            "contents": conversa,
            "tools": [{ "functionDeclarations": [{ "name": "buscar_imovel", "parameters": { "type": "object", "properties": { "termo_de_busca": { "type": "string" } }, "required": ["termo_de_busca"] } }, { "name": "qualificar_lead", "parameters": { "type": "object", "properties": { "interesse": { "type": "string" }, "nome": { "type": "string" } }, "required": ["interesse", "nome"] } }]}]
        });
        const contentResponse = response.data?.candidates?.[0]?.content;
        const functionCall = contentResponse?.parts?.[0]?.functionCall;

        if (functionCall) {
            if (functionCall.name === "qualificar_lead") {
                const nomeDoCliente = functionCall.args.nome || "Cliente";
                await axios.post('https://api.apresenta.me/webhook/integration/5099/ab72a9ac29cc5dba9a32eeb37f45461e', { nome: nomeDoCliente, celular: sender, mensagem: "Atendimento pela Sheila" });
                atualizarIndiceLeads(sender, nomeDoCliente);
                const msg = "Perfeito, acabei de encaminhar seu interesse para nossa equipe!";
                conversa.push({ "role": "model", "parts": [{ "text": msg }] });
                await enviarMensagem(sender, msg);
                salvarHistorico(sender, conversa); 
            } else if (functionCall.name === "buscar_imovel") {
                const termo = functionCall.args.termo_de_busca;
                const imovel = cacheImoveis.find(i => String(i.ListingID) === String(termo) || (i.DetailViewUrl && i.DetailViewUrl.includes(termo)));
                let dados = imovel ? `ID: ${imovel.ListingID}, Preço: R$ ${imovel.Details.ListPrice}` : "Imóvel não localizado.";
                conversa.push({ "role": "model", "parts": [{ "text": `CONSULTA TÉCNICA: ${dados}` }] });
                const respFinal = await axios.post(url, { "contents": conversa });
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
    await carregarDados();
    const { name, phone, building_id } = req.body;
    const celular = phone ? phone.replace(/\D/g, '') : null;
    const imovel = cacheImoveis.find(i => String(i.ListingID) === String(building_id));
    const link = imovel ? imovel.DetailViewUrl : "consulte site";
    const conversa = obterHistorico(celular);
    conversa.push({ role: "model", parts: [{ text: `Olá ${name}, recebemos sua solicitação: ${link}.` }] });
    await enviarTemplateLead(celular, name, link);
    salvarHistorico(celular, conversa); 
    atualizarIndiceLeads(celular, name, "WhatsApp");
    res.status(200).send("OK");
});

app.post('/enviar-crm/:sender', async (req, res) => {
    await carregarDados();
    const { sender } = req.params;
    const lead = leadsIndex[sender];
    if (!lead) return res.status(404).send("Não encontrado.");
    await axios.post('https://api.apresenta.me/webhook/integration/5099/ab72a9ac29cc5dba9a32eeb37f45461e', { nome: lead.nome, celular: sender });
    atualizarIndiceLeads(sender, lead.nome, lead.origem, true);
    res.status(200).send("Enviado!");
});

app.listen(process.env.PORT || 8080, '0.0.0.0', () => console.log("Servidor online"));
