#!/usr/bin/env node
// Uso: node scripts/despachar-webhook.js <payloadBase64> [--enviar]
//
// A Evolution API só aceita UMA url de webhook por instância (confirmado em
// 25/09/2026 via GET /webhook/find: "webhookByEvents": false, uma única
// "url") — e essa instância é a MESMA usada pelo validador de hangares em
// produção, com o mesmo número de WhatsApp. Por isso TODA mensagem, de
// QUALQUER grupo (hangar ou unidade de fechamento de caixa), chega no MESMO
// webhook do n8n. Este script existe só para decidir, pelo GRUPO de onde a
// mensagem veio, qual dos dois projetos deve processá-la, e repassar o
// payload tal e qual para o script certo — sem conhecer a lógica de nenhum
// dos dois.
//
// O payload que o workflow já monta para o validador de hangares
// (nó "Preparar Payload") contém exatamente os campos que
// scripts/lib/whatsapp-fechamento.js também precisa (key.remoteJid,
// key.fromMe, key.id, key.participantAlt, pushName, message.imageMessage) —
// não precisou mudar nada na preparação do payload, só este roteamento.
//
// Fica dentro de fechamento-caixa/ (e não em scripts/ na raiz) de propósito:
// é o ÚNICO arquivo que referencia os dois projetos, e mantê-lo aqui evita
// que o validador de hangares precise saber que o fechamento de caixa
// existe.

const path = require('path');
const { execFileSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

const PROCESSAR_FECHAMENTO = path.join(__dirname, 'processar-fechamento.js');
const CONSULTAR_CAIXA = path.join(__dirname, 'consultar-caixa.js');
const PROCESSAR_MENSAGEM_HANGARES = path.join(__dirname, '..', '..', 'scripts', 'processar-mensagem.js');

// Palavras que sinalizam pergunta sobre caixa/dinheiro no privado (ver
// ehConsultaDeCaixaAdmin) — gatilho barato (regex local), sem gastar
// chamada de API só para decidir o roteamento.
const PALAVRAS_CAIXA = /dinheiro|caixa|cofre|faturad|faturou|envelope|saldo/;

function ehGrupoDeFechamento(payloadBase64) {
  let evento;
  try {
    evento = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf-8'));
  } catch (e) {
    return false; // payload ilegível: deixa o validador de hangares tratar e relatar o erro, como já fazia antes deste roteador existir
  }
  const remoteJid = ((evento.data || {}).key || {}).remoteJid;
  if (!remoteJid) return false;

  try {
    const { carregarConfig } = require('./lib/unidades');
    const config = carregarConfig();
    return config.unidades.some((u) => (u.grupoWhatsappId || '').trim() === remoteJid);
  } catch (e) {
    // Config do fechamento de caixa ilegível não pode travar o validador de
    // hangares, que é quem está em produção há mais tempo — cai para lá.
    return false;
  }
}

/**
 * Mensagem PRIVADA (não grupo) do número cadastrado em ADMIN_WHATSAPP_ID
 * (.env), perguntando sobre caixa/dinheiro de uma unidade ou cofre
 * conhecido (pedido do usuário, 30/09/2026 — ver scripts/consultar-caixa.js).
 * O MESMO número de admin também manda comandos para o validador de
 * hangares no privado — por isso só desvia quando a mensagem tem cara de
 * pergunta sobre caixa (palavra-chave + nome de unidade/cofre cadastrado);
 * qualquer outra coisa desse número continua indo para o validador de
 * hangares, como sempre foi.
 */
function ehConsultaDeCaixaAdmin(payloadBase64) {
  let evento;
  try {
    evento = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf-8'));
  } catch (e) {
    return false;
  }

  const key = (evento.data || {}).key || {};
  const remoteJid = key.remoteJid || null;
  if (key.fromMe === true || !remoteJid || remoteJid.endsWith('@g.us')) return false;

  const adminId = (process.env.ADMIN_WHATSAPP_ID || '').trim();
  if (!adminId || remoteJid !== adminId) return false;

  const msg = (evento.data || {}).message || {};
  const texto = msg.conversation || (msg.extendedTextMessage && msg.extendedTextMessage.text) || '';

  try {
    const { carregarConfig, normalizar } = require('./lib/unidades');
    const config = carregarConfig();
    const alvo = normalizar(texto);
    if (!PALAVRAS_CAIXA.test(alvo)) return false;

    const nomesConhecidos = config.unidades.flatMap((u) => [u.nome, ...(u.apelidos || [])]).map(normalizar).filter(Boolean);
    const cofresConhecidos = [...new Set(config.unidades.map((u) => u.cofre).filter(Boolean))].map(normalizar);
    return [...nomesConhecidos, ...cofresConhecidos].some((n) => alvo.includes(n))
      || /todas as unidades|em geral|no total/.test(alvo);
  } catch (e) {
    return false;
  }
}

function main() {
  const [payloadBase64, ...resto] = process.argv.slice(2);
  if (!payloadBase64) {
    console.log(JSON.stringify({
      status: 'parametros_invalidos',
      mensagem: 'Uso: node scripts/despachar-webhook.js <payloadBase64> [--enviar]',
      notificarAdmin: true,
    }));
    return;
  }

  const arquivo = ehGrupoDeFechamento(payloadBase64)
    ? PROCESSAR_FECHAMENTO
    : ehConsultaDeCaixaAdmin(payloadBase64)
    ? CONSULTAR_CAIXA
    : PROCESSAR_MENSAGEM_HANGARES;

  try {
    const saida = execFileSync('node', [arquivo, payloadBase64, ...resto], { encoding: 'utf-8', maxBuffer: 10 * 1024 * 1024 });
    process.stdout.write(saida);
  } catch (erro) {
    // Os dois scripts despachados sempre saem com código 0 e decidem tudo
    // pelo campo `status` (ver nota em cada um) — chegar aqui significa que
    // algo mais básico falhou (script não encontrado, erro antes do próprio
    // tratamento de erro deles rodar). Devolve json mesmo assim: quem lê
    // stdout no n8n espera uma linha json, nunca um stack trace cru.
    console.log(JSON.stringify({
      status: 'erro_despacho',
      mensagem: erro.message,
      mensagemWhatsapp: '⚠️ Não conseguimos processar essa mensagem agora. Nossa equipe foi avisada.',
      notificarAdmin: true,
    }));
  }
}

if (require.main === module) {
  main();
}

module.exports = { ehGrupoDeFechamento, ehConsultaDeCaixaAdmin };
