/**
 * cenario.js — monta o estado que um teste precisa, e devolve tudo no fim.
 *
 * POR QUE ISTO EXISTE
 * Os testes leem config/hangares.json e os arquivos de data/, que são REAIS: o
 * config é versionado e o painel o edita o tempo todo. Cada vez que uma chave
 * mudou em produção, testes quebraram sem nada de errado no sistema —
 * `exigeFotoVeiculoNoLocal` derrubou treze asserções de uma vez, e
 * `perguntarIdentificacao` derrubou cinco arquivos inteiros.
 *
 * Teste que depende de decisão operacional não testa a regra: testa a
 * configuração de hoje. Aqui cada um declara o que precisa, e o que não declara
 * fica no padrão previsível — não no que estiver ligado no painel.
 *
 * A restauração é registrada em `process.on('exit')` além do finally: config é
 * versionado, e um teste que morra no meio não pode deixá-lo sujo.
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const CONFIG = 'config/hangares.json';
const DADOS = ['data/validacoes.jsonl', 'data/pendencias.json', 'data/fotos-usadas.json', 'data/aviso-patio.json'];

// Estado de um hangar "comum": sem pergunta nenhuma, sem cota, sem foto. É o
// ponto de partida de quase todo teste, e declarar o contrário é explícito.
const PADRAO = {
  perguntarIdentificacao: false,
  exigeFotoVeiculoNoLocal: false,
  placaObrigatoria: false,
};

/**
 * @param {object} hangares  { solojet: { cotaMensalValidacoes: 20 }, ... }
 *   Cada chave é um id de hangar; o valor sobrescreve campos dele. Os campos de
 *   PADRAO são aplicados antes, então só é preciso citar o que foge do comum.
 * @param {boolean} zerarDados  esvazia histórico, pendências e fotos usadas.
 */
function montar({ hangares = {}, zerarDados = true } = {}) {
  const guardado = {};
  for (const arquivo of [CONFIG, ...DADOS]) {
    const p = path.join(RAIZ, arquivo);
    guardado[arquivo] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
  }

  let restaurado = false;
  const restaurar = () => {
    if (restaurado) return;
    restaurado = true;
    for (const [arquivo, conteudo] of Object.entries(guardado)) {
      const p = path.join(RAIZ, arquivo);
      if (conteudo === null) { try { fs.unlinkSync(p); } catch (e) { /* já não existe */ } }
      else fs.writeFileSync(p, conteudo);
    }
  };
  process.on('exit', restaurar);
  process.on('uncaughtException', (e) => { restaurar(); console.error(e); process.exit(1); });

  const cfg = JSON.parse(guardado[CONFIG]);
  for (const h of cfg.hangares) Object.assign(h, PADRAO);
  for (const [id, campos] of Object.entries(hangares)) {
    const h = cfg.hangares.find((x) => x.id === id);
    if (!h) throw new Error(`Cenário pede o hangar "${id}", que não existe no config.`);
    Object.assign(h, campos);
  }
  fs.writeFileSync(path.join(RAIZ, CONFIG), `${JSON.stringify(cfg, null, 2)}\n`);

  if (zerarDados) {
    for (const arquivo of DADOS) {
      fs.mkdirSync(path.dirname(path.join(RAIZ, arquivo)), { recursive: true });
      fs.writeFileSync(path.join(RAIZ, arquivo), arquivo.endsWith('.jsonl') ? '' : '{}');
    }
  }

  return { restaurar, RAIZ };
}

module.exports = { montar, RAIZ, PADRAO };
