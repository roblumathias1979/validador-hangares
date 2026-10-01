/**
 * retiradas.js — pergunta pendente quando o Envelope vem MENOR do que o
 * esperado (dinheiro saiu do caixa além dos depósitos já registrados —
 * vale, compra de insumo, ou algo que precisa de explicação). Pedido do
 * usuário (30/09/2026): perguntar o motivo, perguntar se tem comprovante,
 * e se tiver, subir a foto e lançar junto do registro da retirada.
 *
 * Mesmo padrão de "pergunta pendente" que o validador de hangares usa
 * (pendencias.js/tickets-bloqueados.js): um arquivo JSON pequeno e MUTÁVEL
 * (não é o histórico — é o estado da conversa em andamento), uma pendência
 * por unidade por vez. O histórico de retiradas já resolvidas vai para
 * `data/retiradas.jsonl` (esse sim append-only, como os outros).
 *
 * Três estados, em sequência:
 *   aguardando_motivo       -> próxima mensagem de texto é o motivo
 *   aguardando_comprovante  -> próxima resposta é sim/não
 *   aguardando_foto         -> próxima FOTO é o comprovante (sim foi dito)
 */

const fs = require('fs');
const path = require('path');

/**
 * Quanto o Envelope deveria valer e qual a diferença real — pedido do
 * usuário (30/09→01/10/2026, caso real Vila Mariana): uma mesma mensagem
 * pode informar "Valor recebido" (soma ao Envelope) E uma retirada em
 * "outrosValores" (ex: "Vale Cláudio R$50") no mesmo texto. Comparar o
 * Envelope informado direto contra o saldo anterior, sem somar o recebido,
 * subestima a retirada: Envelope caiu só R$10 (214->204) porque os R$40
 * recebidos quase cobriram a retirada de R$50 — o esperado é
 * saldoAnterior + valorRecebido (254), não só saldoAnterior (214).
 */
function calcularDiferencaEnvelope({ saldoAnterior, valorRecebido, envelopeInformado }) {
  const envelopeEsperado = Number(((saldoAnterior || 0) + (valorRecebido || 0)).toFixed(2));
  const diferenca = Number((envelopeInformado - envelopeEsperado).toFixed(2));
  return { envelopeEsperado, diferenca };
}

const PENDENCIAS_PATH = path.join(__dirname, '..', '..', 'data', 'retiradas-pendentes.json');
const HISTORICO_PATH = path.join(__dirname, '..', '..', 'data', 'retiradas.jsonl');
const COMPROVANTES_DIR = path.join(__dirname, '..', '..', 'data', 'comprovantes-retirada');

function lerPendencias() {
  try {
    return JSON.parse(fs.readFileSync(PENDENCIAS_PATH, 'utf-8'));
  } catch (e) {
    return {};
  }
}

function gravarPendencias(mapa) {
  fs.mkdirSync(path.dirname(PENDENCIAS_PATH), { recursive: true });
  fs.writeFileSync(PENDENCIAS_PATH, JSON.stringify(mapa, null, 2));
}

function abrirPendencia(unidadeId, dados) {
  const mapa = lerPendencias();
  mapa[unidadeId] = {
    estado: 'aguardando_motivo',
    valorRetirada: dados.valorRetirada,
    complementoId: dados.complementoId,
    unidadeNome: dados.unidadeNome,
    grupoId: dados.grupoId,
    motivo: null,
    criadoEm: new Date().toISOString(),
  };
  gravarPendencias(mapa);
  return mapa[unidadeId];
}

function buscarPendencia(unidadeId) {
  return lerPendencias()[unidadeId] || null;
}

function atualizarPendencia(unidadeId, patch) {
  const mapa = lerPendencias();
  if (!mapa[unidadeId]) return null;
  mapa[unidadeId] = { ...mapa[unidadeId], ...patch };
  gravarPendencias(mapa);
  return mapa[unidadeId];
}

function encerrarPendencia(unidadeId, resultadoFinal) {
  const mapa = lerPendencias();
  const pendencia = mapa[unidadeId];
  delete mapa[unidadeId];
  gravarPendencias(mapa);

  fs.mkdirSync(path.dirname(HISTORICO_PATH), { recursive: true });
  const registro = { unidadeId, ...pendencia, ...resultadoFinal, resolvidoEm: new Date().toISOString() };
  fs.appendFileSync(HISTORICO_PATH, `${JSON.stringify(registro)}\n`);
  return registro;
}

function listarHistorico({ unidadeId } = {}) {
  if (!fs.existsSync(HISTORICO_PATH)) return [];
  return fs.readFileSync(HISTORICO_PATH, 'utf-8')
    .split('\n')
    .filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
    .filter(Boolean)
    .filter((r) => !unidadeId || r.unidadeId === unidadeId)
    .reverse();
}

/** Salva os bytes do comprovante em disco e devolve o caminho relativo gravado. */
function salvarComprovante(unidadeId, { base64, mediaType }) {
  fs.mkdirSync(path.join(COMPROVANTES_DIR, unidadeId), { recursive: true });
  const ext = (mediaType || 'image/jpeg').split('/')[1] || 'jpg';
  const nome = `${Date.now()}.${ext}`;
  const caminho = path.join(COMPROVANTES_DIR, unidadeId, nome);
  fs.writeFileSync(caminho, Buffer.from(base64, 'base64'));
  return path.relative(path.join(__dirname, '..', '..'), caminho);
}

// Mesma lista restrita de sim/não do validador de hangares (scripts/lib/
// whatsapp.js) — "ok" ou um emoji não contam como resposta, porque decide
// se vai pedir foto ou encerrar a pendência sem comprovante.
const AFIRMATIVAS = ['sim', 's', 'tenho', 'tem', 'tem sim'];
const NEGATIVAS = ['nao', 'não', 'n', 'nao tenho', 'não tenho', 'sem comprovante'];

function interpretarSimNao(texto) {
  const t = String(texto || '').trim().toLowerCase().replace(/[!.,;]+$/, '');
  if (AFIRMATIVAS.includes(t)) return 'sim';
  if (NEGATIVAS.includes(t)) return 'nao';
  return null;
}

module.exports = {
  calcularDiferencaEnvelope,
  abrirPendencia, buscarPendencia, atualizarPendencia, encerrarPendencia,
  listarHistorico, salvarComprovante, interpretarSimNao,
  PENDENCIAS_PATH, HISTORICO_PATH,
};
