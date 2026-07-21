require('dotenv').config();
const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs'); 
const path = require('path');
const FormData = require('form-data');

// --- FUNÇÕES DE TEMPO E PAUSA ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function gerarAtrasoAleatorio(minMinutos, maxMinutos) {
    const minMs = minMinutos * 60 * 1000;
    const maxMs = maxMinutos * 60 * 1000;
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

const basicAuth = (req, res, next) => {
    const loginEnv = process.env.CENTRAL_USER || "admin";
    const passEnv = process.env.CENTRAL_PASS || "123456";
    
    const b64auth = (req.headers.authorization || '').split(' ')[1] || '';
    const [login, password] = Buffer.from(b64auth, 'base64').toString().split(':');

    if (login && password && login === loginEnv && password === passEnv) {
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
    "leads4sales": "7333"
};

function traduzirOrigem(nomePortal) {
    if (!nomePortal) return "whatsapp_direto";
    const texto = String(nomePortal).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    if (texto.includes("viva real") || texto.includes("vivareal")) return "vivareal"; 
    if (texto.includes("imovelweb") || texto.includes("imovel web")) return "imovelweb"; 
    if (texto.includes("chaves")) return "chaves_na_mao"; 
    if (texto.includes("zap")) return "zap"; 
    if (texto.includes("instagram")) return "instagram"; 
    if (texto.includes("leads4sales")) return "lead4sales"; 
    return "whatsapp_direto"; 
}

// --- SANITIZAÇÃO DE TEXTO DA IA (REMOVE FUNÇÕES E JSON VAZADOS) ---
function limparTextoIA(texto) {
    if (!texto) return "";
    let limpo = texto;

    // 1. Remove chamadas no formato: nome_da_funcao(...)
    const funcoes = [
        "atualizar_status_imovel_crm", "registrar_reclamacao", "registrar_nome",
        "iniciar_captacao", "processar_captacao", "buscar_imovel",
        "buscar_imoveis_filtros", "gerar_cotacao_seguro", "qualificar_lead"
    ];
    funcoes.forEach(func => {
        const regex = new RegExp(func + "\\s*\\([\\s\\S]*?\\)\\n*", "g");
        limpo = limpo.replace(regex, "");
    });

    // 2. Remove blocos JSON crus e formatações de código (```json)
    limpo = limpo.replace(/```json[\s\S]*?```/gi, "");
    limpo = limpo.replace(/```[\s\S]*?```/g, "");
    limpo = limpo.replace(/\{[\s\S]*"funcao"[\s\S]*\}/gi, "");

    return limpo.trim();
}

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

const v = (campo) => {
    if (campo === null || campo === undefined) return '';
    if (Array.isArray(campo)) campo = campo[0];
    if (typeof campo === 'object') {
        return campo._ !== undefined ? String(campo._).trim() : '';
    }
    return String(campo).trim();
};

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

// ==========================================
// --- INTEGRAÇÃO SIGAFY E CRM ---
// ==========================================

async function buscarProprietarioNoCRM(id_imovel) {
    try {
        const config = { 
            headers: { 
                "Authorization": `Bearer ${process.env.CRM_API_TOKEN}`, 
                "Accept": "application/json" 
            } 
        };
        
        const resImovel = await axios.get("https://api.apresenta.me/buildings", {
            ...config,
            params: { "include[owners]": "*", "filter[id]": id_imovel }
        });
        
        const ownerId = resImovel.data?.data?.[0]?.owners?.[0]?.id; 
        if (!ownerId) {
            console.log(`LOG_DEBUG: Imóvel ${id_imovel} não possui proprietário no CRM.`);
            return null;
        }

        const resOwner = await axios.get("https://api.apresenta.me/persons", {
            ...config,
            params: { "include[contacts]": "*", "filter[id]": ownerId }
        });
        
        const dono = resOwner.data?.data?.[0];
        if (!dono) return null;

        let dataFormatada = "01/01/1980";
        if (dono.birth_date) {
            const partes = dono.birth_date.split('-');
            if (partes.length === 3) dataFormatada = `${partes[2]}/${partes[1]}/${partes[0]}`;
        }

        const telefoneBruto = resOwner.data?.data?.[0]?.contacts?.[0]?.cellphone || "";
        const telefoneLimpo = String(telefoneBruto).replace(/\D/g, '');

        return {
            tipoPessoa: dono.juridical ? "juridica" : "fisica",
            documento: dono.taxid || "000.000.000-00", 
            nome: dono.name || "Proprietário",
            dataNascimento: dataFormatada,
            estadoCivil: dono.marital || "Solteiro(a)",
            telefone: telefoneLimpo 
        };
    } catch (error) {
        console.error("Erro ao buscar proprietário no CRM:", error.message);
        return null;
    }
}

const RECADASTRO_INDEX_PATH = '/app/dados/recadastro_imoveis.json';
let recadastroIndex = {};

const carregarRecadastros = () => {
    try {
        if (fs.existsSync(RECADASTRO_INDEX_PATH)) {
            recadastroIndex = JSON.parse(fs.readFileSync(RECADASTRO_INDEX_PATH, 'utf8'));
        }
    } catch (e) {
        recadastroIndex = {};
    }
};
carregarRecadastros();

async function iniciarVarreduraRecadastramentoAutomatica() {
    console.log("🔍 Iniciando varredura automática de recadastramento de imóveis...");
    const agora = new Date();
    let imoveisParaDisparar = [];

    for (const imovel of cacheImoveis) {
        const idImovel = String(imovel.ListingID);
        const ultimoDisparo = recadastroIndex[idImovel]?.ultimaDataDisparo;
        let deveDisparar = false;

        if (!ultimoDisparo) {
            deveDisparar = true;
        } else {
            const diasPassados = (agora - new Date(ultimoDisparo)) / (1000 * 60 * 60 * 24);
            if (diasPassados >= 45) {
                deveDisparar = true;
            }
        }

        if (deveDisparar) {
            imoveisParaDisparar.push(idImovel);
        }
    }

    console.log(`📋 Total de imóveis elegíveis para recadastramento hoje: ${imoveisParaDisparar.length}`);

    for (let i = 0; i < imoveisParaDisparar.length; i++) {
        const idImovel = imoveisParaDisparar[i];
        try {
            console.log(`🚀 Executando recadastramento automático para o imóvel ID: ${idImovel}`);
            await processarDisparoRecadastramento(idImovel);

            recadastroIndex[idImovel] = { ultimaDataDisparo: agora.toISOString() };
            await fs.promises.writeFile(RECADASTRO_INDEX_PATH, JSON.stringify(recadastroIndex, null, 2));

            console.log(`✅ Recadastramento do imóvel ${id_imovel} enviado com sucesso.`);
        } catch (erro) {
            console.error(`❌ Erro ao recadastrar imóvel ${idImovel}:`, erro.message);
        }

        if (i < imoveisParaDisparar.length - 1) {
            const tempoDeEsperaMs = gerarAtrasoAleatorio(4, 8);
            const minutos = (tempoDeEsperaMs / 1000 / 60).toFixed(1);
            console.log(`⏳ Aguardando ${minutos} minutos antes de disparar para o próximo proprietário...`);
            await sleep(tempoDeEsperaMs);
        }
    }
    console.log("🏁 Varredura de recadastramento de imóveis finalizada!");
}

// Função auxiliar que centraliza a lógica de envio (separada da rota do Express)
async function processarDisparoRecadastramento(id_imovel) {
    const imovelXML = cacheImoveis.find(i => String(i.ListingID) === String(id_imovel));
    if (!imovelXML) throw new Error("Imóvel não encontrado no XML.");

    const resultadoDono = await buscarProprietarioNoCRM(id_imovel);
    if (!resultadoDono || !resultadoDono.telefone || resultadoDono.telefone.length < 10) {
        throw new Error("Telefone do proprietário inválido ou não encontrado no CRM.");
    }

    const dadosDono = resultadoDono;
    
    // --- CORREÇÃO CRÍTICA: PREVENÇÃO DO DUPLO 55 ---
    let sender = dadosDono.telefone;
    if (!sender.startsWith("55")) {
        sender = `55${sender}`;
    }
    // -----------------------------------------------

    const endereco = obterEnderecoSeguro(imovelXML);
    const precos = obterPrecosFormatados(imovelXML);
    const tipoNegocioTexto = precos.pVenda > 0 ? "venda" : "locação";

    // Salva o estado de proprietário e o ID do imóvel no índice persistente do lead CORRETO
    if (!leadsIndex[sender]) leadsIndex[sender] = {};
    leadsIndex[sender].isProprietario = true;
    leadsIndex[sender].imovelAtualizando = id_imovel; 
    await fs.promises.writeFile(LEADS_INDEX_PATH, JSON.stringify(leadsIndex, null, 2));

    let conversa = obterHistorico(sender);
    
    // Dispara o template via Meta
    await enviarTemplateAtualizacaoImovel(sender, dadosDono.nome, endereco, tipoNegocioTexto);
    
    // Adiciona apenas a mensagem oficial do modelo no histórico (mantendo a alternância perfeita)
    const textoTemplateEnviado = `Olá ${dadosDono.nome}!\nEu sou a Sheila da Siciliano Imóveis.\nEstamos entrando em contato para atualizar o seu imóvel em ${endereco}.\nContinua disponível para ${tipoNegocioTexto}?`;
    conversa.push({ "role": "model", "parts": [{ "text": textoTemplateEnviado }] });
    
    salvarHistorico(sender, conversa);
}

async function solicitarCotacaoSigafy(dadosCliente, imovel, telefoneCliente) {
    try {
        const token = await gerarTokenSigafy();
        if (!token) return null;

        const url = "https://projetos.sigafy.com.br/api/v1/quote/bail";
        const pLocacao = parseFloat(v(imovel?.Details?.RentalPrice)) || 1000;
        const vCondominio = parseFloat(v(imovel?.Details?.PropertyAdministrationFee)) || 0;
        const vIptu = parseFloat(v(imovel?.Details?.YearlyTax)) || 0;

        const tipoImovelXML = v(imovel?.Details?.PropertyType).toLowerCase();
        let tipoImovelSigafy = "apartamento"; 
        if (tipoImovelXML.includes("casa")) tipoImovelSigafy = "casa";
        else if (tipoImovelXML.includes("comercial") || tipoImovelXML.includes("loja")) tipoImovelSigafy = "sala comercial";

        let dadosProprietario = await buscarProprietarioNoCRM(imovel.ListingID);
        if (!dadosProprietario) {
             dadosProprietario = { documento: "000.000.000-00", nome: "Proprietário Não Informado", dataNascimento: "01/01/1980" };
        }

        let dataNascFormatada = dadosCliente.dataNascimento;
        if (dataNascFormatada) {
            const partes = dataNascFormatada.split(/[-/]/); 
            if (partes.length === 3) {
                let dia = partes[0].padStart(2, '0');
                let mes = partes[1].padStart(2, '0');
                let ano = partes[2];
                if (ano.length === 2) { ano = parseInt(ano) < 30 ? `20${ano}` : `19${ano}`; }
                dataNascFormatada = `${dia}/${mes}/${ano}`;
            }
        }

        const cpfLimpo = dadosCliente.cpf ? dadosCliente.cpf.replace(/\D/g, '') : "";
        const celularLimpo = dadosCliente.celular ? dadosCliente.celular.replace(/\D/g, '') : "";

        const loc = imovel?.Location || {};
        const imovelPretendidoPayload = {
            "cep": v(loc.ZipCode) || "00000-000",
            "codigo_imovel": String(imovel?.ListingID || "00000"),
            "endereco": v(loc.Address) || "Não informado",
            "numero": v(loc.StreetNumber) || "S/N",
            "complemento": v(loc.Complement) || "Sem complemento",
            "bairro": v(loc.Neighborhood) || "Não informado",
            "cidade": v(loc.City) || "Não informado",
            "estado": "RJ" 
        };

        const payload = {
            "gratuito": true, "observacao": "Cotação via Sheila IA", "tipoGarantia": "seguro fianca", "valorTitulo": pLocacao,
            "tipoPessoa": "fisica", "tipoLocacao": "residencial", "tipoimovel": tipoImovelSigafy || "casa", 
            "valorAluguel": pLocacao, "valorCondominio": vCondominio, "valorAgua": 0, "valorLuz": 0, "valorGas": 0, "valorIptu": vIptu,
            "codigo_imovel": dadosCliente.id_imovel || "Não informado", "parceiro": "", "vigencia_meses": 30,
            "administracao": "Sim", "atividade": "Atividade", "experiencia": "Experiencia no ramo", "contato": dadosCliente.nome,
            "solidario": { "solidarios_conjulge": "", "solidarios_cpf": "", "solidarios_nome": "", "solidarios_rg": "", "solidarios_date_expedition": "", "solidarios_orgao_emissor": "", "solidarios_nascimento": "", "solidarios_fone": "", "solidarios_email": "", "solidarios_civil": "", "solidarios_degree": "", "solidarios_sexo": "" },
            "partners": { "partners_cpf": "", "partners_nome": "", "partners_fone": "", "partners_email": "", "partners_percent": "" },
            "cobertura": { "danos": true, "pinturaInterna": true, "multa": true, "pinturaExterna": false },
            "semImovelDefinido": dadosCliente.id_imovel ? false : true, "imovelPretendido": imovelPretendidoPayload,
            "imobiliaria": { "id": 1840, "atendente": "Siciliano Imoveis" },
            "pretendente": {
                "documento": cpfLimpo, "nome": dadosCliente.nome, "sexo": "MASCULINO", "dataNascimento": dataNascFormatada,
                "estadoCivil": "Solteiro(a)", "celular": celularLimpo, "fone": celularLimpo, "email": dadosCliente.email || "nao_informado@email.com",
                "rg": { "numero": "", "expedicao": "", "orgaoEmissor": "" }, "contato": dadosCliente.nome, "cnae": ""
            },
            "proprietarioImovel": {
                "tipoPessoa": "fisica", "documento": dadosProprietario.documento || "000.000.000-00",
                "nome": dadosProprietario.nome || "Não informado", "dataNascimento": dadosProprietario.dataNascimento || "01/01/1980", "estadoCivil": "Solteiro(a)"
            }
        };

        const response = await axios.post(url, payload, { headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json", "Accept": "application/json" } });
        return response.data;
    } catch (error) { console.error("Erro ao gerar cotação Sigafy:", error.message); return null; }
}

async function enviarMensagem(para, texto) {
    const url = `https://graph.facebook.com/v25.0/1110417002164010/messages`;
    try {
        await axios.post(url, { messaging_product: 'whatsapp', to: para, type: 'text', text: { body: texto } }, { headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` } });
    } catch (error) { console.error('Erro ao enviar:', error.message); }
}

async function enviarTemplateLead(para, nome, linkImovel) {
    const url = `https://graph.facebook.com/v25.0/1110417002164010/messages`;
    const payload = { messaging_product: "whatsapp", to: para, type: "template", template: { name: "contato_lead", language: { code: "pt_BR" }, components: [{ type: "body", parameters: [{ type: "text", text: nome }, { type: "text", text: linkImovel }] }] } };
    await axios.post(url, payload, { headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` } });
}
async function enviarTemplateReengajamento(para, nome) {
    const url = `https://graph.facebook.com/v25.0/1110417002164010/messages`;
    const payload = { messaging_product: "whatsapp", to: para, type: "template", template: { name: "rengajamento", language: { code: "pt_BR" }, components: [{ type: "body", parameters: [{ type: "text", text: nome }] }] } };
    await axios.post(url, payload, { headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` } });
}
async function enviarTemplateMeta(para, nomeTemplate, variavelNome) {
    const url = `https://graph.facebook.com/v25.0/1110417002164010/messages`;
    const payload = { messaging_product: "whatsapp", to: para, type: "template", template: { name: nomeTemplate, language: { code: "pt_BR" }, components: [{ type: "body", parameters: [{ type: "text", text: variavelNome }] }] } };
    try { await axios.post(url, payload, { headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` } }); } catch (error) { console.error(`Erro ao enviar template:`, error.message); }
}
async function enviarTemplateAtualizacaoImovel(para, nome, endereco, tipoNegocio) {
    const url = `https://graph.facebook.com/v25.0/1110417002164010/messages`;
    const payload = { messaging_product: "whatsapp", to: para, type: "template", template: { name: "atualizacaodeimovel", language: { code: "pt_BR" }, components: [ { type: "body", parameters: [ { type: "text", text: nome }, { type: "text", text: endereco }, { type: "text", text: tipoNegocio } ] } ] } };
    try { await axios.post(url, payload, { headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` } }); } catch (error) { console.error(`Erro template atualizacaodeimovel:`, error.message); }
}

async function obterUrlMedia(mediaId) {
    const url = `https://graph.facebook.com/v25.0/${mediaId}/`;
    const response = await axios.get(url, { headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` } });
    return response.data.url;
}

async function transcreverAudio(mediaId) {
    try {
        const mediaUrl = await obterUrlMedia(mediaId);
        const audioResponse = await axios.get(mediaUrl, { headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` }, responseType: 'stream' });
        const filePath = `/tmp/${mediaId}.ogg`;
        const writer = fs.createWriteStream(filePath);
        audioResponse.data.pipe(writer);
        await new Promise((resolve, reject) => { writer.on('finish', resolve); writer.on('error', reject); });
        const form = new FormData();
        form.append('file', fs.createReadStream(filePath));
        form.append('model', 'whisper-1');
        const openaiResponse = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, { headers: { ...form.getHeaders(), 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` } });
        fs.unlinkSync(filePath);
        return openaiResponse.data.text;
    } catch (error) { console.error("Erro transcrição:", error.message); return null; }
}

const FILE_PATH = '/app/dados/historico.json';
const LEADS_INDEX_PATH = '/app/dados/leads_index.json';
let historicos = {};
let leadsIndex = {};

function obterHistorico(sender) {
    if (!historicos[sender]) return [];
    return historicos[sender].map(m => ({ role: m.role, parts: Array.isArray(m.parts) ? m.parts : [{ text: m.text || "" }] }));
}

function salvarHistorico(sender, conversa) {
    const historicoAntigo = historicos[sender] || [];
    historicos[sender] = conversa.map((m, index) => { 
        const msgAntiga = historicoAntigo[index];
        return { role: m.role, parts: m.parts, timestamp: msgAntiga?.timestamp || new Date().toISOString() };
    });
    fs.writeFileSync(FILE_PATH, JSON.stringify(historicos, null, 2));
}

function atualizarIndiceLeads(sender, nome, origem, statusCRM = false, id_imovel = null) {
    if (!leadsIndex[sender]) leadsIndex[sender] = { imoveisInteresse: [] };
    if (!leadsIndex[sender].imoveisInteresse) leadsIndex[sender].imoveisInteresse = [];
    if (id_imovel && !leadsIndex[sender].imoveisInteresse.includes(id_imovel)) leadsIndex[sender].imoveisInteresse.push(id_imovel);

    leadsIndex[sender] = {
        ...leadsIndex[sender], sender: sender, nome: nome || leadsIndex[sender]?.nome || "Lead Sem Nome",
        origem: origem || leadsIndex[sender]?.origem || "WhatsApp", ultimaInteracao: new Date().toISOString(),
        enviadoParaCRM: statusCRM || leadsIndex[sender]?.enviadoParaCRM || false
    };
    fs.promises.writeFile(LEADS_INDEX_PATH, JSON.stringify(leadsIndex, null, 2)).catch(console.error);
}

async function enviarLeadParaCRM(sender, contexto, idsImoveis = []) {
    const lead = leadsIndex[sender];
    if (!lead) return;
    let purposeStr = "sale"; 
    if (contexto.purpose) { purposeStr = contexto.purpose; } 
    else if (contexto.interesse && (contexto.interesse.toLowerCase().includes('loca') || contexto.interesse.toLowerCase().includes('aluguel'))) { purposeStr = "rent"; }

    let id_imovel = null;
    let notasAdicionais = "";
    if (idsImoveis && idsImoveis.length > 0) { id_imovel = idsImoveis[0]; if (idsImoveis.length > 1) { notasAdicionais = `\n\n⚠️ ATENÇÃO CORRETOR: O cliente também tem interesse em visitar os imóveis IDs: ${idsImoveis.join(', ')}`; } } 
    else if (lead.imoveisInteresse && lead.imoveisInteresse.length > 0) { id_imovel = lead.imoveisInteresse[lead.imoveisInteresse.length - 1]; }

    const codigoOrigem = parseInt(ORIGENS[lead.origem] || ORIGENS["whatsapp_direto"]);
    let alertaSeguro = "";
    if (lead.dadosSeguro) { alertaSeguro = `\n\n🛡️ [SEGURO FIANÇA PRÉ-COTADO] 🛡️\nO cliente já forneceu dados (CPF: ${lead.dadosSeguro.cpf}). Status API Sigafy: ${lead.dadosSeguro.status}.\n`; }

    const payload = { name: contexto.nome || lead.nome || "Cliente", email: contexto.email || lead.email || null, phone: sender.replace(/\D/g, ''), purpose: purposeStr, origin_id: codigoOrigem, origin: lead.origem || "WhatsApp", message: contexto.mensagem || "Atendimento inicial", notes: (contexto.observacoes || "") + notasAdicionais + alertaSeguro };
    if (id_imovel) { payload.building_id = parseInt(id_imovel); }

    try {
        const url = "https://api.apresenta.me/persons/leads";
        const config = { headers: { "Authorization": `Bearer ${process.env.CRM_API_TOKEN}`, "Content-Type": "application/json", "Accept": "application/json" } };
        const response = await axios.post(url, payload, config);
        const leadIdGerado = response.data?.id || response.data?.data?.id;

        if (leadIdGerado && lead.dadosSeguro && lead.dadosSeguro.detalhes) {
            const detalhes = lead.dadosSeguro.detalhes;
            let filesArray = [];
            if (detalhes.data && Array.isArray(detalhes.data.base64)) {
                detalhes.data.base64.forEach((arquivoBase64, index) => {
                    const binaryData = arquivoBase64.replace(/^data:application\/pdf;base64,/, "");
                    filesArray.push({ name: `Cotacao_Sigafy_${index + 1}.pdf`, binary: binaryData });
                });
            }
            if (filesArray.length > 0) {
                const payloadArquivos = { id: leadIdGerado, files: filesArray };
                try { await axios.post(url, payloadArquivos, config); } catch (errUpload) {}
            }
        }
        lead.enviadoParaCRM = true;
        if (contexto.nome) lead.nome = contexto.nome;
        atualizarIndiceLeads(sender, lead.nome, lead.origem);
    } catch (error) { console.error("ERRO ao enviar CRM:", error.message); }
}

app.get('/limpar-historico/:sender', async (req, res) => {
    const { sender } = req.params;
    if (historicos[sender]) {
        historicos[sender] = [];
        try { await fs.promises.writeFile(FILE_PATH, JSON.stringify(historicos, null, 2)); res.send(`Histórico limpo.`); } 
        catch (err) { res.status(500).send("Erro arquivo."); }
    } else { res.status(404).send("Cliente não encontrado."); }
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
        return txt && !txt.includes("DADOS TÉCNICOS PARA CONSULTA") && !txt.includes("INFORMAÇÃO INTERNA DA SHEILA") && !txt.includes("CONSULTA DE IMÓVEL") && !txt.includes("O nome deste cliente é");
    });
    let html = `<html><body><div class="lead-info"><strong>Cliente:</strong> ${nomeLead}<br><small>${sender}</small></div>
    ${mensagensFiltradas.map(m => {
        const text = m.parts && m.parts[0] ? m.parts[0].text : (m.text || "");
        return `<div class="msg ${m.role}">${text}</div>`;
    }).join('')}</body></html>`;
    res.send(html);
});

app.get('/debug-imovel/:id_imovel', async (req, res) => {
    if (req.query.token !== process.env.CHAT_ACCESS_TOKEN) return res.status(403).send("Acesso negado.");
    const { id_imovel } = req.params;
    try {
        const config = { headers: { "Authorization": `Bearer ${process.env.CRM_API_TOKEN}`, "Accept": "application/json" } };
        const resImovel = await axios.get("https://api.apresenta.me/buildings", { ...config, params: { "include[owners]": "*", "filter[id]": id_imovel } });
        const imovelEncontrado = resImovel.data?.data?.[0];
        const ownerId = imovelEncontrado?.owners?.[0]?.id;
        if (!ownerId) { return res.json({ status: "FALHA", motivo: "Sem ownerId no CRM.", respostaBrutaImovel: imovelEncontrado }); }
        const resOwner = await axios.get("https://api.apresenta.me/persons", { ...config, params: { "include[contacts]": "*", "filter[id]": ownerId } });
        res.json({ status: "SUCESSO", ownerIdDetectado: ownerId, imovel: imovelEncontrado, proprietarioNoCRM: resOwner.data?.data?.[0] });
    } catch (error) { res.status(500).json({ status: "ERRO_API", detalhe: error.message }); }
});

app.post('/disparar-atualizacao-imovel/:id_imovel', async (req, res) => {
    if (req.query.token !== process.env.CHAT_ACCESS_TOKEN) return res.status(403).send("Acesso negado.");
    const { id_imovel } = req.params;
    try {
        await processarDisparoRecadastramento(id_imovel);
        res.status(200).send(`Template de recadastramento disparado com sucesso para o imóvel ID: ${id_imovel}`);
    } catch (error) {
        console.error(`Erro na rota de disparo manual:`, error.message);
        res.status(400).send(`Falha ao disparar: ${error.message}`);
    }
});

app.post('/iniciar-ciclo-recadastro', async (req, res) => {
    if (req.query.token !== process.env.CHAT_ACCESS_TOKEN) { return res.status(403).send("Acesso negado."); }
    res.status(200).send("Varredura iniciada.");
    iniciarVarreduraRecadastramentoAutomatica().catch(err => { console.error("Erro varredura:", err.message); });
});

// --- AUTOMAÇÃO PAUSADA A PEDIDO ---
/* 
setTimeout(() => {
    setInterval(async () => {
        try { await iniciarVarreduraRecadastramentoAutomatica(); } catch (e) { }
    }, 86400000); 
}, 60000);
*/

app.post('/disparar-reengajamento', async (req, res) => {
    if (req.query.token !== "SEU_TOKEN_AQUI") return res.status(403).send("Não autorizado");
    dispararReengajamentoManual(); 
    res.status(200).send("Disparo em lote iniciado no servidor.");
});

app.get('/leads', (req, res) => {
    if (req.query.token !== process.env.CHAT_ACCESS_TOKEN) return res.status(403).send("Acesso negado.");
    res.json(Object.values(leadsIndex).sort((a, b) => new Date(b.ultimaInteracao) - new Date(a.ultimaInteracao)));
});

app.post('/webhook', async (req, res) => {
   if (process.env.SHEILA_PAUSADA === 'true') { return res.sendStatus(200); }    

    const msgData = req.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    if (!msgData) return res.sendStatus(200);

    const sender = msgData.from;
    const nomeMeta = req.body.entry?.[0]?.changes?.[0]?.value?.contacts?.[0]?.profile?.name;

    console.log(`\n========================================`);
    console.log(`🔍 [WEBHOOK] Mensagem recebida de: ${sender}`);
    console.log(`📊 Estado salvo no leadsIndex:`, JSON.stringify(leadsIndex[sender] || "NENHUM ESTADO ENCONTRADO"));
    console.log(`========================================\n`);

    const nomeAtual = leadsIndex[sender]?.nome;
    const nomeParaSalvar = (nomeAtual && nomeAtual !== "Lead Sem Nome") ? nomeAtual : (nomeMeta || "Cliente");
    atualizarIndiceLeads(sender, nomeParaSalvar, "WhatsApp");

    let textoCliente = msgData.text?.body;
    if (msgData.type === 'audio' && msgData.audio?.id) {
        const transcricao = await transcreverAudio(msgData.audio.id);
        if (transcricao) { textoCliente = transcricao; } 
        else { await enviarMensagem(sender, "Recebi seu áudio, mas não compreendi direito. Pode escrever?"); return res.sendStatus(200); }
    }
    if (!textoCliente) return res.sendStatus(200);

    const conversa = obterHistorico(sender);

    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`;
        conversa.push({ "role": "user", "parts": [{ "text": textoCliente }] });

        let promptDinamico = "";

        if (leadsIndex[sender]?.isProprietario && leadsIndex[sender]?.imovelAtualizando) {
            const idImovelProp = leadsIndex[sender].imovelAtualizando;
            const imovelXMLProp = cacheImoveis.find(i => String(i.ListingID) === String(idImovelProp));
            const precosProp = imovelXMLProp ? obterPrecosFormatados(imovelXMLProp) : { pVenda: 0, pLocacao: 0 };
            const valorNumProp = precosProp.pVenda > 0 ? precosProp.pVenda : precosProp.pLocacao;
            const tipoNegocioTxt = precosProp.pVenda > 0 ? "venda" : "locação";
            const tipoNegocioCRM = precosProp.pVenda > 0 ? "sale" : "rent";

            console.log(`🔒 [MODO EXCLUSIVO PROPRIETÁRIO ATIVADO] Imóvel ID: ${idImovelProp}`);

            // --- NOVO PROMPT: REGRA DE DOIS PASSOS (STATUS + VALOR) ---
            promptDinamico = `Você é a Sheila, assistente virtual da Siciliano Imóveis. 
            ATENÇÃO ABSOLUTA: Você está conversando com o PROPRIETÁRIO do imóvel ID ${idImovelProp}. 
            O imóvel está cadastrado para ${tipoNegocioTxt} (tipo_negocio: '${tipoNegocioCRM}') pelo valor atual de R$${valorNumProp}.
            
            REGRAS OBRIGATÓRIAS PARA ESTE ATENDIMENTO (SIGA A ORDEM):
            1. É ESTRITAMENTE PROIBIDO perguntar se ele quer comprar ou alugar, qual bairro ou quartos. Ele é o dono.
            2. NUNCA pergunte o endereço, a referência ou o código do imóvel. Você já tem esses dados.
            3. REGRA DO VALOR: Se o cliente confirmar que o imóvel continua disponível, mas NÃO informar o valor na mesma frase, você DEVE perguntar com educação: "Perfeito! E o valor de ${tipoNegocioTxt} continua R$ ${valorNumProp} ou teve alguma alteração?". NÃO chame a função ainda. Aguarde a resposta dele.
            4. AÇÃO FINAL: SOMENTE APÓS o proprietário confirmar o valor (seja dizendo que continua o mesmo, ou informando um valor novo), chame IMEDIATAMENTE a função 'atualizar_status_imovel_crm'.
            5. Na função, preencha os parâmetros obrigatórios: id_imovel: "${idImovelProp}", tipo_negocio: "${tipoNegocioCRM}", valor_atualizado: [insira o valor confirmado por ele em formato numérico], lock: "free", status: "active".`;

        } else {
            promptDinamico = process.env.SYSTEM_PROMPT || "Você é a Sheila, corretora da Siciliano Imóveis.";
        }

        const payloadInicial = {
            "systemInstruction": { "parts": [{ "text": promptDinamico }] },
            "contents": conversa,
            "tools": [{ "functionDeclarations": [
                { 
                    "name": "atualizar_status_imovel_crm", 
                    "description": "Use APENAS quando estiver falando com um PROPRIETÁRIO e ele confirmar a situação atual do imóvel e o valor.", 
                    "parameters": { 
                        "type": "object", 
                        "properties": { 
                            "id_imovel": { "type": "string" }, "tipo_negocio": { "type": "string" }, "valor_atualizado": { "type": "number" },
                            "lock": { "type": "string" }, "status": { "type": "string" }
                        }, 
                        "required": ["id_imovel", "tipo_negocio", "valor_atualizado", "lock", "status"] 
                    } 
                },
                { "name": "registrar_reclamacao", "description": "Uso para relatar mau atendimento.", "parameters": { "type": "object", "properties": { "motivo": { "type": "string" } }, "required": ["motivo"] } },
                { "name": "registrar_nome", "description": "Salvar nome. Não usar durante Passo 3.", "parameters": { "type": "object", "properties": { "nome": { "type": "string" } }, "required": ["nome"] } },
                { "name": "iniciar_captacao", "description": "Vender, alugar próprio imóvel.", "parameters": { "type": "object", "properties": {}, "required": [] } },
                { "name": "processar_captacao", "description": "Registrar endereço para captação.", "parameters": { "type": "object", "properties": { "endereco": { "type": "string" } }, "required": ["endereco"] } },
                { "name": "buscar_imovel", "description": "Consulta dados por código/URL.", "parameters": { "type": "object", "properties": { "termo_de_busca": { "type": "string" } }, "required": ["termo_de_busca"] } },
                {
                    "name": "buscar_imoveis_filtros",
                    "description": "Busca imóveis com filtros de intenção, cidade, bairro.",
                    "parameters": {
                        "type": "object",
                        "properties": {
                            "intencao": { "type": "string" }, "tipo": { "type": "string" }, "cidade": { "type": "string" },
                            "bairro": { "type": "string" }, "rua": { "type": "string" }, "quartos": { "type": "number" },
                            "vaga": { "type": "integer" }, "precoVendaMax": { "type": "number" }, "precoLocacaoMax": { "type": "number" }, "extras": { "type": "array", "items": { "type": "string" } }
                        }, "required": ["intencao"]
                    }
                },
                { 
                    "name": "gerar_cotacao_seguro", 
                    "description": "Alugar imóvel e todos os dados CPF, etc, preenchidos.", 
                    "parameters": { "type": "object", "properties": { "nome": { "type": "string" }, "cpf": { "type": "string" }, "dataNascimento": { "type": "string" }, "email": { "type": "string" }, "celular": { "type": "string" }, "id_imovel": { "type": "string" } }, "required": ["nome", "cpf", "dataNascimento", "email", "celular", "id_imovel"] } 
                },
                { "name": "qualificar_lead", "description": "Encaminhar para corretor.", "parameters": { "type": "object", "properties": { "interesse": { "type": "string" }, "nome": { "type": "string" }, "ids_imoveis": { "type": "array", "items": { "type": "string" } } }, "required": ["interesse", "nome"] } }
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
           else if (functionCall.name === "atualizar_status_imovel_crm") {
                const { id_imovel, lock, status, valor_atualizado, tipo_negocio } = functionCall.args;
                console.log(`LOG_DEBUG: Atualizando Imóvel ${id_imovel} | Status: ${status} | Lock: ${lock} | Valor: ${valor_atualizado} | Tipo: ${tipo_negocio}`);

                const configCRM = {
                    headers: {
                        "Authorization": `Bearer ${process.env.CRM_API_TOKEN}`,
                        "Content-Type": "application/json",
                        "Accept": "application/json"
                    }
                };

                try {
                    // 1. ATUALIZA O STATUS DO IMÓVEL (Sem tocar nos preços para não dar "Removida")
                    const urlBuilding = `https://api.apresenta.me/buildings/${id_imovel}`;
                    await axios.put(urlBuilding, {
                        lock: lock,
                        status: status
                    }, configCRM);

                    // 2. ATUALIZA O PREÇO NO ENDPOINT ESPECÍFICO (Exatamente como o suporte pediu)
                    const urlPurpose = `https://api.apresenta.me/buildings/${id_imovel}/purposes`;
                    const payloadPurpose = {
                        type: tipo_negocio, // "sale" ou "rent"
                        currency: "BRL",    // O campo obrigatório que faltava
                        amount: valor_atualizado,
                        amount_max: valor_atualizado
                    };

                    await axios.post(urlPurpose, payloadPurpose, configCRM);

                    console.log(`✅ Imóvel ${id_imovel} atualizado no CRM com sucesso (Status e Preço corrigidos)!`);
                    
                    // Limpa o estado de proprietário para encerrar o ciclo
                    if (leadsIndex[sender]) {
                        leadsIndex[sender].isProprietario = false;
                        fs.promises.writeFile(LEADS_INDEX_PATH, JSON.stringify(leadsIndex, null, 2)).catch(console.error);
                    }

                    // Pede para a Sheila agradecer
                    conversa.push({ "role": "user", "parts": [{ "text": `INFORMAÇÃO INTERNA: O sistema foi atualizado com sucesso (Status: ${status}, Valor: R$${valor_atualizado}). Agradeça ao proprietário pela atenção e encerre o atendimento educadamente.` }] });

                } catch (errorUpdate) {
                    console.error("❌ Erro ao atualizar imóvel no CRM:", errorUpdate.response?.data || errorUpdate.message);
                    conversa.push({ "role": "user", "parts": [{ "text": `INFORMAÇÃO INTERNA: Houve uma falha sistêmica ao tentar salvar. Agradeça ao cliente pela informação e diga que seus dados já foram anotados.` }] });
                }

                // Gera a mensagem final da Sheila
                const promptFinal = typeof promptDinamico !== 'undefined' ? promptDinamico : process.env.SYSTEM_PROMPT;
                const respFinal = await axios.post(url, { "systemInstruction": { "parts": [{ "text": promptFinal }] }, "contents": conversa });
                
                // Passa a mensagem pela nova função de limpeza que bloqueia códigos JSON
                let texto = limparTextoIA(respFinal.data?.candidates?.[0]?.content?.parts?.[0]?.text);
                
                if (texto) {
                    await enviarMensagem(sender, texto);
                    conversa.push({ "role": "model", "parts": [{ "text": texto }] });
                    salvarHistorico(sender, conversa);
                }
            }
            else if (functionCall.name === "gerar_cotacao_seguro") {
                const dadosCliente = functionCall.args;
                if (!dadosCliente.cpf || !dadosCliente.nome || !dadosCliente.celular) {
                    const aviso = "INFORMAÇÃO INTERNA DA SHEILA: Você tentou gerar a cotação de seguro, mas o cliente AINDA NÃO FORNECEU todos os dados. Peça os dados em lista.";
                    conversa.push({ "role": "user", "parts": [{ "text": aviso }] });
                    const respCorrecao = await axios.post(url, { "systemInstruction": { "parts": [{ "text": process.env.SYSTEM_PROMPT }] }, "contents": conversa });
                    let textoCorrecao = limparTextoIA(respCorrecao.data?.candidates?.[0]?.content?.parts?.[0]?.text);
                    if (textoCorrecao) {
                        await enviarMensagem(sender, textoCorrecao);
                        conversa.push({ "role": "model", "parts": [{ "text": textoCorrecao }] });
                        salvarHistorico(sender, conversa);
                    }
                    return res.sendStatus(200); 
                }

                const imovelCotado = cacheImoveis.find(i => String(i.ListingID) === String(dadosCliente.id_imovel));
                const resultadoCotacao = await solicitarCotacaoSigafy(dadosCliente, imovelCotado, sender);
                if (!leadsIndex[sender]) atualizarIndiceLeads(sender, dadosCliente.nome);
                leadsIndex[sender].dadosSeguro = { cpf: dadosCliente.cpf, status: resultadoCotacao ? "Cotação Gerada" : "Falha na Cotação", detalhes: resultadoCotacao };
                fs.promises.writeFile(LEADS_INDEX_PATH, JSON.stringify(leadsIndex, null, 2)).catch(console.error);

                await enviarLeadParaCRM(sender, { nome: dadosCliente.nome, email: dadosCliente.email, purpose: "rent", interesse: "aluguel", mensagem: "Atendimento iniciado", observacoes: "Seguro acionado" }, [dadosCliente.id_imovel]);

                let instrucao = "INFORMAÇÃO INTERNA DA SHEILA: A pré-análise foi concluída. REGRA ESTRITA: NÃO INFORME NENHUM VALOR DE SEGURO AO CLIENTE. Diga que a pré-análise deu certo.";
                conversa.push({ "role": "user", "parts": [{ "text": instrucao }] });
                const respFinal = await axios.post(url, { "systemInstruction": { "parts": [{ "text": process.env.SYSTEM_PROMPT }] }, "contents": conversa });
                let texto = limparTextoIA(respFinal.data?.candidates?.[0]?.content?.parts?.[0]?.text);
                if (texto) {
                    await enviarMensagem(sender, texto);
                    conversa.push({ "role": "model", "parts": [{ "text": texto }] });
                    await new Promise(resolve => setTimeout(resolve, 1500)); 
                    const msgAvaliacao = "Ah, e se estiver satisfeito, avalie-nos no Google:\nhttps://search.google.com/local/writereview?placeid=ChIJ_w2xUXjfmwAR3DnuGUi-5hQ";
                    await enviarMensagem(sender, msgAvaliacao);
                    conversa.push({ "role": "model", "parts": [{ "text": msgAvaliacao }] });
                    salvarHistorico(sender, conversa);
                }
            }
            else if (functionCall.name === "registrar_nome") {
                const nomeDoCliente = functionCall.args.nome;
                atualizarIndiceLeads(sender, nomeDoCliente);
                conversa.push({ "role": "user", "parts": [{ "text": `INFORMAÇÃO INTERNA DA SHEILA: O nome '${nomeDoCliente}' foi salvo. Responda naturalmente.` }] });
                const respFinal = await axios.post(url, { "systemInstruction": { "parts": [{ "text": process.env.SYSTEM_PROMPT }] }, "contents": conversa });
                let texto = limparTextoIA(respFinal.data?.candidates?.[0]?.content?.parts?.[0]?.text);
                if (texto) {
                    await enviarMensagem(sender, texto);
                    conversa.push({ "role": "model", "parts": [{ "text": texto }] });
                    salvarHistorico(sender, conversa);
                }
            }
            else if (functionCall.name === "processar_captacao") {
                leadsIndex[sender].categoria = 'processado'; 
                leadsIndex[sender].ultimaInteracao = new Date().toISOString();
                fs.promises.writeFile(LEADS_INDEX_PATH, JSON.stringify(leadsIndex, null, 2)).catch(console.error);
                const resposta = "Perfeito, anotei o endereço! Vou passar essas informações para nossa equipe.";
                await enviarMensagem(sender, resposta);
                conversa.push({ "role": "model", "parts": [{ "text": resposta }] });
                salvarHistorico(sender, conversa);
            }      
            else if (functionCall.name === "qualificar_lead") {
                const nomeDoCliente = functionCall.args.nome || "Cliente";
                const idsExtraidos = functionCall.args.ids_imoveis || []; 
                atualizarIndiceLeads(sender, nomeDoCliente);
                await enviarLeadParaCRM(sender, { interesse: functionCall.args.interesse, mensagem: "Atendimento realizado", observacoes: `Resumo: ${functionCall.args.interesse}` }, idsExtraidos);
                const msg1 = "Perfeito, acabei de encaminhar seu interesse para nossa equipe de corretores! ✨";
                await enviarMensagem(sender, msg1);
                conversa.push({ "role": "model", "parts": [{ "text": msg1 }] });
                await new Promise(resolve => setTimeout(resolve, 1500));
                const msg2 = "Ah, e se estiver satisfeito, deixe uma avaliação!\nhttps://search.google.com/local/writereview?placeid=ChIJ_w2xUXjfmwAR3DnuGUi-5hQ";
                await enviarMensagem(sender, msg2);
                conversa.push({ "role": "model", "parts": [{ "text": msg2 }] });
                salvarHistorico(sender, conversa); 
            }
            else if (functionCall.name === "registrar_reclamacao") {
                const motivo = functionCall.args.motivo;
                const numeroGerencia = "5521985559544"; 
                if (!leadsIndex[sender]) atualizarIndiceLeads(sender, null);
                leadsIndex[sender].statusUrgente = true;
                fs.promises.writeFile(LEADS_INDEX_PATH, JSON.stringify(leadsIndex, null, 2)).catch(console.error);
                const alerta = `🚨 *ALERTA DE RECLAMAÇÃO* 🚨\n*Motivo:* ${motivo}`;
                await enviarMensagem(numeroGerencia, alerta);
                conversa.push({ "role": "user", "parts": [{ "text": `INFORMAÇÃO INTERNA: O alerta foi enviado. Peça desculpas ao cliente.` }] });
                const respFinal = await axios.post(url, { "systemInstruction": { "parts": [{ "text": process.env.SYSTEM_PROMPT }] }, "contents": conversa });
                let texto = limparTextoIA(respFinal.data?.candidates?.[0]?.content?.parts?.[0]?.text);
                if (texto) {
                    await enviarMensagem(sender, texto);
                    conversa.push({ "role": "model", "parts": [{ "text": texto }] });
                    salvarHistorico(sender, conversa);
                }
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
                    let dados = `DADOS TÉCNICOS: ID ${imovel.ListingID}, Venda: ${precos.venda}, Locação: ${precos.locacao}, Endereço: ${enderecoSeguro}, Extras: ${features}, Descrição: ${desc}. Link: ${imovel.DetailViewUrl}.`;
                    conversa.push({ "role": "user", "parts": [{ "text": dados }] });
                } else {
                    conversa.push({ "role": "user", "parts": [{ "text": `O imóvel "${termo}" não foi localizado.` }] });
                }
                const respFinal = await axios.post(url, { "systemInstruction": { "parts": [{ "text": process.env.SYSTEM_PROMPT }] }, "contents": conversa });
                let texto = limparTextoIA(respFinal.data?.candidates?.[0]?.content?.parts?.[0]?.text);
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
                const mapaTipos = { "apartamento": "residential/apartment", "cobertura": "residential/penthouse", "casa": "residential/home", "sala comercial": "commercial/office", "loja": "commercial/loja" };
                const mapaIntencao = { "compra": "forsale", "venda": "forsale", "aluguel": "forrent", "locacao": "forrent" };
                const { intencao, cidade, bairro, quartos, precoVendaMax, precoLocacaoMax, tipo, vaga, extras } = functionCall.args;
                const precoMax = precoVendaMax || precoLocacaoMax || 0;
                const nVagasPedido = parseInt(vaga);
                const buscaIntencao = normalize(intencao || "");
                const isVenda = buscaIntencao.includes("compra") || buscaIntencao.includes("venda") || buscaIntencao.includes("sale");
                const isLocacao = buscaIntencao.includes("aluguel") || buscaIntencao.includes("locacao") || buscaIntencao.includes("rent");
                
                const filtra = (i, modoExato) => {
                    const cidadeImovel = normalize(v(i.Location?.City)); 
                    const bairroImovel = normalize(v(i.Location?.Neighborhood));
                    const tipoImovelXML = normalize(v(i.Details?.PropertyType));
                    const transacaoXML = normalize(v(i.TransactionType));
                    const descricao = normalize(v(i.Details?.Description));
                    const pV = parseFloat(v(i.Details?.ListPrice)) || 0;
                    const pL = parseFloat(v(i.Details?.RentalPrice)) || 0;
                    const qteQuartos = parseInt(v(i.Details?.Bedrooms)) || 0;
                    const nTipoBusca = mapaTipos[normalize(tipo)] || normalize(tipo);

                    const matchCidade = !cidade || cidadeImovel.includes(normalize(cidade)); 
                    const matchBairro = !bairro || bairroImovel.includes(normalize(bairro));
                    const matchIntencao = !intencao || (isVenda && transacaoXML.includes("sale")) || (isLocacao && transacaoXML.includes("rent"));
                    
                    let matchTipo = true;
                    if (tipo) {
                        if (mapaTipos[normalize(tipo)]) { matchTipo = tipoImovelXML.includes(nTipoBusca); } 
                        else { matchTipo = tipoImovelXML.includes(nTipoBusca) || descricao.includes(normalize(tipo)); }
                    }
                    
                    let matchPreco = true;
                    if (precoMax > 0) {
                        if (isVenda) matchPreco = (pV > 0 && pV <= precoMax);
                        else if (isLocacao) matchPreco = (pL > 0 && pL <= precoMax);
                    }
                    const nVagasXML = parseInt(v(i.Details?.Garage)) || 0;
                    const matchVaga = isNaN(nVagasPedido) ? true : (modoExato ? (nVagasXML === nVagasPedido) : (nVagasXML >= nVagasPedido));
                    const matchQuartos = !quartos || (modoExato ? (qteQuartos === quartos) : (qteQuartos >= quartos));
                    const features = Array.isArray(i.Details?.Features?.Feature) ? i.Details.Features.Feature.map(f => normalize(f)).join(' ') : normalize(v(i.Details?.Features?.Feature));
                    const matchExtras = !extras || extras.every(extra => descricao.includes(normalize(extra)) || features.includes(normalize(extra)));
                    
                    return matchCidade && matchBairro && matchIntencao && matchTipo && matchQuartos && matchPreco && matchVaga && matchExtras;
                };
                
                let resultados = cacheImoveis.filter(i => filtra(i, true));
                if (resultados.length === 0) resultados = cacheImoveis.filter(i => filtra(i, false));
                resultados = resultados.slice(0, 3);

                if (resultados.length > 0) {
                    await enviarMensagem(sender, "Encontrei estas opções para você:");
                    let contextoOpcoes = `INFORMAÇÃO INTERNA DA SHEILA - DADOS DOS IMÓVEIS SUGERIDOS NA BUSCA:\n`;

                    for (const i of resultados) {
                        const precos = obterPrecosFormatados(i);
                        const enderecoSeguro = obterEnderecoSeguro(i);
                        const features = obterFeatures(i);
                        const desc = v(i.Details?.Description);
                        
                        contextoOpcoes += `- Link: ${i.DetailViewUrl}\n  ID: ${i.ListingID}\n  Venda: ${precos.venda} | Locação: ${precos.locacao}\n  Endereço permitido: ${enderecoSeguro}\n  Quartos: ${v(i.Details?.Bedrooms)} | Suítes: ${v(i.Details?.Suites)} | Vagas: ${v(i.Details?.Garage)}\n  Extras: ${features}\n\n`;

                        const dados = `Título: ${i.Title}, Descrição: ${desc}, Preço Venda: ${precos.venda}, Preço Locação: ${precos.locacao}, Link: ${i.DetailViewUrl}`;
                        const payloadLocal = [...conversa, { "role": "user", "parts": [{ "text": `Apresente este imóvel: ${dados}. Respeite rigorosamente as regras do seu SYSTEM PROMPT.` }] }];

                        try {
                            const respFinal = await axios.post(url, { "systemInstruction": { "parts": [{ "text": process.env.SYSTEM_PROMPT }] }, "contents": payloadLocal });
                            let texto = limparTextoIA(respFinal.data?.candidates?.[0]?.content?.parts?.[0]?.text);
                            if (texto) {
                                await enviarMensagem(sender, texto);
                                conversa.push({ "role": "model", "parts": [{ "text": texto }] });
                            } else {
                                const precoDisplay = (precos.pLocacao > 0) ? `${precos.locacao} (Locação)` : `${precos.venda} (Venda)`;
                                await enviarMensagem(sender, `*${i.Title}*\n💰 ${precoDisplay}\n🔗 ${i.DetailViewUrl}`);
                            }
                        } catch (e) {
                            const precoDisplay = (precos.pLocacao > 0) ? `${precos.locacao} (Locação)` : `${precos.venda} (Venda)`;
                            await enviarMensagem(sender, `*${i.Title}*\n💰 ${precoDisplay}\n🔗 ${i.DetailViewUrl}`);
                        }
                        await new Promise(resolve => setTimeout(resolve, 1000));
                    }
                    contextoOpcoes += `DIRETRIZ: Consulte estritamente os dados acima. NUNCA invente ruas.`;
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
            let textoRespostaPura = limparTextoIA(contentResponse?.parts?.[0]?.text);
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

// --- ROTA WEBHOOK LEADS4SALES ---
app.post('/webhook-leads4sales', async (req, res) => {
    try {
        const data = req.body;
        if (!data.clientListingId) { return res.status(400).json({ error: "clientListingId é obrigatório" }); }
        res.status(200).json({ status: "success", message: "Lead recebido com sucesso" });

        const nome = data.name || 'Cliente';
        let celular = data.phoneNumber ? data.phoneNumber.replace(/\D/g, '') : "";
        const referenciaOriginal = String(data.clientListingId);
        const mensagemPortal = data.message || 'Gostaria de informações sobre este imóvel.';

        if (!celular) return;
        if (!celular.startsWith("55")) { celular = `55${celular}`; }

        let imovel = cacheImoveis.find(i => String(i.ListingID) === referenciaOriginal);
        if (!imovel && referenciaOriginal.includes('_')) {
            const idLimpo = referenciaOriginal.split('_')[1]; 
            imovel = cacheImoveis.find(i => String(i.ListingID) === idLimpo);
        }

        const idDefinitivo = imovel ? imovel.ListingID : referenciaOriginal;
        const linkImovel = imovel ? imovel.DetailViewUrl : `https://sicilianoimoveis.com.br/imovel/${idDefinitivo}`;

        atualizarIndiceLeads(celular, nome, 'lead4sales', false, idDefinitivo);
        let conversa = obterHistorico(celular);
        
        if (conversa.length === 0) {
            let contextoOculto = `DADOS TÉCNICOS: Novo lead vindo do Leads4Sales.\nNome: ${nome}\nMensagem: "${mensagemPortal}"\nID do Imóvel: ${idDefinitivo}\n`;
            if (imovel) {
                const precos = obterPrecosFormatados(imovel);
                contextoOculto += `Dados: Venda ${precos.venda}, Locação ${precos.locacao}, Endereço permitido: ${obterEnderecoSeguro(imovel)}.`;
            }

            conversa.push({ role: "user", parts: [{ text: contextoOculto }] });
            const textoTemplate = `Olá ${nome}, recebemos sua solicitação para o imóvel: ${linkImovel}.`;
            conversa.push({ role: "model", parts: [{ text: textoTemplate }] });
            salvarHistorico(celular, conversa);
            await enviarTemplateLead(celular, nome, linkImovel);
        }
    } catch (error) { if (!res.headersSent) res.status(500).json({ error: "Erro interno no servidor" }); }
});

// --- ROTA WEBHOOK IMOVELWEB ---
app.post('/webhook-imovelweb', async (req, res) => {
    res.status(200).send('Webhook recebido com sucesso');
    try {
        const data = req.body;
        if (data.eventType !== 'CONTACTO_MENSAJE' && data.eventType !== 'CONTACTO') return;

        const nome = data.name || 'Cliente';
        const telefoneBruto = data.phone || "";
        const referencia = data.internalReference || "";
        const mensagemPortal = data.message || 'Gostaria de informações sobre este imóvel.';

        if (!telefoneBruto) return;
        const celular = telefoneBruto.replace(/\D/g, '');
        const imovel = cacheImoveis.find(i => String(i.ListingID) === String(referencia));
        const linkImovel = imovel ? imovel.DetailViewUrl : `https://sicilianoimoveis.com.br/imovel/${referencia}`;

        atualizarIndiceLeads(celular, nome, 'imovelweb', false, referencia);
        let conversa = obterHistorico(celular);
        
        if (conversa.length === 0) {
            let contextoOculto = `DADOS TÉCNICOS: Novo lead do Imovelweb.\nNome: ${nome}\nMensagem: "${mensagemPortal}"\nID: ${referencia}\n`;
            if (imovel) {
                const precos = obterPrecosFormatados(imovel);
                contextoOculto += `Dados: Venda ${precos.venda}, Locação ${precos.locacao}, Endereço permitido: ${obterEnderecoSeguro(imovel)}.`;
            }
            conversa.push({ role: "user", parts: [{ text: contextoOculto }] });
            const textoTemplate = `Olá ${nome}, recebemos sua solicitação para o imóvel: ${linkImovel}.`;
            conversa.push({ role: "model", parts: [{ text: textoTemplate }] });
            salvarHistorico(celular, conversa);
            await enviarTemplateLead(celular, nome, linkImovel);
        }
    } catch (error) {}
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
            const contextoOculto = `DADOS TÉCNICOS: O cliente ${name} quer info. ID ${imovel.ListingID}, Venda: ${precos.venda}, Locação: ${precos.locacao}, Endereço permitido: ${enderecoSeguro}. Extras: ${features}, Descrição: ${desc}.`;
            conversa.push({ role: "user", parts: [{ text: contextoOculto }] });
        } else {
            conversa.push({ role: "user", parts: [{ text: `Cliente ${name} interessado no ID ${building_id}.` }] });
        }

        conversa.push({ role: "model", parts: [{ text: `Olá ${name}, recebemos sua solicitação para o imóvel: ${link}.` }] });
        await enviarTemplateLead(celular, name, link);
        salvarHistorico(celular, conversa); 
        const origemTraduzida = traduzirOrigem(origin_desc?.name);
        atualizarIndiceLeads(celular, name, origemTraduzida, false, building_id);
        res.status(200).send("Lead processado.");
    } catch (error) { res.status(500).send("Erro"); }
});

app.get('/central', basicAuth, (req, res) => {
    const caminhoHtml = path.join(__dirname, 'central.html');
    fs.readFile(caminhoHtml, 'utf8', (err, data) => {
        if (err) return res.status(500).send("Erro ao carregar central.");
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
        await enviarLeadParaCRM(sender, { interesse: "venda", mensagem: "Envio manual", observacoes: `Link da conversa: ${linkEspelho}` });
        res.status(200).send("Enviado com sucesso!");
    } catch (error) { res.status(500).send("Erro ao enviar para CRM."); }
});

app.post('/remover-urgencia/:sender', async (req, res) => {
    const { sender } = req.params;
    if (req.query.token !== process.env.CHAT_ACCESS_TOKEN) return res.status(403).send("Acesso negado.");
    const lead = leadsIndex[sender];
    if (lead && lead.statusUrgente) {
        lead.statusUrgente = false; 
        try {
            await fs.promises.writeFile(LEADS_INDEX_PATH, JSON.stringify(leadsIndex, null, 2));
            return res.status(200).send("Status removido.");
        } catch (error) { return res.status(500).send("Erro ao salvar."); }
    }
    res.status(200).send("Lead não urgente.");
});

async function monitorarLeads() {
    const agora = new Date();
    for (const sender in leadsIndex) {
        const lead = leadsIndex[sender];
        if (lead.enviadoParaCRM) continue; 
        if (lead.status === 'aguardando_humano') continue;
        if (!lead.ultimaInteracao) continue; 

        const diffHoras = (agora - new Date(lead.ultimaInteracao)) / (1000 * 60 * 60);

        if (lead.categoria === 'captacao' && diffHoras >= 2) {
            await forcarEnvioCRM(sender, "Encaminhamento automático: captação não forneceu endereço.");
            continue;
        }

        if (diffHoras >= 24 && !lead.reengajamento24hEnviado) {
            const nomeLead = leadsIndex[sender]?.nome || "cliente";
            await enviarTemplateReengajamento(sender, nomeLead);
            const conversa = historicos[sender] || [];
            conversa.push({ "role": "model", "parts": [{ "text": `Oi ${nomeLead}! Notei que não tivemos retorno. Ainda tem interesse?` }] });
            salvarHistorico(sender, conversa);
            lead.ultimaInteracao = agora.toISOString(); 
            lead.reengajamento24hEnviado = true; 
            fs.promises.writeFile(LEADS_INDEX_PATH, JSON.stringify(leadsIndex, null, 2)).catch(console.error);
        }
    }
}
setInterval(monitorarLeads, 1800000);

async function dispararReengajamentoManual() {
    console.log("Iniciando varredura manual...");
    let leadsParaReengajar = [];
    for (const sender in leadsIndex) {
        const lead = leadsIndex[sender];
        if (lead.enviadoParaCRM) continue; 
        if (lead.status === 'aguardando_humano') continue;
        if (lead.reengajamentoManualEnviado) continue; 
        leadsParaReengajar.push({ sender, lead });
    }
    for (let i = 0; i < leadsParaReengajar.length; i++) {
        const { sender, lead } = leadsParaReengajar[i];
        const nomeLead = lead.nome || "cliente";
        try {
            await enviarTemplateMeta(sender, "rengajamento7", nomeLead); 
            lead.reengajamentoManualEnviado = true;
            fs.promises.writeFile(LEADS_INDEX_PATH, JSON.stringify(leadsIndex, null, 2)).catch(console.error);
        } catch (erro) {}
        if (i < leadsParaReengajar.length - 1) { await sleep(gerarAtrasoAleatorio(4, 8)); }
    }
}

async function forcarEnvioCRM(sender, obs) {
    const linkEspelho = `https://webhook-siciliano-production.up.railway.app/chat/${sender}?token=${process.env.CHAT_ACCESS_TOKEN}`;
    await enviarLeadParaCRM(sender, { interesse: "venda", mensagem: "Encaminhamento", observacoes: `Sheila: ${obs}\nLink: ${linkEspelho}` });
}

async function configurarWebhookImovelweb() {}
async function assinarEventosImovelweb() {}

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

(async () => {
    try {
        console.log("Iniciando configuração do Imóvelweb...");
        await configurarWebhookImovelweb();
        await assinarEventosImovelweb();
        console.log("Configuração finalizada!");
    } catch (error) { console.log("Erro na configuração:", error.message); }
})();
