/**
 * pendencias.js — lembra o que o bot perguntou, para entender a resposta.
 *
 * O bot é stateless: cada execução do n8n é isolada. Quando um ticket está
 * fora do prazo de 2h, ele pergunta "quer usar uma das validações fora do
 * prazo?" — e antes disto, um "SIM" do cliente chegava sem nada a que se
 * referir. A pergunta prometia uma interação que o sistema não sabia
 * completar (decisão nº 3 em aberto no ESTADO-ATUAL.md).
 *
 * Isto NÃO é uma máquina de estados de conversa genérica. É o mínimo para
 * fechar esse buraco: guarda a última pergunta feita a UMA pessoa em UM grupo,
 * com validade curta.
 *
 * Por que a chave é grupo + remetente, e não só o grupo: num grupo com várias
 * pessoas, dois clientes podem ter tickets pendentes ao mesmo tempo. Chavear
 * só pelo grupo faria o "SIM" de um validar o ticket do outro — ocupando vaga
 * e consumindo cota do hangar por um ticket que ninguém autorizou.
 *
 * Por que expira: um "sim" solto horas depois, sobre outro assunto, não pode
 * disparar validação. Passado o prazo, a pendência some e o bot pede a foto de
 * novo — custa uma repetição ao cliente, o que é bem mais barato que validar o
 * ticket errado.
 */

const path = require('path');
const { comTrava, salvarAtomico, lerJson } = require('./trava-arquivo');

const ARQUIVO = path.join(__dirname, '..', '..', 'data', 'pendencias.json');

// 30 minutos: folgado para quem está no celular e foi atender um cliente,
// curto o bastante para não sobreviver a uma troca de assunto.
const VALIDADE_MS = 30 * 60 * 1000;

function chaveDe(grupoId, remetenteId) {
  return `${grupoId}|${remetenteId || 'desconhecido'}`;
}

function expirada(p, agora = Date.now()) {
  return !p || !p.criadoEm || agora - p.criadoEm > VALIDADE_MS;
}

// Toda escrita já aproveita para varrer o que venceu: sem isso o arquivo
// cresceria para sempre com perguntas que ninguém respondeu.
function semExpiradas(estado, agora = Date.now()) {
  const limpo = {};
  for (const [k, v] of Object.entries(estado)) {
    if (!expirada(v, agora)) limpo[k] = v;
  }
  return limpo;
}

function registrar(grupoId, remetenteId, dados) {
  return comTrava(ARQUIVO, () => {
    const agora = Date.now();
    const estado = semExpiradas(lerJson(ARQUIVO, {}), agora);
    // Sobrescreve de propósito: se a pessoa mandou outra foto antes de
    // responder, a pergunta válida é a da foto nova.
    estado[chaveDe(grupoId, remetenteId)] = { ...dados, criadoEm: agora };
    salvarAtomico(ARQUIVO, estado);
    return estado[chaveDe(grupoId, remetenteId)];
  });
}

function buscar(grupoId, remetenteId) {
  const p = lerJson(ARQUIVO, {})[chaveDe(grupoId, remetenteId)];
  return expirada(p) ? null : p;
}

// Devolve a pendência E a remove, sob a mesma trava. Separar busca de remoção
// permitiria que duas mensagens quase simultâneas do mesmo cliente validassem
// o mesmo ticket duas vezes.
function consumir(grupoId, remetenteId) {
  return comTrava(ARQUIVO, () => {
    const agora = Date.now();
    const estado = semExpiradas(lerJson(ARQUIVO, {}), agora);
    const k = chaveDe(grupoId, remetenteId);
    const p = estado[k];
    if (!p) return null;
    delete estado[k];
    salvarAtomico(ARQUIVO, estado);
    return p;
  });
}

function descartar(grupoId, remetenteId) {
  return consumir(grupoId, remetenteId) !== null;
}

module.exports = { registrar, buscar, consumir, descartar, chaveDe, VALIDADE_MS };
