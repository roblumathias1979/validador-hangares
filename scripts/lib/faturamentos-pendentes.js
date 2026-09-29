/**
 * faturamentos-pendentes.js — cobranças que esperam o AVAL do admin.
 *
 * Regra fechada pelo usuário em 29/09/2026: ticket vencido sem cota pode ser
 * faturado, mas o boleto (Asaas, PRODUÇÃO, dinheiro real) só é emitido DEPOIS
 * de o admin autorizar no privado. O cliente manda a foto de autorização; isso
 * cria um registro AQUI, que fica aguardando; o admin aprova; só então o Asaas
 * emite e a validação é liberada.
 *
 * A foto do cliente é o "quem mandou cobrar"; o SIM do admin é o "pode cobrar".
 * São duas autorizações distintas, e o boleto exige as duas — por isso o valor
 * fica guardado aqui, calculado no pedido, e o Asaas só é chamado no aval.
 *
 * NÃO é apagado ao concluir: uma cobrança emitida é dinheiro, e o registro de
 * quem pediu, quem aprovou e quando é o que se audita depois.
 */

const path = require('path');
const crypto = require('crypto');
const { comTrava, salvarAtomico, lerJson } = require('./trava-arquivo');

const ARQUIVO = path.join(__dirname, '..', '..', 'data', 'faturamentos-pendentes.json');
const RETENCAO_MS = 90 * 24 * 3600 * 1000; // dado financeiro: guarda 90 dias

function enfileirar(pedido) {
  return comTrava(ARQUIVO, () => {
    const todos = lerJson(ARQUIVO, {});
    const id = crypto.randomUUID();
    todos[id] = {
      id,
      ticket: pedido.ticket,
      hangarId: pedido.hangarId || null,
      grupoId: pedido.grupoId || null,
      valor: pedido.valor ?? null,
      horasDecorridas: pedido.horasDecorridas ?? null,
      fotoMsgId: pedido.fotoMsgId || null,      // referência da foto de autorização
      solicitadoPor: pedido.solicitadoPor || null,
      estado: 'aguardando_admin',
      criadoEm: new Date().toISOString(),
      decididoPor: null,
      decididoEm: null,
      resultado: null,                          // dados do boleto, quando emitido
    };
    salvarAtomico(ARQUIVO, todos);
    return todos[id];
  });
}

function estaAguardando(id) {
  const f = lerJson(ARQUIVO, {})[id];
  return f && f.estado === 'aguardando_admin' ? f : null;
}

/** Por ticket, o faturamento que ainda espera decisão (para o admin citar o número). */
function aguardandoPorTicket(ticket) {
  return Object.values(lerJson(ARQUIVO, {}))
    .find((f) => f.estado === 'aguardando_admin' && f.ticket === ticket) || null;
}

/** O mais recente aguardando — para o "SIM" sem número referir-se ao que chegou. */
function maisRecenteAguardando() {
  return Object.values(lerJson(ARQUIVO, {}))
    .filter((f) => f.estado === 'aguardando_admin')
    .sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm)))[0] || null;
}

/**
 * Marca a decisão. `aprovado` true guarda o resultado do boleto; false apenas
 * registra a recusa. Quem EMITE o boleto é quem chama, antes de marcar — este
 * módulo só guarda o desfecho.
 */
function decidir(id, { aprovado, quem, resultado }) {
  return comTrava(ARQUIVO, () => {
    const todos = lerJson(ARQUIVO, {});
    const f = todos[id];
    if (!f) throw new Error(`Faturamento ${id} não encontrado.`);
    if (f.estado !== 'aguardando_admin') throw new Error(`Faturamento ${id} já foi ${f.estado}.`);
    f.estado = aprovado ? 'faturado' : 'recusado';
    f.decididoPor = quem || null;
    f.decididoEm = new Date().toISOString();
    if (resultado) f.resultado = resultado;
    const limite = Date.now() - RETENCAO_MS;
    for (const [k, x] of Object.entries(todos)) {
      if (x.decididoEm && new Date(x.decididoEm).getTime() < limite) delete todos[k];
    }
    salvarAtomico(ARQUIVO, todos);
    return f;
  });
}

function listar() {
  return Object.values(lerJson(ARQUIVO, {}))
    .sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm)));
}

module.exports = { enfileirar, estaAguardando, aguardandoPorTicket, maisRecenteAguardando, decidir, listar, ARQUIVO };
