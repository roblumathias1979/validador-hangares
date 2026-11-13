#!/usr/bin/env node
/**
 * "Esse veículo pertence ao ticket X?" (13/11/2026).
 *
 * No antifraude (AIBM 1 e 2), depois que a foto do veículo passa na conferência
 * de local, o bot pergunta se o veículo pertence ao ticket antes de validar. A
 * foto do carro, no grupo, se perdia entre as outras mensagens; a pergunta cola
 * o número do ticket e a placa lida logo abaixo dela.
 *
 * Protege: a pergunta traz ticket e placa e NÃO valida nem gasta a foto; SIM valida
 * e o aviso final repete ticket e placa; NÃO cancela e devolve o pedido da foto do
 * veículo; resposta solta não valida; placa corrigida à mão vale; foto reutilizada
 * continua sendo barrada ANTES da pergunta; local incompatível não pergunta; e
 * `confirmarVeiculoNoTicket: false` volta a validar direto.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.FATURAMENTO_SIMULAR = 'true';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const GRUPO = '120363430127934870@g.us'; // AIBM 1
const PESSOA = '5511999999999@s.whatsapp.net';
const OUTRA = '5511888888888@s.whatsapp.net';
const FOTO = Buffer.from('foto-do-carro-confirmar').toString('base64');

const cenario = require('./cenario');
cenario.montar({ hangares: { aibm: { exigeFotoVeiculoNoLocal: true } }, zerarDados: false });

const EXTRA = ['data/fotos-usadas.json', 'data/pendencias.json', 'data/validacoes.jsonl', 'data/mensagens-vistas.json'];
const guardado = {};
for (const a of EXTRA) { const p = path.join(RAIZ, a); guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; }
process.on('exit', () => { for (const a of EXTRA) { const p = path.join(RAIZ, a); if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) { /* ok */ } } else fs.writeFileSync(p, guardado[a]); } });
const zerar = () => { for (const a of EXTRA) fs.writeFileSync(path.join(RAIZ, a), a.endsWith('.jsonl') ? '' : '{}'); };
zerar();

let validacoes = [];
const child = require('child_process');
child.execFileSync = (_cmd, args) => {
  const arquivo = path.basename(args[0]);
  if (arquivo === 'validate-ticket.js') { validacoes.push({ ticket: args[2], placa: args[3] }); return JSON.stringify({ status: 'validado', mensagemWhatsapp: `✅ Ticket ${args[2]} validado.`, ticket: args[2], placa: args[3], vagasDisponiveis: 9, totalVagas: 12 }); }
  if (arquivo === 'consultar-ticket.js') return JSON.stringify({ status: 'consulta_ok', jaValidado: false, ticket: args[1] });
  throw new Error(`script inesperado no teste: ${arquivo}`);
};

let respostaLocal = { local: 'compativel', localMotivo: 'bate', cenario: 'concreto', placa: 'TKM1I33' };
const ocr = require(path.join(RAIZ, 'scripts', 'ocr-ticket.js'));
ocr.lerLocal = async () => respostaLocal;

let fotoAtual = FOTO;
const http = require('http');
http.request = (_o, cb) => { const r = new (require('stream').PassThrough)(); r.statusCode = 200; process.nextTick(() => { cb(r); r.end(JSON.stringify({ base64: fotoAtual, mimetype: 'image/jpeg' })); }); return { on() { return this; }, write() {}, end() {}, setTimeout() {}, destroy() {} }; };

const fotosUsadas = require(path.join(RAIZ, 'scripts', 'lib', 'fotos-usadas.js'));
const pendencias = require(path.join(RAIZ, 'scripts', 'lib', 'pendencias.js'));
const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));

const foto = (quem = PESSOA) => ({ data: { key: { remoteJid: GRUPO, fromMe: false, id: `F${Math.random()}`, participant: quem }, pushName: 'Cliente', message: { imageMessage: { caption: '', mimetype: 'image/jpeg' } } } });
const texto = (t, quem = PESSOA) => ({ data: { key: { remoteJid: GRUPO, fromMe: false, id: `T${Math.random()}`, participant: quem }, pushName: 'Cliente', message: { conversation: t } } });
const abrirPedido = (ticket) => pendencias.registrar(GRUPO, PESSOA, { ticket, placa: null, placaEhGenerica: true, dataEmissaoIso: new Date().toISOString(), hangarId: 'aibm', tipo: 'foto_local', hashTicket: `hash-do-ticket-${ticket}` });

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

