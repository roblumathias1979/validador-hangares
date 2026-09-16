#!/usr/bin/env node
// Uso: node scripts/consultar-patio.js <hangarId> [--sem-cache]
//
// Lê a situação do pátio no ValidPark: vagas livres, ocupadas, quantos são
// ticket e quantos são credenciado, mais a lista de tickets validados que o
// site mostra.
//
// Pensado para responder no WhatsApp quando alguém pergunta o status do pátio.
//
// CACHE DE 60 SEGUNDOS, e não é detalhe: cada consulta abre um Chromium e faz
// login, o que leva ~10s e pesa numa máquina de 2 GB. Sem cache, três pessoas
// perguntando ao mesmo tempo num grupo derrubariam o servidor — e a resposta
// seria idêntica, porque o pátio não muda a cada segundo.
//
// Só leitura: não valida nem altera nada.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { carregarConfig, buscarHangar, login } = require('./lib/hangar');

const CACHE = path.join(__dirname, '..', 'data', 'cache-patio.json');
const CACHE_MS = 60 * 1000;

const REGEX_CONTADORES = {
  total: /Total de vagas:\s*(\d+)/i,
  disponiveis: /Dispon[íi]veis:\s*(\d+)/i,
  utilizadas: /Utilizadas:\s*(\d+)/i,
  tickets: /Tickets:\s*(\d+)/i,
  credenciados: /Credenciados:\s*(\d+)/i,
};

/**
 * O site junta todos os cards validados num único elemento, com os campos
 * separados por quebra de linha. Cada entrada começa em "Placa:", então é por
 * aí que separamos — não há um seletor por card.
 */
function extrairValidados(texto) {
  return (texto || '')
    .split(/(?=Placa:)/g)
    .map((bloco) => bloco.replace(/\s+/g, ' ').trim())
    .filter((bloco) => bloco.startsWith('Placa:'))
    .map((bloco) => ({
      placa: (bloco.match(/Placa:\s*([^\s|]+)/i) || [])[1] || null,
      entrada: (bloco.match(/Entrada:\s*([\d/]+\s[\d:]+)/i) || [])[1] || null,
      tolerancia: (bloco.match(/Toler[âa]ncia:\s*([\d/]+\s[\d:]+)/i) || [])[1] || null,
      validadoPor: (bloco.match(/Validado por:\s*([^\s|]+)/i) || [])[1] || null,
      // O número do ticket aparece solto no fim do card, depois de tudo.
      ticket: (bloco.match(/\b(\d{12})\b/) || [])[1] || null,
    }));
}

function lerCache(hangarId) {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf-8'))[hangarId];
    if (c && Date.now() - new Date(c.em).getTime() < CACHE_MS) return c;
  } catch (e) { /* sem cache */ }
  return null;
}

function gravarCache(hangarId, dados) {
  try {
    let tudo = {};
    try { tudo = JSON.parse(fs.readFileSync(CACHE, 'utf-8')); } catch (e) { /* novo */ }
    tudo[hangarId] = dados;
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(tudo, null, 2));
  } catch (e) { /* cache é otimização; falhar aqui não pode derrubar a consulta */ }
}

function montarMensagem(hangar, d) {
  const linhas = [`📊 *${hangar.hangar || hangar.id}*`, ''];

  if (d.total !== null) {
    linhas.push(`Vagas: ${d.disponiveis} livres de ${d.total}`);
    if (d.utilizadas !== null) {
      const detalhe = [
        d.tickets !== null ? `${d.tickets} por ticket` : null,
        d.credenciados !== null ? `${d.credenciados} credenciados` : null,
      ].filter(Boolean).join(', ');
      linhas.push(`Ocupadas: ${d.utilizadas}${detalhe ? ` (${detalhe})` : ''}`);
    }
  } else {
    linhas.push('Não consegui ler o contador de vagas do site.');
  }

  if (d.validados.length) {
    linhas.push('', `*Tickets validados* (${d.validados.length} mais recentes):`);
    // Limite de 10 na mensagem: o site mostra ~21, e uma mensagem com todos
    // fica ilegível no celular. O resto continua no json, para o painel.
    for (const v of d.validados.slice(0, 10)) {
      linhas.push(`• ${v.ticket || '(sem número)'} — ${v.placa || 'sem placa'}${v.tolerancia ? ` — até ${v.tolerancia}` : ''}`);
    }
    if (d.validados.length > 10) linhas.push(`_(e mais ${d.validados.length - 10})_`);
  } else {
    linhas.push('', 'Nenhum ticket validado aparece na lista do site agora.');
  }

  if (d.doCache) linhas.push('', '_dados de até 1 minuto atrás_');
  return linhas.join('\n');
}

async function consultarPatio(hangarId, { usarCache = true } = {}) {
  const hangar = buscarHangar(carregarConfig(), hangarId);

  if (usarCache) {
    const c = lerCache(hangarId);
    if (c) return { ...c, doCache: true, mensagemWhatsapp: montarMensagem(hangar, { ...c, doCache: true }) };
  }

  const seletores = hangar.seletores || {};
  const navegador = await chromium.launch({ headless: true });
  try {
    const pagina = await navegador.newPage();
    await pagina.goto(hangar.validadorUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await login(pagina, hangar);

    // Mesma espera da validação: o site preenche o contador depois do login, e
    // ler cedo demais devolve string vazia.
    await pagina.locator(seletores.areaVagasDisponiveis)
      .filter({ hasText: REGEX_CONTADORES.disponiveis })
      .first().waitFor({ timeout: 15000 }).catch(() => {});

    const textoContador = (await pagina.textContent(seletores.areaVagasDisponiveis).catch(() => '')) || '';
    const numeros = {};
    for (const [nome, re] of Object.entries(REGEX_CONTADORES)) {
      const m = textoContador.match(re);
      numeros[nome] = m ? Number(m[1]) : null;
    }

    const textoValidados = (await pagina.locator('.card-ticket-validados').first().innerText().catch(() => '')) || '';
    const validados = extrairValidados(textoValidados);

    const dados = { status: 'patio_ok', hangar: hangarId, ...numeros, validados, em: new Date().toISOString() };
    gravarCache(hangarId, dados);
    return { ...dados, doCache: false, mensagemWhatsapp: montarMensagem(hangar, { ...dados, doCache: false }) };
  } finally {
    await navegador.close();
  }
}

async function main() {
  const [hangarId, ...flags] = process.argv.slice(2);
  if (!hangarId) {
    console.log(JSON.stringify({
      status: 'parametros_invalidos',
      mensagem: 'Uso: node scripts/consultar-patio.js <hangarId> [--sem-cache]',
      mensagemWhatsapp: '⚠️ Não conseguimos consultar o pátio no momento. Nossa equipe foi avisada.',
      notificarAdmin: true,
    }));
    return;
  }
  try {
    console.log(JSON.stringify(await consultarPatio(hangarId, { usarCache: !flags.includes('--sem-cache') })));
  } catch (erro) {
    console.log(JSON.stringify({
      status: 'erro',
      hangar: hangarId,
      mensagem: erro.message,
      mensagemWhatsapp: '⚠️ Não consegui consultar o pátio agora. Nossa equipe foi avisada.',
      notificarAdmin: true,
    }));
  }
}

if (require.main === module) {
  main();
}

module.exports = { consultarPatio, extrairValidados };
