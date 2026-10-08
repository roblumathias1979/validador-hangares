/**
 * creditos-anthropic.js — medidor de SALDO ESTIMADO dos créditos da Anthropic.
 *
 * Por que "estimado": a Anthropic NÃO tem API que devolva o saldo (só o Console,
 * no navegador). O que dá para fazer é contar o custo de cada chamada que o bot
 * faz — cada resposta da API já traz `usage` (tokens de entrada/saída) — e
 * subtrair do crédito que a administração diz ter carregado. Enquanto TODO o uso
 * passar por este bot, a estimativa acompanha o Console de perto; se a mesma
 * chave for usada em outro lugar, descola. A fonte da verdade continua o Console.
 *
 * Fluxo: `registrarUso` soma o custo a cada chamada (chamado pelo OCR e pela
 * leitura de placas); `definirCredito` zera o contador e grava quanto foi
 * carregado ("recarreguei US$ 50"); `estado` devolve saldo = carregado − gasto.
 */

const path = require('path');
const { comTrava, salvarAtomico, lerJson } = require('./trava-arquivo');

const ARQUIVO = path.join(__dirname, '..', '..', 'data', 'uso-anthropic.json');
const DIAS_GUARDAR = 60; // histórico por dia, para a média e "dias restantes"

// Preço por 1 milhão de tokens (USD) — tabela oficial da Anthropic (cache: out/2026).
// Atualize aqui se a Anthropic mudar preço ou se o bot passar a usar outro modelo.
const PRECOS = {
  'claude-opus-5-5': { in: 4, out: 20, cacheRead: 0.20 },
  'claude-opus-5': { in: 5, out: 25, cacheRead: 0.25 },
  'claude-opus-4-8': { in: 5, out: 25, cacheRead: 0.50 },
  'claude-sonnet-5-5': { in: 2, out: 10, cacheRead: 0.20 },
  'claude-sonnet-5': { in: 2, out: 10, cacheRead: 0.20 },
  'claude-haiku-5-5': { in: 0.10, out: 0.50, cacheRead: 0.02 },
  'claude-haiku-4-5': { in: 1, out: 5, cacheRead: 0.10 },
};

function precoDoModelo(modelo) {
  if (PRECOS[modelo]) return PRECOS[modelo];
  // Modelo desconhecido: usa o mais caro que a gente conhece, para a estimativa
  // errar para MAIS (nunca prometer saldo que não existe) e marca como aproximada.
  return { ...PRECOS['claude-opus-5'], aproximado: true };
}

/** Custo em USD de uma chamada, a partir do `usage` que a API devolve. */
function custoUsd(modelo, usage) {
  if (!usage) return { custo: 0, aproximado: false };
  const p = precoDoModelo(modelo);
  const inTok = usage.input_tokens || 0;
  const outTok = usage.output_tokens || 0;
  const cacheRead = usage.cache_read_input_tokens || 0;
  const cacheWrite = usage.cache_creation_input_tokens || 0;
  const custo = (inTok * p.in + outTok * p.out + cacheRead * p.cacheRead + cacheWrite * p.in * 1.25) / 1e6;
  return { custo, aproximado: Boolean(p.aproximado) };
}

/** Soma o custo de uma chamada ao acumulado. Nunca lança — contar gasto não
 *  pode derrubar o OCR. */
function registrarUso({ modelo, usage } = {}) {
  try {
    const { custo, aproximado } = custoUsd(modelo, usage);
    if (!(custo > 0)) return null;
    return comTrava(ARQUIVO, () => {
      const d = lerJson(ARQUIVO, {});
      d.desde = d.desde || new Date().toISOString();
      d.gastoUsd = (d.gastoUsd || 0) + custo;
      d.gastoTotalUsd = (d.gastoTotalUsd || 0) + custo; // histórico, não zera na recarga
      d.chamadas = (d.chamadas || 0) + 1;
      d.tokensEntrada = (d.tokensEntrada || 0) + (usage.input_tokens || 0);
      d.tokensSaida = (d.tokensSaida || 0) + (usage.output_tokens || 0);
      if (aproximado) d.aproximado = true;
      const dia = new Date().toISOString().slice(0, 10);
      d.porDia = d.porDia || {};
      d.porDia[dia] = (d.porDia[dia] || 0) + custo;
      const corte = new Date(Date.now() - DIAS_GUARDAR * 86400000).toISOString().slice(0, 10);
      for (const k of Object.keys(d.porDia)) if (k < corte) delete d.porDia[k];
      salvarAtomico(ARQUIVO, d);
      return d;
    });
  } catch (e) {
    return null;
  }
}

