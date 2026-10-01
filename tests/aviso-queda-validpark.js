#!/usr/bin/env node
/**
 * Aviso automático de "ValidPark parece fora": quando uma validação falha por
 * INFRAESTRUTURA (login/resultado não confirmados, ou exceção), o bot cutuca a
 * administração sugerindo ligar a contingência. O que este teste protege:
 *
 * 1. Falha de infraestrutura (status 'indeterminado'/'erro') dispara o aviso,
 *    e ele vai para TODOS os destinos de administração.
 * 2. Recusa legítima (validado, sem vaga, já usado) NÃO dispara — senão o aviso
 *    viraria ruído e ninguém o levaria a sério.
 * 3. Throttle: numa queda com movimento, não repete o aviso a cada tentativa.
 *
 * O bot NÃO liga nada sozinho: só avisa. Ligar continua sendo o SIM do admin.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const GRUPO = '120363431859218622@g.us'; // Solojet
const PESSOA = '5511999999999@s.whatsapp.net';

require('./cenario').montar({ hangares: { solojet: { cotaMensalValidacoes: null } } });

const EXTRA = ['data/aviso-queda-validpark.json', 'data/tickets-bloqueados.json', 'data/mensagens-vistas.json'];
const guardado = {};
for (const a of EXTRA) { const p = path.join(RAIZ, a); guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; }
process.on('exit', () => { for (const a of EXTRA) { const p = path.join(RAIZ, a); if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) {} } else fs.writeFileSync(p, guardado[a]); } });
for (const a of EXTRA) fs.writeFileSync(path.join(RAIZ, a), '{}');

// OCR: ticket dentro do prazo (emitido agora).
let ticketAtual = 'V00000000001';
const agora = () => new Date(Date.now() - 5 * 60 * 1000).toISOString();
const ocr = require(path.join(RAIZ, 'scripts', 'ocr-ticket.js'));
ocr.lerTicket = async () => ({ status: 'ocr_ok', ticket: ticketAtual, dataEmissaoIso: agora(), conferencia: { ok: true } });

// Scripts filhos: consulta diz "ok, não validado"; a validação devolve o status
// que o teste escolher (resultadoValidacao).
let resultadoValidacao = { status: 'indeterminado', mensagemWhatsapp: '⚠️ não deu' };
const child = require('child_process');
const gitReal = child.execFileSync;
child.execFileSync = (cmd, args, opcoes) => {
  if (cmd === 'git') return args.includes('rev-parse') ? 'x' : '';
  const nome = path.basename((args && args[0]) || String(cmd));
  if (nome === 'consultar-ticket.js') return JSON.stringify({ status: 'consulta_ok', jaValidado: false });
  if (nome === 'validate-ticket.js') return JSON.stringify(resultadoValidacao);
  return gitReal(cmd, args, opcoes);
};

const http = require('http');
http.request = (_o, cb) => {
  const r = new (require('stream').PassThrough)(); r.statusCode = 200;
  process.nextTick(() => { cb(r); r.end(JSON.stringify({ base64: Buffer.from('f').toString('base64'), mimetype: 'image/jpeg' })); });
  return { on() { return this; }, write() {}, end() {}, setTimeout() {}, destroy() {} };
};

const evolution = require(path.join(RAIZ, 'scripts', 'lib', 'evolution.js'));
let enviados = [];
evolution.enviarTexto = async (grupo, texto) => { enviados.push({ grupo, texto }); return { ok: true }; };

const { destinosAdmin } = require(path.join(RAIZ, 'scripts', 'lib', 'admins.js'));
const { carregarConfig } = require(path.join(RAIZ, 'scripts', 'lib', 'hangar.js'));
const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));

const foto = () => ({ data: { key: { remoteJid: GRUPO, fromMe: false, id: `T${Math.random()}`, participant: PESSOA }, pushName: 'Cliente', message: { imageMessage: { caption: '', mimetype: 'image/jpeg' } } } });
const nudges = () => enviados.filter((e) => /ligar contingência/i.test(e.texto));

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

async function main() {
  const destinos = destinosAdmin(carregarConfig());

  console.log('Falha de infraestrutura (indeterminado): avisa a administração');
  resultadoValidacao = { status: 'indeterminado', mensagemWhatsapp: '⚠️ não consegui confirmar' };
  enviados = [];
  ticketAtual = 'V00000000001';
  await processar(foto(), {});
  conferir('avisou', nudges().length > 0);
  conferir('foi para todos os destinos de administração', destinos.every((d) => nudges().some((n) => n.grupo === d)), `destinos=${destinos.length}, nudges=${nudges().length}`);
  conferir('o texto sugere ligar a contingência', nudges().every((n) => /ligar contingência/i.test(n.texto)));

  console.log('\nThrottle: segunda falha logo em seguida NÃO repete');
  enviados = [];
  ticketAtual = 'V00000000002';
  await processar(foto(), {});
  conferir('não repetiu o aviso', nudges().length === 0, `veio ${nudges().length}`);

  console.log('\nRecusa legítima (validado) NÃO avisa');
  fs.writeFileSync(path.join(RAIZ, 'data', 'aviso-queda-validpark.json'), '{}'); // zera o throttle
  resultadoValidacao = { status: 'validado', mensagemWhatsapp: '✅ validado' };
  enviados = [];
  ticketAtual = 'V00000000003';
  await processar(foto(), {});
  conferir('não avisou numa validação normal', nudges().length === 0, `veio ${nudges().length}`);

  console.log('\nExceção no validate-ticket (status erro) também avisa');
  fs.writeFileSync(path.join(RAIZ, 'data', 'aviso-queda-validpark.json'), '{}');
  resultadoValidacao = { status: 'erro', mensagem: 'estourou', mensagemWhatsapp: '⚠️ erro' };
  enviados = [];
  ticketAtual = 'V00000000004';
  await processar(foto(), {});
  conferir('avisou no status erro', nudges().length > 0);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main().catch((e) => { console.error('teste quebrou:', e); falhas += 1; }).finally(() => process.exit(falhas ? 1 : 0));
