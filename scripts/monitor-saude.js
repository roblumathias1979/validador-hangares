#!/usr/bin/env node
/**
 * monitor-saude.js — verifica se o sistema está de pé e avisa quando não está.
 *
 * O PROBLEMA QUE ISTO RESOLVE
 * Quando algo quebra, ninguém fica sabendo. Em 16/09/2026 o bot passou a manhã
 * inteira derrubando fotos com "spawn E2BIG" e a descoberta veio de um cliente
 * reclamando. A sessão do WhatsApp cair tem o mesmo desfecho: o bot
 * simplesmente para de responder, em silêncio.
 *
 * O LIMITE HONESTO DESTE MONITOR
 * Se a sessão do WhatsApp estiver fora, o aviso NÃO pode ir pelo WhatsApp. Por
 * isso o resultado é sempre gravado em data/saude.json, que o painel mostra em
 * destaque — essa é a via que funciona mesmo com o WhatsApp caído. O envio é
 * uma tentativa a mais, útil quando o que quebrou foi outra coisa (n8n parado,
 * disco cheio) e o WhatsApp ainda funciona.
 *
 * Roda a cada 5 minutos por systemd timer (infra/monitor-saude.timer).
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(RAIZ, '.env') });

const { carregarConfig } = require('./lib/hangar');
const { salvarAtomico, lerJson } = require('./lib/trava-arquivo');

const ARQUIVO = path.join(RAIZ, 'data', 'saude.json');
const EVOLUTION_URL = process.env.EVOLUTION_URL || 'http://127.0.0.1:8080';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'validador-hangares';
const N8N_URL = process.env.N8N_URL || 'http://127.0.0.1:5678';

// Re-avisa a cada 6h enquanto o problema persistir. Sem isso, um problema que
// começou de madrugada só teria avisado uma vez, quando ninguém estava vendo.
const REAVISO_MS = 6 * 3600 * 1000;

function pedir(url, cabecalhos = {}, metodo = 'GET', corpo = null) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const dados = corpo ? JSON.stringify(corpo) : null;
    const req = http.request(
      {
        hostname: u.hostname,
        port: u.port,
        path: u.pathname + u.search,
        method: metodo,
        headers: {
          ...cabecalhos,
          ...(dados ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dados) } : {}),
          Connection: 'close',
        },
        agent: false,
        timeout: 15000,
      },
      (res) => {
        let texto = '';
        res.on('data', (c) => (texto += c));
        res.on('end', () => resolve({ ok: res.statusCode < 400, status: res.statusCode, texto }));
      }
    );
    req.on('error', (e) => resolve({ ok: false, erro: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ ok: false, erro: 'timeout' }); });
    if (dados) req.write(dados);
    req.end();
  });
}

async function verificar() {
  const checagens = {};

  // 1. Sessão do WhatsApp — a mais importante: é ela que some em silêncio
  //    quando o celular principal passa ~14 dias sem conectar.
  const chave = process.env.EVOLUTION_API_KEY;
  const r = await pedir(`${EVOLUTION_URL}/instance/fetchInstances`, { apikey: chave });
  if (!r.ok) {
    checagens.whatsapp = { ok: false, detalhe: `Evolution não respondeu (${r.erro || r.status})` };
  } else {
    let estado = null;
    try {
      const d = JSON.parse(r.texto);
      const itens = Array.isArray(d) ? d : [d];
      const i = (itens.find((x) => (x.instance || x).name === EVOLUTION_INSTANCE) || itens[0] || {});
      const inst = i.instance || i;
      estado = inst.connectionStatus || inst.status || null;
    } catch (e) { /* estado fica null */ }
    checagens.whatsapp = estado === 'open'
      ? { ok: true, detalhe: 'sessão conectada' }
      : { ok: false, detalhe: `sessão em "${estado}" — o bot não recebe nem responde` };
  }

  // 2. n8n: sem ele o webhook não chega a lugar nenhum.
  const n = await pedir(`${N8N_URL}/healthz`);
  checagens.n8n = n.ok
    ? { ok: true, detalhe: 'respondendo' }
    : { ok: false, detalhe: `não respondeu (${n.erro || n.status})` };

  // 3. Disco: o Chromium precisa de espaço para abrir, e ficar sem disco
  //    quebra tudo de formas confusas.
  try {
    const { execFileSync } = require('child_process');
    const saida = execFileSync('df', ['-Pk', RAIZ], { encoding: 'utf-8' }).trim().split('\n').pop().split(/\s+/);
    const livreGb = Number(saida[3]) / 1024 / 1024;
    checagens.disco = livreGb > 1
      ? { ok: true, detalhe: `${livreGb.toFixed(1)} GB livres` }
      : { ok: false, detalhe: `só ${livreGb.toFixed(1)} GB livres` };
  } catch (e) {
    checagens.disco = { ok: false, detalhe: `não consegui medir: ${e.message}` };
  }

  const problemas = Object.entries(checagens).filter(([, c]) => !c.ok);
  return {
    em: new Date().toISOString(),
    saudavel: problemas.length === 0,
    checagens,
    problemas: problemas.map(([nome, c]) => `${nome}: ${c.detalhe}`),
  };
}