(async () => {
  console.log('1) A pergunta');
  abrirPedido('011609000100');
  let r = await processar(foto(), {});
  conferir('local compatível: pergunta em vez de validar', r.status === 'confirmar_veiculo_ticket', r.status);
  conferir('traz o número do ticket', /011609000100/.test(r.mensagemWhatsapp));
  conferir('traz a placa lida', /TKM1I33/.test(r.mensagemWhatsapp));
  conferir('diz que o local confere', /confere com o \*AIBM 1\*/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  conferir('NÃO validou ainda', validacoes.length === 0);
  conferir('a foto ainda não foi gasta', fotosUsadas.jaUsada(FOTO) === null);
  conferir('a pendência virou "confirmar_veiculo"', (pendencias.buscar(GRUPO, PESSOA) || {}).tipo === 'confirmar_veiculo');

  console.log('\n2) Resposta solta e de outra pessoa não validam');
  r = await processar(texto('talvez'), {});
  conferir('texto solto pede SIM ou NÃO', r.status === 'confirmacao_veiculo_nao_entendida' && /011609000100/.test(r.mensagemWhatsapp), r.status);
  r = await processar(texto('sim', OUTRA), {});
  conferir('um SIM de OUTRA pessoa do grupo não valida', validacoes.length === 0 && (r.responder === false || r.status === 'ignorado'), r.status);

  console.log('\n3) SIM valida e o aviso repete ticket e placa');
  r = await processar(texto('sim'), {});
  conferir('valida', r.status === 'validado' && validacoes.length === 1 && validacoes[0].ticket === '011609000100', r.status);
  conferir('o aviso final amarra o veículo ao ticket', /Veículo TKM1I33 vinculado ao ticket 011609000100/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  conferir('agora a foto do carro foi gasta (par com a do ticket)', fotosUsadas.jaUsada(FOTO) !== null);
  conferir('registra quem confirmou', r.veiculoConfirmadoPor === 'Cliente');
  conferir('não sobra pendência', pendencias.buscar(GRUPO, PESSOA) === null);

  console.log('\n4) NÃO cancela e devolve o pedido da foto do veículo');
  zerar(); validacoes = []; fotoAtual = Buffer.from('outro-carro-4').toString('base64');
  abrirPedido('011609000200');
  await processar(foto(), {});
  r = await processar(texto('não'), {});
  conferir('não valida', r.status === 'veiculo_nao_confere' && validacoes.length === 0, r.status);
  conferir('a foto não foi gasta', fotosUsadas.jaUsada(fotoAtual) === null);
  const p4 = pendencias.buscar(GRUPO, PESSOA) || {};
  conferir('o pedido da foto do veículo volta (dá para reenviar a certa)', p4.tipo === 'foto_local' && p4.ticket === '011609000200', JSON.stringify(p4));
  conferir('a mensagem orienta os dois casos', /foto do veículo certo/.test(r.mensagemWhatsapp) && /ticket é outro/.test(r.mensagemWhatsapp));
  fotoAtual = Buffer.from('carro-certo-4').toString('base64');
  r = await processar(foto(), {});
  conferir('reenviando a foto certa, pergunta de novo', r.status === 'confirmar_veiculo_ticket', r.status);

  console.log('\n5) Placa corrigida à mão');
  zerar(); validacoes = []; fotoAtual = Buffer.from('carro-5').toString('base64');
  abrirPedido('011609000300');
  await processar(foto(), {});
  r = await processar(texto('placa ABC1D23'), {});
  conferir('anota a placa e repete a pergunta', r.status === 'placa_anotada' && /ABC1D23/.test(r.mensagemWhatsapp), r.status);
  r = await processar(texto('sim'), {});
  conferir('valida com a placa corrigida', r.status === 'validado' && validacoes[0].placa === 'ABC1D23', JSON.stringify(validacoes));
  conferir('o aviso mostra a placa corrigida', /Veículo ABC1D23 vinculado/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);

  console.log('\n6) O que NÃO pergunta');
  zerar(); validacoes = []; fotoAtual = Buffer.from('carro-6').toString('base64');
  respostaLocal = { local: 'incompativel', localMotivo: 'asfalto com faixa amarela', cenario: 'x', placa: null };
  abrirPedido('011609000400');
  r = await processar(foto(), {});
  conferir('local incompatível: bloqueia, sem pergunta', r.status === 'local_incompativel' && r.notificarAdmin === true, r.status);
  respostaLocal = { local: 'indeterminado', localMotivo: 'close', cenario: 'x', placa: null };
  r = await processar(foto(), {});
  conferir('local indeterminado: pede outra foto, sem pergunta', r.status === 'local_indeterminado', r.status);
  respostaLocal = { local: 'compativel', localMotivo: 'bate', cenario: 'concreto', placa: null };
  r = await processar(foto(), {});
  conferir('sem placa lida, a pergunta avisa', r.status === 'confirmar_veiculo_ticket' && /Não consegui ler a placa/.test(r.mensagemWhatsapp), r.status);
  r = await processar(texto('sim'), {});
  conferir('e o aviso final não inventa placa', r.status === 'validado' && /Veículo vinculado ao ticket/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);

  console.log('\n7) Foto reutilizada continua barrada ANTES da pergunta');
  respostaLocal = { local: 'compativel', localMotivo: 'bate', cenario: 'concreto', placa: 'TKM1I33' };
  abrirPedido('011609000500');
  r = await processar(foto(), {});
  conferir('mesma foto de um ticket já validado: recusa', r.status === 'foto_reutilizada' && r.notificarAdmin === true, r.status);

  console.log('\n8) A chave confirmarVeiculoNoTicket: false volta a validar direto');
  zerar(); validacoes = [];
  cenario.montar({ hangares: { aibm: { exigeFotoVeiculoNoLocal: true, confirmarVeiculoNoTicket: false } }, zerarDados: false });
  fotoAtual = Buffer.from('carro-8').toString('base64');
  abrirPedido('011609000600');
  r = await processar(foto(), {});
  conferir('valida direto, sem pergunta', r.status === 'validado' && validacoes.length === 1, r.status);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.error('teste quebrou:', e); process.exit(1); });
