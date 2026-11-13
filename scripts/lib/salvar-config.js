/**
 * salvar-config.js — grava config/hangares.json e registra a alteração no git.
 *
 * Usado pelo PAINEL e pelo BOT. Nasceu dentro do painel; saiu de lá em
 * 17/09/2026, quando comandos no grupo do WhatsApp passaram a alterar
 * configuração também. Duas funções gravando o mesmo arquivo de jeitos
 * diferentes seria a duplicação de sempre — e aqui com agravante: uma delas
 * commitando e a outra não deixaria o servidor com alteração solta, que o
 * próximo deploy encontraria como divergência.
 *
 * TRÊS GARANTIAS
 *
 * 1. Exclusão mútua. Painel e bot rodam em processos diferentes e podem gravar
 *    ao mesmo tempo; sem trava, um sobrescreve o outro sem deixar rastro.
 * 2. Se o commit falhar, a escrita é DESFEITA. Arquivo divergindo do git em
 *    silêncio é o problema que este módulo existe para evitar.
 * 3. Se o PUSH falhar, a alteração FICA. O commit local é o que vale em
 *    produção — o bot lê o arquivo, não o GitHub. Desfazer porque a rede caiu
 *    seria trocar um problema pequeno por um grande.
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { comTrava } = require('./trava-arquivo');

const RAIZ = path.join(__dirname, '..', '..');
const CONFIG = path.join(RAIZ, 'config', 'hangares.json');

function git(args, raiz = RAIZ) {
  return execFileSync('git', args, { cwd: raiz, encoding: 'utf-8' }).trim();
}

/**
 * Envia o commit ao GitHub. Se o push for RECUSADO porque o GitHub andou (alguém
 * mesclou na main enquanto o servidor tinha alteração local — o painel e o bot
 * gravam aqui e eu/outros mesclam lá), busca, reaplica as alterações do servidor
 * por cima e tenta de novo UMA vez. Sem isto os commits do servidor ficavam
 * presos ("N alterações ainda não enviadas") e o `git pull` seguinte falhava com
 * "divergent branches" — foi o que impediu a mudança do AIBM de chegar, em
 * 13/11/2026. Conflito de verdade (os dois lados mexeram na MESMA chave) não se
 * resolve sozinho: aborta, deixa tudo como estava e diz o motivo.
 */
function enviar(raiz, identidade) {
  const empurrar = () => git(['push', 'origin', 'HEAD:main'], raiz);
  try {
    empurrar();
    return { enviado: true };
  } catch (e) {
    const texto = String((e && e.message) || e);
    if (!/rejected|non-fast-forward|fetch first|failed to push/i.test(texto)) {
      return { enviado: false, motivo: texto.slice(0, 200) };
    }
  }
  try {
    git(['fetch', 'origin', 'main'], raiz);
    git([...identidade, 'rebase', 'origin/main'], raiz);
  } catch (e) {
    try { git(['rebase', '--abort'], raiz); } catch (_) { /* não havia rebase em andamento */ }
    return { enviado: false, motivo: 'o GitHub tem mudanças que conflitam com as do servidor — precisa juntar à mão (git pull --rebase)' };
  }
  try {
    empurrar();
    return { enviado: true, reconciliado: true };
  } catch (e) {
    return { enviado: false, motivo: String((e && e.message) || e).slice(0, 200) };
  }
}

/**
 * @param {object} config   o conteúdo completo a gravar
 * @param {string} resumo   o que mudou, em uma linha — vira a mensagem do commit
 * @param {string} autor    quem alterou ("Painel do Validador", "Bot do WhatsApp")
 */
function salvarEComitar(config, resumo, autor = 'Painel do Validador', { raiz = RAIZ } = {}) {
  const arquivo = path.join(raiz, 'config', 'hangares.json');
  const identidade = ['-c', `user.name=${autor}`, '-c', 'user.email=painel@validador.local'];
  return comTrava(arquivo, () => {
    const antes = fs.readFileSync(arquivo, 'utf-8');
    fs.writeFileSync(arquivo, `${JSON.stringify(config, null, 2)}\n`);
    try {
      git(['add', 'config/hangares.json'], raiz);
      git([...identidade, 'commit', '-m', `${autor}: ${resumo}`], raiz);
    } catch (erro) {
      fs.writeFileSync(arquivo, antes);
      throw new Error(`Não consegui commitar, alteração desfeita: ${erro.message.slice(0, 200)}`);
    }
    const push = enviar(raiz, identidade);
    // Depois de reaplicar por cima do GitHub o hash mudou: devolve o de agora.
    const commit = git(['rev-parse', '--short', 'HEAD'], raiz);
    return { commitado: true, commit, push };
  });
}

module.exports = { salvarEComitar, CONFIG };
