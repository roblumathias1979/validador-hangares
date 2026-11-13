#!/usr/bin/env node
/**
 * Trocar as fotos de referência de um pátio pelo grupo de administração
 * (13/11/2026): escolher o pátio, mandar até 3 fotos, PRONTO, confirmar com SIM.
 *
 * Protege: nada muda antes do SIM (as fotos ficam numa área de espera); NÃO e
 * CANCELAR limpam; as antigas são copiadas antes de sair; só 3 fotos entram;
 * arquivo que não é imagem ou é grande demais é recusado; a troca que falha no
 * meio devolve as fotos de antes; grupo de hangar não comanda; só 3 cópias antigas
 * ficam. Usa o pátio "solojet-shares" para não tocar nas fotos reais do AIBM.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const ADM = '120363432317888806@g.us';
const GRUPO_HANGAR = '120363431859218622@g.us';
const PESSOA = '5511999999999@s.whatsapp.net';
const PATIO = 'solojet-shares';

require('./cenario').montar({});

const DIRS = ['data/referencias/' + PATIO, 'data/referencias-pendentes', 'data/referencias-anteriores'];
const EXTRA = ['data/mensagens-vistas.json', 'data/pendencias.json'];
const guardado = {};
for (const a of EXTRA) { const p = path.join(RAIZ, a); guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; fs.writeFileSync(p, '{}'); }
const limparDirs = () => { for (const d of DIRS) fs.rmSync(path.join(RAIZ, d), { recursive: true, force: true }); };
limparDirs();
process.on('exit', () => { limparDirs(); for (const a of EXTRA) { const p = path.join(RAIZ, a); if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) { /* ok */ } } else fs.writeFileSync(p, guardado[a]); } });

// Evolution: devolve a "imagem" que o teste mandar.
let proxima = { base64: Buffer.from('foto-de-teste').toString('base64'), mimetype: 'image/jpeg' };
const http = require('http');
const chamadas = [];
http.request = (o, cb) => { chamadas.push(String((o && o.path) || '')); const r = new (require('stream').PassThrough)(); r.statusCode = 200; process.nextTick(() => { cb(r); r.end(JSON.stringify(proxima)); }); return { on() { return this; }, write() {}, end() {}, setTimeout() {}, destroy() {} }; };

const child = require('child_process');
const real = child.execFileSync;
child.execFileSync = (c, a, o) => (c === 'git' ? (a.includes('rev-parse') ? 'x' : '') : real(c, a, o));

const { interpretarComandoFotosPatio, interpretarMensagem } = require(path.join(RAIZ, 'scripts', 'lib', 'whatsapp.js'));
const referencias = require(path.join(RAIZ, 'scripts', 'lib', 'referencias.js'));
const refs = require(path.join(RAIZ, 'scripts', 'lib', 'referencias-whatsapp.js'));
const extrair = require(path.join(RAIZ, 'scripts', 'lib', 'extrair-quadros.js'));
const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));
const crypto = require('crypto');

const texto = (jid, t) => ({ data: { key: { remoteJid: jid, fromMe: false, id: `T${Math.random()}`, participant: PESSOA }, pushName: 'Rodrigo', message: { conversation: t } } });
const imagem = (jid, id) => ({ data: { key: { remoteJid: jid, fromMe: false, id, participant: PESSOA }, pushName: 'Rodrigo', message: { imageMessage: { caption: '', mimetype: 'image/jpeg' } } } });
const adm = (t) => processar(texto(ADM, t), {});
const nomes = () => referencias.listar(PATIO).filter((a) => a.usadoNaConferencia).map((a) => a.nome);
const semear = (n) => { for (let i = 0; i < n; i += 1) referencias.guardar(PATIO, { mimetype: 'image/jpeg', base64: Buffer.from(`antiga-${i}`).toString('base64'), rotulo: 'antiga' }); };

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

