#!/usr/bin/env node
// Uso: node scripts/ocr-ticket.js <caminhoImagem>
//      node scripts/ocr-ticket.js --stdin [mimetype] [hangarId]
//        (base64 pela entrada padrão; hangarId liga a conferência de local
//         nos hangares que exigem foto do veículo — hoje AIBM 1 e 2)
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

// Sem isto o .env nunca é lido. Diferente dos outros scripts, este não passa
// por lib/hangar.js (não recebe hangarId) — e é lib/hangar.js quem carrega o
// dotenv. O resultado era "ANTHROPIC_API_KEY não configurada" mesmo com a
// chave preenchida corretamente no .env.
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { carregarConfig, buscarHangar } = require('./lib/hangar');

const { blocoPromptLocal } = require('./lib/conferir-local');
const referencias = require('./lib/referencias');

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

function chamarClaude({ mediaType, dados, prompt, referencias: refs = [] }) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      reject(new Error('ANTHROPIC_API_KEY não configurada em .env — preencha antes de usar o OCR.'));
      return;
    }

    const corpo = JSON.stringify({
      model: MODELO,
      // 500 bastava quando a resposta tinha 4 campos curtos. Com a conferência
      // de local ligada, o modelo passou a devolver também `cenario` e
      // `localMotivo`, que são descrições em TEXTO LIVRE — a resposta estourava
      // o limite e vinha cortada no meio, produzindo um json inválido
      // (16/09/2026: o ticket era lido corretamente e se perdia na hora de
      // interpretar). O dobro dá folga para a descrição do pátio.
      max_tokens: refs.length || (prompt && prompt.length > PROMPT.length) ? 1500 : 500,
      messages: [
        {
          role: 'user',
          content: [
            // A foto do cliente vem PRIMEIRO e é rotulada, senão o modelo pode
            // confundir qual imagem deve ler o ticket.
            { type: 'text', text: 'FOTO DO CLIENTE (é nesta que está o ticket):' },
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: dados } },
            ...refs.flatMap((r, i) => ([
              { type: 'text', text: `FOTO DE REFERÊNCIA ${i + 1} do pátio deste hangar:` },
              { type: 'image', source: { type: 'base64', media_type: r.mimetype, data: r.base64 } },
            ])),
            { type: 'text', text: prompt || PROMPT },
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
  const ano = 2000 + Number(ano2);

  // O regex só garante o FORMATO, não que a data exista. Sem esta checagem,
  // "31/02/26" virava "2026-02-31" e o Date rolava silenciosamente para 3 de
  // março — uma data plausível e errada, que depois seria comparada com a
  // janela de 2h. Reconstruir e comparar os componentes pega esse caso.
  const d = new Date(Date.UTC(ano, Number(mes) - 1, Number(dia), Number(hora), Number(min), Number(seg)));
  const bate =
    d.getUTCFullYear() === ano &&
    d.getUTCMonth() === Number(mes) - 1 &&
    d.getUTCDate() === Number(dia) &&
    d.getUTCHours() === Number(hora) &&
    d.getUTCMinutes() === Number(min) &&
    d.getUTCSeconds() === Number(seg);
  if (!bate) return null;

  return `${ano}-${mes}-${dia}T${hora}:${min}:${seg}-03:00`;
}

// O número do ticket carrega dentro dele a própria data/hora de emissão:
//
//   01 | 1109 | 085843
//        dia/mês  hh:mm:ss     ->  11/09 08:58:43
//
// Formato CONFIRMADO em 12 tickets reais (4 fotos do usuário em 12/09/2026 +
// todos os exemplos documentados neste repo). Os dois prefixos "03" conhecidos
// são de tickets emulados, e ambos terminam em segundo :00 — ticket de totem
// nunca cai em segundo redondo.
//
// Por que isso importa: o número e a data impressa são lidos de partes
// DIFERENTES do papel. Se concordam, nenhum dos dois foi lido errado. É
// verificação independente, diferente do campo `confianca`, que é o próprio
// modelo se autoavaliando. Um dígito trocado valida o ticket de outra pessoa.
//
// Limite conhecido: o ANO não está no número, só dia/mês/hora. Ano lido errado
// não é pego aqui — mas falha do lado seguro, porque joga a emissão para fora
// da janela de 2h e a validação é recusada.
function conferirTicketComData(ticket, dataDdMmAaHhMmSs) {
  const dia = ticket.slice(2, 4);
  const mes = ticket.slice(4, 6);
  const hh = ticket.slice(6, 8);
  const mm = ticket.slice(8, 10);
  const ss = ticket.slice(10, 12);
  const doNumero = `${dia}/${mes} ${hh}:${mm}:${ss}`;

  if (Number(dia) < 1 || Number(dia) > 31 || Number(mes) < 1 || Number(mes) > 12 ||
      Number(hh) > 23 || Number(mm) > 59 || Number(ss) > 59) {
    return { ok: false, doNumero, doPapel: null, motivo: `o número não contém uma data válida (${doNumero})` };
  }

  const m = (dataDdMmAaHhMmSs || '').match(/^(\d{2})\/(\d{2})\/(\d{2})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (!m) return { ok: false, doNumero, doPapel: null, motivo: 'a data impressa não foi lida' };

  const doPapel = `${m[1]}/${m[2]} ${m[4]}:${m[5]}:${m[6]}`;
  if (doNumero !== doPapel) {
    return { ok: false, doNumero, doPapel, motivo: `número diz ${doNumero} e papel diz ${doPapel}` };
  }
  return { ok: true, doNumero, doPapel, motivo: '' };
}

// Lê a base64 da entrada padrão. Existe para a foto do WhatsApp não precisar
// passar pelo disco: ela vem da Evolution já em base64
// (/chat/getBase64FromMediaMessage), e gravar foto de cliente em arquivo é
// dado pessoal parado no servidor, com o risco de sobrar ali se algo falhar
// no meio do fluxo.
function lerBase64DaEntrada() {
  const bruto = fs.readFileSync(0, 'utf-8').trim();
  if (!bruto) {
    throw new Error('Nada chegou pela entrada padrão — esperava a imagem em base64.');
  }
  // Aceita tanto base64 pura quanto data URI ("data:image/jpeg;base64,...").
  const m = bruto.match(/^data:([^;]+);base64,(.*)$/s);
  return m ? { mediaType: m[1], dados: m[2] } : { dados: bruto, mediaType: null };
}

// `origem` é { caminho } ou { base64, mediaType } — o segundo caso é o do
// WhatsApp, onde a imagem nunca toca o disco.
async function lerTicket(origem) {
  const entrada = typeof origem === 'string' ? { caminho: origem } : (origem || {});

  let imagem;
  if (entrada.caminho) {
    if (!fs.existsSync(entrada.caminho)) {
      throw new Error(`Arquivo de imagem não encontrado: ${entrada.caminho}`);
    }
    imagem = lerImagemBase64(entrada.caminho);
  } else if (entrada.base64) {
    imagem = { dados: entrada.base64, mediaType: entrada.mediaType || 'image/jpeg' };
  } else {
    throw new Error('lerTicket precisa de um caminho de arquivo ou da imagem em base64.');
  }

  // Hangares com histórico de fraude no pátio (hoje AIBM 1 e 2) exigem que a
  // foto mostre o veículo no local. A conferência vai na MESMA chamada que lê
  // o ticket: uma foto, uma chamada, um custo. Separar em duas dobraria preço
  // e tempo sem ganho nenhum.
  
  // Fotos do próprio pátio, quando existirem. Comparar imagem com imagem é o
  // que uma pessoa faria; a descrição em texto sozinha depende de alguém ter
  // descrito o lugar bem. Cada imagem entra na conta da chamada, por isso o
  // limite de 3 em referencias.js.
  const refs = (entrada.hangar && entrada.hangar.exigeFotoVeiculoNoLocal)
    ? referencias.imagensParaConferencia(entrada.hangar.id)
    : [];
  const extraLocal = blocoPromptLocal(entrada.hangar || null, refs.length > 0);
  const resposta = await chamarClaude({ ...imagem, prompt: PROMPT + extraLocal, referencias: refs });

  const textoResposta = (resposta.content || []).map((b) => b.text || '').join('');
  let extraido;
  try {
    extraido = extrairJson(textoResposta);
  } catch (erro) {
    return {
      status: 'ocr_falhou',
      // Mostra o INÍCIO e o FIM: resposta cortada por limite de tokens só se
      // denuncia no fim, e antes só o começo aparecia — o que fez a causa real
      // (max_tokens baixo demais) passar despercebida em 16/09/2026.
      mensagem: `Não consegui interpretar a resposta do modelo (${textoResposta.length} caracteres). `
        + `Início: ${textoResposta.slice(0, 120)} ... Fim: ${textoResposta.slice(-120)}`,
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

  // Verificação independente: não seguir daqui é o ponto mais importante deste
  // script. Um número com dígito trocado não dá erro nenhum lá na frente — ele
  // simplesmente valida o ticket de outra pessoa.
  const conferencia = conferirTicketComData(ticket, extraido.dataEmissaoDDMMAAHHMMSS);
  if (!conferencia.ok) {
    return {
      status: 'ocr_conferencia_falhou',
      mensagem: `Número e data não conferem entre si: ${conferencia.motivo}.`,
      ticketLido: ticket,
      dataEmissaoLida: extraido.dataEmissaoDDMMAAHHMMSS || null,
      conferencia,
      mensagemWhatsapp: '⚠️ A foto ficou com o número ou a data pouco legíveis. Pode reenviar, mais de perto e com o papel bem iluminado?',
      notificarAdmin: false,
    };
  }

  return {
    status: 'ocr_ok',
    ticket,
    dataEmissaoIso,
    conferencia: { ok: true, valor: conferencia.doNumero },
    // Só vêm preenchidos quando o hangar exige a foto com o veículo; quem
    // decide o que fazer com eles é avaliarLocal(), em conferir-local.js.
    cenario: extraido.cenario || null,
    local: extraido.local || null,
    localMotivo: extraido.localMotivo || null,
  };
}

async function main() {
  const [caminhoImagem, mimetypeArg, hangarIdArg] = process.argv.slice(2);

  if (caminhoImagem === '--stdin') {
    try {
      const daEntrada = lerBase64DaEntrada();
      const resultado = await lerTicket({
        base64: daEntrada.dados,
        mediaType: daEntrada.mediaType || mimetypeArg || 'image/jpeg',
        hangar: hangarIdArg ? buscarHangar(carregarConfig(), hangarIdArg) : null,
      });
      console.log(JSON.stringify(resultado));
    } catch (erro) {
      console.log(JSON.stringify({
        status: 'erro',
        mensagem: erro.message,
        mensagemWhatsapp: '⚠️ Não conseguimos processar a foto do ticket no momento. Nossa equipe foi avisada.',
        notificarAdmin: true,
      }));
    }
    return;
  }

  if (!caminhoImagem) {
    console.log(JSON.stringify({
      status: 'parametros_invalidos',
      mensagem: 'Uso: node scripts/ocr-ticket.js <caminhoImagem>',
      mensagemWhatsapp: '⚠️ Não conseguimos processar a foto do ticket no momento. Nossa equipe foi avisada.',
      notificarAdmin: true,
    }));
    return;
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
    // Sai com 0 DE PROPÓSITO, mesmo em falha: quem decide o que fazer é o nó
    // seguinte do n8n, lendo o campo `status` do json. Código != 0 faz o nó
    // "Execute Command" tratar como falha e engolir o json — a mensagem se
    // perderia antes de chegar ao cliente. Mesmo padrão de identificar-hangar.js.
  }
}

if (require.main === module) {
  main();
}

module.exports = { lerTicket, paraIso, extrairJson, conferirTicketComData };
