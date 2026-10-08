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
const https = require('https');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(RAIZ, '.env'), override: true });

const { carregarConfig } = require('./lib/hangar');
const { salvarAtomico, lerJson } = require('./lib/trava-arquivo');
const { destinosAdmin } = require('./lib/admins');

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

/**
 * Decide o que a resposta da API da Anthropic diz sobre a saúde do OCR.
 *
 * Em 08/10/2026 os créditos acabaram e o bot passou a engolir todas as fotos de
 * ticket: respondia "Recebi seu ticket, já estou verificando..." e silenciava.
 * O monitor dava tudo verde, porque não olhava a API — a descoberta veio de um
 * cliente reclamando, de novo.
 *
 * Só conta como PROBLEMA o que exige ação humana: crédito esgotado e chave
 * recusada. Instabilidade passageira (429, 5xx, rede) não alarma — o OCR tenta de
 * novo na próxima foto, e acordar alguém por um soluço de 30s faria o aviso
 * perder credibilidade.
 */
function classificarAnthropic({ status, texto, erro }) {
  if (erro) return { ok: true, detalhe: `sem resposta da API agora (${erro}) — tratado como instabilidade passageira` };
  if (status >= 200 && status < 300) return { ok: true, detalhe: 'API respondendo (OCR com crédito)' };
  if (/credit balance is too low/i.test(texto || '')) {
    return { ok: false, detalhe: 'créditos da API da Anthropic ESGOTADOS — o bot não consegue ler fotos de ticket. Recarregue em https://console.anthropic.com/settings/billing (Comprar créditos)' };
  }
  if (status === 401 || status === 403) {
    return { ok: false, detalhe: `chave da API da Anthropic recusada (HTTP ${status}) — o bot não consegue ler fotos de ticket` };
  }
  return { ok: true, detalhe: `API respondeu HTTP ${status} — tratado como instabilidade passageira` };
}

// Chamada mínima (1 token de saída, modelo mais barato): o saldo e a chave são
// checados igual, a um custo desprezível mesmo a cada 5 minutos.
function chamarAnthropic(chave) {
  return new Promise((resolve) => {
    const corpo = JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ok' }],
    });
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': chave,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(corpo),
        },
        timeout: 15000,
      },
      (res) => {
        let texto = '';
        res.on('data', (c) => (texto += c));
        res.on('end', () => resolve({ status: res.statusCode, texto }));
      }
    );
    req.on('error', (e) => resolve({ erro: e.message }));
    req.on('timeout', () => { req.destroy(); resolve({ erro: 'timeout' }); });
    req.write(corpo);
    req.end();
  });
}

async function checarAnthropic(chamar = chamarAnthropic) {
  const chave = process.env.ANTHROPIC_API_KEY;
  if (!chave) return { ok: false, detalhe: 'ANTHROPIC_API_KEY não configurada — o bot não consegue ler fotos de ticket' };
  return classificarAnthropic(await chamar(chave));
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

  // 4. API do OCR: sem crédito (ou com chave recusada) o bot recebe a foto e
  //    não consegue ler — silêncio total para o cliente.
  checagens.anthropic = await checarAnthropic();

  const problemas = Object.entries(checagens).filter(([, c]) => !c.ok);
  return {
    em: new Date().toISOString(),
    saudavel: problemas.length === 0,
    checagens,
    problemas: problemas.map(([nome, c]) => `${nome}: ${c.detalhe}`),
  };
}

