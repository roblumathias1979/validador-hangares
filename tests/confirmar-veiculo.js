#!/usr/bin/env node
/**
 * Vínculo do veículo ao ticket no antifraude (13/11/2026).
 *
 * A foto do carro, no grupo, se perdia entre as outras mensagens e depois ninguém
 * sabia de qual ticket era. Regra:
 *  - a PRIMEIRA foto do carro depois do ticket confere (local compatível): valida
 *    direto, e o aviso final já diz "Veículo X vinculado ao ticket Y";
 *  - se a verificação NÃO concluiu (indeterminado ou incompatível), o bot diz "não
 *    consegui conferir se o veículo está no pátio. Posso vincular esse veículo ao
 *    ticket X? Se sim, agora preciso da foto mais afastada e dentro do pátio": SIM
 *    vincula e pede a foto; a foto afastada que conferir valida direto (o vínculo
 *    já foi autorizado) e gasta TODAS as fotos juntas; NÃO volta a pedir a foto certa;
 *  - foto reutilizada segue recusada à parte; quando uma foto posterior conferir sem
 *    vínculo autorizado, aí PERGUNTA "esse veículo pertence ao ticket X?";
 *  - `confirmarVeiculoNoTicket: false` nunca pergunta (volta ao pedido simples).
 *
 * Protege: validação direta na primeira foto; a mensagem e o vínculo; o SIM/NÃO/foto
 * como resposta; resposta solta e SIM de outra pessoa não validam; placa corrigida
 * à mão vale; incompatível avisa a administração; reuso continua barrado.
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
const indet = (placa = null) => ({ local: 'indeterminado', localMotivo: 'close demais', cenario: 'x', placa });
const hashDe = (b64) => fotosUsadas.impressaoDigital(b64);
const b64 = (t) => Buffer.from(t).toString('base64');

(async () => {
  console.log('1) Primeira foto do carro confere: valida direto');
  abrirPedido('011609000100');
  let r = await processar(foto(), {});
  conferir('valida direto, sem perguntar', r.status === 'validado' && validacoes.length === 1 && validacoes[0].ticket === '011609000100', r.status);
  conferir('o aviso final amarra o veículo ao ticket', /Veículo TKM1I33 vinculado ao ticket 011609000100/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  conferir('a foto do carro foi gasta', fotosUsadas.jaUsada(FOTO) !== null);
  conferir('não sobra pendência', pendencias.buscar(GRUPO, PESSOA) === null);

  console.log('\n2) Não deu para conferir: pergunta se pode VINCULAR');
  zerar(); validacoes = []; fotoAtual = b64('carro-2a'); const F2A = fotoAtual;
  respostaLocal = indet('TKM1I33');
  abrirPedido('011609000200');
  r = await processar(foto(), {});
  conferir('status continua local_indeterminado', r.status === 'local_indeterminado', r.status);
  conferir('diz que não conseguiu conferir se o veículo está no pátio', /Não consegui conferir se o veículo está no pátio/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  conferir('pergunta se pode vincular, com ticket e placa', /Posso vincular esse veículo \(placa \*TKM1I33\*\) ao ticket \*011609000200\*\?/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  conferir('avisa o que vem depois: foto mais afastada e dentro do pátio', /mais afastado e dentro do pátio/.test(r.mensagemWhatsapp));
  conferir('NÃO validou', validacoes.length === 0);
  conferir('não aciona a administração (foi só enquadramento)', r.notificarAdmin === false);
  conferir('a pendência é "vincular_veiculo"', (pendencias.buscar(GRUPO, PESSOA) || {}).tipo === 'vincular_veiculo');

  console.log('\n3) Resposta solta e de outra pessoa não vinculam');
  r = await processar(texto('talvez'), {});
  conferir('texto solto repete a pergunta', r.status === 'vinculo_nao_entendido' && /011609000200/.test(r.mensagemWhatsapp), r.status);
  r = await processar(texto('sim', OUTRA), {});
  conferir('um SIM de OUTRA pessoa não vincula', r.responder === false || r.status === 'ignorado', r.status);
  conferir('a pendência segue a mesma', (pendencias.buscar(GRUPO, PESSOA) || {}).tipo === 'vincular_veiculo');

  console.log('\n4) SIM vincula e pede a foto afastada; ela confere e valida direto');
  r = await processar(texto('sim'), {});
  conferir('SIM vincula', r.status === 'veiculo_vinculado' && /vinculei o veículo \(placa \*TKM1I33\*\) ao ticket \*011609000200\*/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  conferir('e pede a foto mais afastada e dentro do pátio', /mais afastado e dentro do pátio/.test(r.mensagemWhatsapp));
  const p4 = pendencias.buscar(GRUPO, PESSOA) || {};
  conferir('o pedido volta a ser de foto do veículo, com o vínculo anotado', p4.tipo === 'foto_local' && p4.veiculoVinculado && p4.veiculoVinculado.hash === hashDe(F2A), JSON.stringify(p4));
  conferir('ainda não validou, e a foto vinculada ainda não foi gasta', validacoes.length === 0 && fotosUsadas.jaUsada(F2A) === null);
  fotoAtual = b64('carro-2b-afastado'); respostaLocal = compat('TKM1I33');
  r = await processar(foto(), {});
  conferir('a foto afastada confere: valida DIRETO (o vínculo já foi autorizado)', r.status === 'validado' && validacoes.length === 1 && validacoes[0].ticket === '011609000200', r.status);
  conferir('o aviso final amarra o veículo ao ticket', /Veículo TKM1I33 vinculado ao ticket 011609000200/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  conferir('as DUAS fotos do carro foram gastas (a vinculada e a afastada)', fotosUsadas.jaUsada(F2A) !== null && fotosUsadas.jaUsada(fotoAtual) !== null);
  conferir('não sobra pendência', pendencias.buscar(GRUPO, PESSOA) === null);

  console.log('\n5) Mandar a foto afastada sem responder vale como SIM');
  zerar(); validacoes = []; fotoAtual = b64('carro-5a'); const F5A = fotoAtual;
  respostaLocal = indet(null);
  abrirPedido('011609000300');
  r = await processar(foto(), {});
  conferir('sem placa lida, a pergunta não inventa placa', /Posso vincular esse veículo ao ticket \*011609000300\*\?/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  fotoAtual = b64('carro-5b'); respostaLocal = compat('TKM1I33');
  r = await processar(foto(), {});
  conferir('a foto afastada, sem resposta, vincula e valida', r.status === 'validado' && validacoes.length === 1, r.status);
  conferir('a foto anterior também foi gasta', fotosUsadas.jaUsada(F5A) !== null);

  console.log('\n6) NÃO ao vínculo: pede a foto do veículo certo; a próxima que conferir pergunta');
  zerar(); validacoes = []; fotoAtual = b64('carro-6a');
  respostaLocal = indet('TKM1I33');
  abrirPedido('011609000400');
  await processar(foto(), {});
  r = await processar(texto('não'), {});
  conferir('NÃO: não vincula nem valida', r.status === 'veiculo_nao_vinculado' && validacoes.length === 0, r.status);
  conferir('orienta os dois casos', /foto do veículo certo/.test(r.mensagemWhatsapp) && /ticket é outro/.test(r.mensagemWhatsapp));
  const p6 = pendencias.buscar(GRUPO, PESSOA) || {};
  conferir('o pedido da foto do veículo volta, sem vínculo', p6.tipo === 'foto_local' && !p6.veiculoVinculado, JSON.stringify(p6));
  fotoAtual = b64('carro-6b'); respostaLocal = compat('TKM1I33');
  r = await processar(foto(), {});
  conferir('uma foto que confere, sem vínculo autorizado, PERGUNTA se pertence ao ticket', r.status === 'confirmar_veiculo_ticket' && /011609000400/.test(r.mensagemWhatsapp) && /TKM1I33/.test(r.mensagemWhatsapp), r.status);
  conferir('e não valida nem gasta a foto antes do SIM', validacoes.length === 0 && fotosUsadas.jaUsada(fotoAtual) === null);
  r = await processar(texto('talvez'), {});
  conferir('resposta solta pede SIM ou NÃO', r.status === 'confirmacao_veiculo_nao_entendida', r.status);
  r = await processar(texto('sim'), {});
  conferir('SIM valida e o aviso amarra o veículo', r.status === 'validado' && /vinculado ao ticket 011609000400/.test(r.mensagemWhatsapp), r.status);

  console.log('\n7) Placa corrigida à mão na pergunta de vínculo');
  zerar(); validacoes = []; fotoAtual = b64('carro-7a');
  respostaLocal = indet('TKM1I33');
  abrirPedido('011609000500');
  await processar(foto(), {});
  r = await processar(texto('placa ABC1D23'), {});
  conferir('anota a placa e repete a pergunta de vínculo', r.status === 'placa_anotada' && /ABC1D23/.test(r.mensagemWhatsapp) && /vincular/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  r = await processar(texto('sim'), {});
  conferir('o vínculo usa a placa corrigida', /ABC1D23/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  fotoAtual = b64('carro-7b'); respostaLocal = compat(null);
  r = await processar(foto(), {});
  conferir('valida (e o aviso mostra a placa corrigida)', r.status === 'validado' && /Veículo ABC1D23 vinculado/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);

  console.log('\n8) Incompatível: mesma pergunta, mas avisa a administração');
  zerar(); validacoes = []; fotoAtual = b64('carro-8a');
  respostaLocal = { local: 'incompativel', localMotivo: 'asfalto com faixa amarela', cenario: 'x', placa: 'TKM1I33' };
  abrirPedido('011609000600');
  r = await processar(foto(), {});
  conferir('status local_incompativel e a administração é avisada', r.status === 'local_incompativel' && r.notificarAdmin === true, r.status);
  conferir('o texto ao cliente é neutro (não acusa) e pergunta o vínculo', /Não consegui conferir se o veículo está no pátio/.test(r.mensagemWhatsapp) && /Posso vincular/.test(r.mensagemWhatsapp) && !/fraude|não parece/i.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  await processar(texto('sim'), {});
  fotoAtual = b64('carro-8b');
  r = await processar(foto(), {});
  conferir('com o vínculo feito, outra foto incompatível NÃO repete a pergunta: pede a foto afastada', r.status === 'local_incompativel' && /mais afastada e dentro do pátio/.test(r.mensagemWhatsapp) && !/Posso vincular/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  conferir('e continua avisando a administração', r.notificarAdmin === true);
  conferir('nada foi validado', validacoes.length === 0);

  console.log('\n9) Foto reutilizada continua recusada à parte');
  zerar(); validacoes = [];
  respostaLocal = compat('TKM1I33'); fotoAtual = FOTO;
  abrirPedido('011609000700');
  await processar(foto(), {});
  abrirPedido('011609000701');
  r = await processar(foto(), {});
  conferir('mesma foto de um ticket já validado: recusa e avisa a administração', r.status === 'foto_reutilizada' && r.notificarAdmin === true, r.status);

  console.log('\n10) confirmarVeiculoNoTicket: false volta ao pedido simples');
  zerar(); validacoes = [];
  cenario.montar({ hangares: { aibm: { exigeFotoVeiculoNoLocal: true, confirmarVeiculoNoTicket: false } }, zerarDados: false });
  respostaLocal = indet('TKM1I33'); fotoAtual = b64('carro-10a');
  abrirPedido('011609000800');
  r = await processar(foto(), {});
  conferir('não pergunta o vínculo: só pede outra foto afastada', r.status === 'local_indeterminado' && !/Posso vincular/.test(r.mensagemWhatsapp) && /mais afastada e dentro do pátio/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  fotoAtual = b64('carro-10b'); respostaLocal = compat('TKM1I33');
  r = await processar(foto(), {});
  conferir('e valida direto quando a foto seguinte confere', r.status === 'validado' && validacoes.length === 1, r.status);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.error('teste quebrou:', e); process.exit(1); });
