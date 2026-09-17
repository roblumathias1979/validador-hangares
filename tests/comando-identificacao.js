#!/usr/bin/env node
/**
 * Ligar e desligar a pergunta de identificação pelo próprio grupo.
 *
 * Quem opera o pátio está no grupo, não no painel. A permissão é ABERTA a todo
 * o grupo de propósito: identificação é conveniência de registro, não controle
 * antifraude — desligá-la não libera validação nenhuma. Em troca, toda mudança
 * avisa a administração dizendo quem mudou.
 *
 * O que merece teste é o reconhecimento: um comando que dispara com frase
 * solta mexeria em configuração de produção por engano, e isso sim seria caro.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const GRUPO = '120363431859218622@g.us'; // Solojet
const PESSOA = '5511999999999@s.whatsapp.net';

require('./cenario').montar({ hangares: { solojet: { perguntarIdentificacao: true } } });

// O comando commita. Num teste isso sujaria o repositório e mandaria lixo para
// o GitHub — o stub tem que estar de pé ANTES de o módulo ser carregado,
// porque salvar-config.js captura execFileSync por desestruturação no topo.
const child = require('child_process');
const gitReal = child.execFileSync;
child.execFileSync = (cmd, args, opcoes) => {
  if (cmd === 'git') {
    if (args.some((a) => ['add', 'commit', 'push'].includes(a))) return '';
    if (args.includes('rev-parse')) return 'commit-de-teste';
  }
  if (cmd === 'node') throw new Error('comando não pode abrir navegador');
  return gitReal(cmd, args, opcoes);
};

const { carregarConfig } = require(path.join(RAIZ, 'scripts', 'lib', 'hangar.js'));
const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));

const texto = (t) => ({ data: {
  key: { remoteJid: GRUPO, fromMe: false, id: `T${Math.random()}`, participant: PESSOA },
  pushName: 'Danialison', message: { conversation: t },
} });

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  if (ok) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};
const ligado = () => carregarConfig().hangares.find((h) => h.id === 'solojet').perguntarIdentificacao === true;

async function main() {
  console.log('Desligar pelo grupo');
  conferir('começa ligado', ligado());
  const off = await processar(texto('desativar identificação'), {});
  conferir('responde', off.status === 'identificacao_alterada', `veio "${off.status}"`);
  conferir('desligou de verdade no config', !ligado());
  conferir('avisa a administração', off.notificarAdmin === true);
  conferir('o aviso diz quem mudou', /Danialison/.test(off.mensagem || ''), off.mensagem);

  console.log('\nRepetir o comando não faz nada');
  const denovo = await processar(texto('desativar identificação'), {});
  conferir('avisa que já está assim', denovo.status === 'identificacao_sem_mudanca', `veio "${denovo.status}"`);
  conferir('não aciona a administração à toa', denovo.notificarAdmin === false);

  console.log('\nLigar de volta');
  const on = await processar(texto('ativar identificação'), {});
  conferir('religou', on.status === 'identificacao_alterada' && ligado());

  console.log('\nO que NÃO pode virar comando');
  const naoComandos = [
    'a identificação está errada',
    'gostaria de saber se a identificação do ticket de ontem ficou certa ou se preciso mandar de novo',
    'ativar',
    'bom dia pessoal',
    'pode desativar depois',
  ];
  for (const frase of naoComandos) {
    const r = await processar(texto(frase), {});
    conferir(`não mexe com "${frase.slice(0, 34)}"`, r.status !== 'identificacao_alterada', `veio "${r.status}"`);
  }
  conferir('e continua ligado depois de tudo', ligado());

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main()
  .catch((e) => { console.error('teste quebrou:', e); falhas += 1; })
  .finally(() => process.exit(falhas ? 1 : 0));
