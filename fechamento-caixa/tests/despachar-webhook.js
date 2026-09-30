#!/usr/bin/env node
/**
 * Testa ehGrupoDeFechamento e ehConsultaDeCaixaAdmin — as duas regras que
 * decidem para qual dos três scripts (fechamento por grupo, consulta de
 * caixa no privado do admin, ou validador de hangares) uma mensagem vai.
 *
 * ehConsultaDeCaixaAdmin lê process.env.ADMIN_WHATSAPP_ID e
 * config/unidades.json de verdade (não mocka nada) — fixa o admin de teste
 * DEPOIS de importar o módulo: despachar-webhook.js carrega o .env (com
 * override:true) no require, e num servidor com .env de verdade isso
 * sobrescreveria um valor de teste setado antes. A própria função lê
 * process.env em cada chamada (não guarda o valor no import), então setar
 * depois funciona em qualquer máquina, com ou sem .env real.
 */

const path = require('path');

const { ehGrupoDeFechamento, ehConsultaDeCaixaAdmin } = require(path.join(__dirname, '..', 'scripts', 'despachar-webhook'));

const ADMIN_TESTE = '5511999990000@s.whatsapp.net';
process.env.ADMIN_WHATSAPP_ID = ADMIN_TESTE;

function codificar(evento) {
  return Buffer.from(JSON.stringify(evento)).toString('base64');
}

function eventoTexto({ remoteJid, texto, fromMe = false }) {
  return { data: { key: { remoteJid, fromMe, id: 'X1' }, message: { conversation: texto } } };
}

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  if (ok) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

console.log('ehGrupoDeFechamento: grupo cadastrado em config/unidades.json de verdade');
// Grupo real do Hotel Nacional Inn (ver config/unidades.json) — confirma
// contra a config de verdade, não uma mockada, porque é isso que roda em produção.
conferir(
  'grupo da Hotel Nacional Inn -> true',
  ehGrupoDeFechamento(codificar(eventoTexto({ remoteJid: '120363430341217645@g.us', texto: 'oi' })))
);
conferir(
  'grupo qualquer, não cadastrado -> false',
  ehGrupoDeFechamento(codificar(eventoTexto({ remoteJid: '999999999999@g.us', texto: 'oi' }))) === false
);

console.log('\nehConsultaDeCaixaAdmin: só o admin, só com palavra-chave + unidade/cofre conhecido');
conferir(
  'admin perguntando de uma unidade conhecida com palavra-chave -> true',
  ehConsultaDeCaixaAdmin(codificar(eventoTexto({ remoteJid: ADMIN_TESTE, texto: 'quanto tem de dinheiro na nacional inn?' })))
);
conferir(
  'admin perguntando pelo COFRE com palavra-chave -> true',
  ehConsultaDeCaixaAdmin(codificar(eventoTexto({ remoteJid: ADMIN_TESTE, texto: 'quanto faturou o cofre de pocos de caldas essa semana' })))
);
conferir(
  'admin manda algo SEM palavra-chave de caixa -> false (cai pro validador de hangares)',
  ehConsultaDeCaixaAdmin(codificar(eventoTexto({ remoteJid: ADMIN_TESTE, texto: 'libera o ticket do hangar 12' }))) === false
);
conferir(
  'admin manda palavra-chave mas SEM unidade/cofre reconhecível -> false (não adivinha)',
  ehConsultaDeCaixaAdmin(codificar(eventoTexto({ remoteJid: ADMIN_TESTE, texto: 'quanto tem de dinheiro aí' }))) === false
);
conferir(
  'MESMA pergunta, mas de outro número -> false (não é o admin)',
  ehConsultaDeCaixaAdmin(codificar(eventoTexto({ remoteJid: '5511888887777@s.whatsapp.net', texto: 'quanto tem de dinheiro na nacional inn?' }))) === false
);
conferir(
  'admin, mesma pergunta, mas em GRUPO (não privado) -> false',
  ehConsultaDeCaixaAdmin(codificar(eventoTexto({ remoteJid: '120363430341217645@g.us', texto: 'quanto tem de dinheiro na nacional inn?' }))) === false
);
conferir(
  'mensagem do próprio bot (fromMe) -> false',
  ehConsultaDeCaixaAdmin(codificar(eventoTexto({ remoteJid: ADMIN_TESTE, texto: 'quanto tem de dinheiro na nacional inn?', fromMe: true }))) === false
);

console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
process.exit(falhas ? 1 : 0);
