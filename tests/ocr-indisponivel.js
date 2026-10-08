#!/usr/bin/env node
/**
 * Regressão de 08/10/2026 — os créditos da Anthropic acabaram e o bot FICOU MUDO.
 *
 * O cliente mandava a foto do ticket, recebia "Recebi seu ticket, já estou
 * verificando..." e nunca mais ouvia nada. A API recusava a chamada do OCR
 * ("credit balance is too low"), a exceção subia sem tratamento, e nem o
 * cliente nem a administração eram avisados. O monitor de saúde também não
 * olhava a API, então estava tudo verde. Quem descobriu foi um cliente.
 *
 * Cobre:
 *  1. a classificação do erro da API (o que é problema do serviço, e o que não é);
 *  2. o OCR devolvendo `ocr_indisponivel` em vez de lançar exceção;
 *  3. o fluxo completo: cliente avisado, administração acionada, causa visível;
 *  4. o monitor de saúde enxergando crédito esgotado e chave recusada, sem
 *     alarmar por instabilidade passageira.
 *
 * Roda sem rede: a Evolution e a Anthropic são substituídas.
 */

const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const GRUPO_SOLOJET = '120363431859218622@g.us';

const { montar } = require('./cenario');
montar({ hangares: { solojet: { grupoWhatsappId: GRUPO_SOLOJET } } });

// Histórico, pendências e mensagens vistas são de PRODUÇÃO (ver erro-nao-fica-mudo.js).
const registro = require(path.join(RAIZ, 'scripts', 'lib', 'registro.js'));
registro.registrar = () => null;
const pendencias = require(path.join(RAIZ, 'scripts', 'lib', 'pendencias.js'));
pendencias.registrar = () => null;
pendencias.consumir = () => null;
pendencias.buscar = () => null;

// --- A Evolution devolve uma imagem de mentira; a Anthropic recusa por crédito ---

const { PassThrough } = require('stream');

function respostaFalsa(status, corpo) {
  return (_opcoes, cb) => {
    const resposta = new PassThrough();
    resposta.statusCode = status;
    process.nextTick(() => { cb(resposta); resposta.end(corpo); });
    return { on() { return this; }, write() {}, end() {}, setTimeout() {}, destroy() {} };
  };
}

const http = require('http');
http.request = respostaFalsa(200, JSON.stringify({ base64: 'ZmFsc28=', mimetype: 'image/jpeg' }));

const https = require('https');
const CREDITO = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.' } });
function anthropicResponde(status, corpo) { https.request = respostaFalsa(status, corpo); }

const ocr = require(path.join(RAIZ, 'scripts', 'ocr-ticket.js'));
const { processar, resultadoDeErro } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));
const monitor = require(path.join(RAIZ, 'scripts', 'monitor-saude.js'));

// Definida DEPOIS de carregar os scripts: eles chamam dotenv com `override`, que
// trocaria a chave de teste pela do .env (vazia no computador de desenvolvimento).
// A chave é lida a cada chamada, então basta existir quando o teste rodar.
process.env.ANTHROPIC_API_KEY = 'chave-de-teste';

let falhas = 0;
function conferir(nome, condicao, detalhe) {
  if (condicao) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
}

function payloadFoto() {
  return {
    data: {
      key: { remoteJid: GRUPO_SOLOJET, fromMe: false, id: `TESTE-${Date.now()}`, participant: '5511999999999@s.whatsapp.net' },
      pushName: 'Teste',
      message: { imageMessage: { caption: '', mimetype: 'image/jpeg' } },
    },
  };
}

