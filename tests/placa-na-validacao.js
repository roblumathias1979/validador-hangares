#!/usr/bin/env node
/**
 * A placa NUNCA chega vazia ao ValidPark.
 *
 * No primeiro teste real do VOASP (17/09/2026) o cliente respondeu SIM e
 * recebeu "OPS: Digite a placa do veiculo corretamente". A pendência da cota
 * mensal guardava `placa: null` e o SIM validava com esse null — o caminho sem
 * cota sempre aplicou `legenda -> placa padrão do hangar -> AAA0000`, e foi a
 * pergunta da cota que passou por fora dessa cadeia.
 *
 * Informar a placa NÃO é obrigatório: sem ela vale a genérica, como nos demais
 * pátios. O que este teste vigia é o argumento que chega ao validador do site,
 * não a mensagem ao cliente — é ali que o erro aparecia.
 *
 * Config e estado são reais: o teste guarda e devolve.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const GRUPO_VOASP = '120363413246656441@g.us';
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

// Garante o cenário: VOASP com grupo e cota de 20.
{
  const cfg = JSON.parse(guardado['config/hangares.json']);
  const v = cfg.hangares.find((h) => h.id === 'voasp');
  v.grupoWhatsappId = GRUPO_VOASP;
  v.cotaMensalValidacoes = 20;
  v.perguntarIdentificacao = false;
  fs.writeFileSync(path.join(RAIZ, 'config/hangares.json'), JSON.stringify(cfg, null, 2) + '\n');
}

// O que foi passado ao validador do site — é isso que o teste vigia.
let placaEnviadaAoSite = '(não chamado)';

const child = require('child_process');
child.execFileSync = (_cmd, args) => {
  const arquivo = path.basename(args[0]);
  if (arquivo === 'validate-ticket.js') {
    placaEnviadaAoSite = args[3];
    return JSON.stringify({ status: 'validado', ticket: args[2], placa: args[3], mensagemWhatsapp: `✅ Ticket ${args[2]} validado.`, vagasDisponiveis: 15, totalVagas: 20 });
  }
  if (arquivo === 'consultar-ticket.js') return JSON.stringify({ status: 'consulta_ok', jaValidado: false });
  throw new Error(`script inesperado: ${arquivo}`);
};

const ocr = require(path.join(RAIZ, 'scripts', 'ocr-ticket.js'));
let ticketAtual = '011709101527';
ocr.lerTicket = async () => ({ status: 'ocr_ok', ticket: ticketAtual, dataEmissaoIso: new Date().toISOString() });

const http = require('http');
http.request = (_o, cb) => {
  const r = new (require('stream').PassThrough)();
  r.statusCode = 200;
  process.nextTick(() => { cb(r); r.end(JSON.stringify({ base64: Buffer.from(`f${Math.random()}`).toString('base64'), mimetype: 'image/jpeg' })); });
  return { on() { return this; }, write() {}, end() {}, setTimeout() {}, destroy() {} };
};

const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));

const foto = (legenda = '') => ({ data: {
  key: { remoteJid: GRUPO_VOASP, fromMe: false, id: `T${Math.random()}`, participant: PESSOA },
  pushName: 'Teste', message: { imageMessage: { caption: legenda, mimetype: 'image/jpeg' } },
} });
const texto = (t) => ({ data: {
  key: { remoteJid: GRUPO_VOASP, fromMe: false, id: `T${Math.random()}`, participant: PESSOA },
  pushName: 'Teste', message: { conversation: t },
} });

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  if (ok) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

async function main() {
  for (const a of ARQUIVOS.slice(1)) fs.writeFileSync(path.join(RAIZ, a), a.endsWith('.jsonl') ? '' : '{}');

  console.log('Ticket SEM placa: segue e valida com a genérica');
  const sem = await processar(foto(), {});
  conferir('pergunta da cota', sem.status === 'requer_decisao_cota_mensal', `veio "${sem.status}"`);
  conferir('não pede placa ao cliente', !/placa.*obrigat/i.test(sem.mensagemWhatsapp || ''));
  const semSim = await processar(texto('sim'), {});
  conferir('valida', semSim.status === 'validado', `veio "${semSim.status}"`);
  conferir('a placa genérica chegou ao site', placaEnviadaAoSite === 'AAA0000', `foi "${placaEnviadaAoSite}"`);
  conferir('avisa que usou a placa padrão', /placa padr[ãa]o/i.test(semSim.mensagemWhatsapp || ''));

  console.log('\nPlaca já na legenda da foto: não pede de novo');
  ticketAtual = '011709101528';
  placaEnviadaAoSite = '(não chamado)';
  const direto = await processar(foto('ETZ4780'), {});
  conferir('vai direto para a cota', direto.status === 'requer_decisao_cota_mensal', `veio "${direto.status}"`);
  await processar(texto('sim'), {});
  conferir('valida com a placa da legenda', placaEnviadaAoSite === 'ETZ4780', `foi "${placaEnviadaAoSite}"`);

  console.log('\nPlaca mandada fora de hora vira a placa do pedido');
  ticketAtual = '011709101529';
  placaEnviadaAoSite = '(não chamado)';
  await processar(foto('ABC1234'), {});          // abre a pergunta da cota
  const corrigida = await processar(texto('XYZ9876'), {});  // manda outra placa
  conferir('anota a nova placa', corrigida.status === 'placa_anotada', `veio "${corrigida.status}"`);
  await processar(texto('sim'), {});
  conferir('valida com a placa corrigida', placaEnviadaAoSite === 'XYZ9876', `foi "${placaEnviadaAoSite}"`);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main()
  .catch((e) => { console.error('teste quebrou:', e); falhas += 1; })
  .finally(() => { restaurar(); process.exit(falhas ? 1 : 0); });
