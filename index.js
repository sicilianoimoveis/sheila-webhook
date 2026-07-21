require('dotenv').config();
const express = require('express');
const axios = require('axios');
const xml2js = require('xml2js');
const fs = require('fs'); 
const path = require('path');
const FormData = require('form-data'); // Adicionado para transcrição de áudio

// --- FUNÇÕES DE TEMPO E PAUSA ---
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

function gerarAtrasoAleatorio(minMinutos, maxMinutos) {
    const minMs = minMinutos * 60 * 1000;
    const maxMs = maxMinutos * 60 * 1000;
    return Math.floor(Math.random() * (maxMs - minMs + 1)) + minMs;
}

const basicAuth = (req, res, next) => {
    // Agora ele busca do seu painel do Railway
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
    "lead4sales": "7333"
};

// Traduz o nome que vem do CRM para a chave da Sheila
function traduzirOrigem(nomePortal) {
    if (!nomePortal) return "whatsapp_direto";
    
    // Converte tudo para minúsculo e tira acentos para evitar erros
    const texto = String(nomePortal).toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
    
    if (texto.includes("viva real") || texto.includes("vivareal")) return "vivareal"; // Vai retornar 7331
    if (texto.includes("imovelweb") || texto.includes("imovel web")) return "imovelweb"; // Vai retornar 7329
    if (texto.includes("chaves")) return "chaves_na_mao"; // Vai retornar 7330
    if (texto.includes("zap")) return "zap"; // Vai retornar 7332
    if (texto.includes("instagram")) return "instagram"; // Vai retornar 7328
    if (texto.includes("lead4sales")) return "lead4sales"; // Vai retornar 7333
    
    return "whatsapp_direto"; // Padrão se não achar nada
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

// --- FUNÇÕES AUXILIARES DE EXTRAÇÃO XML ---
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

// --- FUNÇÕES DE ENVIO ---

// ==========================================
// --- INTEGRAÇÃO SIGAFY E CRM (SEGURO FIANÇA) ---
// ==========================================

async function buscarProprietarioNoCRM(id_imovel) {
    try {
        const config = { 
            headers: { 
                "Authorization": `Bearer ${process.env.CRM_API_TOKEN}`, 
                "Accept": "application/json" 
            } 
        };
        
        // 1. PRIMEIRA CHAMADA: Busca o imóvel para pegar o ID do dono
        const resImovel = await axios.get("https://api.apresenta.me/buildings", {
            ...config,
            params: {
                "include[owners]": "*",
                "filter[id]": id_imovel
            }
        });
        
        const ownerId = resImovel.data?.data?.[0]?.owners?.[0]?.id; 
        
        if (!ownerId) {
            console.log(`LOG_DEBUG: Imóvel ${id_imovel} não possui proprietário no CRM.`);
            return null;
        }

        // 2. SEGUNDA CHAMADA: Busca os dados do proprietário
        const resOwner = await axios.get("https://api.apresenta.me/persons", {
            ...config,
            params: {
                "include[contacts]": "*",
                "filter[id]": ownerId
            }
        });
        
        const dono = resOwner.data?.data?.[0];
        if (!dono) return null;

        // 3. Formatação da Data de Nascimento
        let dataFormatada = "01/01/1980";
        if (dono.birth_date) {
            const partes = dono.birth_date.split('-');
            if (partes.length === 3) dataFormatada = `${partes[2]}/${partes[1]}/${partes[0]}`;
        }

        // 4. Extração exata baseada no mapeamento do painel: data[0].contacts[0].cellphone
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
async function gerarTokenSigafy() {
    try {
        const url = "https://projetos.sigafy.com.br/api/v1/quote/bail-auth";
        
        // Trava de segurança: Se as variáveis não estiverem no Railway, ele avisa no log e para.
        if (!process.env.SIGAFY_USER || !process.env.SIGAFY_PASS) {
            console.error("❌ ERRO: Credenciais da Sigafy (SIGAFY_USER / SIGAFY_PASS) não encontradas no .env");
            return null;
        }

        const body = {
            "username": process.env.SIGAFY_USER,
            "password": process.env.SIGAFY_PASS
        };
        
        const response = await axios.post(url, body, {
            headers: { "Content-Type": "application/json", "Accept": "application/json" }
        });
        return response.data.token;
    } catch (error) {
        console.error("Erro ao gerar token Sigafy:", error.response?.data || error.message);
        return null;
    }
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
             dadosProprietario = {
                documento: "000.000.000-00",
                nome: "Proprietário Não Informado",
                dataNascimento: "01/01/1980"
             };
        }

        // --- 1. CORREÇÃO DA DATA DE NASCIMENTO ---
        let dataNascFormatada = dadosCliente.dataNascimento;
        if (dataNascFormatada) {
            const partes = dataNascFormatada.split(/[-/]/); // Trata barra ou traço
            if (partes.length === 3) {
                let dia = partes[0].padStart(2, '0');
                let mes = partes[1].padStart(2, '0');
                let ano = partes[2];
                // Se o cliente mandou "84", o código transforma em "1984"
                if (ano.length === 2) {
                    ano = parseInt(ano) < 30 ? `20${ano}` : `19${ano}`;
                }
                dataNascFormatada = `${dia}/${mes}/${ano}`;
            }
        }

                // --- 2. LIMPEZA DE DADOS (CPF E CELULAR) ---
        // Pega o que o cliente digitou e remove TUDO que não for número (pontos, traços, espaços)
        const cpfLimpo = dadosCliente.cpf ? dadosCliente.cpf.replace(/\D/g, '') : "";
        const celularLimpo = dadosCliente.celular ? dadosCliente.celular.replace(/\D/g, '') : "";

        // --- 3. CORREÇÃO DO ENDEREÇO DO IMÓVEL ---
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
            // ... (mantenha os outros campos do payload iguais até a parte do pretendente)
            "gratuito": true,
            "observacao": "Cotação via Sheila IA",
            "tipoGarantia": "seguro fianca",
            "valorTitulo": pLocacao,
            "tipoPessoa": "fisica",
            "tipoLocacao": "residencial",
            "tipoimovel": tipoImovelSigafy || "casa", 
            "valorAluguel": pLocacao,
            "valorCondominio": vCondominio,
            "valorAgua": 0,
            "valorLuz": 0,
            "valorGas": 0,
            "valorIptu": vIptu,
            "codigo_imovel": dadosCliente.id_imovel || "Não informado",
            "parceiro": "",
            "vigencia_meses": 30,
            "administracao": "Sim",
            "atividade": "Atividade",
            "experiencia": "Experiencia no ramo",
            "contato": dadosCliente.nome,
            "solidario": {
                "solidarios_conjulge": "", "solidarios_cpf": "", "solidarios_nome": "", "solidarios_rg": "", "solidarios_date_expedition": "", "solidarios_orgao_emissor": "", "solidarios_nascimento": "", "solidarios_fone": "", "solidarios_email": "", "solidarios_civil": "", "solidarios_degree": "", "solidarios_sexo": ""
            },
            "partners": {
                "partners_cpf": "", "partners_nome": "", "partners_fone": "", "partners_email": "", "partners_percent": ""
            },
            "cobertura": {
                "danos": true, "pinturaInterna": true, "multa": true, "pinturaExterna": false
            },
            "semImovelDefinido": dadosCliente.id_imovel ? false : true,
            "imovelPretendido": imovelPretendidoPayload,
            "imobiliaria": {
                "id": 1840,
                "atendente": "Siciliano Imoveis"
            },
            "pretendente": {
                "documento": cpfLimpo, // Envia o CPF 100% limpo (só números)
                "nome": dadosCliente.nome,
                "sexo": "MASCULINO", 
                "dataNascimento": dataNascFormatada,
                "estadoCivil": "Solteiro(a)",
                "celular": celularLimpo, // Usa estritamente o celular que a Sheila perguntou
                "fone": celularLimpo,
                "email": dadosCliente.email || "nao_informado@email.com",
                "rg": {
                    "numero": "", "expedicao": "", "orgaoEmissor": ""
                },
                "contato": dadosCliente.nome,
                "cnae": ""
            },
            "proprietarioImovel": {
                "tipoPessoa": "fisica",
                "documento": dadosProprietario.documento || "000.000.000-00",
                "nome": dadosProprietario.nome || "Não informado",
                "dataNascimento": dadosProprietario.dataNascimento || "01/01/1980",
                "estadoCivil": "Solteiro(a)"
            }
        };

        const response = await axios.post(url, payload, {
            headers: {
                "Authorization": `Bearer ${token}`,
                "Content-Type": "application/json",
                "Accept": "application/json"
            }
        });
        
        return response.data;
    } catch (error) {
        console.error("Erro ao gerar cotação Sigafy:", error.response?.data || error.message);
        return null;
    }
}

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
async function enviarTemplateMeta(para, nomeTemplate, variavelNome) {
    const url = `https://graph.facebook.com/v25.0/1110417002164010/messages`;
    const payload = {
        messaging_product: "whatsapp",
        to: para,
        type: "template",
        template: {
            name: nomeTemplate,
            language: { code: "pt_BR" },
            components: [{ type: "body", parameters: [{ type: "text", text: variavelNome }] }]
        }
    };
    try {
        await axios.post(url, payload, { headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` } });
    } catch (error) { 
        console.error(`Erro ao enviar template ${nomeTemplate}:`, error.response?.data || error.message); 
    }
}

async function enviarTemplateAtualizacaoImovel(para, nome, endereco, tipoNegocio) {
    const url = `https://graph.facebook.com/v25.0/1110417002164010/messages`;
    const payload = {
        messaging_product: "whatsapp",
        to: para,
        type: "template",
        template: {
            name: "atualizacaodeimovel",
            language: { code: "pt_BR" },
            components: [
                {
                    type: "body",
                    parameters: [
                        { type: "text", text: nome },
                        { type: "text", text: endereco },
                        { type: "text", text: tipoNegocio }
                    ]
                }
            ]
        }
    };
    try {
        await axios.post(url, payload, { headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` } });
    } catch (error) { 
        console.error(`Erro ao enviar template atualizacaodeimovel:`, error.response?.data || error.message); 
    }
}

// --- ROTINA DE ATUALIZAÇÃO DE IMÓVEIS (RECADASTRAMENTO) ---

async function buscarContatoProprietarioCRM(id_imovel) {
    try {
        const config = { headers: { "Authorization": `Bearer ${process.env.CRM_API_TOKEN}`, "Accept": "application/json" } };
        
        // 1. Busca o imóvel para pegar o ID do dono (Baseado na imagem 1 e 4)
        const resImovel = await axios.get("https://api.apresenta.me/buildings", {
            ...config,
            params: { "include[owners]": "*", "filter[id]": id_imovel }
        });
        
        const ownerId = resImovel.data?.data?.[0]?.owners?.[0]?.id; 
        if (!ownerId) return null;

        // 2. Busca os dados de contato do proprietário (Baseado na imagem 6 e 7)
        const resOwner = await axios.get("https://api.apresenta.me/persons", {
            ...config,
            params: { "include[contacts]": "*", "filter[id]": ownerId }
        });
        
        const dono = resOwner.data?.data?.[0];
        if (!dono || !dono.contacts) return null;

        // Procura um telefone celular válido nos contatos
        const contatoCelular = dono.contacts.find(c => c.value && c.value.replace(/\D/g, '').length >= 10);
        if (!contatoCelular) return null;

        return {
            idDono: ownerId,
            nome: dono.name || "Proprietário",
            telefone: contatoCelular.value.replace(/\D/g, '') // Apenas números
        };
    } catch (error) {
        console.error(`Erro ao buscar contato do proprietário do imóvel ${id_imovel}:`, error.message);
        return null;
    }
}
// NOVO: Função para obter a URL de download do áudio no WhatsApp
async function obterUrlMedia(mediaId) {
    const url = `https://graph.facebook.com/v25.0/${mediaId}/`;
    const response = await axios.get(url, { headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` } });
    return response.data.url;
}

// NOVO: Função para baixar o áudio e enviar para a OpenAI
async function transcreverAudio(mediaId) {
    try {
        const mediaUrl = await obterUrlMedia(mediaId);
        
        // Baixa o áudio do WhatsApp
        const audioResponse = await axios.get(mediaUrl, { 
            headers: { 'Authorization': `Bearer ${process.env.WHATSAPP_TOKEN}` }, 
            responseType: 'stream' 
        });

        // Salva temporariamente na pasta /tmp (padrão em hospedagens como Railway)
        const filePath = `/tmp/${mediaId}.ogg`;
        const writer = fs.createWriteStream(filePath);
        audioResponse.data.pipe(writer);

        await new Promise((resolve, reject) => {
            writer.on('finish', resolve);
            writer.on('error', reject);
        });

        // Prepara o formulário para enviar à OpenAI
        const form = new FormData();
        form.append('file', fs.createReadStream(filePath));
        form.append('model', 'whisper-1');

        // Envia para a API do Whisper
        const openaiResponse = await axios.post('https://api.openai.com/v1/audio/transcriptions', form, {
            headers: {
                ...form.getHeaders(),
                'Authorization': `Bearer ${process.env.OPENAI_API_KEY}`
            }
        });

        // Apaga o arquivo de áudio temporário para não lotar o servidor
        fs.unlinkSync(filePath);
        
        return openaiResponse.data.text;
    } catch (error) {
        console.error("Erro na transcrição de áudio:", error.message);
        return null;
    }
}

// --- CONTROLE DE DADOS ---
const FILE_PATH = '/app/dados/historico.json';
const LEADS_INDEX_PATH = '/app/dados/leads_index.json';
let historicos = {};
let leadsIndex = {};

function obterHistorico(sender) {
    if (!historicos[sender]) return [];
    
    // RETORNA APENAS 'role' E 'parts' PARA NÃO QUEBRAR A API DO GEMINI
    return historicos[sender].map(m => ({
        role: m.role,
        parts: Array.isArray(m.parts) ? m.parts : [{ text: m.text || "" }]
    }));
}

function salvarHistorico(sender, conversa) {
    // Puxa o histórico antigo da memória para não perder as datas das mensagens passadas
    const historicoAntigo = historicos[sender] || [];
    
    historicos[sender] = conversa.map((m, index) => { 
        const msgAntiga = historicoAntigo[index];
        return {
            role: m.role, 
            parts: m.parts,
            // Mantém a hora original se for uma mensagem antiga, ou cria uma nova se for mensagem nova
            timestamp: msgAntiga?.timestamp || new Date().toISOString() 
        };
    });
    fs.writeFileSync(FILE_PATH, JSON.stringify(historicos, null, 2));
}

function atualizarIndiceLeads(sender, nome, origem, statusCRM = false, id_imovel = null) {
    if (!leadsIndex[sender]) leadsIndex[sender] = { imoveisInteresse: [] };
    if (!leadsIndex[sender].imoveisInteresse) leadsIndex[sender].imoveisInteresse = [];
    
    if (id_imovel && !leadsIndex[sender].imoveisInteresse.includes(id_imovel)) {
        leadsIndex[sender].imoveisInteresse.push(id_imovel);
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
// --- NOVO: FUNÇÃO CENTRALIZADA DE ENVIO PARA O CRM COM UPLOAD DE ARQUIVOS ---
async function enviarLeadParaCRM(sender, contexto, idsImoveis = []) {
    const lead = leadsIndex[sender];
    if (!lead) return;

    // 1. Converte a intenção para os padrões do CRM (sale ou rent)
    let purposeStr = "sale"; 
    if (contexto.purpose) {
        purposeStr = contexto.purpose; 
    } else if (contexto.interesse && (contexto.interesse.toLowerCase().includes('loca') || contexto.interesse.toLowerCase().includes('aluguel'))) {
        purposeStr = "rent";
    }

    // 2. Lógica Inteligente de Imóveis
    let id_imovel = null;
    let notasAdicionais = "";

    if (idsImoveis && idsImoveis.length > 0) {
        id_imovel = idsImoveis[0]; 
        if (idsImoveis.length > 1) {
            notasAdicionais = `\n\n⚠️ ATENÇÃO CORRETOR: O cliente também tem interesse em visitar os imóveis IDs: ${idsImoveis.join(', ')}`;
        }
    } else if (lead.imoveisInteresse && lead.imoveisInteresse.length > 0) {
        id_imovel = lead.imoveisInteresse[lead.imoveisInteresse.length - 1]; 
    }

    // 3. Traduz a origem atual do lead
    const codigoOrigem = parseInt(ORIGENS[lead.origem] || ORIGENS["whatsapp_direto"]);
    let alertaSeguro = "";
    if (lead.dadosSeguro) {
        alertaSeguro = `\n\n🛡️ [SEGURO FIANÇA PRÉ-COTADO] 🛡️\nO cliente já forneceu os dados para o seguro (CPF: ${lead.dadosSeguro.cpf}). Status da API Sigafy: ${lead.dadosSeguro.status}. Confira os valores e use como argumento de venda!\n`;
    }

    // 4. Monta o Payload principal
    const payload = {
        name: contexto.nome || lead.nome || "Cliente",
        email: contexto.email || lead.email || null,
        phone: sender.replace(/\D/g, ''), 
        purpose: purposeStr,
        origin_id: codigoOrigem,
        origin: lead.origem || "WhatsApp",
        message: contexto.mensagem || "Atendimento inicial realizado pela Sheila (IA).",
        notes: (contexto.observacoes || "") + notasAdicionais + alertaSeguro 
    };

    if (id_imovel) {
        payload.building_id = parseInt(id_imovel);
    }

    try {
        const url = "https://api.apresenta.me/persons/leads";
        const config = {
            headers: {
                "Authorization": `Bearer ${process.env.CRM_API_TOKEN}`,
                "Content-Type": "application/json",
                "Accept": "application/json"
            }
        };

        // --- ETAPA A: CRIA O LEAD NO CRM ---
        const response = await axios.post(url, payload, config);
        console.log(`LOG_DEBUG: Lead criado no CRM com sucesso! Origem: ${codigoOrigem}, Building_ID: ${id_imovel || 'Nenhum'}`);
        
        // Captura o ID gerado pelo CRM (A maioria das APIs retorna em response.data.id ou response.data.data.id)
        const leadIdGerado = response.data?.id || response.data?.data?.id;

       // --- ETAPA B: UPLOAD DOS PDFS DA SIGAFY NO LEAD CRIADO ---
        if (leadIdGerado && lead.dadosSeguro && lead.dadosSeguro.detalhes) {
            const detalhes = lead.dadosSeguro.detalhes;
            let filesArray = [];

            // Verifica se a estrutura nova da Sigafy (data.base64 array) existe
            if (detalhes.data && Array.isArray(detalhes.data.base64)) {
                // Itera sobre todos os arquivos base64 retornados
                detalhes.data.base64.forEach((arquivoBase64, index) => {
                    // O log mostra que vem apenas a string pura, mas mantemos o replace por segurança 
                    // caso a API passe a enviar o prefixo mime-type no futuro
                    const binaryData = arquivoBase64.replace(/^data:application\/pdf;base64,/, "");
                    
                    filesArray.push({
                        name: `Cotacao_Sigafy_${index + 1}.pdf`, // Gera nomes automáticos (Ex: Cotacao_Sigafy_1.pdf)
                        binary: binaryData
                    });
                });
            } else {
                console.log("LOG_DEBUG: A estrutura do base64 da Sigafy mudou ou não foi encontrada.", JSON.stringify(detalhes));
            }

            // Se encontrou os arquivos, faz o envio usando o payload do CRM
            if (filesArray.length > 0) {
                console.log(`LOG_DEBUG: Enviando ${filesArray.length} arquivo(s) Sigafy para o Lead ID ${leadIdGerado}...`);
                const payloadArquivos = {
                    id: leadIdGerado,
                    files: filesArray
                };
                
                try {
                    await axios.post(url, payloadArquivos, config);
                    console.log(`✅ PDFs da Sigafy anexados com sucesso ao CRM!`);
                } catch (errUpload) {
                    console.error("❌ Erro ao fazer upload do PDF no CRM:", errUpload.response?.data || errUpload.message);
                }
            }
        }

        // --- ETAPA C: ATUALIZA A MEMÓRIA ---
        lead.enviadoParaCRM = true;
        if (contexto.nome) lead.nome = contexto.nome;
        atualizarIndiceLeads(sender, lead.nome, lead.origem);
    } catch (error) {
        console.error("ERRO ao enviar para o CRM via API:", error.response?.data || error.message);
    }
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
        return txt && 
               !txt.includes("DADOS TÉCNICOS PARA CONSULTA") && 
               !txt.includes("INFORMAÇÃO INTERNA DA SHEILA") && 
               !txt.includes("CONSULTA DE IMÓVEL") && 
               !txt.includes("O nome deste cliente é");
    });

    let html = `<html><head><meta name="viewport" content="width=device-width, initial-scale=1.0">
    <style>body{font-family:sans-serif;background:#e5ddd5;margin:0;padding:0;}.header{background:#fff;padding:20px;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.1);}.header img{width:80px;height:auto;margin-bottom:10px;}.lead-info{background:#fff;padding:15px;text-align:center;margin-bottom:10px;}.msg{padding:10px 15px;margin:5px 10px;border-radius:8px;max-width:85%;position:relative;font-size:14px;word-wrap:break-word;}.user{background:#dcf8c6;margin-left:auto;text-align:right;}.model{background:#ffffff;margin-right:auto;}.time{font-size:10px;color:#999;margin-top:5px;display:block;}</style></head><body>
    <div class="header"><img src="https://img.apre.me/M7UtVktPLcjSy00sSk8sKc7LVMhPz8-RL07NyUyzzVSztDQwtU0GAA.jpeg" alt="Logo"><div style="font-weight:bold; color:#333;">Atendido pela Sheila</div></div>
    <div class="lead-info"><strong>Cliente:</strong> ${nomeLead}<br><small>${sender}</small><br><a href="https://wa.me/${sender}" style="color:#075e54;">Enviar WhatsApp</a></div>
    ${mensagensFiltradas.map(m => {
        const text = m.parts && m.parts[0] ? m.parts[0].text : (m.text || "");
        
        // CORREÇÃO DA DATA: Usa a hora salva. Se for uma mensagem antiga (sem data), usa a atual como fallback para não quebrar.
        const dataMsg = m.timestamp ? new Date(m.timestamp) : new Date();
        const timeString = dataMsg.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', hour: '2-digit', minute: '2-digit', day: '2-digit', month: '2-digit'});

        return `<div class="msg ${m.role}">${text}<span class="time">${timeString}</span></div>`;
    }).join('')}</body></html>`;

    res.send(html);
});

// --- ROTA DE DIAGNÓSTICO VISUAL DO CRM ---
app.get('/debug-imovel/:id_imovel', async (req, res) => {
    if (req.query.token !== process.env.CHAT_ACCESS_TOKEN) return res.status(403).send("Acesso negado.");
    
    const { id_imovel } = req.params;
    
    try {
        const config = { headers: { "Authorization": `Bearer ${process.env.CRM_API_TOKEN}`, "Accept": "application/json" } };
        
        // 1. Tenta buscar o imóvel
        const resImovel = await axios.get("https://api.apresenta.me/buildings", {
            ...config,
            params: { "include[owners]": "*", "filter[id]": id_imovel }
        });
        
        const imovelEncontrado = resImovel.data?.data?.[0];
        const ownerId = imovelEncontrado?.owners?.[0]?.id;
        
        if (!ownerId) {
            return res.json({
                status: "FALHA",
                motivo: "O imóvel foi encontrado, mas NÃO possui nenhum 'ownerId' (proprietário) vinculado a ele no CRM.",
                respostaBrutaImovel: imovelEncontrado
            });
        }

        // 2. Tenta buscar o proprietário
        const resOwner = await axios.get("https://api.apresenta.me/persons", {
            ...config,
            params: { "include[contacts]": "*", "filter[id]": ownerId }
        });
        
        const proprietarioEncontrado = resOwner.data?.data?.[0];

        // Retorna tudo limpo na tela do navegador
        res.json({
            status: "SUCESSO",
            ownerIdDetectado: ownerId,
            imovel: imovelEncontrado,
            proprietarioNoCRM: proprietarioEncontrado
        });

    } catch (error) {
        res.status(500).json({
            status: "ERRO_API",
            detalhe: error.response?.data || error.message
        });
    }
});
// Adicione isso nas suas rotas do Express
app.post('/disparar-atualizacao-imovel/:id_imovel', async (req, res) => {
    if (req.query.token !== process.env.CHAT_ACCESS_TOKEN) return res.status(403).send("Acesso negado.");
    
    const { id_imovel } = req.params;
    const imovelXML = cacheImoveis.find(i => String(i.ListingID) === String(id_imovel));
    if (!imovelXML) return res.status(404).send("Imóvel não encontrado no XML.");

    // CORRIGIDO: Chamando o nome exato da função: buscarProprietarioNoCRM
    const resultadoDono = await buscarProprietarioNoCRM(id_imovel);
    
    if (!resultadoDono) {
        return res.status(404).send("Contato do proprietário não encontrado no CRM (Retornou nulo).");
    }

    const dadosDono = resultadoDono;
    
    // Validação de segurança para garantir que o telefone veio limpo e com tamanho válido
    if (!dadosDono.telefone || dadosDono.telefone.length < 10) {
        return res.status(400).send(`Proprietário ${dadosDono.nome} encontrado, mas o telefone é inválido ou está vazio: "${dadosDono.telefone}"`);
    }

    const sender = `55${dadosDono.telefone}`; 
    const endereco = obterEnderecoSeguro(imovelXML);
    const precos = obterPrecosFormatados(imovelXML);
    
    const valorNumerico = precos.pVenda > 0 ? precos.pVenda : precos.pLocacao;
    const tipoNegocioTexto = precos.pVenda > 0 ? "venda" : "locação";
    const tipoNegocioCRM = precos.pVenda > 0 ? "sale" : "rent";

    if (!leadsIndex[sender]) leadsIndex[sender] = {};
    leadsIndex[sender].isProprietario = true;
    fs.promises.writeFile(LEADS_INDEX_PATH, JSON.stringify(leadsIndex, null, 2)).catch(console.error);

    let conversa = obterHistorico(sender);
    
    await enviarTemplateAtualizacaoImovel(sender, dadosDono.nome, endereco, tipoNegocioTexto);
    
    const textoTemplateEnviado = `Olá ${dadosDono.nome}!\nEu sou a Sheila da Siciliano Imóveis.\nEstamos entrando em contato para atualizar o seu imóvel em ${endereco}.\nContinua disponível para ${tipoNegocioTexto}?`;
    conversa.push({ "role": "model", "parts": [{ "text": textoTemplateEnviado }] });
    
    const contextoOculto = `INFORMAÇÃO INTERNA: O cliente a seguir é o PROPRIETÁRIO do imóvel ID ${id_imovel}. O imóvel está cadastrado para ${tipoNegocioTexto} (tipo_negocio: '${tipoNegocioCRM}') pelo valor atual de R$${valorNumerico}. Você acabou de disparar a mensagem acima. Aja naturalmente a partir da resposta dele. Seu objetivo é descobrir se o imóvel continua disponível e confirmar qual é o valor atual (amount) para atualização sistêmica.`;
    conversa.push({ "role": "user", "parts": [{ "text": contextoOculto }] });
    
    salvarHistorico(sender, conversa);

    res.status(200).send(`Template de atualização disparado para ${dadosDono.nome} (${sender})`);
});
app.post('/disparar-reengajamento', async (req, res) => {
    const tokenFornecido = req.query.token;
    
    // Validação básica de segurança
    if (tokenFornecido !== "SEU_TOKEN_AQUI") {
        return res.status(403).send("Não autorizado");
    }

    // Chama a função pesada sem colocar 'await' aqui.
    // Assim, a API responde rápido para a interface (evitando erro de timeout), 
    // enquanto o loop de 4 a 8 minutos continua rodando silenciosamente no servidor.
    dispararReengajamentoManual(); 

    res.status(200).send("Disparo em lote iniciado no servidor.");
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

    // NOVO: Processamento central de Mensagens (Texto ou Áudio)
    let textoCliente = msgData.text?.body;
    
    if (msgData.type === 'audio' && msgData.audio?.id) {
        console.log("LOG_DEBUG: Áudio recebido, iniciando transcrição...");
        const transcricao = await transcreverAudio(msgData.audio.id);
        
        if (transcricao) {
            textoCliente = transcricao;
            console.log(`LOG_DEBUG: Áudio transcrito: "${transcricao}"`);
        } else {
            await enviarMensagem(sender, "Recebi seu áudio, mas infelizmente não consegui compreender direito. Você poderia escrever para mim?");
            return res.sendStatus(200);
        }
    }

   // Se não for nem texto nem áudio, ou se estiver vazio, encerra a requisição
    if (!textoCliente) return res.sendStatus(200);

    const conversa = obterHistorico(sender);
    const referral = msgData?.referral?.source_url;

    // RESTAURADO: O bloco try, a URL do Gemini e a injeção da mensagem do cliente!
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-3.1-flash-lite:generateContent?key=${process.env.GEMINI_API_KEY}`;
        conversa.push({ "role": "user", "parts": [{ "text": textoCliente }] });

        // --- CORREÇÃO DE CONTEXTO: CORTA O FUNIL SE FOR PROPRIETÁRIO ---
        let promptDinamico = process.env.SYSTEM_PROMPT || "Você é a Sheila, corretora da Siciliano Imóveis.";
        
        if (leadsIndex[sender]?.isProprietario) {
            promptDinamico += "\n\n[DIRETRIZ DE EXCEÇÃO TEMPORÁRIA]: O cliente atual é o PROPRIETÁRIO do imóvel que estamos atualizando. IGNORE TOTALMENTE o seu funil de vendas e locação (Passos 1, 2 e 3). Seu ÚNICO objetivo é confirmar se o imóvel continua disponível e qual é o valor atual. Quando ele confirmar, NÃO faça mais perguntas e chame IMEDIATAMENTE a função 'atualizar_status_imovel_crm'.";
        }

        const payloadInicial = {
            "systemInstruction": { "parts": [{ "text": promptDinamico }] },
            "contents": conversa,
            "tools": [{ "functionDeclarations": [
{ 
            "name": "atualizar_status_imovel_crm", 
            "description": "Use APENAS quando estiver falando com um PROPRIETÁRIO e ele confirmar a situação atual do imóvel e o valor. Esta função altera o status e o valor no sistema.", 
            "parameters": { 
                "type": "object", 
                "properties": { 
                    "id_imovel": { "type": "string", "description": "O ID do imóvel." },
                    "tipo_negocio": { "type": "string", "description": "O tipo de negócio atual (retorne EXATAMENTE 'sale' ou 'rent' de acordo com o contexto oculto)." },
                    "valor_atualizado": { "type": "number", "description": "O valor atualizado informado pelo proprietário (apenas números). Se ele disser que NÃO mudou, retorne o valor que você tem no contexto." },
                    "lock": { 
                        "type": "string", 
                        "description": "O motivo da situação. Valores permitidos: 'free' (continua disponível), 'rented', 'rented_by_other', 'rented_available', 'available_to_sale', 'sold', 'sold_by_other', 'suspended', 'expired', 'awaiting_approval', 'inactive_on_site', 'only_portals', 'reserved', 'awaiting_proposal'."
                    },
                    "status": { 
                        "type": "string", 
                        "description": "A situação geral do imóvel. Valores permitidos: 'active', 'inactive', 'filed' ou 'rented'."
                    }
                }, 
                "required": ["id_imovel", "tipo_negocio", "valor_atualizado", "lock", "status"] 
            } 
        },
        { 
            "name": "registrar_reclamacao", 
            "description": "Use IMEDIATAMENTE se o cliente reclamar de mau atendimento, relatar um problema grave (ex: falso corretor) ou cobrar um retorno que não foi dado.", 
            "parameters": { 
                "type": "object", 
                "properties": { 
                    "motivo": { "type": "string", "description": "Resumo do problema relatado pelo cliente." } 
                }, 
                "required": ["motivo"] 
            } 
        },
       { 
            "name": "registrar_nome", 
            "description": "Use para registrar o nome do cliente. ATENÇÃO: É PROIBIDO usar esta função durante o Passo 3 (Seguro Fiança). Se o cliente quiser alugar/visitar, foque em pedir todos os dados da cotação e use apenas gerar_cotacao_seguro.", 
            "parameters": { 
                "type": "object", 
                "properties": { "nome": { "type": "string" } }, 
                "required": ["nome"] 
            } 
        },
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
            "description": "Busca imóveis com filtros detalhados de intenção, cidade, bairro, tipo, orçamento e características.",
            "parameters": {
                "type": "object",
                "properties": {
                    "intencao": { "type": "string", "description": "A intenção do cliente: use exatamente 'compra' ou 'aluguel'." },
                    "tipo": { "type": "string", "description": "O tipo do imóvel: 'apartamento', 'loja', 'sala comercial', etc." },
                    "cidade": { 
                        "type": "string", 
                        "description": "A cidade de preferência. ATENÇÃO: NUNCA inclua o nome do bairro aqui. Se o cliente disser 'Centro de Niterói', envie apenas 'Niterói'." 
                    },
                    "bairro": { 
                        "type": "string", 
                        "description": "O bairro desejado. ATENÇÃO: Se o cliente disser 'Centro de Niterói', você DEVE preencher este campo com 'Centro'." 
                    },                 
                    "rua": { "type": "string", "description": "Nome da rua, avenida ou logradouro para filtrar os imóveis. Ex: 'Presidente Backer', 'Miguel de Frias'." },
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
            "name": "gerar_cotacao_seguro", 
            "description": "Chame APENAS QUANDO o cliente quiser alugar um imóvel E já tiver fornecido TODOS os dados obrigatórios: Nome, CPF, Data de Nascimento, E-mail e Celular. IMPORTANTE: Quando for pedir os dados que faltam, faça isso de forma natural, amigável e coloque os itens em uma pequena lista (bullet points) para facilitar a leitura do cliente.", 
            "parameters": {  
                "type": "object", 
                "properties": { 
                    "nome": { "type": "string", "description": "Nome completo do cliente" }, 
                    "cpf": { "type": "string", "description": "CPF do cliente (apenas números)" },
                    "dataNascimento": { "type": "string", "description": "Data de nascimento (DD/MM/AAAA)" },
                    "email": { "type": "string", "description": "E-mail do cliente" },
                    "celular": { "type": "string", "description": "Celular do pretendente com DDD. Pergunte ao cliente caso não tenha sido informado no texto." },
                    "id_imovel": { "type": "string", "description": "O ID (referência) do imóvel que ele quer alugar." }
                }, 
                "required": ["nome", "cpf", "dataNascimento", "email", "celular", "id_imovel"] 
            } 
        },

        { 
            "name": "qualificar_lead", 
            "description": "Chame ao perceber interesse claro em visita ou falar com corretor. Sempre extraia o nome do cliente da conversa.", 
            "parameters": { 
                "type": "object", 
                "properties": { 
                    "interesse": { "type": "string" }, 
                    "nome": { "type": "string" },
                    "ids_imoveis": {
                        "type": "array",
                        "items": { "type": "string" },
                        "description": "Lista com os códigos (IDs) dos imóveis que o cliente deseja visitar ou demonstrou interesse na conversa atual."
                    }
                }, 
                "required": ["interesse", "nome"] 
            } 
        }
    ]}] // <-- ESSAS SÃO AS CHAVES QUE FALTAVAM AQUI!
}; // <-- E O PONTO E VÍRGULA FECHANDO O PAYLOAD AQUI!

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
                // Extraindo todos os parâmetros enviados pela Sheila, incluindo tipo_negocio e valor_atualizado
                const { id_imovel, lock, status, valor_atualizado, tipo_negocio } = functionCall.args;
                
                console.log(`LOG_DEBUG: Sheila solicitou atualização do Imóvel ${id_imovel} | Status: ${status} | Lock: ${lock} | Valor: ${valor_atualizado} | Tipo: ${tipo_negocio}`);

                // Rota de alteração do CRM 
                const urlUpdate = `https://api.apresenta.me/buildings/${id_imovel}`; 
                
                // Montando o payload EXATAMENTE como a documentação da Apresenta.me exige (com o array purposes)
                const payloadUpdate = {
                    lock: lock,
                    status: status,
                    purposes: [
                        {
                            purpose: tipo_negocio, // 'sale' ou 'rent'
                            amount: valor_atualizado,
                            amount_max: valor_atualizado 
                        }
                    ]
                };

                try {
                    // Executa o PUT de alteração no CRM
                    await axios.put(urlUpdate, payloadUpdate, {
                        headers: {
                            "Authorization": `Bearer ${process.env.CRM_API_TOKEN}`,
                            "Content-Type": "application/json",
                            "Accept": "application/json"
                        }
                    });

                    console.log(`✅ Imóvel ${id_imovel} atualizado no CRM com sucesso!`);
                    
                    // Remove a tag de atualização do proprietário para encerrar o ciclo
                    if (leadsIndex[sender]) {
                        leadsIndex[sender].isProprietario = false;
                        fs.promises.writeFile(LEADS_INDEX_PATH, JSON.stringify(leadsIndex, null, 2)).catch(console.error);
                    }

                    // Avisa a Sheila que deu certo para ela se despedir
                    conversa.push({ "role": "user", "parts": [{ "text": `INFORMAÇÃO INTERNA: O sistema foi atualizado com sucesso (Status: ${status}). Agradeça ao proprietário pela atenção e encerre o atendimento educadamente.` }] });

                } catch (errorUpdate) {
                    console.error("❌ Erro ao atualizar imóvel no CRM:", errorUpdate.response?.data || errorUpdate.message);
                    conversa.push({ "role": "user", "parts": [{ "text": `INFORMAÇÃO INTERNA: Houve uma falha sistêmica ao tentar salvar. Agradeça ao cliente pela informação e diga que seus dados já foram anotados.` }] });
                }

                // Pede para a Sheila gerar a resposta final com base no sucesso/falha acima
                // Caso a variável promptDinamico exista no escopo, ela será usada, senão usa o padrão.
                const promptFinal = typeof promptDinamico !== 'undefined' ? promptDinamico : process.env.SYSTEM_PROMPT;
                
                const respFinal = await axios.post(url, { "systemInstruction": { "parts": [{ "text": promptFinal }] }, "contents": conversa });
                const texto = respFinal.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                
                if (texto) {
                    await enviarMensagem(sender, texto);
                    conversa.push({ "role": "model", "parts": [{ "text": texto }] });
                    salvarHistorico(sender, conversa);
                }
            }
                else if (functionCall.name === "gerar_cotacao_seguro") {
                const dadosCliente = functionCall.args;
                
                                // --- PROTEÇÃO CONTRA A IA APRESSADA ---
                if (!dadosCliente.cpf || dadosCliente.cpf.trim() === "" || 
                    !dadosCliente.nome || dadosCliente.nome.trim() === "" ||
                    !dadosCliente.celular || dadosCliente.celular.trim() === "") {
                    
                    console.log("LOG_DEBUG: A Sheila tentou chamar o seguro sem dados completos. Bloqueando...");
                    
                    const aviso = "INFORMAÇÃO INTERNA DA SHEILA: Você tentou gerar a cotação de seguro, mas o cliente AINDA NÃO FORNECEU todos os dados (CPF, Nome, Data de Nascimento, E-mail e Celular). Peça os dados que faltam de forma muito educada e coloque-os em formato de lista (um embaixo do outro) para o cliente entender facilmente.";

                    
                    conversa.push({ "role": "user", "parts": [{ "text": aviso }] });
                    const respCorrecao = await axios.post(url, { "systemInstruction": { "parts": [{ "text": process.env.SYSTEM_PROMPT }] }, "contents": conversa });
                    const textoCorrecao = respCorrecao.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                    
                    if (textoCorrecao) {
                        await enviarMensagem(sender, textoCorrecao);
                        conversa.push({ "role": "model", "parts": [{ "text": textoCorrecao }] });
                        salvarHistorico(sender, conversa);
                    }
                    return res.sendStatus(200); // Interrompe a falsa cotação aqui!
                }
                // --------------------------------------

                // --------------------------------------
                
                // Acha o imóvel no cache para puxar dados
                const imovelCotado = cacheImoveis.find(i => String(i.ListingID) === String(dadosCliente.id_imovel));
                
                // --- NOVOS LOGS AQUI ---
                console.log(`\nLOG_DEBUG: Iniciando cotação Sigafy...`);
                console.log(`LOG_DEBUG: Dados enviados pela Sheila:`, JSON.stringify(dadosCliente, null, 2));
                
                // Dispara a API da Sigafy silenciosamente
                const resultadoCotacao = await solicitarCotacaoSigafy(dadosCliente, imovelCotado, sender);
                
                // --- LOG DA RESPOSTA DA API ---
                console.log(`LOG_DEBUG: Resposta recebida da Sigafy:`, JSON.stringify(resultadoCotacao, null, 2));
                console.log(`----------------------------------------\n`);

                // Salva a aprovação na memória do Lead para ir pro CRM depois
                if (!leadsIndex[sender]) atualizarIndiceLeads(sender, dadosCliente.nome);

                leadsIndex[sender].dadosSeguro = {
                    cpf: dadosCliente.cpf,
                    status: resultadoCotacao ? "Cotação Gerada" : "Falha na Cotação",
                    detalhes: resultadoCotacao // Guarda o JSON de resposta da Sigafy
                };
                fs.promises.writeFile(LEADS_INDEX_PATH, JSON.stringify(leadsIndex, null, 2)).catch(console.error);

                // --- INÍCIO DA CORREÇÃO: ENVIAR PARA O CRM ---
                const linkEspelho = `https://webhook-siciliano-production.up.railway.app/chat/${sender}?token=${process.env.CHAT_ACCESS_TOKEN}`;
                
                await enviarLeadParaCRM(sender, {
                    // Forçando o nome e email do cliente para não ir como "Cliente" genérico
                    nome: dadosCliente.nome,
                    name: dadosCliente.nome,
                    email: dadosCliente.email,
                    
                    // Forçando a finalidade Aluguel
                    purpose: "rent", 
                    interesse: "aluguel",
                    
                    mensagem: "Atendimento de locação iniciado pela Sheila",
                    observacoes: `Resumo: Lead quer alugar. Funil de seguro acionado.\nLink da conversa: ${linkEspelho}`
                }, [dadosCliente.id_imovel]);
                // --------------------------------------------------

                // Instrução que volta para a Sheila (AGORA COM A TAG CERTA PARA SUMIR DA TELA)
                let instrucao = "INFORMAÇÃO INTERNA DA SHEILA: A pré-análise foi concluída com sucesso no sistema. ";
                instrucao += "REGRA ESTRITA: NÃO INFORME NENHUM VALOR DE SEGURO AO CLIENTE. ";
                instrucao += "Diga apenas, com muita empatia, que a pré-análise deu certo e que o corretor vai apresentar as melhores condições exclusivas durante a visita ou contato.";

                conversa.push({ "role": "user", "parts": [{ "text": instrucao }] });
                
                const respFinal = await axios.post(url, { "systemInstruction": { "parts": [{ "text": process.env.SYSTEM_PROMPT }] }, "contents": conversa });
                const texto = respFinal.data?.candidates?.[0]?.content?.parts?.[0]?.text;
                
                if (texto) {
                    await enviarMensagem(sender, texto);
                    conversa.push({ "role": "model", "parts": [{ "text": texto }] });
                    
                    // --- NOVO: DISPARO DO CONVITE DE AVALIAÇÃO ---
                    await new Promise(resolve => setTimeout(resolve, 1500)); // Pausa de digitação
                    
                    const msgAvaliacao = "Ah, e se estiver satisfeito com o meu atendimento até aqui, te convido a deixar uma avaliação rápida no link abaixo. Ajuda muito o meu trabalho!\nhttps://search.google.com/local/writereview?placeid=ChIJ_w2xUXjfmwAR3DnuGUi-5hQ";
                    await enviarMensagem(sender, msgAvaliacao);
                    conversa.push({ "role": "model", "parts": [{ "text": msgAvaliacao }] });
                    // ----------------------------------------------
                    
                    salvarHistorico(sender, conversa);
                }
            }
                else if (functionCall.name === "registrar_nome") {
    const nomeDoCliente = functionCall.args.nome;
    
    // 1. Atualiza apenas o nome no seu banco de dados (não envia pro CRM)
    atualizarIndiceLeads(sender, nomeDoCliente);
    
    // 2. Avisa a Sheila que o nome foi salvo e pede para ela continuar o papo
    conversa.push({ "role": "user", "parts": [{ "text": `INFORMAÇÃO INTERNA DA SHEILA: O nome '${nomeDoCliente}' foi salvo no sistema. Agora responda com empatia e naturalmente ao que o cliente acabou de falar.` }] });
    
    const respFinal = await axios.post(url, { "systemInstruction": { "parts": [{ "text": process.env.SYSTEM_PROMPT }] }, "contents": conversa });
    const texto = respFinal.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    
    if (texto) {
        await enviarMensagem(sender, texto);
        conversa.push({ "role": "model", "parts": [{ "text": texto }] });
        salvarHistorico(sender, conversa);
    }
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
                const nomeDoCliente = functionCall.args.nome || "Cliente";
                const idsExtraidos = functionCall.args.ids_imoveis || []; // Puxa os IDs que a Sheila detectou
                
                const linkEspelho = `https://webhook-siciliano-production.up.railway.app/chat/${sender}?token=${process.env.CHAT_ACCESS_TOKEN}`;
                
                // Salva o nome
                atualizarIndiceLeads(sender, nomeDoCliente);
                
                // Dispara pro CRM passando a lista de IDs capturada!
                await enviarLeadParaCRM(sender, {
                    interesse: functionCall.args.interesse,
                    mensagem: "Atendimento realizado pela Sheila",
                    observacoes: `Resumo: ${functionCall.args.interesse}\nLink da conversa: ${linkEspelho}`
                }, idsExtraidos);

                const msg1 = "Perfeito, acabei de encaminhar seu interesse para nossa equipe de corretores! ✨";
                await enviarMensagem(sender, msg1);
                conversa.push({ "role": "model", "parts": [{ "text": msg1 }] });

                await new Promise(resolve => setTimeout(resolve, 1500));

                const msg2 = "Ah, e se estiver satisfeito com o meu atendimento até aqui, te convido a deixar uma avaliação rápida no link abaixo. Ajuda muito o meu trabalho!\nhttps://search.google.com/local/writereview?placeid=ChIJ_w2xUXjfmwAR3DnuGUi-5hQ";
                await enviarMensagem(sender, msg2);
                conversa.push({ "role": "model", "parts": [{ "text": msg2 }] });

                salvarHistorico(sender, conversa); 
            }
                else if (functionCall.name === "registrar_reclamacao") {
    const motivo = functionCall.args.motivo;
    
    // ATENÇÃO: Coloque o SEU número de WhatsApp aqui (com 55 e DDD, igual no sistema)
    const numeroGerencia = "5521985559544"; 

    // 1. Marca o lead com status de urgência no banco de dados
    if (!leadsIndex[sender]) atualizarIndiceLeads(sender, null);
    leadsIndex[sender].statusUrgente = true;
    fs.promises.writeFile(LEADS_INDEX_PATH, JSON.stringify(leadsIndex, null, 2)).catch(console.error);

    // 2. Dispara o alerta para o SEU WhatsApp
    const alerta = `🚨 *ALERTA DE RECLAMAÇÃO/COBRANÇA* 🚨\n\n*Cliente:* ${leadsIndex[sender]?.nome || sender}\n*Motivo:* ${motivo}\n*Acesse o chat:* https://webhook-siciliano-production.up.railway.app/chat/${sender}?token=${process.env.CHAT_ACCESS_TOKEN}`;
    await enviarMensagem(numeroGerencia, alerta);

    // 3. Pede para a Sheila acalmar o cliente
    conversa.push({ "role": "user", "parts": [{ "text": `INFORMAÇÃO INTERNA: O alerta foi enviado com sucesso para a diretoria da Siciliano. Agora, peça desculpas ao cliente de forma muito empática, avise que o caso acabou de ser escalado para a gerência e que entraremos em contato com urgência para resolver.` }] });
    
    const respFinal = await axios.post(url, { "systemInstruction": { "parts": [{ "text": process.env.SYSTEM_PROMPT }] }, "contents": conversa });
    const texto = respFinal.data?.candidates?.[0]?.content?.parts?.[0]?.text;
    
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
                    
                    let dados = `DADOS TÉCNICOS PARA CONSULTA INTERNA: ID ${imovel.ListingID}, Título: ${imovel.Title}, Venda: ${precos.venda}, Locação: ${precos.locacao}, Condomínio: ${precos.condominio}, IPTU: ${precos.iptu}, Endereço permitido (NÃO informe número/complemento): ${enderecoSeguro}, Quartos: ${v(imovel.Details?.Bedrooms)}, Suítes: ${v(imovel.Details?.Suites)}, Vagas: ${v(imovel.Details?.Garage)}, Extras: ${features}, Descrição: ${desc}. Link: ${imovel.DetailViewUrl}. Lembre-se: aja com naturalidade e empatia ao apresentar este imóvel.`;


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

               // Extraindo a 'cidade' também
                const { intencao, cidade, bairro, quartos, precoVendaMax, precoLocacaoMax, tipo, vaga, extras } = functionCall.args;
               console.log(`LOG_DEBUG: A Sheila está filtrando -> Intenção: ${intencao} | Cidade: ${cidade} | Bairro: ${bairro} | Tipo: ${tipo}`); 
               const precoMax = precoVendaMax || precoLocacaoMax || 0;
                
                const nVagasPedido = parseInt(vaga);
                const buscaIntencao = normalize(intencao || "");
                const isVenda = buscaIntencao.includes("compra") || buscaIntencao.includes("venda") || buscaIntencao.includes("sale");
                const isLocacao = buscaIntencao.includes("aluguel") || buscaIntencao.includes("locacao") || buscaIntencao.includes("rent");
                
                const filtra = (i, modoExato) => {
                    const cidadeImovel = normalize(v(i.Location?.City)); // <--- Puxa a cidade do XML
                    const bairroImovel = normalize(v(i.Location?.Neighborhood));
                    const tipoImovelXML = normalize(v(i.Details?.PropertyType));
                    const transacaoXML = normalize(v(i.TransactionType));
                    const descricao = normalize(v(i.Details?.Description));
                    const pV = parseFloat(v(i.Details?.ListPrice)) || 0;
                    const pL = parseFloat(v(i.Details?.RentalPrice)) || 0;
                    const qteQuartos = parseInt(v(i.Details?.Bedrooms)) || 0;

                    const nIntencaoBusca = mapaTipos[normalize(intencao)] || normalize(intencao);
                    const nTipoBusca = mapaTipos[normalize(tipo)] || normalize(tipo);

                    // Filtros de Localização
                    const matchCidade = !cidade || cidadeImovel.includes(normalize(cidade)); // <--- Filtro de cidade
                    const matchBairro = !bairro || bairroImovel.includes(normalize(bairro));
                    
                    const matchIntencao = !intencao || (isVenda && transacaoXML.includes("sale")) || (isLocacao && transacaoXML.includes("rent"));
                    
                    // CORREÇÃO DO TIPO (Loja vs Sala Comercial)
                    let matchTipo = true;
                    if (tipo) {
                        if (mapaTipos[normalize(tipo)]) {
                            // Se mapeamos o tipo (ex: loja = commercial/loja), exige que o XML seja EXATAMENTE esse, ignorando o que tá escrito na descrição
                            matchTipo = tipoImovelXML.includes(nTipoBusca);
                        } else {
                            // Se for algo não mapeado, aí sim procura na descrição
                            matchTipo = tipoImovelXML.includes(nTipoBusca) || descricao.includes(normalize(tipo));
                        }
                    }
                    
                    let matchPreco = true;
                    if (precoMax > 0) {
                        if (isVenda) matchPreco = (pV > 0 && pV <= precoMax);
                        else if (isLocacao) matchPreco = (pL > 0 && pL <= precoMax);
                    }

                    const nVagasXML = parseInt(v(i.Details?.Garage)) || 0;
                    const matchVaga = isNaN(nVagasPedido) ? true : (modoExato ? (nVagasXML === nVagasPedido) : (nVagasXML >= nVagasPedido));
                    const matchQuartos = !quartos || (modoExato ? (qteQuartos === quartos) : (qteQuartos >= quartos));

                    const features = Array.isArray(i.Details?.Features?.Feature) 
                        ? i.Details.Features.Feature.map(f => normalize(f)).join(' ') 
                        : normalize(v(i.Details?.Features?.Feature));
                        
                    const matchExtras = !extras || extras.every(extra => descricao.includes(normalize(extra)) || features.includes(normalize(extra)));
                    
                    // Retorna incluindo matchCidade
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
// --- NOVA ROTA: WEBHOOK LEADS4SALES ---
app.post('/webhook-leads4sales', async (req, res) => {
    try {
        const data = req.body;
        console.log("LOG_DEBUG: Lead recebido do Leads4Sales:", JSON.stringify(data, null, 2));

        // 1. VALIDAÇÃO OBRIGATÓRIA
        if (!data.clientListingId) {
            console.log("LOG_DEBUG: Lead recebido sem clientListingId. Retornando erro 400.");
            // CORREÇÃO: Responder obrigatoriamente em formato JSON
            return res.status(400).json({ error: "clientListingId é obrigatório" });
        }

        // 2. CORREÇÃO PRINCIPAL DO ERRO: Responder com JSON válido para a plataforma deles!
        res.status(200).json({ status: "success", message: "Lead recebido com sucesso" });

        // 3. Extração dos dados
        const nome = data.name || 'Cliente';
        let celular = data.phoneNumber ? data.phoneNumber.replace(/\D/g, '') : "";
        const referenciaOriginal = String(data.clientListingId);
        const mensagemPortal = data.message || 'Gostaria de informações sobre este imóvel.';

        if (!celular) {
            console.log("LOG_DEBUG: Lead do Leads4Sales sem telefone. Abortando.");
            return;
        }

        // CORREÇÃO: Forçar o código do Brasil (55) caso o Leads4Sales mande apenas "19991367388"
        if (!celular.startsWith("55")) {
            celular = `55${celular}`;
        }

        // 4. Inteligência de Link e Tratamento do ID composto (Ex: 5099_3307)
        let imovel = cacheImoveis.find(i => String(i.ListingID) === referenciaOriginal);
        
        // Se não achou pelo ID completo e ele tiver um "_" (ex: 5099_3307), tenta achar só pela segunda parte (3307)
        if (!imovel && referenciaOriginal.includes('_')) {
            const idLimpo = referenciaOriginal.split('_')[1]; 
            imovel = cacheImoveis.find(i => String(i.ListingID) === idLimpo);
        }

        const idDefinitivo = imovel ? imovel.ListingID : referenciaOriginal;
        const linkImovel = imovel ? imovel.DetailViewUrl : `https://sicilianoimoveis.com.br/imovel/${idDefinitivo}`;

        // 5. Atualiza o cadastro
        atualizarIndiceLeads(celular, nome, 'lead4sales', false, idDefinitivo);

        let conversa = obterHistorico(celular);
        
        // 6. Abordagem Ativa (se for lead novo)
        if (conversa.length === 0) {
            let contextoOculto = `DADOS TÉCNICOS PARA CONSULTA INTERNA DA SHEILA: Novo lead vindo do Leads4Sales.\nNome do cliente: ${nome}\nMensagem: "${mensagemPortal}"\nID do Imóvel: ${idDefinitivo}\n`;
            
            if (imovel) {
                const precos = obterPrecosFormatados(imovel);
                contextoOculto += `Dados do imóvel: Venda ${precos.venda}, Locação ${precos.locacao}, Endereço permitido: ${obterEnderecoSeguro(imovel)}.`;
            }

            conversa.push({ role: "user", parts: [{ text: contextoOculto }] });
            const textoTemplate = `Olá ${nome}, recebemos sua solicitação para o imóvel: ${linkImovel}.`;
            conversa.push({ role: "model", parts: [{ text: textoTemplate }] });
            
            salvarHistorico(celular, conversa);

            // Dispara o template via Meta
            await enviarTemplateLead(celular, nome, linkImovel);
            
            console.log(`LOG_DEBUG: Novo Lead Leads4Sales processado! Nome: ${nome} | Celular: ${celular} | Imóvel: ${idDefinitivo}`);
        }
    } catch (error) {
        console.error("ERRO ao processar webhook do Leads4Sales:", error.message);
        // CORREÇÃO: Falhas críticas internas também devem retornar JSON
        if (!res.headersSent) res.status(500).json({ error: "Erro interno no servidor" });
    }
});

// --- NOVA ROTA: WEBHOOK DO IMOVELWEB (CORRIGIDA) ---
app.post('/webhook-imovelweb', async (req, res) => {
    res.status(200).send('Webhook recebido com sucesso');

    try {
        const data = req.body;
        console.log("LOG_DEBUG: Body recebido do Imóvelweb:", JSON.stringify(data, null, 2));

        // 1. CORREÇÃO: O campo enviado é 'eventType' e não 'tipoEvento'
        if (data.eventType !== 'CONTACTO_MENSAJE' && data.eventType !== 'CONTACTO') {
            return;
        }

        // 2. CORREÇÃO: Mapeando corretamente os campos enviados pelo Imóvelweb
        const nome = data.name || 'Cliente';
        const telefoneBruto = data.phone || "";
        
        // O usuário confirmou que 'internalReference' é o código do imóvel no XML
        const referencia = data.internalReference || "";
        const mensagemPortal = data.message || 'Gostaria de informações sobre este imóvel.';

        if (!telefoneBruto) {
            console.log("LOG_DEBUG: Lead do Imovelweb recebido sem telefone. Abortando.");
            return;
        }

        // 3. Limpeza do Telefone
        const celular = telefoneBruto.replace(/\D/g, '');

        // 4. Inteligência de Link
        const imovel = cacheImoveis.find(i => String(i.ListingID) === String(referencia));
        const linkImovel = imovel ? imovel.DetailViewUrl : `https://sicilianoimoveis.com.br/imovel/${referencia}`;

        // 5. Atualiza o cadastro do Lead
        atualizarIndiceLeads(celular, nome, 'imovelweb', false, referencia);

        let conversa = obterHistorico(celular);
        
        // 6. Abordagem Ativa
        if (conversa.length === 0) {
            let contextoOculto = `DADOS TÉCNICOS PARA CONSULTA INTERNA DA SHEILA: Novo lead vindo do portal Imovelweb.\nNome do cliente: ${nome}\nMensagem que ele deixou no portal: "${mensagemPortal}"\nID do Imóvel: ${referencia}\n`;
            
            if (imovel) {
                const precos = obterPrecosFormatados(imovel);
                contextoOculto += `Dados do imóvel de interesse: Venda ${precos.venda}, Locação ${precos.locacao}, Endereço permitido: ${obterEnderecoSeguro(imovel)}.`;
            }

            conversa.push({ role: "user", parts: [{ text: contextoOculto }] });
            
            const textoTemplate = `Olá ${nome}, recebemos sua solicitação para o imóvel: ${linkImovel}.`;
            conversa.push({ role: "model", parts: [{ text: textoTemplate }] });
            
            salvarHistorico(celular, conversa);

            await enviarTemplateLead(celular, nome, linkImovel);
            
            console.log(`LOG_DEBUG: Novo Lead Imovelweb processado com sucesso! Nome: ${nome} | Imóvel: ${referencia}`);
        } else {
            console.log(`LOG_DEBUG: Lead Imovelweb (${celular}) já possui histórico.`);
        }

    } catch (error) {
        console.error("ERRO ao processar webhook do Imovelweb:", error.message);
    }
});

app.post('/webhook-lead', async (req, res) => {
    console.log("DADOS REAIS QUE CHEGARAM DO CRM:", JSON.stringify(req.body, null, 2));
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
            
            const contextoOculto = `DADOS TÉCNICOS PARA CONSULTA INTERNA DA SHEILA: O cliente ${name} quer informações deste imóvel. ID ${imovel.ListingID}, Venda: ${precos.venda}, Locação: ${precos.locacao}, Condomínio: ${precos.condominio}, IPTU: ${precos.iptu}, Endereço permitido (NÃO informe número/complemento, é proibido): ${enderecoSeguro}, Quartos: ${v(imovel.Details?.Bedrooms)}, Suítes: ${v(imovel.Details?.Suites)}, Vagas: ${v(imovel.Details?.Garage)}, Características Extras: ${features}, Descrição Completa: ${desc}. Lembre-se: aja estritamente de acordo com o seu SYSTEM PROMPT (sem usar listas, formato humanizado).`;
            
            conversa.push({ role: "user", parts: [{ text: contextoOculto }] });
        } else {
            conversa.push({ role: "user", parts: [{ text: `O nome deste cliente é ${name}. Ele se interessou no imóvel de ID ${building_id}, mas os dados não estão no cache.` }] });
        }

        conversa.push({ role: "model", parts: [{ text: `Olá ${name}, recebemos sua solicitação para o imóvel: ${link}.` }] });
        await enviarTemplateLead(celular, name, link);
        salvarHistorico(celular, conversa); 
        
        // NOVO: Usando o tradutor de origens que garante a normalização do texto
        const origemTraduzida = traduzirOrigem(origin_desc?.name);
        atualizarIndiceLeads(celular, name, origemTraduzida, false, building_id);
        
        res.status(200).send("Lead processado com contexto seguro injetado e origem formatada.");
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
        
        // Chamada atualizada com a função unificada
        await enviarLeadParaCRM(sender, {
            interesse: "venda", // Genérico para manual
            mensagem: "Envio manual via Central de Leads",
            observacoes: `Lead enviado manualmente.\nLink da conversa: ${linkEspelho}`
        });

        res.status(200).send("Lead enviado com sucesso via função central!");
    } catch (error) { res.status(500).send("Erro ao enviar para CRM."); }
});

// --- NOVA ROTA: LIMPAR STATUS DE URGÊNCIA ---
app.post('/remover-urgencia/:sender', async (req, res) => {
    const { sender } = req.params;
    
    // Proteção com o token
    if (req.query.token !== process.env.CHAT_ACCESS_TOKEN) {
        return res.status(403).send("Acesso negado.");
    }

    const lead = leadsIndex[sender];
    
    // Verifica se o lead existe e se realmente está com status urgente
    if (lead && lead.statusUrgente) {
        lead.statusUrgente = false; // Remove a urgência!
        
        try {
            await fs.promises.writeFile(LEADS_INDEX_PATH, JSON.stringify(leadsIndex, null, 2));
            return res.status(200).send("Status de urgência removido com sucesso.");
        } catch (error) {
            console.error("Erro ao salvar remoção de urgência:", error);
            return res.status(500).send("Erro ao salvar arquivo.");
        }
    }
    
    res.status(200).send("O lead não estava marcado como urgente.");
});

// --- MONITORAMENTO AUTOMÁTICO DE LEADS (RODA A CADA 30 MIN) ---
async function monitorarLeads() {
    const agora = new Date();
    
    for (const sender in leadsIndex) {
        const lead = leadsIndex[sender];
        
        // Travas de segurança essenciais
        if (lead.enviadoParaCRM) continue; 
        if (lead.status === 'aguardando_humano') continue; // Protege o cliente como o Nicolas
        if (!lead.ultimaInteracao) continue; // Evita falha se a data estiver vazia

        const diffHoras = (agora - new Date(lead.ultimaInteracao)) / (1000 * 60 * 60);

        // REGRA 1: Captação (2 horas)
        if (lead.categoria === 'captacao' && diffHoras >= 2) {
            await forcarEnvioCRM(sender, "Encaminhamento automático: Lead de captação não forneceu endereço em 2h.");
            continue;
        }

        // REGRA 2: Reengajamento Automático (24 horas)
        if (diffHoras >= 24 && !lead.reengajamento24hEnviado) {
            const nomeLead = leadsIndex[sender]?.nome || "cliente";
            
            // Aqui mantemos o envio antigo e a mensagem direto no histórico
            await enviarTemplateReengajamento(sender, nomeLead);
            
            const conversa = historicos[sender] || [];
            conversa.push({ "role": "model", "parts": [{ "text": `Oi ${nomeLead}! Notei que não tivemos retorno. Ainda tem interesse no imóvel ou precisa de ajuda com algo mais específico?` }] });
            salvarHistorico(sender, conversa);
            
            // Marca para não enviar mais a cobrança de 24h
            lead.ultimaInteracao = agora.toISOString(); 
            lead.reengajamento24hEnviado = true; 
            
            // Lembre-se de salvar o 'lead' atualizado no seu banco de dados aqui

fs.promises.writeFile(LEADS_INDEX_PATH, JSON.stringify(leadsIndex, null, 2)).catch(console.error);
        }
    }
}
// Roda a cada 30 minutos (1800000 ms)
setInterval(monitorarLeads, 1800000);

// --- DISPARO MANUAL PELA CENTRAL DE LEADS ---
// Rota ou função conectada ao botão no painel HTML
async function dispararReengajamentoManual() {
    console.log("Iniciando varredura para reengajamento manual...");
    let leadsParaReengajar = [];

    // --- ETAPA 1: SELECIONAR QUEM VAI RECEBER ---
    for (const sender in leadsIndex) {
        const lead = leadsIndex[sender];
        
        // Filtros (Ignora se já foi pro CRM, se espera corretor ou se já recebeu este disparo antes)
        if (lead.enviadoParaCRM) continue; 
        if (lead.status === 'aguardando_humano') continue;
        if (lead.reengajamentoManualEnviado) continue; 

        // Adiciona à lista de disparo apenas quem passou nos filtros
        leadsParaReengajar.push({ sender, lead });
    }

    console.log(`Encontrados ${leadsParaReengajar.length} leads aptos para o reengajamento manual.`);

    // --- ETAPA 2: DISPARAR COM PAUSAS DE 4 A 8 MINUTOS ---
    for (let i = 0; i < leadsParaReengajar.length; i++) {
        const { sender, lead } = leadsParaReengajar[i];
        const nomeLead = lead.nome || "cliente";

        try {
            // Usa o novo modelo criado na Meta
            await enviarTemplateMeta(sender, "rengajamento7", nomeLead); 

            // Trava para NUNCA MAIS receber este disparo manual
            lead.reengajamentoManualEnviado = true;
            
fs.promises.writeFile(LEADS_INDEX_PATH, JSON.stringify(leadsIndex, null, 2)).catch(console.error);
            // Lembre-se de salvar o 'lead' atualizado no seu banco de dados aqui
            
            console.log(`✅ [${new Date().toLocaleTimeString()}] rengajamento7 enviado para: ${nomeLead}`);

        } catch (erro) {
            console.error(`❌ Falha ao reengajar ${nomeLead}:`, erro.message);
        }

        // Aplica o intervalo de segurança (exceto no último lead da lista)
        if (i < leadsParaReengajar.length - 1) {
            const tempoDeEsperaMs = gerarAtrasoAleatorio(4, 8);
            const minutos = (tempoDeEsperaMs / 1000 / 60).toFixed(1);
            
            console.log(`⏳ Prevenção Meta: Aguardando ${minutos} minutos antes do próximo envio...`);
            await sleep(tempoDeEsperaMs);
        }
    }

    console.log("🏁 Lote manual de reengajamento finalizado com sucesso!");
}


async function forcarEnvioCRM(sender, obs) {
    const linkEspelho = `https://webhook-siciliano-production.up.railway.app/chat/${sender}?token=${process.env.CHAT_ACCESS_TOKEN}`;
    // Chamada atualizada com a função unificada
    await enviarLeadParaCRM(sender, {
        interesse: "venda", // Genérico de timeout
        mensagem: "Encaminhamento automático",
        observacoes: `Sheila: ${obs}\nLink da conversa: ${linkEspelho}`
    });
}

async function configurarWebhookImovelweb() {
    
}

async function assinarEventosImovelweb() {
   
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

(async () => {
    try {
        console.log("Iniciando configuração do Imóvelweb...");
        await configurarWebhookImovelweb();
        await assinarEventosImovelweb();
        console.log("Configuração finalizada!");
    } catch (error) {
        console.log("Erro na configuração:", error.message);
    }
})();