(async () => {
  console.log('1) Parser');
  for (const [t, esperado] of [['atualizar fotos dos pátios', true], ['Trocar as fotos de referência', true], ['mandar novas fotos do local', true], ['substituir fotos do AIBM', true],
    ['ver fotos do pátio', false], ['mandei a foto agora', false], ['atualizar servidor', false], ['bom dia', false]]) {
    conferir(`"${t}" → ${esperado}`, interpretarComandoFotosPatio(t) === esperado);
  }

  console.log('\n2) Fluxo completo com SIM');
  semear(2);
  const antigas = nomes();
  let r = await adm('atualizar fotos dos pátios');
  conferir('abre a lista de pátios com a quantidade de fotos', r.status === 'fotos_escolher_patio' && /Solojet Shares — 📷 2 fotos/.test(r.mensagemWhatsapp), r.status);
  const n = (r.mensagemWhatsapp.match(/\*(\d+)\* Solojet Shares /) || [])[1];
  r = await adm('todos');
  conferir('"todos" não vale: uma troca de cada vez', r.status === 'fotos_patio_nao_entendido', r.status);
  r = await adm(n);
  conferir('escolhido o pátio, pede as fotos e avisa que substituem', r.status === 'fotos_coletando' && /Solojet Shares/.test(r.mensagemWhatsapp) && /substituir/.test(r.mensagemWhatsapp), r.status);
  for (let i = 1; i <= 5; i += 1) {
    r = await processar(imagem(ADM, `IMG${i}`), {});
    conferir(`foto ${i} recebida`, r.status === 'fotos_recebida' && new RegExp(`foto ${i} `).test(r.mensagemWhatsapp), r.status + ' ' + r.mensagemWhatsapp);
  }
  r = await processar(imagem(ADM, 'IMG6'), {});
  conferir('a sexta avisa que só 5 entram', r.status === 'fotos_recebida' && /5 primeiras/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  r = await processar(imagem(ADM, 'IMG1'), {});
  conferir('a mesma foto reenviada não conta duas vezes', refs.listarPendentes(PATIO).length === 6, String(refs.listarPendentes(PATIO).length));
  conferir('NADA mudou ainda nas fotos atuais', JSON.stringify(nomes()) === JSON.stringify(antigas));
  r = await adm('pronto');
  conferir('PRONTO pede confirmação mostrando o que muda', r.status === 'fotos_confirmar' && /as 2 fotos atuais/.test(r.mensagemWhatsapp) && /5 fotos novas/.test(r.mensagemWhatsapp) && /cópia/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  conferir('ainda nada mudou antes do SIM', JSON.stringify(nomes()) === JSON.stringify(antigas));
  r = await adm('talvez');
  conferir('resposta solta pede SIM ou NÃO', r.status === 'fotos_confirma_nao_entendido');
  r = await adm('sim');
  conferir('SIM troca', r.status === 'fotos_atualizadas' && /5 fotos\* novas/.test(r.mensagemWhatsapp) && /substituíram 2/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  const novas = nomes();
  conferir('o pátio agora tem as 5 novas (e nenhuma das antigas)', novas.length === 5 && !novas.some((x) => antigas.includes(x)), novas.join());
  const pastaCopias = path.join(RAIZ, 'data', 'referencias-anteriores', PATIO);
  const copia = fs.readdirSync(pastaCopias);
  conferir('as 2 antigas ficaram numa cópia datada', copia.length === 1 && fs.readdirSync(path.join(pastaCopias, copia[0])).length === 2);
  conferir('a área de espera foi limpa', refs.listarPendentes(PATIO).length === 0);

  console.log('\n3) NÃO, CANCELAR e casos de borda');
  r = await adm('atualizar fotos dos pátios'); await adm(n);
  await processar(imagem(ADM, 'B1'), {}); await adm('pronto');
  r = await adm('não');
  conferir('NÃO mantém as fotos e limpa a espera', r.status === 'fotos_cancelado' && JSON.stringify(nomes()) === JSON.stringify(novas) && refs.listarPendentes(PATIO).length === 0, r.status);
  await adm('atualizar fotos dos pátios'); await adm(n);
  r = await adm('pronto');
  conferir('PRONTO sem foto nenhuma: avisa e continua esperando', r.status === 'fotos_nenhuma', r.status);
  await processar(imagem(ADM, 'C1'), {});
  r = await adm('cancelar');
  conferir('CANCELAR limpa a espera e não mexe nas fotos', r.status === 'fotos_cancelado' && refs.listarPendentes(PATIO).length === 0 && JSON.stringify(nomes()) === JSON.stringify(novas), r.status);
  await adm('atualizar fotos dos pátios'); await adm(n);
  r = await adm('bom dia');
  conferir('texto qualquer no meio da coleta lembra o que falta', r.status === 'fotos_aguardando', r.status);
  proxima = { base64: Buffer.from('x').toString('base64'), mimetype: 'application/pdf' };
  r = await processar(imagem(ADM, 'D1'), {});
  conferir('arquivo que não é imagem é recusado', r.status === 'fotos_recusada' && /JPEG, PNG ou WebP/.test(r.mensagemWhatsapp), r.status);
  proxima = { base64: Buffer.alloc(3 * 1048576 + 10, 1).toString('base64'), mimetype: 'image/jpeg' };
  r = await processar(imagem(ADM, 'D2'), {});
  conferir('foto maior que 3 MB é recusada', r.status === 'fotos_recusada' && /limite é 3 MB/.test(r.mensagemWhatsapp), r.status);
  proxima = { base64: Buffer.from('foto-de-teste').toString('base64'), mimetype: 'image/jpeg' };
  r = await adm('atualizar fotos dos pátios');
  conferir('comando novo no meio recomeça e larga a espera', r.status === 'fotos_escolher_patio' && refs.listarPendentes(PATIO).length === 0, r.status);
  await adm('cancelar');

  console.log('\n4) Grupo de hangar não comanda');
  r = await processar(texto(GRUPO_HANGAR, 'atualizar fotos dos pátios'), {});
  conferir('no grupo de um hangar não vira comando', !/^fotos_/.test(String(r.status)), r.status);
  r = await processar(imagem(GRUPO_HANGAR, 'H1'), {});
  conferir('foto solta no grupo de hangar não vai para a espera', refs.listarPendentes(PATIO).length === 0);

  console.log('\n5) Cópias antigas e falha no meio da troca');
  limparDirs();
  semear(1);
  for (let k = 1; k <= 5; k += 1) {
    refs.guardarPendente(PATIO, { mimetype: 'image/jpeg', base64: Buffer.from(`nova-${k}`).toString('base64'), idMensagem: `R${k}` });
    refs.aplicar(PATIO, new Date(`2026-11-0${k}T10:00:00Z`));
  }
  conferir('só as 3 últimas cópias ficam', fs.readdirSync(pastaCopias).length === 3, fs.readdirSync(pastaCopias).join());
  const antesFalha = nomes();
  const conteudoAntes = antesFalha.map((x) => referencias.conteudo(PATIO, x).dados.toString());
  refs.guardarPendente(PATIO, { mimetype: 'image/jpeg', base64: Buffer.from('vai-falhar').toString('base64'), idMensagem: 'F1' });
  const guardarReal = referencias.guardar;
  referencias.guardar = () => { throw new Error('disco cheio (simulado)'); };
  let erro = null;
  try { refs.aplicar(PATIO, new Date('2026-11-09T10:00:00Z')); } catch (e) { erro = e; } finally { referencias.guardar = guardarReal; }
  conferir('a falha avisa e diz que manteve as de antes', erro && /Mantive as de antes/.test(erro.message), erro && erro.message);
  conferir('as fotos de antes voltaram, com os mesmos nomes', JSON.stringify(nomes()) === JSON.stringify(antesFalha), nomes().join());
  conferir('...e o mesmo conteúdo', nomes().map((x) => referencias.conteudo(PATIO, x).dados.toString()).join() === conteudoAntes.join());
  conferir('...e a área de espera não foi limpa (dá para tentar de novo)', refs.listarPendentes(PATIO).length === 1);

  console.log('\n6) Fotos gravadas em sequência não se sobrescrevem');
  limparDirs();
  const gravados = [1, 2, 3, 4, 5].map((k) => referencias.guardar(PATIO, { mimetype: 'image/jpeg', base64: Buffer.from(`x${k}`).toString('base64'), rotulo: 'seq' }).nome);
  conferir('cinco fotos no mesmo instante, cinco arquivos', new Set(gravados).size === 5 && nomes().length === 5, gravados.join());
  let recusouSexta = false;
  try { referencias.guardar(PATIO, { mimetype: 'image/jpeg', base64: Buffer.from('s').toString('base64') }); } catch (e) { recusouSexta = /5 imagens/.test(e.message); }
  conferir('a sexta é recusada (o limite agora é 5)', recusouSexta);


  console.log('\n7) Vídeo: o bot tira os quadros e mostra no grupo');
  const tmpV = fs.mkdtempSync(path.join(require('os').tmpdir(), 'video-teste-'));
  const mp4 = path.join(tmpV, 'teste.mp4');
  real('ffmpeg', ['-nostdin', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=duration=6:size=320x240:rate=10', '-pix_fmt', 'yuv420p', '-y', mp4]);
  const base64Video = fs.readFileSync(mp4).toString('base64');
  fs.rmSync(tmpV, { recursive: true, force: true });
  const video = (id, segundos) => ({ data: { key: { remoteJid: ADM, fromMe: false, id, participant: PESSOA }, pushName: 'Rodrigo', message: { videoMessage: { mimetype: 'video/mp4', seconds: segundos, fileLength: '300000' } } } });
  const vidaDe = (id, jid) => ({ data: { key: { remoteJid: jid, fromMe: false, id, participant: PESSOA }, pushName: 'X', message: { videoMessage: { mimetype: 'video/mp4', seconds: 6 } } } });
  const m = interpretarMensagem(video('V0', 6).data ? { data: video('V0', 6).data } : {});
  conferir('o parser reconhece o vídeo (tipo, segundos)', m.tipo === 'video' && m.segundos === 6 && m.ignorar === false, JSON.stringify({ t: m.tipo, s: m.segundos }));
  conferir('instantes: 5 quadros em 10 s caem em 1, 3, 5, 7 e 9', JSON.stringify(extrair.instantes(10, 5).map((x) => Math.round(x))) === '[1,3,5,7,9]');

  limparDirs();
  proxima = { base64: base64Video, mimetype: 'video/mp4' };
  await adm('atualizar fotos dos pátios'); await adm(n);
  chamadas.length = 0;
  r = await processar(video('V1', 6), {});
  conferir('o vídeo vira 5 quadros', r.status === 'fotos_recebida' && /5 quadros/.test(r.mensagemWhatsapp) && refs.listarPendentes(PATIO).length === 5, r.status + ' ' + r.mensagemWhatsapp);
  conferir('os 5 quadros foram mostrados no grupo', chamadas.filter((c) => /sendMedia/.test(c)).length === 5, chamadas.join(' '));
  const arqs = refs.listarPendentes(PATIO);
  conferir('são JPEG de verdade', arqs.every((a) => fs.readFileSync(a).slice(0, 3).equals(Buffer.from([0xff, 0xd8, 0xff]))));
  conferir('são quadros diferentes (instantes diferentes)', new Set(arqs.map((a) => crypto.createHash('md5').update(fs.readFileSync(a)).digest('hex'))).size >= 4);
  r = await processar(video('V2', 6), {});
  conferir('com as 5 já recebidas, avisa que está cheio', /Já tenho as 5/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  r = await adm('limpar');
  conferir('LIMPAR zera o que foi recebido e segue esperando', r.status === 'fotos_limpas' && refs.listarPendentes(PATIO).length === 0, r.status);
  const jpg = { base64: Buffer.from('foto-de-teste').toString('base64'), mimetype: 'image/jpeg' };
  proxima = jpg; await processar(imagem(ADM, 'P1'), {}); await processar(imagem(ADM, 'P2'), {}); proxima = { base64: base64Video, mimetype: 'video/mp4' };
  chamadas.length = 0;
  r = await processar(video('V3', 6), {});
  conferir('com 2 fotos já recebidas, o vídeo completa só os 3 que faltam', refs.listarPendentes(PATIO).length === 5 && /3 quadros/.test(r.mensagemWhatsapp) && chamadas.filter((c) => /sendMedia/.test(c)).length === 3, r.mensagemWhatsapp);
  await adm('limpar');
  chamadas.length = 0;
  r = await processar(video('V4', 120), {});
  conferir('vídeo longo demais é recusado antes de baixar', r.status === 'fotos_recusada' && /limite é 60 s/.test(r.mensagemWhatsapp) && !chamadas.some((c) => /getBase64/.test(c)), r.mensagemWhatsapp);
  const PATH_ORIGINAL = process.env.PATH;
  process.env.PATH = '/caminho-que-nao-existe';
  try { r = await processar(video('V5', 6), {}); } finally { process.env.PATH = PATH_ORIGINAL; }
  conferir('sem ffmpeg no servidor: explica e sugere fotos', r.status === 'fotos_recusada' && /ffmpeg/.test(r.mensagemWhatsapp) && /apt install/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  conferir('nada ficou na espera depois da falha', refs.listarPendentes(PATIO).length === 0);
  await adm('cancelar');
  let erroLongo = null;
  try { extrair.extrairQuadros(base64Video, { quantidade: 5, executar: (c, a) => (c === 'ffprobe' ? '90.0\n' : '') }); } catch (e) { erroLongo = e; }
  conferir('a biblioteca recusa vídeo com mais de 60 s', erroLongo && erroLongo.codigo === 'longo');
  r = await processar(vidaDe('V6', ADM), {});
  conferir('vídeo no grupo de administração SEM coleta em andamento não quebra nem responde', r.responder === false || r.status === 'ignorado', JSON.stringify({ s: r.status, r: r.responder }));
  r = await processar(imagem(ADM, 'FOTOSOLTA'), {});
  conferir('foto solta no grupo de administração também fica em silêncio', r.responder === false, JSON.stringify({ s: r.status, r: r.responder }));
  r = await processar(vidaDe('V7', GRUPO_HANGAR), {});
  conferir('vídeo em grupo de hangar é ignorado', r.status === 'ignorado' && r.responder === false, r.status);
  proxima = { base64: Buffer.from('foto-de-teste').toString('base64'), mimetype: 'image/jpeg' };

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
  process.exit(falhas ? 1 : 0);
})();
