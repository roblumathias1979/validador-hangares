/**
 * trava-arquivo.js — exclusão mútua entre processos, para estado em arquivo.
 *
 * Extraído de cota-fora-prazo.js em 15/09/2026, quando as pendências de
 * conversa passaram a precisar da mesma coisa. Copiar as ~30 linhas seria
 * criar uma segunda fonte para a mesma lógica — o padrão que já custou caro
 * neste projeto (a tabela GRUPO_PARA_HANGAR duplicada no workflow, que ficou
 * fora de sincronia e deixou produção quebrada por semanas).
 *
 * Os scripts são CLIs de vida curta chamados pelo n8n, e dois podem rodar ao
 * mesmo tempo para o mesmo hangar. Sem trava, leitura+escrita concorrentes
 * perdem incrementos; sem gravação atômica, um processo morto no meio do
 * writeFileSync deixa o JSON truncado.
 */

const fs = require('fs');
const path = require('path');

// Depois disso a trava é considerada abandonada (processo morreu sem liberar).
// Folgado em relação ao trabalho real, que é ler e gravar um JSON pequeno.
const TRAVA_ABANDONADA_MS = 10000;
// Tempo máximo esperando a vez antes de desistir com erro.
const TRAVA_ESPERA_MAX_MS = 15000;

// Pausa síncrona. Não há loop de eventos a proteger: são processos de vida
// curta, e a alternativa assíncrona complicaria quem chama sem ganho real.
function dormir(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Executa `fn` com exclusão mútua sobre `arquivoEstado`.
 *
 * O open com flag 'wx' falha se o arquivo já existe, e essa checagem-e-criação
 * é atômica no sistema de arquivos — é o que garante que só um processo entra
 * por vez.
 */
function comTrava(arquivoEstado, fn) {
  const arquivoTrava = `${arquivoEstado}.lock`;
  fs.mkdirSync(path.dirname(arquivoEstado), { recursive: true });
  const inicio = Date.now();
  let fd = null;

  while (fd === null) {
    try {
      fd = fs.openSync(arquivoTrava, 'wx');
    } catch (erro) {
      if (erro.code !== 'EEXIST') throw erro;

      let idade = 0;
      try {
        idade = Date.now() - fs.statSync(arquivoTrava).mtimeMs;
      } catch (e) {
        continue; // sumiu entre o open e o stat: tenta pegar de novo
      }
      if (idade > TRAVA_ABANDONADA_MS) {
        try { fs.unlinkSync(arquivoTrava); } catch (e) { /* outro já removeu */ }
        continue;
      }
      if (Date.now() - inicio > TRAVA_ESPERA_MAX_MS) {
        throw new Error(
          `Não consegui obter a trava (${arquivoTrava}) em ${TRAVA_ESPERA_MAX_MS}ms. ` +
          'Se nenhum outro processo estiver rodando, apague esse arquivo à mão.'
        );
      }
      dormir(50);
    }
  }

  try {
    fs.writeSync(fd, `${process.pid}`);
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch (e) { /* ignora */ }
    try { fs.unlinkSync(arquivoTrava); } catch (e) { /* ignora */ }
  }
}

/**
 * Gravação atômica: escreve num temporário e renomeia. O rename é atômico no
 * mesmo sistema de arquivos, então nunca existe um instante em que o arquivo
 * está pela metade no disco.
 */
function salvarAtomico(arquivoEstado, objeto) {
  fs.mkdirSync(path.dirname(arquivoEstado), { recursive: true });
  const temporario = `${arquivoEstado}.${process.pid}.tmp`;
  fs.writeFileSync(temporario, JSON.stringify(objeto, null, 2));
  fs.renameSync(temporario, arquivoEstado);
}

function lerJson(arquivoEstado, padrao = {}) {
  try {
    return JSON.parse(fs.readFileSync(arquivoEstado, 'utf-8'));
  } catch (e) {
    return padrao;
  }
}

module.exports = { comTrava, salvarAtomico, lerJson, TRAVA_ABANDONADA_MS, TRAVA_ESPERA_MAX_MS };
