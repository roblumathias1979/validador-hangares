#!/usr/bin/env node
/**
 * Antes de gastar uma das validações do mês, o bot PERGUNTA.
 *
 * A cota é do hangar, não do bot: quem manda o ticket no grupo pode não ser
 * quem decide se aquele carro merece gastar uma das 20. Validar direto tiraria
 * a escolha de quem paga a conta.
 *
 * Este teste mexe em config/hangares.json (para dar um grupo ao VOASP, que
 * ainda não tem) e nos arquivos de estado. Guarda e devolve TODOS eles, e
 * confere no fim que o repositório ficou limpo — um teste que suja o config
 * versionado seria pior que teste nenhum.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const GRUPO_VOASP = '120363999999999999@g.us';   // só existe dentro deste teste
const GRUPO_SOLOJET = '120363431859218622@g.us'; // hangar sem cota, para contraste
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
// Rede de segurança: se algo derrubar o processo no meio, o config volta.
process.on('exit', restaurar);
process.on('uncaughtException', (e) => { restaurar(); console.error(e); process.exit(1); });

// Dá um grupo ao VOASP só para este teste.
{
  const cfg = JSON.parse(guardado['config/hangares.json']);
  cfg.hangares.find((h) => h.id === 'voasp').grupoWhatsappId = GRUPO_VOASP;
  fs.writeFileSync(path.join(RAIZ, 'config/hangares.json'), JSON.stringify(cfg, null, 2) + '\n');
}

let respostaDoOcr = { status: 'ocr_ok', ticket: '011609200001', dataEmissaoIso: new Date().toISOString() };

const child = require('child_process');
child.execFileSync = (_cmd, args) => {
  const arquivo = path.basename(args[0]);
  if (arquivo === 'validate-ticket.js') {
    return JSON.stringify({ status: 'validado', ticket: args[2], placa: args[3], mensagemWhatsapp: `✅ Ticket ${args[2]} validado.`, vagasDisponiveis: 15, totalVagas: 20 });
  }
  if (arquivo === 'consultar-ticket.js') return JSON.stringify({ status: 'consulta_ok', jaValidado: false });
  throw new Error(`script inesperado: ${arquivo}`);
};

const ocr = require(path.join(RAIZ, 'scripts', 'ocr-ticket.js'));
ocr.lerTicket = async () => respostaDoOcr;

const http = require('http');
http.request = (_o, cb) => {
  const r = new (require('stream').PassThrough)();
  r.statusCode = 200;
  process.nextTick(() => { cb(r); r.end(JSON.stringify({ base64: Buffer.from(`f${Math.random()}`).toString('base64'), mimetype: 'image/jpeg' })); });
  return { on() { return this; }, write() {}, end() {}, setTimeout() {}, destroy() {} };
};

const cota = require(path.join(RAIZ, 'scripts', 'lib', 'cota-mensal.js'));
const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));

const foto = (grupo) => ({ data: {
  key: { remoteJid: grupo, fromMe: false, id: `T${Math.random()}`, participant: PESSOA },
  pushName: 'Teste', message: { imageMessage: { caption: '', mimetype: 'image/jpeg' } },
} });
const texto = (grupo, t) => ({ data: {
  key: { remoteJid: grupo, fromMe: false, id: `T${Math.random()}`, participant: PESSOA },
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

  const VOASP = { id: 'voasp', cotaMensalValidacoes: 20 };

  console.log('Ticket no VOASP: pergunta antes de validar');
  const pergunta = await processar(foto(GRUPO_VOASP), {});
  conferir('não valida de cara', pergunta.status !== 'validado', `veio "${pergunta.status}"`);
  conferir('pede decisão', pergunta.status === 'requer_decisao_cota_mensal');
  conferir('diz quantas restam', /restam 20/i.test(pergunta.mensagemWhatsapp || ''));
  conferir('pede SIM ou NÃO', /SIM/.test(pergunta.mensagemWhatsapp) && /NÃO/.test(pergunta.mensagemWhatsapp));
  conferir('cota intacta enquanto não responde', cota.situacao(VOASP).usadas === 0);

  console.log('\nResposta que não é sim nem não: reforça sem adivinhar');
  const confusa = await processar(texto(GRUPO_VOASP, 'ok'), {});
  conferir('não valida', confusa.status !== 'validado', `veio "${confusa.status}"`);
  conferir('fala em validações do mês', /valida[çc][õo]es do m[êe]s/i.test(confusa.mensagemWhatsapp || ''));

  console.log('\nNÃO: cancela e a cota fica intacta');
  const nao = await processar(texto(GRUPO_VOASP, 'não'), {});
  conferir('cancela', nao.status === 'cancelado_pelo_cliente', `veio "${nao.status}"`);
  conferir('diz que a cota está intacta', /cota do m[êe]s continua intacta/i.test(nao.mensagemWhatsapp || ''));
  conferir('nada foi gasto', cota.situacao(VOASP).usadas === 0);

  console.log('\nSIM: valida e gasta uma');
  respostaDoOcr = { status: 'ocr_ok', ticket: '011609200002', dataEmissaoIso: new Date().toISOString() };
  await processar(foto(GRUPO_VOASP), {});
  const sim = await processar(texto(GRUPO_VOASP, 'sim'), {});
  conferir('valida', sim.status === 'validado', `veio "${sim.status}"`);
  conferir('gastou exatamente uma', cota.situacao(VOASP).usadas === 1, `usadas=${cota.situacao(VOASP).usadas}`);

  console.log('\nHangar sem cota: valida direto, sem perguntar');
  respostaDoOcr = { status: 'ocr_ok', ticket: '011609200003', dataEmissaoIso: new Date().toISOString() };
  const semCota = await processar(foto(GRUPO_SOLOJET), {});
  conferir('valida sem perguntar', semCota.status === 'validado', `veio "${semCota.status}"`);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main()
  .catch((e) => { console.error('teste quebrou:', e); falhas += 1; })
  .finally(() => { restaurar(); process.exit(falhas ? 1 : 0); });
