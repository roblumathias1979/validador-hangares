/**
 * armazenamento.js — o "sistema próprio" que acumula os fechamentos.
 *
 * Um arquivo JSONL append-only (mesmo padrão de data/validacoes.jsonl no
 * validador de hangares): cada linha é um fechamento processado, nunca
 * reescrita. O painel e o exportador de planilha só LEEM este arquivo.
 */

const fs = require('fs');
const path = require('path');

const DATA_PATH = path.join(__dirname, '..', '..', 'data', 'fechamentos.jsonl');

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

module.exports = { gravarFechamento, listarFechamentos, DATA_PATH };
