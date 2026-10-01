#!/usr/bin/env node
/**
 * Contingência do ValidPark: com o site fora do ar, a validação NORMAL (dentro
 * do prazo) não vai ao navegador — vai pelo coletor, no pátio do próprio hangar.
 *
 * É a rede de segurança para quando o ValidPark cai. O que este teste protege:
 *
 * 1. Ligada, a validação dentro do prazo NÃO abre o ValidPark (nenhum script
 *    filho é chamado) e enfileira para o coletor, no pátio do hangar (não #1PARK).
 * 2. A guarda do pátio cheio continua valendo: sem o ValidPark para contar
 *    vagas, usa a lotação do snapshot — cheio, bloqueia em vez de validar.
 * 3. Sem snapshot fresco (coletor também mudo), recusa honestamente — não
 *    valida no escuro.
 * 4. Desligada, nada muda: a validação volta a abrir o ValidPark.
 *
 * Config, fila, bloqueados e snapshot são reais: o teste guarda e devolve.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';
// Espera curta no teste: o bot aguarda o resultado do coletor para responder na
// hora; aqui um "coletor" simulado marca a validação logo, e a espera é breve.
process.env.CONTINGENCIA_ESPERA_MS = '3000';
process.env.CONTINGENCIA_POLL_MS = '20';

const RAIZ = path.join(__dirname, '..');
const GRUPO = '120363431859218622@g.us'; // Solojet (bolsão "HANGAR SOLOJET", pátio 30)
const PESSOA = '5511999999999@s.whatsapp.net';
const ADMIN = '5511913119423@s.whatsapp.net'; // grupoAdministracao
const AUTORIZADO = '5511992773041@s.whatsapp.net'; // admin completo (adminsWhatsapp)
const ADMGRUPO = '120363432317888806@g.us'; // grupo de administração (adminsWhatsapp)

require('./cenario').montar({ hangares: { solojet: { cotaMensalValidacoes: null, grupoAdministracao: ADMIN } } });

// Liga a contingência no config que o cenário acabou de escrever (o cenário só
// mexe em campos de hangar; a chave global é global). O cenário restaura o
// config original no fim, então esta alteração não vaza.
const CONFIG = path.join(RAIZ, 'config', 'hangares.json');
(() => { const c = JSON.parse(fs.readFileSync(CONFIG, 'utf-8')); c.contingenciaValidPark = { ativo: true, desde: new Date().toISOString(), por: 'teste' }; fs.writeFileSync(CONFIG, `${JSON.stringify(c, null, 2)}\n`); })();

// Estado que o cenário não zera: fila, bloqueados e o snapshot do pátio.
const EXTRA = ['data/validacoes-pendentes.json', 'data/tickets-bloqueados.json', 'data/techparking-snapshot.json'];
const guardado = {};
for (const a of EXTRA) { const p = path.join(RAIZ, a); guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; }
process.on('exit', () => { for (const a of EXTRA) { const p = path.join(RAIZ, a); if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) {} } else fs.writeFileSync(p, guardado[a]); } });
for (const a of EXTRA) fs.writeFileSync(path.join(RAIZ, a), '{}');

const SNAPSHOT = path.join(RAIZ, 'data', 'techparking-snapshot.json');
// Escreve uma foto do pátio: capacidade `vagas`, `ocupadas` tickets validados
// dentro dele. `idadeMin` envelhece a foto para testar o caso sem dados frescos.
function escreverSnapshot({ vagas, ocupadas = 0, idadeMin = 0 }) {
  const futuro = new Date(Date.now() + 5 * 86400000).toISOString(); // tolerância longe: não é fantasma
  const avulsos = [];
  for (let i = 0; i < ocupadas; i += 1) avulsos.push({ IDPATIO: 30, USUARIO: 'HANGAR SOLOJET', CARTAO: `C${i}`, TOLERANCIA: futuro, PLACA: '' });
  fs.writeFileSync(SNAPSHOT, JSON.stringify({
    recebidoEm: new Date(Date.now() - idadeMin * 60000).toISOString(),
    coletadoEm: null,
    patios: [{ IDPATIO: 30, PATIO: 'HANGAR SOLOJET', VAGAS: vagas }],
    avulsos,
    credenciados: [],
  }));
}

// OCR devolve um ticket DENTRO do prazo (emitido agora). O número muda por caso.
let ticketAtual = 'C00000000001';
const agora = () => new Date(Date.now() - 5 * 60 * 1000).toISOString(); // há 5 min: dentro das 2h
const ocr = require(path.join(RAIZ, 'scripts', 'ocr-ticket.js'));
ocr.lerTicket = async () => ({ status: 'ocr_ok', ticket: ticketAtual, dataEmissaoIso: agora(), conferencia: { ok: true } });

// Com a contingência ligada, NENHUM script filho deve rodar (nada de ValidPark).
// Git é no-op (o comando pelo WhatsApp commita, e isso não pode sujar o repo);
// qualquer `node <script>` é tentativa de abrir o ValidPark e falha o teste.
let chamouScript = false;
const child = require('child_process');
const gitReal = child.execFileSync;
child.execFileSync = (cmd, args, opcoes) => {
  if (cmd === 'git') {
    if (args.some((a) => ['add', 'commit', 'push'].includes(a))) return '';
    if (args.includes('rev-parse')) return 'commit-de-teste';
    return gitReal(cmd, args, opcoes);
  }
  chamouScript = true;
  throw new Error('nao deveria chamar ' + path.basename((args && args[0]) || String(cmd)));
};

// Download da imagem da foto: responde sem rede.
const http = require('http');
http.request = (_o, cb) => {
  const r = new (require('stream').PassThrough)(); r.statusCode = 200;
  process.nextTick(() => { cb(r); r.end(JSON.stringify({ base64: Buffer.from('f').toString('base64'), mimetype: 'image/jpeg' })); });
  return { on() { return this; }, write() {}, end() {}, setTimeout() {}, destroy() {} };
};

// Consulta de pátio: stub (o real abre o ValidPark via Playwright). Precisa
// estar de pé ANTES de processar-mensagem exigir o módulo, que ele desestrutura.
const consultar = require(path.join(RAIZ, 'scripts', 'consultar-patio.js'));
let ultimaConsulta = null;
consultar.consultarPatio = async (id, opcoes) => {
  ultimaConsulta = { id, formato: (opcoes || {}).formato };
  return { status: 'patio_ok', disponiveis: 28, total: 90, mensagemWhatsapp: `📊 *${id}*\nVagas: 28 livres de 90` };
};

// Envio a grupos: stub (o real chama a Evolution). Antes do require, idem.
const evolution = require(path.join(RAIZ, 'scripts', 'lib', 'evolution.js'));
let enviados = [];
let imagensEnviadas = [];
evolution.enviarTexto = async (grupo, texto) => { enviados.push({ grupo, texto }); return { ok: true }; };
evolution.enviarImagem = async (grupo, base64, opts) => { imagensEnviadas.push({ grupo, base64, legenda: (opts || {}).legenda }); return { ok: true }; };

const fila = require(path.join(RAIZ, 'scripts', 'lib', 'validacoes-pendentes.js'));
const bloqueados = require(path.join(RAIZ, 'scripts', 'lib', 'tickets-bloqueados.js'));
const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));

const foto = (grupo) => ({ data: { key: { remoteJid: grupo, fromMe: false, id: `T${Math.random()}`, participant: PESSOA }, pushName: 'Cliente', message: { imageMessage: { caption: '', mimetype: 'image/jpeg' } } } });
const textoAdmin = (t) => ({ data: { key: { remoteJid: ADMIN, fromMe: false, id: `A${Math.random()}` }, pushName: 'Rodrigo', message: { conversation: t } } });
const textoPrivado = (de, t) => ({ data: { key: { remoteJid: de, fromMe: false, id: `P${Math.random()}` }, pushName: 'Estranho', message: { conversation: t } } });
const textoGrupo = (grupo, t) => ({ data: { key: { remoteJid: grupo, fromMe: false, id: `G${Math.random()}`, participant: PESSOA }, pushName: 'Alguém', message: { conversation: t } } });
const fotoGrupoAdmin = (legenda) => ({ data: { key: { remoteJid: ADMGRUPO, fromMe: false, id: `I${Math.random()}`, participant: PESSOA }, pushName: 'Alguém', message: { imageMessage: { caption: legenda, mimetype: 'image/jpeg' } } } });
const ativoAgora = () => (JSON.parse(fs.readFileSync(CONFIG, 'utf-8')).contingenciaValidPark || {}).ativo === true;

// "Coletor" simulado: fica de olho na fila e, assim que o bot enfileira uma
// validação, marca o resultado — como o coletor do aeroporto faria em segundos.
// Devolve uma função para desligar. `ok=false` simula falha na validação.
function simularColetor(ok = true) {
  const iv = setInterval(() => {
    const pend = fila.retirarParaProcessar();
    for (const v of pend) fila.registrarResultado(v.id, { ok, codigo: ok ? 200 : 500, resposta: ok ? 'ok' : 'erro' });
  }, 10);
  return () => clearInterval(iv);
}

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

async function main() {
  console.log('Ligada, pátio com vaga: valida pelo coletor e responde NA HORA, sem ValidPark');
  escreverSnapshot({ vagas: 90, ocupadas: 0 });
  ticketAtual = 'C00000000001';
  let pararColetor = simularColetor(true);
  const r1 = await processar(foto(GRUPO), {});
  pararColetor();
  conferir('não chamou o ValidPark', chamouScript === false);
  conferir('responde validado na hora (uma mensagem só)', r1.status === 'validado' && /validado/i.test(r1.mensagemWhatsapp || ''), `veio "${r1.status}"`);
  const feita = fila.listar().find((v) => v.ticket === 'C00000000001');
  conferir('validou no pátio do hangar (30), não no #1PARK', feita && feita.patioId === 30 && feita.patioLabel === 'HANGAR SOLOJET', JSON.stringify(feita));
  conferir('motivo contingência e prazo do hangar', feita && feita.motivo === 'contingencia' && feita.dias === 20);
  conferir('marcada como avisada (sem aviso duplicado)', feita && feita.avisado === true);

  console.log('\nLigada, coletor falha: responde o erro na hora');
  escreverSnapshot({ vagas: 90, ocupadas: 0 });
  ticketAtual = 'C00000000009';
  pararColetor = simularColetor(false);
  const rFalha = await processar(foto(GRUPO), {});
  pararColetor();
  conferir('status de falha', rFalha.status === 'contingencia_falhou', `veio "${rFalha.status}"`);
  conferir('avisa a equipe', rFalha.notificarAdmin === true);

  console.log('\nLigada, coletor mudo: cai no aviso assíncrono (não trava)');
  escreverSnapshot({ vagas: 90, ocupadas: 0 });
  ticketAtual = 'C00000000010';
  const rTimeout = await processar(foto(GRUPO), {}); // sem coletor: espera esgota
  conferir('vira recebimento assíncrono', rTimeout.status === 'contingencia_enfileirada', `veio "${rTimeout.status}"`);
  conferir('ainda não avisada (servidor avisa depois)', (fila.listar().find((v) => v.ticket === 'C00000000010') || {}).avisado !== true);

  console.log('\nLigada, pátio cheio: bloqueia (guarda anti-fraude de sempre)');
  escreverSnapshot({ vagas: 2, ocupadas: 2 });
  ticketAtual = 'C00000000002';
  const r2 = await processar(foto(GRUPO), {});
  conferir('status sem_vagas', r2.status === 'sem_vagas', `veio "${r2.status}"`);
  conferir('travou o ticket', Boolean(bloqueados.estaBloqueado(ticketAtual)));
  conferir('não enfileirou o cheio', fila.listar().every((v) => v.ticket !== ticketAtual));

  console.log('\nLigada, snapshot velho: recusa honesta, não valida no escuro');
  escreverSnapshot({ vagas: 90, ocupadas: 0, idadeMin: 30 });
  ticketAtual = 'C00000000003';
  const r3 = await processar(foto(GRUPO), {});
  conferir('status sem dados', r3.status === 'contingencia_sem_dados', `veio "${r3.status}"`);
  conferir('chama a equipe', r3.notificarAdmin === true);
  conferir('não enfileirou às cegas', fila.listar().every((v) => v.ticket !== ticketAtual));

  console.log('\nComando pelo WhatsApp: admin liga e desliga no privado');
  const resetCont = (autorizados = []) => { const c = JSON.parse(fs.readFileSync(CONFIG, 'utf-8')); c.contingenciaValidPark = { ativo: false, desde: null, por: null, autorizados }; fs.writeFileSync(CONFIG, `${JSON.stringify(c, null, 2)}\n`); };
  resetCont();
  const estranho = await processar(textoPrivado(PESSOA, 'ligar contingência'), {});
  conferir('não-admin é ignorado', estranho.responder === false && estranho.status === 'ignorado', `veio "${estranho.status}"`);
  conferir('e não ligou nada', ativoAgora() === false);

  const pergunta = await processar(textoAdmin('ligar contingência'), {});
  conferir('ligar PERGUNTA antes', pergunta.status === 'contingencia_confirmar' && /modo contingência/i.test(pergunta.mensagemWhatsapp), `veio "${pergunta.status}"`);
  conferir('ainda não ligou (só perguntou)', ativoAgora() === false);
  const ligou = await processar(textoAdmin('sim'), {});
  conferir('SIM ativa', ligou.status === 'contingencia_ligada', `veio "${ligou.status}"`);
  conferir('config ligada', ativoAgora() === true);
  conferir('avisa que ativou validando direto', /ATIVADO/.test(ligou.mensagemWhatsapp) && /aeroporto/i.test(ligou.mensagemWhatsapp));

  const dnovo = await processar(textoAdmin('ligar contingencia'), {});
  conferir('ligar de novo avisa que já está (sem perguntar)', dnovo.status === 'contingencia_sem_mudanca', `veio "${dnovo.status}"`);

  const desligou = await processar(textoAdmin('desligar contingência'), {});
  conferir('desligar é direto (sem perguntar)', desligou.status === 'contingencia_desligada', `veio "${desligou.status}"`);
  conferir('config desligada', ativoAgora() === false);

  console.log('\nLigar e responder NÃO: não ativa');
  await processar(textoAdmin('ligar contingência'), {});
  const recusa = await processar(textoAdmin('não'), {});
  conferir('NÃO cancela', recusa.status === 'contingencia_cancelada' && ativoAgora() === false, `veio "${recusa.status}"`);

  const conversa = await processar(textoAdmin('o validpark caiu de novo, que saco'), {});
  conferir('frase solta não é comando', conversa.status !== 'contingencia_confirmar' && ativoAgora() === false, `veio "${conversa.status}"`);

  console.log('\nNúmero em adminsWhatsapp: admin COMPLETO (contingência + financeiro)');
  resetCont();
  await processar(textoPrivado(AUTORIZADO, 'ligar contingência'), {});
  const extraLiga = await processar(textoPrivado(AUTORIZADO, 'sim'), {});
  conferir('liga a contingência (após confirmar)', extraLiga.status === 'contingencia_ligada', `veio "${extraLiga.status}"`);
  resetCont();
  // Zera o que ficou pendente dos casos acima (ticket cheio bloqueado), para o
  // "sim" não cair num pedido real. "sim" sem nada pendente: se PASSOU da porta
  // de admin, responde "nada aguardando"; se fosse barrado, viria "ignorado".
  fs.writeFileSync(path.join(RAIZ, 'data', 'tickets-bloqueados.json'), '{}');
  fs.writeFileSync(path.join(RAIZ, 'data', 'validacoes-pendentes.json'), '{}');
  const extraFin = await processar(textoPrivado(AUTORIZADO, 'sim'), {});
  conferir('alcança o financeiro', extraFin.status === 'autorizacao_sem_alvo', `veio "${extraFin.status}"`);

  console.log('\nGrupo de administração: comanda pela conversa do grupo');
  resetCont();
  await processar(textoGrupo(ADMGRUPO, 'ligar contingência'), {});
  const grpLiga = await processar(textoGrupo(ADMGRUPO, 'sim'), {});
  conferir('grupo admin liga (após confirmar)', grpLiga.status === 'contingencia_ligada', `veio "${grpLiga.status}"`);
  conferir('config ligada', ativoAgora() === true);
  const grpDesliga = await processar(textoGrupo(ADMGRUPO, 'desligar contingência'), {});
  conferir('grupo admin desliga', grpDesliga.status === 'contingencia_desligada', `veio "${grpDesliga.status}"`);
  fs.writeFileSync(path.join(RAIZ, 'data', 'tickets-bloqueados.json'), '{}');
  fs.writeFileSync(path.join(RAIZ, 'data', 'validacoes-pendentes.json'), '{}');
  const grpFin = await processar(textoGrupo(ADMGRUPO, 'sim'), {});
  conferir('grupo admin alcança o financeiro', grpFin.status === 'autorizacao_sem_alvo', `veio "${grpFin.status}"`);
  const grpOutro = await processar(textoGrupo(GRUPO, 'ligar contingência'), {});
  conferir('grupo de hangar comum NÃO comanda', grpOutro.status !== 'contingencia_ligada' && grpOutro.status !== 'contingencia_confirmar', `veio "${grpOutro.status}"`);

  console.log('\nConsulta de pátio pelo grupo admin (nomeando o hangar)');
  ultimaConsulta = null;
  const cons1 = await processar(textoGrupo(ADMGRUPO, 'como está o pátio do solojet'), {});
  conferir('consulta o hangar citado', ultimaConsulta && ultimaConsulta.id === 'solojet', JSON.stringify(ultimaConsulta));
  conferir('genérico traz tudo (ambos)', ultimaConsulta && ultimaConsulta.formato === 'ambos', ultimaConsulta && ultimaConsulta.formato);
  conferir('responde com o pátio', /Vagas:/.test(cons1.mensagemWhatsapp || ''));

  ultimaConsulta = null;
  await processar(textoGrupo(ADMGRUPO, 'credenciados do alljet'), {}); // sem verbo: vale no hub
  conferir('credenciados vai no formato certo', ultimaConsulta && ultimaConsulta.id === 'alljet' && ultimaConsulta.formato === 'credenciados', JSON.stringify(ultimaConsulta));

  ultimaConsulta = null;
  await processar(textoGrupo(ADMGRUPO, 'tickets validados do aibm 2'), {});
  conferir('tickets do aibm 2 no formato certo', ultimaConsulta && ultimaConsulta.id === 'aibm-2' && ultimaConsulta.formato === 'tickets', JSON.stringify(ultimaConsulta));

  ultimaConsulta = null;
  const consSem = await processar(textoGrupo(ADMGRUPO, 'como está o pátio?'), {});
  conferir('sem nome, pergunta qual pátio', consSem.status === 'admin_patio_sem_hangar' && ultimaConsulta === null, `veio "${consSem.status}"`);

  console.log('\nDisparo de mensagem para grupos (pelo grupo admin)');
  // Começa.
  const bc1 = await processar(textoGrupo(ADMGRUPO, 'mandar mensagem para grupos'), {});
  conferir('abre o disparo com a lista', bc1.status === 'broadcast_escolher_alvos' && /TODOS/i.test(bc1.mensagemWhatsapp), `veio "${bc1.status}"`);
  conferir('lista é numerada', /\*1\*/.test(bc1.mensagemWhatsapp || ''));
  // Escolhe TODOS.
  const bc2 = await processar(textoGrupo(ADMGRUPO, 'todos'), {});
  conferir('pede o texto', bc2.status === 'broadcast_pedir_texto', `veio "${bc2.status}"`);
  // Manda o texto.
  const MENSAGEM = 'Pátio fecha hoje às 22h para manutenção.';
  const bc3 = await processar(textoGrupo(ADMGRUPO, MENSAGEM), {});
  conferir('pede confirmação', bc3.status === 'broadcast_confirmar' && bc3.mensagemWhatsapp.includes(MENSAGEM), `veio "${bc3.status}"`);
  conferir('nada enviado antes do SIM', enviados.length === 0);
  // Confirma.
  enviados = [];
  const bc4 = await processar(textoGrupo(ADMGRUPO, 'sim'), {});
  conferir('envia ao confirmar', bc4.status === 'broadcast_enviado' && bc4.broadcastEnviados > 0, `veio "${bc4.status}"`);
  conferir('enviou a todos os grupos', enviados.length === bc4.broadcastEnviados && enviados.length > 1, `${enviados.length} envios`);
  conferir('o grupo do Solojet recebeu o texto', enviados.some((e) => e.grupo === GRUPO && e.texto === MENSAGEM));
  conferir('não vazou para o próprio grupo admin', enviados.every((e) => e.grupo !== ADMGRUPO));

  console.log('\nDisparo: NÃO cancela, e dá para escolher por número');
  enviados = [];
  await processar(textoGrupo(ADMGRUPO, 'mandar mensagem para grupos'), {});
  const sel = await processar(textoGrupo(ADMGRUPO, '1'), {});
  conferir('seleção por número só um grupo', sel.status === 'broadcast_pedir_texto', `veio "${sel.status}"`);
  await processar(textoGrupo(ADMGRUPO, 'teste'), {});
  const nao = await processar(textoGrupo(ADMGRUPO, 'não'), {});
  conferir('NÃO cancela sem enviar', nao.status === 'broadcast_cancelado' && enviados.length === 0, `veio "${nao.status}"`);

  console.log('\nDisparo de ARTE (imagem) em massa');
  enviados = []; imagensEnviadas = [];
  await processar(textoGrupo(ADMGRUPO, 'mandar mensagem para grupos'), {});
  await processar(textoGrupo(ADMGRUPO, 'todos'), {});
  const artePrev = await processar(fotoGrupoAdmin('Promoção de outubro!'), {});
  conferir('reconhece a arte e pede confirmação', artePrev.status === 'broadcast_confirmar' && /imagem/i.test(artePrev.mensagemWhatsapp), `veio "${artePrev.status}"`);
  conferir('mostra a legenda na prévia', /Promoção de outubro/.test(artePrev.mensagemWhatsapp || ''));
  conferir('nada enviado antes do SIM', imagensEnviadas.length === 0);
  const arteEnv = await processar(textoGrupo(ADMGRUPO, 'sim'), {});
  conferir('envia a arte ao confirmar', arteEnv.status === 'broadcast_enviado' && arteEnv.broadcastEnviados > 0, `veio "${arteEnv.status}"`);
  conferir('enviou IMAGEM (não texto) a todos', imagensEnviadas.length === arteEnv.broadcastEnviados && imagensEnviadas.length > 1, `${imagensEnviadas.length} imagens`);
  conferir('a legenda foi junto', imagensEnviadas.every((i) => i.legenda === 'Promoção de outubro!'));
  conferir('a arte não vazou para o próprio grupo admin', imagensEnviadas.every((i) => i.grupo !== ADMGRUPO));

  console.log('\nDisparo: CANCELAR a qualquer momento');
  await processar(textoGrupo(ADMGRUPO, 'mandar mensagem para grupos'), {});
  const canc = await processar(textoGrupo(ADMGRUPO, 'cancelar'), {});
  conferir('cancela no meio', canc.status === 'broadcast_cancelado', `veio "${canc.status}"`);

  console.log('\nNúmero só em autorizados: contingência SIM, financeiro NÃO');
  const SO_CONT = '5511940000000@s.whatsapp.net';
  resetCont([SO_CONT]);
  await processar(textoPrivado(SO_CONT, 'ligar contingência'), {});
  const soLiga = await processar(textoPrivado(SO_CONT, 'sim'), {});
  conferir('liga a contingência (após confirmar)', soLiga.status === 'contingencia_ligada', `veio "${soLiga.status}"`);
  const soFin = await processar(textoPrivado(SO_CONT, 'sim'), {});
  conferir('não alcança o financeiro', soFin.status === 'ignorado', `veio "${soFin.status}"`);

  console.log('\nDesligada: volta a usar o ValidPark');
  const c = JSON.parse(fs.readFileSync(CONFIG, 'utf-8')); c.contingenciaValidPark.ativo = false; fs.writeFileSync(CONFIG, `${JSON.stringify(c, null, 2)}\n`);
  escreverSnapshot({ vagas: 90, ocupadas: 0 });
  ticketAtual = 'C00000000004';
  chamouScript = false;
  await processar(foto(GRUPO), {}).catch(() => {});
  conferir('tentou abrir o ValidPark de novo', chamouScript === true);

  console.log('\nReivindicação do aviso: só um (bot OU servidor) avisa o grupo');
  fs.writeFileSync(path.join(RAIZ, 'data', 'validacoes-pendentes.json'), '{}');
  const it = fila.enfileirar({ ticket: 'R1', grupoId: GRUPO, hangarId: 'solojet', motivo: 'contingencia' });
  conferir('sem resultado, ninguém reivindica', fila.reivindicarAviso(it.id).pronto === false);
  fila.registrarResultado(it.id, { ok: true, codigo: 200, resposta: 'ok' });
  const primeiro = fila.reivindicarAviso(it.id);
  const segundo = fila.reivindicarAviso(it.id);
  conferir('o primeiro reivindica', primeiro.pronto && primeiro.reivindicado === true);
  conferir('o segundo vê que já foi avisado', segundo.pronto && segundo.reivindicado === false && segundo.jaAvisado === true);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main().catch((e) => { console.error('teste quebrou:', e); falhas += 1; }).finally(() => process.exit(falhas ? 1 : 0));
