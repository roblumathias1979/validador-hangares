/**
 * evolution.js — a mesma Evolution API do validador de hangares (reaproveitada
 * de propósito para não pagar por um segundo número/chip de WhatsApp), vista
 * só pelo que este projeto precisa: baixar a foto de uma mensagem e mandar
 * texto de volta.
 *
 * Não importa o módulo homônimo de validador-hangares/scripts/lib —
 * este projeto é para ser independente (código e configuração próprios),
 * mesmo compartilhando servidor e instância da Evolution.
 */

const http = require('http');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), override: true });

const EVOLUTION_URL = process.env.EVOLUTION_URL || 'http://127.0.0.1:8080';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'validador-hangares';

function chamarEvolution(caminho, corpo) {
  return new Promise((resolve, reject) => {
    const chave = process.env.EVOLUTION_API_KEY;
    if (!chave) {
      reject(new Error('EVOLUTION_API_KEY não configurada no .env.'));
      return;
    }
    const url = new URL(caminho, EVOLUTION_URL);
    const dados = JSON.stringify(corpo);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          apikey: chave,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(dados),
          // Sem keep-alive de propósito — o mesmo bug de socket morto em
          // conexão ociosa já mordeu o validador de hangares (ver
          // scripts/processar-mensagem.js daquele projeto).
          Connection: 'close',
        },
        agent: false,
        timeout: 60000,
      },
      (res) => {
        let corpoResposta = '';
        res.on('data', (c) => { corpoResposta += c; });
        res.on('end', () => {
          try {
            resolve(JSON.parse(corpoResposta));
          } catch (e) {
            reject(new Error(`Evolution devolveu resposta não-json (HTTP ${res.statusCode}): ${corpoResposta.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Evolution não respondeu em 60s.')));
    req.write(dados);
    req.end();
  });
}

/**
 * Grupos de que o número do bot participa, como [{ id, nome }] — usado para
 * descobrir o `grupoWhatsappId` de cada unidade sem precisar catar o id de
 * 22 dígitos manualmente. Mesma leitura que o painel do validador de
 * hangares já faz.
 */
function listarGrupos({ timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const chave = process.env.EVOLUTION_API_KEY;
    if (!chave) {
      reject(new Error('EVOLUTION_API_KEY não configurada no .env.'));
      return;
    }
    const url = new URL(`/group/fetchAllGroups/${EVOLUTION_INSTANCE}?getParticipants=false`, EVOLUTION_URL);
    const req = http.get(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: { apikey: chave }, timeout: timeoutMs },
      (res) => {
        let corpo = '';
        res.on('data', (c) => { corpo += c; });
        res.on('end', () => {
          let dados;
          try { dados = JSON.parse(corpo); } catch (e) {
            reject(new Error(`Evolution devolveu resposta não-json (HTTP ${res.statusCode}).`));
            return;
          }
          if (!Array.isArray(dados)) {
            reject(new Error(`Evolution não devolveu uma lista de grupos (HTTP ${res.statusCode}).`));
            return;
          }
          resolve(dados
            .map((g) => ({ id: g.id, nome: String(g.subject || '').replace(/^"|"$/g, '').trim() || g.id }))
            .filter((g) => g.id && g.id.endsWith('@g.us'))
            .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')));
        });
      }
    );
    req.on('error', (e) => reject(new Error(`Não consegui falar com a Evolution: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error(`Evolution não respondeu em ${timeoutMs / 1000}s.`)); });
  });
}

async function baixarImagemBase64(messageId) {
  const r = await chamarEvolution(
    `/chat/getBase64FromMediaMessage/${EVOLUTION_INSTANCE}`,
    { message: { key: { id: messageId } }, convertToMp4: false }
  );
  if (!r || !r.base64) {
    throw new Error(`Evolution não devolveu a imagem da mensagem ${messageId}.`);
  }
  return { base64: r.base64, mediaType: r.mimetype || 'image/jpeg' };
}

async function enviarTexto(destino, texto) {
  let ultimoErro = null;
  for (let tentativa = 1; tentativa <= 2; tentativa += 1) {
    try {
      return await chamarEvolution(`/message/sendText/${EVOLUTION_INSTANCE}`, { number: destino, text: texto });
    } catch (erro) {
      ultimoErro = erro;
      if (tentativa < 2) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw ultimoErro;
}

module.exports = { listarGrupos, baixarImagemBase64, enviarTexto, EVOLUTION_URL, EVOLUTION_INSTANCE };
