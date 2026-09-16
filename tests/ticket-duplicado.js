#!/usr/bin/env node
/**
 * O mesmo ticket não pode validar em dois pátios.
 *
 * Cada hangar tem seu login no ValidPark, e cada login enxerga só o próprio
 * pátio — sobreposição zero entre as listas, medida em 15/09/2026. Mas o número
 * do ticket é global: quem gera é o servidor central do aeroporto. Nenhum dos
 * sites tem como perceber a segunda validação.
 *
 * Aconteceu em 16/09/2026: ticket 011609161628 validado no Alljet às 19:25 e no
 * Hangar 1 às 19:36. Nosso histórico é a única barreira contra isso.
 *
 * Os arquivos de estado são reais: o teste guarda e devolve.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const GRUPO_ALLJET = '120363411486868499@g.us';
const GRUPO_HANGAR1 = '120363410198746053@g.us';
const PESSOA = '5511999999999@s.whatsapp.net';
const TICKET = '011609161628';

const ARQUIVOS = ['data/validacoes.jsonl', 'data/pendencias.json', 'data/fotos-usadas.json'];
const guardado = {};
for (const a of ARQUIVOS) {
  const p = path.join(RAIZ, a);
  guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
}
const restaurar = () => {
  for (const a of ARQUIVOS) {
    const p = path.join(RAIZ, a);
    if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) { /* já não existe */ } }
    else fs.writeFileSync(p, guardado[a]);
  }
};

let respostaDoOcr = { status: 'ocr_ok', ticket: TICKET, dataEmissaoIso: new Date().toISOString() };

const child = require('child_process');
child.execFileSync = (_cmd, args) => {
  const arquivo = path.basename(args[0]);
  if (arquivo === 'validate-ticket.js') {
    return JSON.stringify({ status: 'validado', ticket: args[2], placa: args[3], mensagemWhatsapp: 'validado', vagasDisponiveis: 20, totalVagas: 37 });
  }
  if (arquivo === 'consultar-ticket.js') return JSON.stringify({ status: 'consulta_ok', jaValidado: false });
  throw new Error(`script inesperado: ${arquivo}`);
};

const ocr = require(path.join(RAIZ, 'scripts', 'ocr-ticket.js'));
ocr.lerTicket = async () => respostaDoOcr;

const http = require('http');
http.request = (_o, cb) => {
  const r = new (require('stream').PassThrough)();
  r.statusCode = 200;
  process.nextTick(() => { cb(r); r.end(JSON.stringify({ base64: Buffer.from(`f${Date.now()}${Math.random()}`).toString('base64'), mimetype: 'image/jpeg' })); });
  return { on() { return this; }, write() {}, end() {}, setTimeout() {}, destroy() {} };
};

const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));

const payload = (grupo) => ({
  data: {
    key: { remoteJid: grupo, fromMe: false, id: `T${Date.now()}${Math.random()}`, participant: PESSOA },
    pushName: 'Teste',
    message: { imageMessage: { caption: '', mimetype: 'image/jpeg' } },
  },
});

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  if (ok) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

async function main() {
  for (const a of ARQUIVOS) {
    fs.writeFileSync(path.join(RAIZ, a), a.endsWith('.jsonl') ? '' : '{}');
  }

  console.log('Primeira validação, no Alljet');
  const primeira = await processar(payload(GRUPO_ALLJET), {});
  conferir('valida', primeira.status === 'validado', `veio "${primeira.status}"`);

  console.log('\nMesmo ticket no Hangar 1: o caso real de hoje');
  const segunda = await processar(payload(GRUPO_HANGAR1), {});
  conferir('não valida', segunda.status !== 'validado', `veio "${segunda.status}"`);
  conferir('diz que o ticket já foi validado', segunda.status === 'ticket_ja_validado');
  conferir('aciona a administração', segunda.notificarAdmin === true);
  conferir('avisa que foi em outro pátio', /outro p[áa]tio/i.test(segunda.mensagemWhatsapp || ''));
  conferir('guarda onde foi validado', segunda.validadoNoHangar === 'alljet');

  console.log('\nMesmo ticket, mesmo pátio: recusa e avisa também');
  const repetida = await processar(payload(GRUPO_ALLJET), {});
  conferir('não valida', repetida.status === 'ticket_ja_validado', `veio "${repetida.status}"`);
  conferir('também aciona a administração', repetida.notificarAdmin === true);
  conferir('não fala em outro pátio para o cliente', !/outro p[áa]tio/i.test(repetida.mensagemWhatsapp || ''));
  conferir('o detalhe ao admin diz que é o mesmo pátio', /mesmo p[áa]tio/i.test(repetida.mensagem || ''));

  console.log('\nTicket diferente segue validando');
  respostaDoOcr = { status: 'ocr_ok', ticket: '011609999888', dataEmissaoIso: new Date().toISOString() };
  const outro = await processar(payload(GRUPO_HANGAR1), {});
  conferir('valida normalmente', outro.status === 'validado', `veio "${outro.status}"`);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main()
  .catch((e) => { console.error('teste quebrou:', e); falhas += 1; })
  .finally(() => { restaurar(); process.exit(falhas ? 1 : 0); });
