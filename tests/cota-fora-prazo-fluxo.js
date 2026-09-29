#!/usr/bin/env node
/**
 * Caminho da cota fora do prazo: cliente pede, escolhe usar, coletor valida.
 *
 * Ticket vencido não é mais recusado direto — se o hangar tem cota, o bot
 * pergunta, e o SIM enfileira a validação (que roda no aeroporto) e desconta a
 * cota. O que este teste protege:
 *
 * 1. Já-validado ganha de vencido: não se gasta cota num ticket já usado.
 * 2. SIM desconta a cota E enfileira; NÃO não gasta nada.
 * 3. Sem cota, escala — não valida à revelia.
 *
 * Config e estado (cota, pendências, fila) são reais: o cenário guarda e devolve.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const GRUPO = '120363431859218622@g.us'; // Solojet (cota 5)
const GRUPO_AIBM = '120363430127934870@g.us'; // AIBM 1 (cota 0)
const PESSOA = '5511999999999@s.whatsapp.net';

require('./cenario').montar({ hangares: { solojet: { cotaMensalForaPrazo: 5 }, aibm: { cotaMensalForaPrazo: 0 } } });

// Estado que o cenário não zera: cota usada e a fila.
const EXTRA = ['data/cota-fora-prazo.json', 'data/validacoes-pendentes.json'];
const guardado = {};
for (const a of EXTRA) { const p = path.join(RAIZ, a); guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; }
process.on('exit', () => { for (const a of EXTRA) { const p = path.join(RAIZ, a); if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) {} } else fs.writeFileSync(p, guardado[a]); } });
for (const a of EXTRA) fs.writeFileSync(path.join(RAIZ, a), '{}');

// OCR devolve um ticket VENCIDO (emitido há muito).
let ticketAtual = '012809072451';
const vencido = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
const ocr = require(path.join(RAIZ, 'scripts', 'ocr-ticket.js'));
ocr.lerTicket = async () => ({ status: 'ocr_ok', ticket: ticketAtual, dataEmissaoIso: vencido, conferencia: { ok: true } });

// Nenhum script filho deve ser chamado — vencido não vai ao ValidPark.
const child = require('child_process');
child.execFileSync = (_c, args) => { throw new Error('nao deveria chamar ' + path.basename(args[0])); };

const http = require('http');
http.request = (_o, cb) => {
  const r = new (require('stream').PassThrough)(); r.statusCode = 200;
  process.nextTick(() => { cb(r); r.end(JSON.stringify({ base64: Buffer.from('f').toString('base64'), mimetype: 'image/jpeg' })); });
  return { on() { return this; }, write() {}, end() {}, setTimeout() {}, destroy() {} };
};

const cotaForaPrazo = require(path.join(RAIZ, 'scripts', 'lib', 'cota-fora-prazo.js'));
const fila = require(path.join(RAIZ, 'scripts', 'lib', 'validacoes-pendentes.js'));
const registro = require(path.join(RAIZ, 'scripts', 'lib', 'registro.js'));
const { carregarConfig, buscarHangar } = require(path.join(RAIZ, 'scripts', 'lib', 'hangar.js'));
const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));

const foto = (grupo) => ({ data: { key: { remoteJid: grupo, fromMe: false, id: `T${Math.random()}`, participant: PESSOA }, pushName: 'Cliente', message: { imageMessage: { caption: '', mimetype: 'image/jpeg' } } } });
const texto = (grupo, t) => ({ data: { key: { remoteJid: grupo, fromMe: false, id: `T${Math.random()}`, participant: PESSOA }, pushName: 'Cliente', message: { conversation: t } } });
const solojet = () => buscarHangar(carregarConfig(), 'solojet');

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

async function main() {
  console.log('Ticket vencido com cota: oferece usar');
  conferir('cota começa em 5', cotaForaPrazo.obterRestante(solojet()) === 5);
  const oferta = await processar(foto(GRUPO), {});
  conferir('não recusa nem valida', oferta.status === 'fora_do_prazo_requer_decisao', `veio "${oferta.status}"`);
  conferir('oferece a cota', /5\*? validação/.test(oferta.mensagemWhatsapp) && /SIM/.test(oferta.mensagemWhatsapp), oferta.mensagemWhatsapp);
  conferir('não gastou cota só de perguntar', cotaForaPrazo.obterRestante(solojet()) === 5);

  console.log('\nNÃO: não gasta, não enfileira');
  const nao = await processar(texto(GRUPO, 'não'), {});
  conferir('cancela', nao.status === 'cancelado_pelo_cliente', `veio "${nao.status}"`);
  conferir('cota intacta', cotaForaPrazo.obterRestante(solojet()) === 5);
  conferir('fila vazia', fila.retirarParaProcessar().length === 0);

  console.log('\nSIM: desconta e enfileira');
  await processar(foto(GRUPO), {});           // oferta de novo
  const sim = await processar(texto(GRUPO, 'sim'), {});
  conferir('confirma', sim.status === 'fora_do_prazo_enfileirado', `veio "${sim.status}"`);
  conferir('desconta 1 (restam 4)', cotaForaPrazo.obterRestante(solojet()) === 4, `restam ${cotaForaPrazo.obterRestante(solojet())}`);
  const naFila = fila.retirarParaProcessar();
  conferir('enfileirou a validação', naFila.length === 1 && naFila[0].ticket === ticketAtual, JSON.stringify(naFila.map(x=>x.ticket)));
  conferir('a fila sabe o hangar e o motivo', naFila[0].hangarId === 'solojet' && naFila[0].motivo === 'cota');
  conferir('a resposta avisa que valida depois', /aviso aqui/.test(sim.mensagemWhatsapp));

  console.log('\nHangar sem cota: escala, não valida');
  ticketAtual = '012809081706';
  const semCota = await processar(foto(GRUPO_AIBM), {});
  conferir('não oferece cota', semCota.status === 'fora_do_prazo', `veio "${semCota.status}"`);
  conferir('aciona a administração', semCota.notificarAdmin === true);
  conferir('nada na fila', fila.listar().filter(v => v.hangarId === 'aibm').length === 0);

  console.log('\nTicket já validado ganha de vencido');
  ticketAtual = '012809091027';
  registro.registrar({ status: 'validado', hangarId: 'solojet', ticket: ticketAtual, grupoId: GRUPO });
  const jaVal = await processar(foto(GRUPO), {});
  conferir('diz que já foi validado', jaVal.status === 'ticket_ja_validado', `veio "${jaVal.status}"`);
  conferir('não ofereceu cota', jaVal.status !== 'fora_do_prazo_requer_decisao');

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main().catch((e) => { console.error('teste quebrou:', e); falhas += 1; }).finally(() => process.exit(falhas ? 1 : 0));
