#!/usr/bin/env node
/**
 * Ticket tentado em pátio CHEIO fica travado até a administração autorizar.
 *
 * O caso real (18/09/2026): tentativa no Hangar Aristek com o pátio lotado. Se
 * não há vaga, o carro daquele ticket provavelmente não está ali — e o
 * movimento seguinte de quem age de má-fé é estacionar no pátio e pedir a
 * validação em OUTRO hangar.
 *
 * Por isso o bloqueio é GLOBAL. É o que este teste protege acima de tudo:
 * travar só no pátio onde aconteceu deixaria aberta exatamente a porta que se
 * quer fechar.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const GRUPO_ARISTEK = '120363000000000001@g.us';
const GRUPO_SOLOJET = '120363431859218622@g.us';
const PESSOA = '5511999999999@s.whatsapp.net';
const TICKET = '011809140000';

const cenario = require('./cenario');
cenario.montar({ hangares: { 'hangar-aristek': { grupoWhatsappId: GRUPO_ARISTEK }, solojet: {} } });

// data/tickets-bloqueados.json é real e o cenário não o conhece: guarda aqui.
const ARQ = path.join(RAIZ, 'data', 'tickets-bloqueados.json');
const guardado = fs.existsSync(ARQ) ? fs.readFileSync(ARQ, 'utf-8') : null;
const devolver = () => {
  if (guardado === null) { try { fs.unlinkSync(ARQ); } catch (e) { /* já não existe */ } }
  else fs.writeFileSync(ARQ, guardado);
};
process.on('exit', devolver);
fs.writeFileSync(ARQ, '{}');

// O validador devolve o que o caso pedir.
let respostaDoSite = { status: 'sem_vagas', mensagemWhatsapp: '⚠️ Não há vagas disponíveis.', vagasDisponiveis: 0, totalVagas: 13 };
const child = require('child_process');
child.execFileSync = (_cmd, args) => {
  const arquivo = path.basename(args[0]);
  if (arquivo === 'validate-ticket.js') return JSON.stringify({ ...respostaDoSite, ticket: args[2], placa: args[3] });
  if (arquivo === 'consultar-ticket.js') return JSON.stringify({ status: 'consulta_ok', jaValidado: false });
  throw new Error(`script inesperado: ${arquivo}`);
};

const ocr = require(path.join(RAIZ, 'scripts', 'ocr-ticket.js'));
ocr.lerTicket = async () => ({ status: 'ocr_ok', ticket: TICKET, dataEmissaoIso: new Date().toISOString() });

const http = require('http');
http.request = (_o, cb) => {
  const r = new (require('stream').PassThrough)();
  r.statusCode = 200;
  process.nextTick(() => { cb(r); r.end(JSON.stringify({ base64: Buffer.from(`f${Math.random()}`).toString('base64'), mimetype: 'image/jpeg' })); });
  return { on() { return this; }, write() {}, end() {}, setTimeout() {}, destroy() {} };
};

const bloqueados = require(path.join(RAIZ, 'scripts', 'lib', 'tickets-bloqueados.js'));
const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));

const foto = (grupo) => ({ data: {
  key: { remoteJid: grupo, fromMe: false, id: `T${Math.random()}`, participant: PESSOA },
  pushName: 'Teste', message: { imageMessage: { caption: '', mimetype: 'image/jpeg' } },
} });

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  if (ok) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

async function main() {
  console.log('Tentativa em pátio cheio');
  const cheio = await processar(foto(GRUPO_ARISTEK), {});
  conferir('não valida', cheio.status === 'sem_vagas', `veio "${cheio.status}"`);
  conferir('trava o ticket', bloqueados.estaBloqueado(TICKET) !== null);
  conferir('avisa a administração', cheio.notificarAdmin === true);
  conferir('a mensagem fala em bloqueio', /bloqueado/i.test(cheio.mensagemWhatsapp || ''));
  conferir('e fala em autorização', /autoriza/i.test(cheio.mensagemWhatsapp || ''));

  console.log('\nO MOVIMENTO SUSPEITO: tentar o mesmo ticket em outro hangar');
  // O site aceitaria: pátio com vaga. Quem tem que barrar é o bloqueio.
  respostaDoSite = { status: 'validado', mensagemWhatsapp: '✅ validado', vagasDisponiveis: 30, totalVagas: 90 };
  const outro = await processar(foto(GRUPO_SOLOJET), {});
  conferir('NÃO valida no outro pátio', outro.status !== 'validado', `veio "${outro.status}"`);
  conferir('diz que está bloqueado', outro.status === 'ticket_bloqueado');
  conferir('aciona a administração de novo', outro.notificarAdmin === true);
  conferir('o detalhe conta a insistência', /tentativa 2/i.test(outro.mensagem || ''), outro.mensagem);

  console.log('\nO registro guarda o rastro');
  const r = bloqueados.estaBloqueado(TICKET);
  conferir('guarda onde travou', r.hangarId === 'hangar-aristek', r.hangarId);
  conferir('conta as tentativas', (r.tentativas || []).length >= 1, `${(r.tentativas || []).length}`);
  conferir('não se autoriza sozinho', r.autorizadoEm === null);

  console.log('\nDepois da autorização, valida');
  bloqueados.autorizar(TICKET, 'rodrigo');
  conferir('sai da lista de travados', bloqueados.estaBloqueado(TICKET) === null);
  const liberado = await processar(foto(GRUPO_SOLOJET), {});
  conferir('valida', liberado.status === 'validado', `veio "${liberado.status}"`);

  console.log('\nO histórico da decisão não some');
  const naLista = bloqueados.listar().find((x) => x.ticket === TICKET);
  conferir('continua na lista', Boolean(naLista));
  conferir('com quem autorizou', naLista.autorizadoPor === 'rodrigo');
  let erro = null;
  try { bloqueados.autorizar(TICKET, 'outro'); } catch (e) { erro = e.message; }
  conferir('não autoriza duas vezes', /já foi autorizado/i.test(erro || ''), erro);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main()
  .catch((e) => { console.error('teste quebrou:', e); falhas += 1; })
  .finally(() => { devolver(); process.exit(falhas ? 1 : 0); });