// Tentativa de aviso. Pode falhar justamente quando mais importa — se o que
// caiu foi o WhatsApp, não há como avisar por ele. O registro em disco é a via
// que sempre funciona.
async function avisar(resultado) {
  const config = carregarConfig();
  const destino = (config.hangares.find((h) => (h.grupoAdministracao || '').trim()) || {}).grupoAdministracao;
  if (!destino) return { avisado: false, motivo: 'nenhum hangar tem grupoAdministracao configurado' };

  const texto = [
    '🔴 Validador com problema',
    ...resultado.problemas.map((p) => `• ${p}`),
    '',
    'Verificado em ' + new Date(resultado.em).toLocaleString('pt-BR'),
  ].join('\n');

  const r = await pedir(
    `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
    { apikey: process.env.EVOLUTION_API_KEY },
    'POST',
    { number: destino, text: texto }
  );
  return r.ok ? { avisado: true, destino } : { avisado: false, motivo: r.erro || `HTTP ${r.status}` };
}

async function main() {
  const anterior = lerJson(ARQUIVO, null);
  const atual = await verificar();

  // Avisa na TRANSIÇÃO para problema, e depois a cada 6h enquanto durar.
  // Avisar a cada 5 minutos viraria ruído e a pessoa pararia de ler.
  const eraSaudavel = !anterior || anterior.saudavel;
  const faz6h = anterior && anterior.ultimoAvisoEm
    && (Date.now() - new Date(anterior.ultimoAvisoEm).getTime()) > REAVISO_MS;

  let aviso = null;
  if (!atual.saudavel && (eraSaudavel || faz6h)) {
    aviso = await avisar(atual);
    atual.ultimoAvisoEm = aviso.avisado ? atual.em : (anterior && anterior.ultimoAvisoEm) || null;
    atual.ultimoAviso = aviso;
  } else if (!atual.saudavel && anterior) {
    atual.ultimoAvisoEm = anterior.ultimoAvisoEm || null;
  }

  // Voltou ao normal depois de um problema: vale avisar também, senão a pessoa
  // fica sem saber se ainda precisa agir.
  if (atual.saudavel && anterior && !anterior.saudavel) {
    const r = await pedir(
      `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
      { apikey: process.env.EVOLUTION_API_KEY },
      'POST',
      {
        number: (carregarConfig().hangares.find((h) => (h.grupoAdministracao || '').trim()) || {}).grupoAdministracao,
        text: '🟢 Validador normalizado — tudo respondendo de novo.',
      }
    );
    atual.recuperadoAvisado = r.ok;
  }

  salvarAtomico(ARQUIVO, atual);
  console.log(JSON.stringify(atual));
}

if (require.main === module) {
  main().catch((e) => {
    console.log(JSON.stringify({ em: new Date().toISOString(), saudavel: false, problemas: [`monitor falhou: ${e.message}`] }));
    process.exit(0);
  });
}

module.exports = { verificar };