// Manda um texto para TODOS os destinos de administração (grupoAdministracao de
// cada hangar + a lista adminsWhatsapp — o grupo "Adm Bot" incluso). Devolve se
// algum recebeu.
async function enviarAdmins(texto) {
  const destinos = destinosAdmin(carregarConfig());
  if (!destinos.length) return { avisado: false, motivo: 'nenhum destino de administração' };
  let algum = false;
  for (const number of destinos) {
    const r = await pedir(
      `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
      { apikey: process.env.EVOLUTION_API_KEY }, 'POST', { number, text: texto }
    );
    if (r.ok) algum = true;
  }
  return { avisado: algum, destinos };
}

/**
 * O ValidPark está de pé? Faz o que uma validação faz — login e leitura das
 * vagas de um pátio de referência. Serve mais que um GET na página: a queda que
 * motivou tudo isso servia a página de login (HTTP 200) mas falhava o login/a
 * validação. Só `total` numérico (contador que só aparece DEPOIS do login)
 * prova que entrou. Lança/!total = fora. Em contingência, não checa — estamos
 * contornando o site de propósito, e checá-lo só gastaria um navegador.
 */
async function checarValidpark() {
  const cfg = carregarConfig();
  if ((cfg.contingenciaValidPark || {}).ativo === true) return { pular: true, motivo: 'em contingência' };
  const ref = (cfg.hangares || []).find(
    (h) => (h.grupoWhatsappId || '').trim() && h.usuarioEnvVar && process.env[h.usuarioEnvVar]
  );
  if (!ref) return { pular: true, motivo: 'sem hangar de referência com credencial' };
  try {
    const { consultarPatio } = require('./consultar-patio');
    const p = await consultarPatio(ref.id, { usarCache: false });
    return Number.isFinite(p.total)
      ? { ok: true, ref: ref.id, detalhe: 'login e leitura ok' }
      : { ok: false, ref: ref.id, detalhe: 'logou mas não leu as vagas — site instável' };
  } catch (e) {
    return { ok: false, ref: ref.id, detalhe: `não respondeu: ${String(e.message).slice(0, 80)}` };
  }
}

// O estado do ValidPark é um alarme SEPARADO do saudavel geral: ele não entra no
// "🟢 normalizado", que diria bobagem ("site respondendo") durante a contingência.
// Avisa na queda e a cada REAVISO_MS enquanto durar; avisa também quando volta.
async function acompanharValidpark(anterior, atual, vpInjetado) {
  const vp = vpInjetado || await checarValidpark();
  const ant = (anterior && anterior.validpark) || null;
  if (vp.pular) {
    if (ant) atual.validpark = ant; // preserva o último conhecido, sem alarmar
    return;
  }
  const estavaOk = ant ? ant.ok !== false : true;
  let ultimoAvisoEm = (ant && ant.ultimoAvisoEm) || null;
  const foraDesde = vp.ok ? null : ((ant && ant.foraDesde) || atual.em);
  const caiuAgora = estavaOk && !vp.ok;
  const faz6h = !vp.ok && ultimoAvisoEm && (Date.now() - new Date(ultimoAvisoEm).getTime() > REAVISO_MS);

  if (!vp.ok && (caiuAgora || faz6h)) {
    const r = await enviarAdmins(
      `🔴 O ValidPark parece fora do ar (${vp.detalhe}).\n\n`
      + 'Quer validar pelo sistema do aeroporto enquanto isso? Responda *ligar contingência*.'
    );
    if (r.avisado) ultimoAvisoEm = atual.em;
  }
  if (vp.ok && ant && ant.ok === false) {
    await enviarAdmins('🟢 O ValidPark voltou a responder. Se você tinha ligado a *contingência*, já pode desligar — responda *desligar contingência*.');
    ultimoAvisoEm = null;
  }
  atual.validpark = { ok: vp.ok, detalhe: vp.detalhe, ref: vp.ref, em: atual.em, foraDesde, ultimoAvisoEm };
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
    ...(resultado.problemas.some((p) => p.startsWith('anthropic:'))
      ? ['', 'Responda *recarregar anthropic* aqui no grupo para receber o passo a passo.']
      : []),
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

  // Vigia do ValidPark, à parte do saudavel geral (ver acompanharValidpark).
  // Nunca derruba o monitor: um erro aqui não pode apagar o resto da checagem.
  try {
    await acompanharValidpark(anterior, atual);
  } catch (e) {
    atual.validparkErro = String(e.message).slice(0, 120);
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

module.exports = { verificar, checarValidpark, acompanharValidpark, classificarAnthropic, checarAnthropic };
