/**
 * armazenamento.js — o "sistema próprio" que acumula os fechamentos.
 *
 * Dois arquivos JSONL append-only (mesmo padrão de data/validacoes.jsonl no
 * validador de hangares): cada linha é um registro processado, nunca
 * reescrita. O painel e o exportador de planilha só LEEM esses arquivos.
 *
 *   fechamentos.jsonl  — um registro por FOTO de relatório processada.
 *   complementos.jsonl — um registro por mensagem de TEXTO complementando
 *                        valores escritos à mão (ex: "Envelope R$214,00") —
 *                        ver scripts/lib/texto-fechamento.js.
 */

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', '..', 'data', 'fechamentos.jsonl');
const DATA_PATH_COMPLEMENTOS = path.join(__dirname, '..', '..', 'data', 'complementos.jsonl');
const DATA_PATH_AUDITORIAS = path.join(__dirname, '..', '..', 'data', 'auditorias.jsonl');

function gravarFechamento(registro) {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  // Uma única chamada de write (append) é atômica o bastante para uma linha
  // deste tamanho — mesma lógica já usada no restante do projeto para JSONL.
  fs.appendFileSync(DATA_PATH, `${JSON.stringify(registro)}\n`);
  return registro;
}

function listarFechamentos({ unidadeId, desde, ate, apenasInconsistentes } = {}) {
  if (!fs.existsSync(DATA_PATH)) return [];
  return fs.readFileSync(DATA_PATH, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((linha) => {
      try { return JSON.parse(linha); } catch (e) { return null; }
    })
    .filter(Boolean)
    .filter((r) => !unidadeId || r.unidadeId === unidadeId)
    .filter((r) => !desde || r.criadoEm >= desde)
    .filter((r) => !ate || r.criadoEm <= ate)
    .filter((r) => !apenasInconsistentes || (r.conferenciaInterna || {}).status === 'inconsistente' || (r.conferenciaMaquininha || {}).status === 'a_conferir')
    .reverse(); // mais recente primeiro, é o que interessa a quem confere
}

/**
 * Detecta se um fechamento (nº impresso no relatório) JÁ foi registrado
 * para aquela unidade — caso real (30/09/2026): a mesma foto da Vila
 * Mariana (nº 1327) foi mandada 3 vezes em 4 minutos e virou 3 registros
 * idênticos, inflando o total de dinheiro/faturamento em 3x.
 *
 * Só considera fechamentos NÃO-parciais como "já registrado": um PARCIAL
 * com o mesmo número é o caixa ainda aberto, não uma repetição (ele nem
 * entra nas somas de armazenamento.js/consulta-caixa.js, que já filtram
 * `situacao !== 'parcial'`).
 */
function fechamentoJaExiste(unidadeId, numero) {
  const alvo = String(numero || '').trim();
  if (!alvo) return false;
  return listarFechamentos({ unidadeId }).some(
    (f) => (f.relatorio || {}).situacao !== 'parcial' && String((f.relatorio || {}).numero || '').trim() === alvo
  );
}

function gravarComplemento(registro) {
  fs.mkdirSync(path.dirname(DATA_PATH_COMPLEMENTOS), { recursive: true });
  fs.appendFileSync(DATA_PATH_COMPLEMENTOS, `${JSON.stringify(registro)}\n`);
  return registro;
}

function listarComplementos({ unidadeId } = {}) {
  if (!fs.existsSync(DATA_PATH_COMPLEMENTOS)) return [];
  return fs.readFileSync(DATA_PATH_COMPLEMENTOS, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((linha) => {
      try { return JSON.parse(linha); } catch (e) { return null; }
    })
    .filter(Boolean)
    .filter((r) => !unidadeId || r.unidadeId === unidadeId)
    .reverse();
}

function gravarAuditoria(registro) {
  fs.mkdirSync(path.dirname(DATA_PATH_AUDITORIAS), { recursive: true });
  fs.appendFileSync(DATA_PATH_AUDITORIAS, `${JSON.stringify(registro)}\n`);
  return registro;
}

function listarAuditorias({ unidadeId } = {}) {
  if (!fs.existsSync(DATA_PATH_AUDITORIAS)) return [];
  return fs.readFileSync(DATA_PATH_AUDITORIAS, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((linha) => {
      try { return JSON.parse(linha); } catch (e) { return null; }
    })
    .filter(Boolean)
    .filter((r) => !unidadeId || r.unidadeId === unidadeId)
    .reverse();
}

function round2(v) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

/**
 * Controle de dinheiro por unidade (pedido do usuário, 30/09/2026): dinheiro
 * normalmente NÃO é depositado todo dia — vai se acumulando num "Envelope"
 * físico que a própria unidade também usa para vales e compra de insumos.
 * Por isso NÃO dá para confiar só na nossa soma (recebido − depósito): a
 * unidade sabe o saldo físico real, e manda por texto (ex: "Envelope
 * R$214,00" — ver texto-fechamento.js). Esse valor é o CHECKPOINT: a partir
 * dele, só contamos o que aconteceu DEPOIS (novos fechamentos em dinheiro e
 * depósitos bancários); antes disso, confiamos no que a unidade informou.
 * Sem nenhum checkpoint ainda, o ponto de partida é zero — a soma passa a
 * ser só uma estimativa (pode não bater com vales/compras que não vemos).
 *
 * `unidadesConfig` (opcional, lista de config/unidades.json): garante que
 * TODA unidade cadastrada apareça no resultado, mesmo sem nenhum fechamento
 * ainda (zerada), e carrega o `cofre` de cada uma — usado pelo painel para
 * oferecer seleção por grupo de unidades que compartilham um cofre físico.
 */
function totalDinheiroPorUnidade(unidadesConfig = []) {
  const fechamentos = listarFechamentos().filter((f) => (f.relatorio || {}).situacao !== 'parcial');
  const complementos = listarComplementos();

  const unidades = new Map(); // unidadeId -> { unidadeId, unidadeNome, cofre }
  for (const u of unidadesConfig) {
    unidades.set(u.id, { unidadeId: u.id, unidadeNome: u.nome, cofre: u.cofre || null });
  }
  for (const f of fechamentos) {
    if (!unidades.has(f.unidadeId)) unidades.set(f.unidadeId, { unidadeId: f.unidadeId, unidadeNome: f.unidadeNome, cofre: null });
  }
  for (const c of complementos) {
    if (!unidades.has(c.unidadeId)) unidades.set(c.unidadeId, { unidadeId: c.unidadeId, unidadeNome: c.unidadeNome, cofre: null });
  }

  const resultado = [];
  for (const { unidadeId, unidadeNome, cofre } of unidades.values()) {
    const fechamentosDaUnidade = fechamentos.filter((f) => f.unidadeId === unidadeId);
    const complementosDaUnidade = complementos
      .filter((c) => c.unidadeId === unidadeId && typeof c.envelope === 'number')
      .sort((a, b) => a.criadoEm.localeCompare(b.criadoEm));

    const ultimoCheckpoint = complementosDaUnidade.length
      ? complementosDaUnidade[complementosDaUnidade.length - 1]
      : null;
    const dataCheckpoint = ultimoCheckpoint ? ultimoCheckpoint.criadoEm : null;
    const valorCheckpoint = ultimoCheckpoint ? ultimoCheckpoint.envelope : 0;

    let totalRecebido = 0;
    let totalDepositado = 0;
    let quantidadeFechamentos = 0;

    for (const f of fechamentosDaUnidade) {
      if (dataCheckpoint && f.criadoEm <= dataCheckpoint) continue; // já contado no checkpoint

      const dinheiro = (f.relatorio || {}).recebidoDinheiro ?? (f.relatorio || {}).dinheiroCaixa;
      if (typeof dinheiro === 'number') totalRecebido = round2(totalRecebido + dinheiro);
      quantidadeFechamentos += 1;

      const anexo = f.documentoAnexo || {};
      if (anexo.tipo === 'deposito_bancario' && typeof (anexo.deposito || {}).valor === 'number') {
        totalDepositado = round2(totalDepositado + anexo.deposito.valor);
      }
    }

    resultado.push({
      unidadeId,
      unidadeNome,
      cofre,
      quantidadeFechamentos,
      totalRecebido,
      totalDepositado,
      saldoEmCaixa: round2(valorCheckpoint + totalRecebido - totalDepositado),
      ultimoCheckpoint: ultimoCheckpoint ? { data: ultimoCheckpoint.criadoEm, envelope: ultimoCheckpoint.envelope } : null,
    });
  }

  return resultado.sort((a, b) => (a.unidadeNome || '').localeCompare(b.unidadeNome || '', 'pt-BR'));
}

// "AAAA-MM-DD" 00:00 em São Paulo (UTC-3 fixo, sem horário de verão desde
// 2019 — mesmo raciocínio de auditar-dia-anterior.js) = 03:00 UTC do MESMO
// dia; 23:59:59.999 em São Paulo = 02:59:59.999 UTC do dia SEGUINTE.
function inicioDiaSaoPauloEmUTC(dataISO) {
  return `${dataISO}T03:00:00.000Z`;
}
function fimDiaSaoPauloEmUTC(dataISO) {
  const d = new Date(`${dataISO}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  d.setUTCHours(2, 59, 59, 999);
  return d.toISOString();
}

/**
 * Dinheiro RECEBIDO num período (pedido do usuário, 30/09/2026: consulta no
 * privado tipo "quanto faturou de dinheiro X de período Y a Z" — ver
 * scripts/consultar-caixa.js). Diferente de totalDinheiroPorUnidade: aqui
 * NÃO tem checkpoint — é só a soma do que foi recebido em dinheiro em cada
 * fechamento (foto) ou complemento (texto) DENTRO do período, então serve
 * tanto para "ontem" quanto "mês passado".
 *
 * Limitação conhecida: se um mesmo dia tiver FOTO (recebidoDinheiro) E TEXTO
 * (valorRecebido) para a mesma unidade, os dois entram na soma — ainda não
 * dá para saber se o texto era só complemento do Envelope ou repetia o
 * valor já recebido na foto (ver scripts/lib/texto-fechamento.js).
 */
function dinheiroRecebidoNoPeriodo({ unidadeIds, desde, ate }) {
  const inicio = desde ? inicioDiaSaoPauloEmUTC(desde) : null;
  const fim = ate ? fimDiaSaoPauloEmUTC(ate) : null;
  const dentroDoPeriodo = (criadoEm) => (!inicio || criadoEm >= inicio) && (!fim || criadoEm <= fim);

  const porUnidade = new Map(unidadeIds.map((id) => [id, 0]));

  for (const f of listarFechamentos()) {
    if ((f.relatorio || {}).situacao === 'parcial') continue;
    if (!porUnidade.has(f.unidadeId) || !dentroDoPeriodo(f.criadoEm)) continue;
    const dinheiro = (f.relatorio || {}).recebidoDinheiro ?? (f.relatorio || {}).dinheiroCaixa;
    if (typeof dinheiro === 'number') porUnidade.set(f.unidadeId, round2(porUnidade.get(f.unidadeId) + dinheiro));
  }

  for (const c of listarComplementos()) {
    if (!porUnidade.has(c.unidadeId) || !dentroDoPeriodo(c.criadoEm)) continue;
    if (typeof c.valorRecebido === 'number') porUnidade.set(c.unidadeId, round2(porUnidade.get(c.unidadeId) + c.valorRecebido));
  }

  const total = round2([...porUnidade.values()].reduce((a, b) => a + b, 0));
  return { porUnidade: Object.fromEntries(porUnidade), total };
}

module.exports = {
  gravarFechamento, listarFechamentos, fechamentoJaExiste,
  gravarComplemento, listarComplementos,
  gravarAuditoria, listarAuditorias,
  totalDinheiroPorUnidade, dinheiroRecebidoNoPeriodo,
  DATA_PATH, DATA_PATH_COMPLEMENTOS, DATA_PATH_AUDITORIAS,
};
