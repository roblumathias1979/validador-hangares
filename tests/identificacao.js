#!/usr/bin/env node
/**
 * "Você quer identificar esse ticket com nome de cliente, carro ou placa?"
 *
 * SIM leva ao texto livre; NÃO segue direto com a placa genérica. A
 * identificação é do HANGAR, não do ValidPark — o site só aceita placa no
 * formato dele, então nome e modelo de carro não teriam onde caber lá. Ela vive
 * no nosso histórico, que é onde alguém procura depois.
 *
 * O ponto que merece vigilância: o NÃO tem que validar com a placa genérica, e
 * não com placa vazia. Foi exatamente esse o erro do VOASP hoje, num caminho
 * de pergunta que eu mesmo acrescentei.
 *
 * Config e estado são reais: o teste guarda e devolve.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const GRUPO = '120363431859218622@g.us'; // Solojet
const PESSOA = '5511999999999@s.whatsapp.net';

const ARQUIVOS = ['config/hangares.json', 'data/validacoes.jsonl', 'data/pendencias.json', 'data/fotos-usadas.json'];
const guardado = {};
for (const a of ARQUIVOS) {
  const p = path.join(RAIZ, a);
  guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
}
let restaurado = false;
const restaurar = () => {
  if (restaurado) return;
  restaurado = true;
  for (const a of ARQUIVOS) {
    const p = path.join(RAIZ, a);
    if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) { /* já não existe */ } }
    else fs.writeFileSync(p, guardado[a]);
  }
};
process.on('exit', restaurar);
process.on('uncaughtException', (e) => { restaurar(); console.error(e); process.exit(1); });

// Cenário: Solojet perguntando identificação, sem cota e sem foto.
{
  const cfg = JSON.parse(guardado['config/hangares.json']);
  const h = cfg.hangares.find((x) => x.id === 'solojet');
  h.perguntarIdentificacao = true;
  h.exigeFotoVeiculoNoLocal = false;
  delete h.cotaMensalValidacoes;
  fs.writeFileSync(path.join(RAIZ, 'config/hangares.json'), JSON.stringify(cfg, null, 2) + '\n');
}

let placaEnviadaAoSite = '(não chamado)';
const child = require('child_process');
child.execFileSync = (_cmd, args) => {
  const arquivo = path.basename(args[0]);
  if (arquivo === 'validate-ticket.js') {
    placaEnviadaAoSite = args[3];
    return JSON.stringify({ status: 'validado', ticket: args[2], placa: args[3], mensagemWhatsapp: `✅ Ticket ${args[2]} validado.`, vagasDisponiveis: 30, totalVagas: 90 });
  }
  if (arquivo === 'consultar-ticket.js') return JSON.stringify({ status: 'consulta_ok', jaValidado: false });
  throw new Error(`script inesperado: ${arquivo}`);
};

const ocr = require(path.join(RAIZ, 'scripts', 'ocr-ticket.js'));
let ticketAtual = '011709300001';
ocr.lerTicket = async () => ({ status: 'ocr_ok', ticket: ticketAtual, dataEmissaoIso: new Date().toISOString() });

const http = require('http');
http.request = (_o, cb) => {
  const r = new (require('stream').PassThrough)();
  r.statusCode = 200;
  process.nextTick(() => { cb(r); r.end(JSON.stringify({ base64: Buffer.from(`f${Math.random()}`).toString('base64'), mimetype: 'image/jpeg' })); });
  return { on() { return this; }, write() {}, end() {}, setTimeout() {}, destroy() {} };
};

const registro = require(path.join(RAIZ, 'scripts', 'lib', 'registro.js'));
const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));

const foto = (legenda = '') => ({ data: {
  key: { remoteJid: GRUPO, fromMe: false, id: `T${Math.random()}`, participant: PESSOA },
  pushName: 'Teste', message: { imageMessage: { caption: legenda, mimetype: 'image/jpeg' } },
} });
const texto = (t) => ({ data: {
  key: { remoteJid: GRUPO, fromMe: false, id: `T${Math.random()}`, participant: PESSOA },
  pushName: 'Teste', message: { conversation: t },
} });

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  if (ok) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};
const ultimo = () => registro.ultimos(1)[0] || {};