/** A administração carregou crédito: grava quanto e ZERA o gasto (novo período). */
function definirCredito(usd) {
  const valor = Number(usd);
  if (!Number.isFinite(valor) || valor < 0) throw new Error('Valor de crédito inválido.');
  return comTrava(ARQUIVO, () => {
    const d = lerJson(ARQUIVO, {});
    d.creditoUsd = valor;
    d.gastoUsd = 0;
    d.recarregadoEm = new Date().toISOString();
    salvarAtomico(ARQUIVO, d);
    return d;
  });
}

function estado() {
  const d = lerJson(ARQUIVO, {});
  const alertaUsd = Number(process.env.ANTHROPIC_ALERTA_USD || 5) || 5;
  const creditoUsd = typeof d.creditoUsd === 'number' ? d.creditoUsd : null;
  const gastoUsd = d.gastoUsd || 0;
  const saldoUsd = creditoUsd == null ? null : Math.max(0, creditoUsd - gastoUsd);
  const dias = Object.entries(d.porDia || {}).sort((a, b) => a[0].localeCompare(b[0])).slice(-7);
  const mediaDiaUsd = dias.length ? dias.reduce((s, [, v]) => s + v, 0) / dias.length : 0;
  const diasRestantes = saldoUsd != null && mediaDiaUsd > 0 ? saldoUsd / mediaDiaUsd : null;
  return {
    creditoUsd, gastoUsd, saldoUsd, alertaUsd,
    recarregadoEm: d.recarregadoEm || null,
    desde: d.desde || null,
    gastoTotalUsd: d.gastoTotalUsd || 0,
    chamadas: d.chamadas || 0,
    tokensEntrada: d.tokensEntrada || 0,
    tokensSaida: d.tokensSaida || 0,
    porDia: d.porDia || {},
    mediaDiaUsd, diasRestantes,
    aproximado: Boolean(d.aproximado),
  };
}

/** Saldo conhecido e no/abaixo do limite de alerta? (null = sem saldo p/ vigiar) */
function estaBaixo() {
  const e = estado();
  if (e.saldoUsd == null) return false;
  return e.saldoUsd <= e.alertaUsd;
}

/**
 * Lê um valor de crédito em dólar de uma frase da administração. Aceita
 * "US$ 50", "$50", "50 usd", "50 dolares", e — quando a frase é claramente uma
 * recarga — um número solto ("recarreguei 50"). Devolve número ou null.
 */
function valorRecargaDoTexto(texto) {
  const t = String(texto || '').toLowerCase().replace(',', '.');
  let m = t.match(/(?:us\$|u\$|\$|usd)\s*(\d+(?:\.\d+)?)/);
  if (m) return Number(m[1]);
  m = t.match(/(\d+(?:\.\d+)?)\s*(?:d[óo]lar(?:es)?|usd|dol)/);
  if (m) return Number(m[1]);
  // Número solto só vale se a frase fala em recarregar/carregar/crédito/saldo,
  // para "recarregar sistema" (sem número) não virar crédito e "15min" não contar.
  if (/\b(recarr|carreg|credit|cr[eé]dit|saldo|coloquei|adicion|comprei)\w*/.test(t)) {
    m = t.match(/\b(\d{1,6}(?:\.\d+)?)\b/);
    if (m) return Number(m[1]);
  }
  return null;
}

module.exports = { registrarUso, definirCredito, estado, estaBaixo, custoUsd, valorRecargaDoTexto, PRECOS, ARQUIVO };
