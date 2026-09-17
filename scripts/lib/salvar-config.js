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

function git(args) {
  return execFileSync('git', args, { cwd: RAIZ, encoding: 'utf-8' }).trim();
}

/**
 * @param {object} config   o conteúdo completo a gravar
 * @param {string} resumo   o que mudou, em uma linha — vira a mensagem do commit
 * @param {string} autor    quem alterou ("Painel do Validador", "Bot do WhatsApp")
 */
function salvarEComitar(config, resumo, autor = 'Painel do Validador') {
  return comTrava(CONFIG, () => {
    const antes = fs.readFileSync(CONFIG, 'utf-8');
    fs.writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);
    try {
      git(['add', 'config/hangares.json']);
      git([
        '-c', `user.name=${autor}`,
        '-c', 'user.email=painel@validador.local',
        'commit', '-m', `${autor}: ${resumo}`,
      ]);
      const commit = git(['rev-parse', '--short', 'HEAD']);

      let push = { enviado: false, motivo: 'sem tentativa' };
      try {
        git(['push', 'origin', 'HEAD:main']);
        push = { enviado: true };
      } catch (e) {
        push = { enviado: false, motivo: String(e.message || e).slice(0, 200) };
      }

      return { commitado: true, commit, push };
    } catch (erro) {
      fs.writeFileSync(CONFIG, antes);
      throw new Error(`Não consegui commitar, alteração desfeita: ${erro.message.slice(0, 200)}`);
    }
  });
}

module.exports = { salvarEComitar, CONFIG };
