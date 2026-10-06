/**
 * consultas-pendentes.js — fila de CONSULTAS de histórico que o COLETOR executa.
 *
 * Mesma ideia da fila de validações: o bot (na AWS) não alcança o TECHPARKING;
 * quem alcança é o coletor, no aeroporto. Então o bot ENFILEIRA a consulta de
 * movimentação (entrada/saída de credenciados), o coletor puxa, consulta o
 * histórico + o cadastro, filtra pelo hangar e devolve o resultado já pronto.
 *
 * É leitura (não muda nada no TECHPARKING), então não há risco de duplicar —
 * mas ainda marca 'processando' para duas leituras não pegarem a mesma consulta.
 * Retenção curta: consulta é efêmera, o bot lê o resultado e pronto.
 */

const path = require('path');
const crypto = require('crypto');
const { comTrava, salvarAtomico, lerJson } = require('./trava-arquivo');

const ARQUIVO = path.join(__dirname, '..', '..', 'data', 'consultas-pendentes.json');
const REENTREGA_MS = 2 * 60 * 1000;   // 'processando' parado além disso volta à fila
const RETENCAO_MS = 30 * 60 * 1000;   // resultados somem depois disso

function enfileirar(pedido) {
  return comTrava(ARQUIVO, () => {
    const todas = lerJson(ARQUIVO, {});
    const id = crypto.randomUUID();
    todas[id] = {
      id,
      tipo: pedido.tipo === 'tudo' ? 'tudo' : 'credenciados', // o que mostrar
      grupoBolsao: pedido.grupoBolsao || null,                // bolsão do hangar, ou null = todos
      hangarId: pedido.hangarId || null,
      grupoId: pedido.grupoId || null,                        // quem perguntou (grupo do WhatsApp)
      dataini: pedido.dataini,                                // "YYYY-MM-DD HH:MM:SS"
      dataend: pedido.dataend,
      estado: 'pendente',
      criadoEm: new Date().toISOString(),
      entregueEm: null,
      concluidoEm: null,
      resultado: null, // { ok, movimentos: [{datahora,evento,cartao,nome,grupo}], total, resposta? }
    };
    salvarAtomico(ARQUIVO, todas);
    return todas[id];
  });
}

function retirarParaProcessar() {
  return comTrava(ARQUIVO, () => {
    const todas = lerJson(ARQUIVO, {});
    const agora = Date.now();
    const lista = [];
    for (const v of Object.values(todas)) {
      if (v.estado === 'processando' && v.entregueEm
          && agora - new Date(v.entregueEm).getTime() > REENTREGA_MS) {
        v.estado = 'pendente';
      }
      if (v.estado === 'pendente') {
        v.estado = 'processando';
        v.entregueEm = new Date().toISOString();
        lista.push({ ...v });
      }
    }
    salvarAtomico(ARQUIVO, todas);
    return lista;
  });
}

function registrarResultado(id, resultado) {
  return comTrava(ARQUIVO, () => {
    const todas = lerJson(ARQUIVO, {});
    const v = todas[id];
    if (!v) return null;
    v.estado = resultado && resultado.ok ? 'feito' : 'erro';
    v.concluidoEm = new Date().toISOString();
    v.resultado = resultado || { ok: false };
    const limite = Date.now() - RETENCAO_MS;
    for (const [k, x] of Object.entries(todas)) {
      if (x.concluidoEm && new Date(x.concluidoEm).getTime() < limite) delete todas[k];
    }
    salvarAtomico(ARQUIVO, todas);
    return v;
  });
}

/** Leitura de uma consulta pelo id — o bot acompanha a sua enquanto espera. */
function consultar(id) {
  return lerJson(ARQUIVO, {})[id] || null;
}

function listar() {
  return Object.values(lerJson(ARQUIVO, {}))
    .sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm)));
}

module.exports = { enfileirar, retirarParaProcessar, registrarResultado, consultar, listar, ARQUIVO, REENTREGA_MS };
