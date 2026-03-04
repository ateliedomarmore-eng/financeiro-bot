import express from "express";
import axios from "axios";
import { createClient } from '@supabase/supabase-js';
import { GoogleGenerativeAI } from "@google/generative-ai";
import pkg from 'whatsapp-web.js';
import qrcode from 'qrcode-terminal';
import qrcodeimg from 'qrcode';
import dotenv from 'dotenv';
import fs from 'fs';

dotenv.config();

const { Client, LocalAuth } = pkg;

const app = express();
app.use(express.json());

// --- CONFIGURAÇÕES ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const sb = createClient(supabaseUrl, supabaseKey);

const TELEGRAM_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const T_URL = `https://api.telegram.org/bot${TELEGRAM_TOKEN}`;

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// --- LÓGICA COMPARTILHADA DA IA E SUPABASE ---
async function processarDespesa(origem, isPhoto, isVoice, isText, textContent, fileRaw, mimeType) {
    try {
        let prompt;
        let content;

        if (isPhoto) {
            prompt = "Analise este recibo e retorne APENAS um JSON no formato: {\"valor\": 0.00, \"descricao\": \"nome do item\", \"categoria\": \"Material ou Salário ou Mão de Obra ou Outros\"}. Se não encontrar o valor, retorne {\"erro\": true}.";
            content = [prompt, { inlineData: { data: Buffer.from(fileRaw).toString("base64"), mimeType: mimeType } }];
        } else if (isVoice) {
            prompt = "Ouça este áudio e extraia informações de gasto/despesa. Retorne APENAS um JSON no formato: {\"valor\": 0.00, \"descricao\": \"o que foi dito\", \"categoria\": \"Material ou Salário ou Mão de Obra ou Outros\"}. Se não encontrar valor ou não for uma despesa, retorne {\"erro\": true}.";
            content = [prompt, { inlineData: { data: Buffer.from(fileRaw).toString("base64"), mimeType: mimeType } }];
        } else {
            prompt = `Analise o seguinte texto e extraia informações de gasto/despesa: "${textContent}". Retorne APENAS um JSON no formato: {"valor": 0.00, "descricao": "o item", "categoria": "Material ou Salário ou Mão de Obra ou Outros"}. Se não for um gasto, retorne {"erro": true}.`;
            content = prompt;
        }

        const result = await model.generateContent(content);
        const responseText = result.response.text();
        const cleanedJson = responseText.replace(/```json|```/g, "").trim();
        const data = JSON.parse(cleanedJson);

        if (data.erro || !data.valor) {
            return { sucesso: false, erroNoReconhecimento: true, isText };
        }

        const descricaoOrigem = data.descricao || `Gasto via ${isPhoto ? 'Foto' : isVoice ? 'Áudio' : 'Texto'}`;

        // Salvar no Supabase
        const { error } = await sb.from('gastos').insert([{
            descricao: descricaoOrigem,
            valor: parseFloat(data.valor),
            categoria: data.categoria || "Outros"
        }]);

        if (error) throw error;

        return {
            sucesso: true,
            data: { ...data, descricao: descricaoOrigem },
            tipoOrigem: isPhoto ? "📸" : isVoice ? "🎙️" : "📝"
        };
    } catch (e) {
        console.error("Erro interno no processarDespesa:", e);
        return { sucesso: false, erroCritico: true };
    }
}

