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

    // UM pedido por ticket. Sem isto, o mesmo ticket pedido duas vezes (duas
    // pessoas do grupo com o mesmo papel, ou a foto de autorização repetida)
    // virava dois pedidos idênticos na fila do admin — em 09/10/2026 o admin
    // viu "010610125049 — voasp, faturar R$ 55,00" duas vezes, e o "NÃO" sem
    // número não agia em nenhum (com mais de um pedido o bot exige o número).
    // O segundo pedido recebe o MESMO registro, sob a mesma trava (sem corrida).
    const existente = Object.values(todos).find((f) => f.estado === 'aguardando_admin' && String(f.ticket) === String(pedido.ticket));
    if (existente) return { ...existente, jaExistia: true };

    const id = crypto.randomUUID();
    todos[id] = {
      id,
      ticket: pedido.ticket,
      hangarId: pedido.hangarId || null,
      grupoId: pedido.grupoId || null,
      valor: pedido.valor ?? null,
      horasDecorridas: pedido.horasDecorridas ?? null,
      motivo: pedido.motivo || null,            // 'patio_cheio' ou 'fora_do_prazo'
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

/** O ticket já tem um boleto REAL emitido? (defesa contra cobrar duas vezes) */
function jaFaturado(ticket) {
  return Object.values(lerJson(ARQUIVO, {}))
    .find((f) => f.estado === 'faturado' && String(f.ticket) === String(ticket) && !(f.resultado && f.resultado.simulado)) || null;
}

/** Os que aguardam decisão, UM por ticket (o mais antigo): pedidos duplicados contam como um. */
function aguardandoUnicos() {
  const vistos = new Set();
  return Object.values(lerJson(ARQUIVO, {}))
    .filter((f) => f.estado === 'aguardando_admin')
    .sort((a, b) => String(a.criadoEm).localeCompare(String(b.criadoEm)))
    .filter((f) => { const k = String(f.ticket); if (vistos.has(k)) return false; vistos.add(k); return true; });
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
    // Um ticket, uma decisão: fecha os pedidos IRMÃOS (mesmo ticket, ainda
    // aguardando) — herdados de antes da trava acima, ou nascidos numa corrida.
    // Sem isto, aprovar um deixaria o outro na fila, pronto para um segundo
    // SIM e um segundo boleto pelo mesmo ticket.
    for (const x of Object.values(todos)) {
      if (x.id !== id && x.estado === 'aguardando_admin' && String(x.ticket) === String(f.ticket)) {
        x.estado = 'duplicado';
        x.decididoPor = quem || null;
        x.decididoEm = f.decididoEm;
        x.resultado = { duplicadoDe: id };
      }
    }
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

module.exports = { enfileirar, estaAguardando, aguardandoPorTicket, aguardandoUnicos, jaFaturado, maisRecenteAguardando, decidir, listar, ARQUIVO };
