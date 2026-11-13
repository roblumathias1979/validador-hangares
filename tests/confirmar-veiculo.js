#!/usr/bin/env node
/**
 * Vínculo do veículo ao ticket no antifraude (13/11/2026).
 *
 * A foto do carro, no grupo, se perdia entre as outras mensagens e depois ninguém
 * sabia de qual ticket era. Regra:
 *  - a PRIMEIRA foto do carro depois do ticket confere (local compatível): valida
 *    direto, e o aviso final já diz "Veículo X vinculado ao ticket Y";
 *  - se a verificação não concluiu (indeterminado, incompatível ou foto
 *    reutilizada), o bot pede outra foto; quando ela conferir, PERGUNTA "esse
 *    veículo pertence ao ticket X?" antes de validar (agora há mais de uma foto);
 *  - `confirmarVeiculoNoTicket: false` nunca pergunta.
 *
 * Protege: validação direta na primeira foto; a pergunta só depois de tentativa
 * anterior, com ticket e placa, sem validar nem gastar a foto; SIM valida; NÃO
 * devolve o pedido; resposta solta e SIM de outra pessoa não validam; placa
 * corrigida à mão vale; foto reutilizada continua barrada antes de tudo.
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
const compat = (placa = 'TKM1I33') => ({ local: 'compativel', localMotivo: 'bate', cenario: 'concreto', placa });

(async () => {
  console.log('1) Primeira foto do carro confere: valida direto');
  abrirPedido('011609000100');
  let r = await processar(foto(), {});
  conferir('valida direto, sem perguntar', r.status === 'validado' && validacoes.length === 1 && validacoes[0].ticket === '011609000100', r.status);
  conferir('o aviso final amarra o veículo ao ticket', /Veículo TKM1I33 vinculado ao ticket 011609000100/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  conferir('a foto do carro foi gasta (par com a do ticket)', fotosUsadas.jaUsada(FOTO) !== null);
  conferir('não sobra pendência', pendencias.buscar(GRUPO, PESSOA) === null);

  console.log('\n2) Verificação não concluiu: pede outra foto; quando conferir, PERGUNTA');
  zerar(); validacoes = []; fotoAtual = Buffer.from('carro-2a').toString('base64');
  respostaLocal = { local: 'indeterminado', localMotivo: 'close demais', cenario: 'x', placa: null };
  abrirPedido('011609000200');
  r = await processar(foto(), {});
  conferir('indeterminado: pede outra foto, não pergunta nada', r.status === 'local_indeterminado' && validacoes.length === 0, r.status);
  conferir('o pedido segue aberto com 1 tentativa', (pendencias.buscar(GRUPO, PESSOA) || {}).tentativasFoto === 1);
  fotoAtual = Buffer.from('carro-2b').toString('base64');
  respostaLocal = compat('TKM1I33');
  r = await processar(foto(), {});
  conferir('a segunda foto confere: pergunta se pertence ao ticket', r.status === 'confirmar_veiculo_ticket', r.status);
  conferir('a pergunta traz ticket e placa', /011609000200/.test(r.mensagemWhatsapp) && /TKM1I33/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  conferir('diz que o local confere', /confere com o \*AIBM 1\*/.test(r.mensagemWhatsapp));
  conferir('NÃO validou nem gastou a foto ainda', validacoes.length === 0 && fotosUsadas.jaUsada(fotoAtual) === null);
  conferir('a pendência virou "confirmar_veiculo"', (pendencias.buscar(GRUPO, PESSOA) || {}).tipo === 'confirmar_veiculo');

  console.log('\n3) Resposta solta e de outra pessoa não validam');
  r = await processar(texto('talvez'), {});
  conferir('texto solto pede SIM ou NÃO', r.status === 'confirmacao_veiculo_nao_entendida' && /011609000200/.test(r.mensagemWhatsapp), r.status);
  r = await processar(texto('sim', OUTRA), {});
  conferir('um SIM de OUTRA pessoa do grupo não valida', validacoes.length === 0 && (r.responder === false || r.status === 'ignorado'), r.status);

  console.log('\n4) SIM valida e o aviso repete ticket e placa');
  r = await processar(texto('sim'), {});
  conferir('valida', r.status === 'validado' && validacoes.length === 1 && validacoes[0].ticket === '011609000200', r.status);
  conferir('o aviso final amarra o veículo ao ticket', /Veículo TKM1I33 vinculado ao ticket 011609000200/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  conferir('agora a foto foi gasta', fotosUsadas.jaUsada(fotoAtual) !== null);
  conferir('registra quem confirmou', r.veiculoConfirmadoPor === 'Cliente');
  conferir('não sobra pendência', pendencias.buscar(GRUPO, PESSOA) === null);

  console.log('\n5) NÃO cancela e devolve o pedido da foto do veículo');
  zerar(); validacoes = [];
  respostaLocal = { local: 'incompativel', localMotivo: 'asfalto com faixa amarela', cenario: 'x', placa: null };
  fotoAtual = Buffer.from('carro-5a').toString('base64');
  abrirPedido('011609000300');
  r = await processar(foto(), {});
  conferir('local incompatível: bloqueia, avisa a administração, sem pergunta', r.status === 'local_incompativel' && r.notificarAdmin === true, r.status);
  respostaLocal = compat('TKM1I33'); fotoAtual = Buffer.from('carro-5b').toString('base64');
  await processar(foto(), {});
  r = await processar(texto('não'), {});
  conferir('NÃO: não valida', r.status === 'veiculo_nao_confere' && validacoes.length === 0, r.status);
  const p5 = pendencias.buscar(GRUPO, PESSOA) || {};
  conferir('o pedido da foto do veículo volta (dá para reenviar a certa)', p5.tipo === 'foto_local' && p5.ticket === '011609000300', JSON.stringify(p5));
  conferir('a mensagem orienta os dois casos', /foto do veículo certo/.test(r.mensagemWhatsapp) && /ticket é outro/.test(r.mensagemWhatsapp));
  fotoAtual = Buffer.from('carro-5c').toString('base64');
  r = await processar(foto(), {});
  conferir('reenviando, pergunta de novo (já houve tentativa)', r.status === 'confirmar_veiculo_ticket', r.status);

  console.log('\n6) Placa corrigida à mão');
  zerar(); validacoes = [];
  respostaLocal = { local: 'indeterminado', localMotivo: 'x', cenario: 'x', placa: null };
  fotoAtual = Buffer.from('carro-6a').toString('base64');
  abrirPedido('011609000400');
  await processar(foto(), {});
  respostaLocal = compat('TKM1I33'); fotoAtual = Buffer.from('carro-6b').toString('base64');
  await processar(foto(), {});
  r = await processar(texto('placa ABC1D23'), {});
  conferir('anota a placa e repete a pergunta', r.status === 'placa_anotada' && /ABC1D23/.test(r.mensagemWhatsapp), r.status);
  r = await processar(texto('sim'), {});
  conferir('valida com a placa corrigida', r.status === 'validado' && validacoes[0].placa === 'ABC1D23', JSON.stringify(validacoes));
  conferir('o aviso mostra a placa corrigida', /Veículo ABC1D23 vinculado/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);

  console.log('\n7) Sem placa lida');
  zerar(); validacoes = [];
  respostaLocal = compat(null); fotoAtual = Buffer.from('carro-7').toString('base64');
  abrirPedido('011609000500');
  r = await processar(foto(), {});
  conferir('primeira foto sem placa: valida direto', r.status === 'validado', r.status);
  conferir('o aviso não inventa placa', /Veículo vinculado ao ticket 011609000500/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);

  console.log('\n8) Foto reutilizada continua barrada, e conta como tentativa');
  zerar(); validacoes = [];
  respostaLocal = compat('TKM1I33'); fotoAtual = FOTO;
  abrirPedido('011609000600');
  await processar(foto(), {});                      // gasta FOTO
  abrirPedido('011609000601');
  r = await processar(foto(), {});
  conferir('mesma foto de um ticket já validado: recusa e avisa a administração', r.status === 'foto_reutilizada' && r.notificarAdmin === true, r.status);
  fotoAtual = Buffer.from('carro-8b').toString('base64');
  r = await processar(foto(), {});
  conferir('a foto nova depois do reuso: pergunta se pertence ao ticket', r.status === 'confirmar_veiculo_ticket' && /011609000601/.test(r.mensagemWhatsapp), r.status);

  console.log('\n9) confirmarVeiculoNoTicket: false nunca pergunta');
  zerar(); validacoes = [];
  cenario.montar({ hangares: { aibm: { exigeFotoVeiculoNoLocal: true, confirmarVeiculoNoTicket: false } }, zerarDados: false });
  respostaLocal = { local: 'indeterminado', localMotivo: 'x', cenario: 'x', placa: null };
  fotoAtual = Buffer.from('carro-9a').toString('base64');
  abrirPedido('011609000700');
  await processar(foto(), {});
  respostaLocal = compat('TKM1I33'); fotoAtual = Buffer.from('carro-9b').toString('base64');
  r = await processar(foto(), {});
  conferir('mesmo depois de uma tentativa, valida direto', r.status === 'validado' && validacoes.length === 1, r.status);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.error('teste quebrou:', e); process.exit(1); });