async function main() {
  console.log('Classificação do erro da API:');
  const c = ocr.classificarErroApi;
  const comStatus = (msg, statusHttp, extra = {}) => Object.assign(new Error(msg), { statusHttp }, extra);
  conferir('crédito esgotado', (c(comStatus('Anthropic retornou erro (status 400): Your credit balance is too low', 400)) || {}).causa === 'sem_credito');
  conferir('chave recusada (401)', (c(comStatus('invalid x-api-key', 401)) || {}).causa === 'chave_recusada');
  conferir('chave ausente', (c(new Error('ANTHROPIC_API_KEY não configurada em .env')) || {}).causa === 'chave_recusada');
  conferir('sobrecarga (529)', (c(comStatus('overloaded', 529)) || {}).causa === 'instabilidade');
  conferir('queda de rede', (c(Object.assign(new Error('ECONNRESET'), { rede: true })) || {}).causa === 'instabilidade');
  conferir('erro desconhecido NÃO é mascarado', c(comStatus('invalid_request_error: max_tokens', 400)) === null);

  console.log('\nO OCR não lança exceção quando a API recusa:');
  anthropicResponde(400, CREDITO);
  let r;
  try { r = await ocr.lerTicket({ base64: 'ZmFsc28=', mediaType: 'image/jpeg', hangar: null }); } catch (e) { r = { status: `EXCECAO: ${e.message}` }; }
  conferir('devolve ocr_indisponivel', r.status === 'ocr_indisponivel', `veio "${r.status}"`);
  conferir('diz a causa', r.causa === 'sem_credito');
  conferir('aciona a administração', r.notificarAdmin === true);
  conferir('não culpa a foto do cliente', /não é a sua foto/.test(r.mensagemWhatsapp || ''));
  conferir('não manda reenviar', !/reenvi/i.test(r.mensagemWhatsapp || ''));

  console.log('\nFluxo completo — a foto chega, a API recusa:');
  const fluxo = await processar(payloadFoto(), {});
  conferir('não estoura com erro interno', fluxo.status !== 'erro', fluxo.mensagem);
  conferir('status ocr_indisponivel', fluxo.status === 'ocr_indisponivel', `veio "${fluxo.status}"`);
  conferir('responde ao cliente, no grupo certo', fluxo.responder === true && fluxo.grupoId === GRUPO_SOLOJET);
  conferir('avisa que a administração foi acionada', /encaminhando para o administrador/.test(fluxo.mensagemWhatsapp || ''));
  conferir('administração acionada', fluxo.notificarAdmin === true && fluxo.escalado === true);
  conferir('a administração vê a causa real', /créditos da API da Anthropic acabaram/.test(fluxo.mensagem || ''), fluxo.mensagem);

  console.log('\nAviso à administração leva a causa:');
  const enviados = [];
  const hangar = { id: 'solojet', hangar: 'Solojet', grupoAdministracao: '120363000000000001@g.us' };
  const { avisarAdmin } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));
  await avisarAdmin(hangar, { ...fluxo }, async (destino, texto) => { enviados.push({ destino, texto }); });
  conferir('enviou ao grupo de administração', enviados.length === 1 && enviados[0].destino === hangar.grupoAdministracao);
  conferir('o texto cita créditos e a situação', /créditos da API da Anthropic acabaram/.test((enviados[0] || {}).texto || '') && /ocr_indisponivel/.test((enviados[0] || {}).texto || ''));

  console.log('\nInstabilidade passageira não vira "recarregue o crédito":');
  anthropicResponde(529, JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }));
  const passageira = await processar(payloadFoto(), {});
  conferir('é ocr_indisponivel, mas por instabilidade', passageira.status === 'ocr_indisponivel');
  conferir('pede para tentar de novo depois', /tente reenviar em alguns minutos/i.test(passageira.mensagemWhatsapp || ''));
  conferir('não manda recarregar crédito', !/cr[eé]dito/i.test(passageira.mensagem || ''));

  console.log('\nExceção realmente inesperada continua com grupo identificado e hangar:');
  const erro = resultadoDeErro(new Error('bug qualquer'), Buffer.from(JSON.stringify(payloadFoto())).toString('base64'));
  conferir('responde no grupo certo', erro.responder === true && erro.grupoId === GRUPO_SOLOJET);
  conferir('traz o hangar (para o histórico do painel)', erro.hangarId === 'solojet', `veio "${erro.hangarId}"`);

  console.log('\nMonitor de saúde:');
  const k = monitor.classificarAnthropic;
  conferir('200 = saudável', k({ status: 200, texto: '{}' }).ok === true);
  const sem = k({ status: 400, texto: CREDITO });
  conferir('crédito esgotado = problema', sem.ok === false);
  conferir('a mensagem diz onde recarregar', /console\.anthropic\.com/.test(sem.detalhe));
  conferir('chave recusada = problema', k({ status: 401, texto: '' }).ok === false);
  conferir('529 NÃO alarma', k({ status: 529, texto: 'Overloaded' }).ok === true);
  conferir('queda de rede NÃO alarma', k({ erro: 'ECONNRESET' }).ok === true);
  conferir('timeout NÃO alarma', k({ erro: 'timeout' }).ok === true);

  const semChave = process.env.ANTHROPIC_API_KEY; delete process.env.ANTHROPIC_API_KEY;
  conferir('sem chave configurada = problema', (await monitor.checarAnthropic(async () => { throw new Error('não deveria chamar'); })).ok === false);
  process.env.ANTHROPIC_API_KEY = semChave;
  conferir('checarAnthropic usa a chave e classifica', (await monitor.checarAnthropic(async (chave) => (chave === 'chave-de-teste' ? { status: 400, texto: CREDITO } : { status: 200, texto: '{}' }))).ok === false);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
  process.exit(falhas ? 1 : 0);
}

main().catch((e) => { console.error('teste quebrou:', e); process.exit(1); });
