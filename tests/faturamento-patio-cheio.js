#!/usr/bin/env node
/**
 * Pátio cheio COM faturamento ligado: em vez de só travar, o bot oferece faturar
 * e validar. O que este teste protege:
 *
 * 1. Sem vaga + faturamento ligado → oferta de faturar (com valor), não bloqueio.
 * 2. Cliente responde NÃO → aí sim TRAVA (a guarda antifraude de sempre).
 * 3. Cliente manda a FOTO → vira pedido de faturamento (motivo patio_cheio) para
 *    a administração aprovar — nada é cobrado sem o SIM do admin.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.FATURAMENTO_SIMULAR = 'false'; // faturamento LIGADO
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const GRUPO = '120363431859218622@g.us'; // Solojet (prazo 2h)
const PESSOA = '5511999999999@s.whatsapp.net';

require('./cenario').montar({ hangares: { solojet: { cotaMensalForaPrazo: 0, cotaMensalValidacoes: null } } });

const EXTRA = ['data/tickets-bloqueados.json', 'data/faturamentos-pendentes.json', 'data/validacoes-pendentes.json', 'data/mensagens-vistas.json'];
const guardado = {};
for (const a of EXTRA) { const p = path.join(RAIZ, a); guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; }
process.on('exit', () => { for (const a of EXTRA) { const p = path.join(RAIZ, a); if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) {} } else fs.writeFileSync(p, guardado[a]); } });
for (const a of EXTRA) fs.writeFileSync(path.join(RAIZ, a), '{}');

// OCR: ticket DENTRO do prazo (emitido há 1h), com data → valor > 0.
let ticketAtual = 'CHEIO0000001';
const ocr = require(path.join(RAIZ, 'scripts', 'ocr-ticket.js'));
ocr.lerTicket = async () => ({ status: 'ocr_ok', ticket: ticketAtual, dataEmissaoIso: new Date(Date.now() - 3600000).toISOString(), conferencia: { ok: true } });

// validate-ticket sempre diz SEM VAGA; consultar-ticket diz ok/não validado.
const child = require('child_process');
child.execFileSync = (_cmd, args) => {
  const arquivo = path.basename(args[0]);
  if (arquivo === 'validate-ticket.js') return JSON.stringify({ status: 'sem_vagas', mensagemWhatsapp: '⚠️ Não há vagas.', vagasDisponiveis: 0, totalVagas: 30, ticket: args[2] });
  if (arquivo === 'consultar-ticket.js') return JSON.stringify({ status: 'consulta_ok', jaValidado: false });
  throw new Error(`script inesperado: ${arquivo}`);
};

const http = require('http');
http.request = (_o, cb) => {
  const r = new (require('stream').PassThrough)(); r.statusCode = 200;
  process.nextTick(() => { cb(r); r.end(JSON.stringify({ base64: Buffer.from(`f${Math.random()}`).toString('base64'), mimetype: 'image/jpeg' })); });
  return { on() { return this; }, write() {}, end() {}, setTimeout() {}, destroy() {} };
};

const bloqueados = require(path.join(RAIZ, 'scripts', 'lib', 'tickets-bloqueados.js'));
const filaFaturamentos = require(path.join(RAIZ, 'scripts', 'lib', 'faturamentos-pendentes.js'));
const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));

const foto = () => ({ data: { key: { remoteJid: GRUPO, fromMe: false, id: `T${Math.random()}`, participant: PESSOA }, pushName: 'Cliente', message: { imageMessage: { caption: '', mimetype: 'image/jpeg' } } } });
const texto = (t) => ({ data: { key: { remoteJid: GRUPO, fromMe: false, id: `T${Math.random()}`, participant: PESSOA }, pushName: 'Cliente', message: { conversation: t } } });

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

async function main() {
  console.log('Pátio cheio + faturamento ligado: oferece faturar (não trava ainda)');
  ticketAtual = 'CHEIO0000001';
  const oferta = await processar(foto(), {});
  conferir('oferece faturar e validar', oferta.status === 'patio_cheio_requer_autorizacao_faturamento', `veio "${oferta.status}"`);
  conferir('mostra o valor', oferta.valor > 0 && /faturar e validar/i.test(oferta.mensagemWhatsapp), oferta.mensagemWhatsapp);
  conferir('NÃO travou ainda', !bloqueados.estaBloqueado('CHEIO0000001'));

  console.log('\nCliente responde NÃO → trava');
  const nao = await processar(texto('não'), {});
  conferir('status sem_vagas', nao.status === 'sem_vagas', `veio "${nao.status}"`);
  conferir('agora travou', Boolean(bloqueados.estaBloqueado('CHEIO0000001')));

  console.log('\nCliente manda a FOTO → pedido de faturamento (motivo patio_cheio)');
  ticketAtual = 'CHEIO0000002';
  await processar(foto(), {});                 // oferta
  const autorizou = await processar(foto(), {}); // foto = autorização
  conferir('vai para aprovação do admin', autorizou.status === 'faturamento_aguardando_admin', `veio "${autorizou.status}"`);
  const fat = filaFaturamentos.listar().find((f) => f.ticket === 'CHEIO0000002');
  conferir('faturamento na fila com motivo patio_cheio', fat && fat.motivo === 'patio_cheio', JSON.stringify(fat && { t: fat.ticket, m: fat.motivo }));
  conferir('não travou quem autorizou', !bloqueados.estaBloqueado('CHEIO0000002'));

  console.log('\nFaturamento DESLIGADO: pátio cheio trava direto (sem oferta)');
  process.env.FATURAMENTO_SIMULAR = 'true';
  ticketAtual = 'CHEIO0000003';
  const semFat = await processar(foto(), {});
  conferir('trava direto', semFat.status === 'sem_vagas' && Boolean(bloqueados.estaBloqueado('CHEIO0000003')), `veio "${semFat.status}"`);
  process.env.FATURAMENTO_SIMULAR = 'false';

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main().catch((e) => { console.error('teste quebrou:', e); falhas += 1; }).finally(() => process.exit(falhas ? 1 : 0));
