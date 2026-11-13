/**
 * agendamentos.js — ações de manutenção marcadas para um horário (reiniciar os
 * serviços, reiniciar o servidor, instalar atualizações), pedidas pela administração
 * no WhatsApp ("agendar reiniciar servidor domingo 03:00").
 *
 * Aqui ficam o cálculo do horário, o armazenamento (data/agendamentos.json, sob trava)
 * e a decisão do que fazer a cada minuto; quem executa é scripts/executar-agendamentos.js,
 * chamado por um timer do systemd a cada minuto.
 *
 * FUSO: horário de Brasília, -03:00 fixo (sem horário de verão desde 2019, o mesmo
 * que lib/fiscalizacao.js usa). O servidor roda em UTC; tudo que a pessoa digita é
 * lido como horário de Brasília e gravado em UTC (ISO).
 *
 * UMA VEZ SÓ: cada agendamento roda uma vez. Repetir é mandar o comando de novo.
 */

const path = require('path');
const crypto = require('crypto');
const { comTrava, salvarAtomico, lerJson } = require('./trava-arquivo');

const ARQUIVO = path.join(__dirname, '..', '..', 'data', 'agendamentos.json');

const OFFSET_H = 3;            // Brasília = UTC-3
const MAX_ATIVOS = 10;
const MAX_DIAS = 30;
const AVISO_MIN = 10;          // avisa o grupo X minutos antes
const TOLERANCIA_MIN = 15;     // atrasado mais que isto, NÃO executa (reinício fora de hora é pior que nenhum)
const RETENCAO_DIAS = 30;

const ACOES = {
  servidor: { rotulo: 'reiniciar o servidor', impacto: 'O bot, o painel e o WhatsApp ficam fora por 2 a 3 minutos.' },
  servicos: { rotulo: 'reiniciar os serviços', impacto: 'O bot, o painel e o WhatsApp ficam fora por cerca de 1 minuto.' },
  atualizar: { rotulo: 'instalar as atualizações do servidor', impacto: 'O bot pode ficar fora por 1 a 3 minutos durante a instalação.' },
};
const DIAS_SEMANA = ['domingo', 'segunda-feira', 'terça-feira', 'quarta-feira', 'quinta-feira', 'sexta-feira', 'sábado'];

// ------------------------------------------------------------------ horário

/** Componentes de uma data em horário de Brasília. */
function partes(data) {
  const d = new Date(data.getTime() - OFFSET_H * 3600000);
  return { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate(), hora: d.getUTCHours(), minuto: d.getUTCMinutes(), dow: d.getUTCDay() };
}

/** Data (UTC) correspondente a um horário de Brasília. */
function deBrasilia(ano, mes, dia, hora, minuto) {
  return new Date(Date.UTC(ano, mes - 1, dia, hora + OFFSET_H, minuto));
}

/**
 * Resolve "03:00 amanhã", "domingo 3h", "15/11 02:00" no próximo instante que existe.
 * `dia`: null | 'hoje' | 'amanha' | 'depois' | {dow} | {dia, mes, ano?}.
 * Devolve {quando, adiouParaAmanha} ou {erro}: hora_invalida | data_invalida | ja_passou | longe.
 */
function calcularQuando({ hora, minuto = 0, dia = null }, agora = new Date()) {
  if (!Number.isInteger(hora) || hora < 0 || hora > 23 || !Number.isInteger(minuto) || minuto < 0 || minuto > 59) return { erro: 'hora_invalida' };
  const h = partes(agora);
  const hojeBase = Date.UTC(h.ano, h.mes - 1, h.dia);
  const noDia = (base, somaDias) => { const d = new Date(base + somaDias * 86400000); return deBrasilia(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate(), hora, minuto); };
  let quando;
  let adiou = false;

  if (dia === null || dia === 'hoje') {
    quando = noDia(hojeBase, 0);
    if (quando.getTime() <= agora.getTime() + 60000) {
      if (dia === 'hoje') return { erro: 'ja_passou' };
      quando = noDia(hojeBase, 1);
      adiou = true; // sem dia dito e o horário de hoje já passou: vale amanhã (a confirmação mostra a data)
    }
  } else if (dia === 'amanha') quando = noDia(hojeBase, 1);
  else if (dia === 'depois') quando = noDia(hojeBase, 2);
  else if (typeof dia.dow === 'number') {
    let falta = (dia.dow - h.dow + 7) % 7;
    quando = noDia(hojeBase, falta);
    if (falta === 0 && quando.getTime() <= agora.getTime() + 60000) quando = noDia(hojeBase, 7);
  } else {
    let ano = dia.ano ? (dia.ano < 100 ? 2000 + dia.ano : dia.ano) : h.ano;
    const monta = (a) => { const d = new Date(Date.UTC(a, dia.mes - 1, dia.dia)); return d.getUTCMonth() === dia.mes - 1 && d.getUTCDate() === dia.dia ? deBrasilia(a, dia.mes, dia.dia, hora, minuto) : null; };
    quando = monta(ano);
    if (!quando) return { erro: 'data_invalida' };
    if (quando.getTime() <= agora.getTime() + 60000 && !dia.ano) { quando = monta(ano + 1); if (!quando) return { erro: 'data_invalida' }; }
    else if (quando.getTime() <= agora.getTime() + 60000) return { erro: 'ja_passou' };
  }
  if (quando.getTime() - agora.getTime() > MAX_DIAS * 86400000) return { erro: 'longe' };
  return { quando, adiouParaAmanha: adiou };
}

