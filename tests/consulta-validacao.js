#!/usr/bin/env node
/**
 * "O ticket do João foi validado?" — o bot responde pelo histórico.
 *
 * O que o teste protege, em ordem de importância:
 *
 * 1. ISOLAMENTO ENTRE PÁTIOS. Quem está no grupo do Solojet não pode descobrir
 *    o cliente do AIBM porque digitou o nome certo. O histórico guarda nome de
 *    pessoa e placa; vazar entre grupos seria pior que não ter a consulta.
 * 2. Não confundir pergunta com resposta. Um "foi validado?" tratado como um
 *    "sim" solto gastaria cota do hangar por causa de uma dúvida.
 * 3. Achar sem depender de acento ou caixa — quem digita "joao" precisa
 *    encontrar "João da Silva".
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const GRUPO_SOLOJET = '120363431859218622@g.us';
const GRUPO_AIBM2 = '120363431499963963@g.us';
const PESSOA = '5511999999999@s.whatsapp.net';

require('./cenario').montar({ hangares: { solojet: {}, 'aibm-2': {} } });

const child = require('child_process');
child.execFileSync = () => { throw new Error('consulta não pode abrir navegador nem validar nada'); };

const registro = require(path.join(RAIZ, 'scripts', 'lib', 'registro.js'));
const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));

const texto = (grupo, t) => ({ data: {
  key: { remoteJid: grupo, fromMe: false, id: `T${Math.random()}`, participant: PESSOA },
  pushName: 'Teste', message: { conversation: t },
} });

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  if (ok) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

// Histórico de mentira, com um caso em cada pátio.
function semear() {
  const linhas = [
    { em: '2026-09-17T13:03:34Z', hangarId: 'solojet', status: 'validado', ticket: '011709095140', placa: 'FLI8888', placaEhGenerica: false, identificacao: 'FLI8888' },
    { em: '2026-09-17T13:19:34Z', hangarId: 'solojet', status: 'validado', ticket: '011709100959', placa: 'ENT9888', placaEhGenerica: false, identificacao: 'João da Silva — Corolla' },
    { em: '2026-09-17T14:10:00Z', hangarId: 'solojet', status: 'sem_vagas', ticket: '011709110000', placa: null, identificacao: 'Pedro Alves' },
    { em: '2026-09-17T13:40:00Z', hangarId: 'aibm-2', status: 'validado', ticket: '011709102222', placa: 'XYZ1A23', placaEhGenerica: false, identificacao: 'Marina Costa' },
  ];
  fs.writeFileSync(path.join(RAIZ, 'data/validacoes.jsonl'), linhas.map((l) => JSON.stringify(l)).join('\n') + '\n');
}

async function main() {
  semear();

  console.log('Pergunta por nome');
  const joao = await processar(texto(GRUPO_SOLOJET, 'o ticket do João foi validado?'), {});
  conferir('responde', joao.status === 'consulta_validacao', `veio "${joao.status}"`);
  conferir('confirma que sim', /Sim, foi validado/i.test(joao.mensagemWhatsapp || ''));
  conferir('mostra o ticket', /011709100959/.test(joao.mensagemWhatsapp || ''));
  conferir('mostra a placa', /ENT9888/.test(joao.mensagemWhatsapp || ''));

  console.log('\nSem acento e em minúsculas encontra igual');
  const semAcento = await processar(texto(GRUPO_SOLOJET, 'joao foi validado'), {});
  conferir('encontra', semAcento.validados === 1, `validados=${semAcento.validados}`);

  console.log('\nPergunta por placa e por número do ticket');
  const porPlaca = await processar(texto(GRUPO_SOLOJET, 'a placa FLI8888 já foi validada?'), {});
  conferir('acha pela placa', porPlaca.validados === 1, `validados=${porPlaca.validados}`);
  const porTicket = await processar(texto(GRUPO_SOLOJET, 'validaram o 011709095140?'), {});
  conferir('acha pelo número', porTicket.validados === 1, `validados=${porTicket.validados}`);

  console.log('\nExiste no histórico mas NÃO validou');
  const pedro = await processar(texto(GRUPO_SOLOJET, 'o ticket do Pedro foi validado?'), {});
  conferir('diz que não foi', /não\*\* foi validado|\*\*não\*\*/i.test(pedro.mensagemWhatsapp || '') || /não/i.test(pedro.mensagemWhatsapp || ''));
  conferir('explica a situação', /sem_vagas/.test(pedro.mensagemWhatsapp || ''));

  console.log('\nISOLAMENTO: um pátio não enxerga o outro');
  const vazamento = await processar(texto(GRUPO_SOLOJET, 'a Marina Costa foi validada?'), {});
  conferir('não encontra o cliente do outro pátio', vazamento.encontrados === 0, `encontrados=${vazamento.encontrados}`);
  conferir('não vaza a placa', !/XYZ1A23/.test(vazamento.mensagemWhatsapp || ''));
  const noDono = await processar(texto(GRUPO_AIBM2, 'a Marina Costa foi validada?'), {});
  conferir('mas o pátio dela encontra', noDono.validados === 1, `validados=${noDono.validados}`);

  console.log('\nNão encontrado');
  const nada = await processar(texto(GRUPO_SOLOJET, 'o ticket do Fulano foi validado?'), {});
  conferir('avisa que não achou', /Não encontrei/i.test(nada.mensagemWhatsapp || ''));
  conferir('explica o limite do histórico', /validação feita à mão/i.test(nada.mensagemWhatsapp || ''));

  console.log('\nPergunta sem dizer de quem');
  const semTermo = await processar(texto(GRUPO_SOLOJET, 'foi validado?'), {});
  conferir('pede o que procurar', semTermo.status === 'consulta_sem_termo', `veio "${semTermo.status}"`);

  console.log('\nConversa normal continua ignorada');
  for (const frase of ['bom dia pessoal', 'vou validar agora', 'obrigado']) {
    const r = await processar(texto(GRUPO_SOLOJET, frase), {});
    conferir(`ignora "${frase}"`, r.status === 'ignorado', `veio "${r.status}"`);
  }

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main()
  .catch((e) => { console.error('teste quebrou:', e); falhas += 1; })
  .finally(() => process.exit(falhas ? 1 : 0));
