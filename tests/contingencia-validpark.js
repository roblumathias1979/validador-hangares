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

const fila = require(path.join(RAIZ, 'scripts', 'lib', 'validacoes-pendentes.js'));
const bloqueados = require(path.join(RAIZ, 'scripts', 'lib', 'tickets-bloqueados.js'));
const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));

const foto = (grupo) => ({ data: { key: { remoteJid: grupo, fromMe: false, id: `T${Math.random()}`, participant: PESSOA }, pushName: 'Cliente', message: { imageMessage: { caption: '', mimetype: 'image/jpeg' } } } });
const textoAdmin = (t) => ({ data: { key: { remoteJid: ADMIN, fromMe: false, id: `A${Math.random()}` }, pushName: 'Rodrigo', message: { conversation: t } } });
const textoPrivado = (de, t) => ({ data: { key: { remoteJid: de, fromMe: false, id: `P${Math.random()}` }, pushName: 'Estranho', message: { conversation: t } } });
const textoGrupo = (grupo, t) => ({ data: { key: { remoteJid: grupo, fromMe: false, id: `G${Math.random()}`, participant: PESSOA }, pushName: 'Alguém', message: { conversation: t } } });
const ativoAgora = () => (JSON.parse(fs.readFileSync(CONFIG, 'utf-8')).contingenciaValidPark || {}).ativo === true;

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

async function main() {
  console.log('Ligada, pátio com vaga: enfileira para o coletor, sem abrir o ValidPark');
  escreverSnapshot({ vagas: 90, ocupadas: 0 });
  ticketAtual = 'C00000000001';
  const r1 = await processar(foto(GRUPO), {});
  conferir('não chamou o ValidPark', chamouScript === false);
  conferir('status de contingência', r1.status === 'contingencia_enfileirada', `veio "${r1.status}"`);
  conferir('avisa que valida pelo aeroporto', /manuten|aeroporto/i.test(r1.mensagemWhatsapp || ''));
  const naFila = fila.retirarParaProcessar();
  conferir('enfileirou 1', naFila.length === 1 && naFila[0].ticket === ticketAtual, JSON.stringify(naFila.map((x) => x.ticket)));
  conferir('no pátio do hangar (30), não no #1PARK', naFila[0] && naFila[0].patioId === 30 && naFila[0].patioLabel === 'HANGAR SOLOJET', JSON.stringify(naFila[0]));
  conferir('motivo contingência e prazo do hangar', naFila[0] && naFila[0].motivo === 'contingencia' && naFila[0].dias === 20);

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

  const ligou = await processar(textoAdmin('ligar contingência'), {});
  conferir('admin liga', ligou.status === 'contingencia_ligada', `veio "${ligou.status}"`);
  conferir('config ligada', ativoAgora() === true);
  conferir('confirma e pede para desligar depois', /LIGADA/.test(ligou.mensagemWhatsapp) && /desligar/i.test(ligou.mensagemWhatsapp));

  const dnovo = await processar(textoAdmin('ligar contingencia'), {});
  conferir('ligar de novo avisa que já está', dnovo.status === 'contingencia_sem_mudanca', `veio "${dnovo.status}"`);

  const desligou = await processar(textoAdmin('desligar contingência'), {});
  conferir('admin desliga', desligou.status === 'contingencia_desligada', `veio "${desligou.status}"`);
  conferir('config desligada', ativoAgora() === false);

  const conversa = await processar(textoAdmin('o validpark caiu de novo, que saco'), {});
  conferir('frase solta não é comando', conversa.status !== 'contingencia_ligada' && ativoAgora() === false, `veio "${conversa.status}"`);

  console.log('\nNúmero em adminsWhatsapp: admin COMPLETO (contingência + financeiro)');
  resetCont();
  const extraLiga = await processar(textoPrivado(AUTORIZADO, 'ligar contingência'), {});
  conferir('liga a contingência', extraLiga.status === 'contingencia_ligada', `veio "${extraLiga.status}"`);
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
  const grpLiga = await processar(textoGrupo(ADMGRUPO, 'ligar contingência'), {});
  conferir('grupo admin liga', grpLiga.status === 'contingencia_ligada', `veio "${grpLiga.status}"`);
  conferir('config ligada', ativoAgora() === true);
  const grpDesliga = await processar(textoGrupo(ADMGRUPO, 'desligar contingência'), {});
  conferir('grupo admin desliga', grpDesliga.status === 'contingencia_desligada', `veio "${grpDesliga.status}"`);
  fs.writeFileSync(path.join(RAIZ, 'data', 'tickets-bloqueados.json'), '{}');
  fs.writeFileSync(path.join(RAIZ, 'data', 'validacoes-pendentes.json'), '{}');
  const grpFin = await processar(textoGrupo(ADMGRUPO, 'sim'), {});
  conferir('grupo admin alcança o financeiro', grpFin.status === 'autorizacao_sem_alvo', `veio "${grpFin.status}"`);
  const grpOutro = await processar(textoGrupo(GRUPO, 'ligar contingência'), {});
  conferir('grupo de hangar comum NÃO comanda', grpOutro.status !== 'contingencia_ligada', `veio "${grpOutro.status}"`);

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

  console.log('\nNúmero só em autorizados: contingência SIM, financeiro NÃO');
  const SO_CONT = '5511940000000@s.whatsapp.net';
  resetCont([SO_CONT]);
  const soLiga = await processar(textoPrivado(SO_CONT, 'ligar contingência'), {});
  conferir('liga a contingência', soLiga.status === 'contingencia_ligada', `veio "${soLiga.status}"`);
  const soFin = await processar(textoPrivado(SO_CONT, 'sim'), {});
  conferir('não alcança o financeiro', soFin.status === 'ignorado', `veio "${soFin.status}"`);

  console.log('\nDesligada: volta a usar o ValidPark');
  const c = JSON.parse(fs.readFileSync(CONFIG, 'utf-8')); c.contingenciaValidPark.ativo = false; fs.writeFileSync(CONFIG, `${JSON.stringify(c, null, 2)}\n`);
  escreverSnapshot({ vagas: 90, ocupadas: 0 });
  ticketAtual = 'C00000000004';
  chamouScript = false;
  await processar(foto(GRUPO), {}).catch(() => {});
  conferir('tentou abrir o ValidPark de novo', chamouScript === true);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main().catch((e) => { console.error('teste quebrou:', e); falhas += 1; }).finally(() => process.exit(falhas ? 1 : 0));
