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
 */
function totalDinheiroPorUnidade() {
  const fechamentos = listarFechamentos().filter((f) => (f.relatorio || {}).situacao !== 'parcial');
  const complementos = listarComplementos();

  const unidades = new Map(); // unidadeId -> { unidadeId, unidadeNome }
  for (const f of fechamentos) {
    if (!unidades.has(f.unidadeId)) unidades.set(f.unidadeId, { unidadeId: f.unidadeId, unidadeNome: f.unidadeNome });
  }
  for (const c of complementos) {
    if (!unidades.has(c.unidadeId)) unidades.set(c.unidadeId, { unidadeId: c.unidadeId, unidadeNome: c.unidadeNome });
  }

  const resultado = [];
  for (const { unidadeId, unidadeNome } of unidades.values()) {
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
      quantidadeFechamentos,
      totalRecebido,
      totalDepositado,
      saldoEmCaixa: round2(valorCheckpoint + totalRecebido - totalDepositado),
      ultimoCheckpoint: ultimoCheckpoint ? { data: ultimoCheckpoint.criadoEm, envelope: ultimoCheckpoint.envelope } : null,
    });
  }

  return resultado.sort((a, b) => (a.unidadeNome || '').localeCompare(b.unidadeNome || '', 'pt-BR'));
}

module.exports = {
  gravarFechamento, listarFechamentos,
  gravarComplemento, listarComplementos,
  totalDinheiroPorUnidade,
  DATA_PATH, DATA_PATH_COMPLEMENTOS,
};