// ======================================
// TELEGRAM WEBHOOK
// ======================================
app.post("/webhook", async (req, res) => {
    const msg = req.body.message;
    if (!msg) return res.sendStatus(200);

    const chatId = msg.chat.id;
    const isPhoto = msg.photo && msg.photo.length > 0;
    const isVoice = msg.voice || msg.audio;
    const isText = msg.text && !msg.text.startsWith('/');

    if (!isPhoto && !isVoice && !isText) {
        return res.sendStatus(200);
    }

    try {
        let fileRaw = null;
        let mimeType = null;
        const textContent = msg.text;

        if (isPhoto) {
            const fileId = msg.photo[msg.photo.length - 1].file_id;
            mimeType = "image/jpeg";
            await axios.post(`${T_URL}/sendMessage`, { chat_id: chatId, text: "📸 Processando imagem do comprovante via Telegram..." });

            const fResponse = await axios.get(`${T_URL}/getFile?file_id=${fileId}`);
            const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fResponse.data.result.file_path}`;
            fileRaw = (await axios.get(fileUrl, { responseType: 'arraybuffer' })).data;
        } else if (isVoice) {
            const fileId = (msg.voice || msg.audio).file_id;
            mimeType = msg.voice ? "audio/ogg" : (msg.audio?.mime_type || "audio/mpeg");
            await axios.post(`${T_URL}/sendMessage`, { chat_id: chatId, text: "🎙️ Analisando seu áudio via Telegram..." });

            const fResponse = await axios.get(`${T_URL}/getFile?file_id=${fileId}`);
            const fileUrl = `https://api.telegram.org/file/bot${TELEGRAM_TOKEN}/${fResponse.data.result.file_path}`;
            fileRaw = (await axios.get(fileUrl, { responseType: 'arraybuffer' })).data;
        }

        const resultado = await processarDespesa('Telegram', isPhoto, isVoice, isText, textContent, fileRaw, mimeType);

        if (!resultado.sucesso) {
            if (resultado.erroNoReconhecimento && !resultado.isText) {
                await axios.post(`${T_URL}/sendMessage`, { chat_id: chatId, text: "❌ Não entendi o valor/despesa." });
            } else if (resultado.erroCritico) {
                await axios.post(`${T_URL}/sendMessage`, { chat_id: chatId, text: "⚠️ Tive uma falha no processamento. Tente novamente mais tarde." });
            }
            return res.sendStatus(200);
        }

        const txt = `✨ *Sincronizado com CRM Finanz!*\n\n${resultado.tipoOrigem} *Item:* ${resultado.data.descricao}\n💰 *Valor:* R$ ${resultado.data.valor.toFixed(2).replace('.', ',')}\n📂 *Cat:* ${resultado.data.categoria}\n\n🤖 _Via Telegram_`;
        await axios.post(`${T_URL}/sendMessage`, { chat_id: chatId, text: txt, parse_mode: 'Markdown' });
        console.log(`✅ Telegram: R$ ${resultado.data.valor}`);

    } catch (e) {
        console.error("Erro no Webhook Telegram:", e);
    }
    res.sendStatus(200);
});

// ======================================
// WHATSAPP BOT
// ======================================
const wappClient = new Client({
    authStrategy: new LocalAuth(),
    puppeteer: {
        args: ['--no-sandbox', '--disable-setuid-sandbox']
    }
});

wappClient.on('qr', (qr) => {
    console.log('\n\n📌 Escaneie este QR Code no seu WhatsApp (Aparelhos Conectados):');
    qrcode.generate(qr, { small: true });

    // Salvar também como PNG para visualização na interface do assistente
    qrcodeimg.toFile('./qr.png', qr, {
        color: { dark: '#000000', light: '#FFFFFF' }
    });
    console.log('✅ Imagem do QR Code gerada.\n\n');
});

wappClient.on('ready', () => {
    console.log('✅ Bot do WhatsApp conectado com sucesso!');
});

wappClient.on('message', async msg => {
    // Evita processar status/stories ou mensagens não normais
    if (msg.from === 'status@broadcast') return;

    try {
        const isPhoto = msg.hasMedia && (msg.type === 'image');
        const isVoice = msg.hasMedia && (msg.type === 'ptt' || msg.type === 'audio');
        const isText = (msg.type === 'chat');

        if (!isPhoto && !isVoice && !isText) return;

        let fileRaw = null;
        let mimeType = null;
        let textContent = msg.body;

        if (isPhoto || isVoice) {
            const media = await msg.downloadMedia();
            if (!media) return;

            fileRaw = Buffer.from(media.data, 'base64');
            mimeType = media.mimetype;

            msg.reply(isPhoto ? "📸 Processando imagem do comprovante..." : "🎙️ Analisando seu áudio...");
        }

        const resultado = await processarDespesa('WhatsApp', isPhoto, isVoice, isText, textContent, fileRaw, mimeType);

        if (!resultado.sucesso) {
            if (resultado.erroNoReconhecimento && !resultado.isText) {
                msg.reply("❌ Não consegui identificar valores/despesas.");
            } else if (resultado.erroCritico) {
                msg.reply("⚠️ Tive uma falha no processamento. Tente novamente mais tarde.");
            }
            return;
        }

        const txt = `✨ *CRM Finanz Atualizado!*\n\n${resultado.tipoOrigem} *Item:* ${resultado.data.descricao}\n💰 *Valor:* R$ ${resultado.data.valor.toFixed(2).replace('.', ',')}\n📂 *Cat:* ${resultado.data.categoria}\n\n🤖 _Via WhatsApp_`;
        msg.reply(txt);
        console.log(`✅ WhatsApp: R$ ${resultado.data.valor}`);

    } catch (e) {
        console.error("Erro processamento Whatsapp:", e);
    }
});

wappClient.initialize();

// ======================================
// INICIALIZAÇÃO SERVIDOR
// ======================================
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Servidor Multiplataforma (Telegram + WhatsApp) rodando na porta ${PORT}!`);
});