async function main() {
  for (const a of ARQUIVOS.slice(1)) fs.writeFileSync(path.join(RAIZ, a), a.endsWith('.jsonl') ? '' : '{}');

  console.log('A pergunta aparece ao receber o ticket');
  const p = await processar(foto(), {});
  conferir('não valida ainda', p.status !== 'validado', `veio "${p.status}"`);
  conferir('pergunta', p.status === 'requer_decisao_identificacao');
  conferir('oferece nome, carro ou placa', /nome de cliente, carro ou placa/i.test(p.mensagemWhatsapp || ''));

  console.log('\nNÃO: valida com a placa genérica (não vazia)');
  const nao = await processar(texto('não'), {});
  conferir('valida', nao.status === 'validado', `veio "${nao.status}"`);
  conferir('a placa genérica chegou ao site', placaEnviadaAoSite === 'AAA0000', `foi "${placaEnviadaAoSite}"`);
  conferir('histórico sem identificação', ultimo().identificacao === null);

  console.log('\nSIM: pede o texto e guarda o que veio');
  ticketAtual = '011709300002'; placaEnviadaAoSite = '(não chamado)';
  await processar(foto(), {});
  const sim = await processar(texto('sim'), {});
  conferir('pede nome, carro ou placa', sim.status === 'aguardando_identificacao', `veio "${sim.status}"`);
  const comNome = await processar(texto('João da Silva — Corolla prata'), {});
  conferir('valida', comNome.status === 'validado', `veio "${comNome.status}"`);
  conferir('guarda a identificação', ultimo().identificacao === 'João da Silva — Corolla prata', JSON.stringify(ultimo().identificacao));
  conferir('mostra no recibo ao cliente', /Identificado como/.test(comNome.mensagemWhatsapp || ''));
  conferir('sem placa informada, usa a genérica', placaEnviadaAoSite === 'AAA0000', `foi "${placaEnviadaAoSite}"`);

  console.log('\nSe a identificação FOR uma placa, ela vira a placa da validação');
  ticketAtual = '011709300003'; placaEnviadaAoSite = '(não chamado)';
  await processar(foto(), {});
  await processar(texto('sim'), {});
  await processar(texto('ABC1D23'), {});
  conferir('a placa chegou ao site', placaEnviadaAoSite === 'ABC1D23', `foi "${placaEnviadaAoSite}"`);
  conferir('e continua registrada como identificação', ultimo().identificacao === 'ABC1D23');

  console.log('\nQuem já sabe o fluxo responde direto, sem dizer SIM antes');
  ticketAtual = '011709300004'; placaEnviadaAoSite = '(não chamado)';
  await processar(foto(), {});
  const direto = await processar(texto('Maria — Fiat Argo'), {});
  conferir('aceita como identificação', direto.status === 'validado', `veio "${direto.status}"`);
  conferir('guardou', ultimo().identificacao === 'Maria — Fiat Argo', JSON.stringify(ultimo().identificacao));

  console.log('\nPlaca na LEGENDA da foto: não pergunta, e ela vira a identificação');
  ticketAtual = '011709300006'; placaEnviadaAoSite = '(não chamado)';
  const comLegenda = await processar(foto('FLI8888'), {});
  conferir('valida direto, sem perguntar', comLegenda.status === 'validado', `veio "${comLegenda.status}"`);
  conferir('a placa chegou ao site', placaEnviadaAoSite === 'FLI8888', `foi "${placaEnviadaAoSite}"`);
  conferir('ficou identificado pela placa', ultimo().identificacao === 'FLI8888', JSON.stringify(ultimo().identificacao));
  conferir('mostra no recibo', /Identificado como/.test(comLegenda.mensagemWhatsapp || ''));

  console.log('\nPátio sem a pergunta ligada valida direto');
  const cfg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'config/hangares.json'), 'utf-8'));
  cfg.hangares.find((x) => x.id === 'solojet').perguntarIdentificacao = false;
  fs.writeFileSync(path.join(RAIZ, 'config/hangares.json'), JSON.stringify(cfg, null, 2) + '\n');
  ticketAtual = '011709300005';
  const semPergunta = await processar(foto('XYZ1234'), {});
  conferir('valida sem perguntar', semPergunta.status === 'validado', `veio "${semPergunta.status}"`);
  conferir('e não inventa identificação', ultimo().identificacao === null, JSON.stringify(ultimo().identificacao));

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main()
  .catch((e) => { console.error('teste quebrou:', e); falhas += 1; })
  .finally(() => { restaurar(); process.exit(falhas ? 1 : 0); });