const dois = (n) => String(n).padStart(2, '0');

/** "domingo, 15/11 às 03:00 (daqui a 2 dias)". */
function formatarQuando(quando, agora = new Date()) {
  const p = partes(quando);
  const a = partes(agora);
  const dias = Math.round((Date.UTC(p.ano, p.mes - 1, p.dia) - Date.UTC(a.ano, a.mes - 1, a.dia)) / 86400000);
  const rel = dias === 0 ? 'hoje' : dias === 1 ? 'amanhã' : `daqui a ${dias} dias`;
  return `${DIAS_SEMANA[p.dow]}, ${dois(p.dia)}/${dois(p.mes)} às ${dois(p.hora)}:${dois(p.minuto)} (${rel})`;
}

// ------------------------------------------------------------- armazenamento

function lerTodos() { return lerJson(ARQUIVO, {}); }

function criar({ acao, quando, grupoId, quem = null }, agora = new Date()) {
  if (!ACOES[acao]) throw Object.assign(new Error('Ação desconhecida.'), { codigo: 'acao' });
  if (quando.getTime() <= agora.getTime()) throw Object.assign(new Error('O horário já passou.'), { codigo: 'passado' });
  if (quando.getTime() - agora.getTime() > MAX_DIAS * 86400000) throw Object.assign(new Error(`O limite é ${MAX_DIAS} dias à frente.`), { codigo: 'longe' });
  return comTrava(ARQUIVO, () => {
    const todos = lerTodos();
    const ativos = Object.values(todos).filter((j) => j.estado === 'pendente');
    if (ativos.length >= MAX_ATIVOS) throw Object.assign(new Error(`Já há ${MAX_ATIVOS} agendamentos ativos.`), { codigo: 'limite' });
    const iso = quando.toISOString();
    if (ativos.some((j) => j.acao === acao && j.quandoIso === iso)) throw Object.assign(new Error('Já existe esse agendamento.'), { codigo: 'duplicado' });
    const id = crypto.randomUUID();
    todos[id] = { id, acao, quandoIso: iso, grupoId, criadoPor: quem, criadoEm: agora.toISOString(), estado: 'pendente', avisadoEm: null, executadoEm: null, resultado: null };
    salvarAtomico(ARQUIVO, todos);
    return todos[id];
  });
}

function listarAtivos() {
  return Object.values(lerTodos()).filter((j) => j.estado === 'pendente').sort((a, b) => a.quandoIso.localeCompare(b.quandoIso));
}

/** Muda o estado de UM agendamento se ele ainda estiver no estado `de` (transição atômica). */
function transicao(id, de, para, extra = {}) {
  return comTrava(ARQUIVO, () => {
    const todos = lerTodos();
    const j = todos[id];
    if (!j || j.estado !== de) return null;
    todos[id] = { ...j, ...extra, estado: para };
    salvarAtomico(ARQUIVO, todos);
    return todos[id];
  });
}

function cancelar(id) { return transicao(id, 'pendente', 'cancelado', { executadoEm: new Date().toISOString() }); }

function cancelarTodos() {
  let n = 0;
  for (const j of listarAtivos()) if (cancelar(j.id)) n += 1;
  return n;
}

/** Marca o aviso de "daqui a X minutos" (uma vez só). */
function marcarAviso(id, agora = new Date()) {
  return comTrava(ARQUIVO, () => {
    const todos = lerTodos();
    const j = todos[id];
    if (!j || j.estado !== 'pendente' || j.avisadoEm) return null;
    todos[id] = { ...j, avisadoEm: agora.toISOString() };
    salvarAtomico(ARQUIVO, todos);
    return todos[id];
  });
}

/** O que fazer agora: {avisar, executar, perdidos}. Pura sobre o que está gravado. */
function classificar(agora = new Date()) {
  const r = { avisar: [], executar: [], perdidos: [] };
  for (const j of listarAtivos()) {
    const falta = new Date(j.quandoIso).getTime() - agora.getTime();
    if (falta > 0) {
      if (falta <= AVISO_MIN * 60000 && !j.avisadoEm) r.avisar.push(j);
    } else if (-falta <= TOLERANCIA_MIN * 60000) r.executar.push(j);
    else r.perdidos.push(j);
  }
  return r;
}

/** Apaga o que já acabou há mais de RETENCAO_DIAS (o histórico não cresce para sempre). */
function podar(agora = new Date()) {
  return comTrava(ARQUIVO, () => {
    const todos = lerTodos();
    const limite = agora.getTime() - RETENCAO_DIAS * 86400000;
    let n = 0;
    for (const [id, j] of Object.entries(todos)) {
      if (j.estado !== 'pendente' && new Date(j.executadoEm || j.quandoIso).getTime() < limite) { delete todos[id]; n += 1; }
    }
    if (n) salvarAtomico(ARQUIVO, todos);
    return n;
  });
}

module.exports = { ACOES, DIAS_SEMANA, MAX_ATIVOS, MAX_DIAS, AVISO_MIN, TOLERANCIA_MIN, ARQUIVO, partes, deBrasilia, calcularQuando, formatarQuando, criar, listarAtivos, transicao, cancelar, cancelarTodos, marcarAviso, classificar, podar };
