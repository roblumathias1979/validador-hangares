#!/usr/bin/env node
// Uso: node scripts/ocr-ticket.js <caminhoImagem>
// Lê a foto de um ticket do estacionamento (#1Park, aeroporto de Jundiaí) e
// extrai o número do ticket (12 dígitos) e a data/hora de emissão, usando a
// API da Anthropic (Claude) com visão. CONFIRMADO pelo usuário (12/09/2026):
// testou 4 fotos reais direto no app do Claude e a leitura saiu perfeita —
// esse script automatiza exatamente esse mesmo teste.
//
// Pensado para rodar ANTES de "Identificar Hangar" no workflow do n8n,
// assim que a foto chegar do WhatsApp de verdade (ainda placeholder — ver
// nó "Nota - OCR pendente" em n8n/workflows/validador-tickets.json). Por
// enquanto recebe um caminho de arquivo local; quando a integração real de
// WhatsApp existir, ela precisa baixar a mídia da mensagem para um arquivo
// e passar o caminho aqui.
//
// Se a confiança for baixa (rasura, foto tremida, ticket de outro sistema),
// NÃO inventa um número — devolve status pedindo reenvio da foto, como já
// previsto na nota do workflow.
const fs = require('fs');
const https = require('https');
const path = require('path');

const MODELO = 'claude-sonnet-5';

const REGEX_TICKET = /^\d{12}$/;

const TIPOS_MIME = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

const PROMPT = `Esta é a foto de um ticket de estacionamento do sistema #1Park (aeroporto de Jundiaí/SBJD). O ticket tem um número de 12 dígitos (rotulado "Ticket" ou "Seq") e uma data/hora de emissão (rotulada "Data/Hora", no formato DD/MM/AA HH:MM:SS).

Responda APENAS com um JSON (sem markdown, sem texto antes ou depois) neste formato exato:
{
  "ticket": "<os 12 dígitos, só números, ou null se não conseguir ler com certeza>",
  "dataEmissaoDDMMAAHHMMSS": "<string exatamente como impressa, ex: 19/03/26 09:25:21, ou null>",
  "confianca": "alta" | "baixa",
  "motivo": "<se confianca=baixa, explique brevemente por quê (borrado, cortado, não é um ticket #1Park, etc); se alta, string vazia>"
}

Se a imagem não for claramente um ticket #1Park, ou se qualquer um dos dois campos não puder ser lido com certeza, use confianca "baixa" e ticket/dataEmissaoDDMMAAHHMMSS null — não adivinhe dígitos.`;

function lerImagemBase64(caminho) {
  const ext = path.extname(caminho).toLowerCase();
  const mediaType = TIPOS_MIME[ext];
  if (!mediaType) {
    throw new Error(`Extensão de imagem não suportada: "${ext}" (arquivo: ${caminho})`);
  }
  const dados = fs.readFileSync(caminho).toString('base64');
  return { mediaType, dados };
}

function chamarClaude({ mediaType, dados }) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      reject(new Error('ANTHROPIC_API_KEY não configurada em .env — preencha antes de usar o OCR.'));
      return;
    }

    const corpo = JSON.stringify({
      model: MODELO,
      max_tokens: 500,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: dados } },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    });

    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(corpo),
        },
      },
      (res) => {
        let corpoResposta = '';
        res.on('data', (chunk) => { corpoResposta += chunk; });
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(corpoResposta);
          } catch (erro) {
            reject(new Error(`Resposta inesperada da Anthropic (status ${res.statusCode}): ${corpoResposta.slice(0, 300)}`));
            return;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(`Anthropic retornou erro (status ${res.statusCode}): ${json.error && json.error.message || JSON.stringify(json)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(corpo);
    req.end();
  });
}

// A resposta do modelo às vezes vem cercada de ```json ... ``` mesmo quando
// instruído a não fazer isso — tira a cerca antes de fazer o parse.
function extrairJson(texto) {
  const semCerca = texto.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(semCerca);
}

// Converte "19/03/26 09:25:21" (DD/MM/AA HH:MM:SS, como impresso no ticket)
// para ISO 8601, assumindo século 20xx e horário de São Paulo (-03:00) —
// mesmo formato que scripts/validate-ticket.js espera em dataEmissaoIso.
function paraIso(dataDdMmAaHhMmSs) {
  const m = (dataDdMmAaHhMmSs || '').match(/^(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return null;
  const [, dia, mes, ano2, hora, min, seg] = m;
  return `20${ano2}-${mes}-${dia}T${hora}:${min}:${seg}-03:00`;
}

async function lerTicket(caminhoImagem) {
  if (!fs.existsSync(caminhoImagem)) {
    throw new Error(`Arquivo de imagem não encontrado: ${caminhoImagem}`);
  }

  const imagem = lerImagemBase64(caminhoImagem);
  const resposta = await chamarClaude(imagem);

  const textoResposta = (resposta.content || []).map((b) => b.text || '').join('');
  let extraido;
  try {
    extraido = extrairJson(textoResposta);
  } catch (erro) {
    return {
      status: 'ocr_falhou',
      mensagem: `Não consegui interpretar a resposta do modelo: ${textoResposta.slice(0, 300)}`,
      mensagemWhatsapp: '⚠️ Não conseguimos ler essa foto do ticket. Pode reenviar, tentando deixar o número e a data bem visíveis?',
      notificarAdmin: true,
    };
  }

  const ticket = (extraido.ticket || '').trim();
  const dataEmissaoIso = paraIso(extraido.dataEmissaoDDMMAAHHMMSS);
  const confiancaAlta = extraido.confianca === 'alta';
  const ticketValido = REGEX_TICKET.test(ticket);

  if (!confiancaAlta || !ticketValido || !dataEmissaoIso) {
    return {
      status: 'ocr_confianca_baixa',
      mensagem: extraido.motivo || 'Confiança baixa ou campos incompletos.',
      ticketLido: ticket || null,
      dataEmissaoLida: extraido.dataEmissaoDDMMAAHHMMSS || null,
      mensagemWhatsapp: '⚠️ Não consegui ler o ticket com certeza nessa foto. Pode reenviar mais de perto, com o número e a data bem visíveis?',
      notificarAdmin: false,
    };
  }

  return {
    status: 'ocr_ok',
    ticket,
    dataEmissaoIso,
  };
}

async function main() {
  const [caminhoImagem] = process.argv.slice(2);
  if (!caminhoImagem) {
    console.error('Uso: node scripts/ocr-ticket.js <caminhoImagem>');
    process.exit(1);
  }

  try {
    const resultado = await lerTicket(caminhoImagem);
    console.log(JSON.stringify(resultado));
  } catch (erro) {
    console.log(JSON.stringify({
      status: 'erro',
      mensagem: erro.message,
      mensagemWhatsapp: '⚠️ Não conseguimos processar a foto do ticket no momento. Nossa equipe foi avisada.',
      notificarAdmin: true,
    }));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { lerTicket, paraIso, extrairJson };
