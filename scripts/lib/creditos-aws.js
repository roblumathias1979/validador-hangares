/**
 * creditos-aws.js — acompanha o CRÉDITO DA AWS (o plano gratuito cobre os custos
 * do servidor com crédito, e o crédito VENCE: o painel da AWS mostra o saldo e a
 * data final). A AWS não deixa o bot ler isso sem dar permissão de cobrança à
 * máquina, então a administração informa pelo WhatsApp ("crédito aws 79,52 até
 * 03/03/2027") e o bot guarda, conta os dias e estima o ritmo de gasto quando
 * há duas leituras. Estimativa: a fonte da verdade é o painel da AWS.
 */

const path = require('path');
const { comTrava, salvarAtomico, lerJson } = require('./trava-arquivo');

const ARQUIVO = path.join(__dirname, '..', '..', 'data', 'credito-aws.json');
const DIA = 86400000;

function definir(saldoUsd, validoAte = null, agora = Date.now()) {
  const valor = Number(saldoUsd);
  if (!Number.isFinite(valor) || valor < 0) throw new Error('Valor de crédito inválido.');
  return comTrava(ARQUIVO, () => {
    const d = lerJson(ARQUIVO, {});
    d.saldoUsd = valor;
    d.informadoEm = new Date(agora).toISOString();
    if (validoAte) d.validoAte = validoAte;
    d.historico = [...(d.historico || []), { em: d.informadoEm, saldoUsd: valor }].slice(-12);
    salvarAtomico(ARQUIVO, d);
    return d;
  });
}

/** Ritmo de gasto (US$/dia) a partir da sequência mais recente em QUEDA. */
function taxaDia(historico) {
  const h = historico || [];
  if (h.length < 2) return null;
  let ini = h.length - 1;
  while (ini > 0 && h[ini - 1].saldoUsd >= h[ini].saldoUsd) ini -= 1; // recuou até uma recarga
  const a = h[ini]; const b = h[h.length - 1];
  const dias = (new Date(b.em) - new Date(a.em)) / DIA;
  if (dias < 3 || b.saldoUsd >= a.saldoUsd) return null; // pouco tempo: estimativa ruim
  return (a.saldoUsd - b.saldoUsd) / dias;
}

function estado(agora = Date.now()) {
  const d = lerJson(ARQUIVO, {});
  if (typeof d.saldoUsd !== 'number') return null;
  // Diferença entre DATAS do calendário (hoje em São Paulo × data final), que é
  // como o painel da AWS conta: 09/10/2026 -> 03/03/2027 são 145 dias.
  const hoje = new Date(agora).toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const diasAteVencer = d.validoAte ? Math.round((Date.parse(`${d.validoAte}T00:00:00Z`) - Date.parse(`${hoje}T00:00:00Z`)) / DIA) : null;
  const diasDesdeInformado = Math.floor((agora - new Date(d.informadoEm)) / DIA);
  const taxa = taxaDia(d.historico);
  const diasDeSaldo = taxa ? d.saldoUsd / taxa : null;
  return { saldoUsd: d.saldoUsd, validoAte: d.validoAte || null, informadoEm: d.informadoEm, diasAteVencer, diasDesdeInformado, taxa, diasDeSaldo };
}

/** {cor, texto, problema} para o status. Pura. */
function avaliar(e) {
  if (!e) return { cor: '⚪', texto: 'Crédito AWS: não informado — mande *crédito aws 79,52 até 03/03/2027* (valores do painel da AWS)', problema: false };
  const usd = `US$ ${e.saldoUsd.toFixed(2).replace('.', ',')}`;
  const venc = e.validoAte ? `, vence ${e.validoAte.split('-').reverse().join('/')} (${e.diasAteVencer} dia(s))` : '';
  const ritmo = e.diasDeSaldo != null ? `; no ritmo atual dura ~${Math.floor(e.diasDeSaldo)} dia(s)` : '';
  const velho = e.diasDesdeInformado > 30 ? ` — informado há ${e.diasDesdeInformado} dias, confira o painel` : '';
  const acaba = (e.diasAteVencer != null && e.diasAteVencer <= 30) || e.saldoUsd <= 10 || (e.diasDeSaldo != null && e.diasDeSaldo <= 30);
  const atencao = (e.diasAteVencer != null && e.diasAteVencer <= 60) || e.diasDesdeInformado > 30 || (e.diasDeSaldo != null && e.diasAteVencer != null && e.diasDeSaldo < e.diasAteVencer);
  const cor = acaba ? '🔴' : atencao ? '🟡' : '🟢';
  return { cor, texto: `Crédito AWS: ${usd}${venc}${ritmo}${velho}`, problema: acaba };
}

module.exports = { definir, estado, avaliar, taxaDia };
