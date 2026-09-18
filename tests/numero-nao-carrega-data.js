#!/usr/bin/env node
/**
 * Ticket cujo número NÃO carrega a data dentro dele.
 *
 * A conferência local nasceu de 12 tickets que seguiam `01 | DDMM | HHMMSS`, e
 * bloqueava quando número e data impressa discordavam. Em 18/09/2026 apareceu
 * um que não segue o padrão — `011111000259`, impresso às 18/09/26 17:42:51,
 * bem legível na foto. O cliente foi recusado três vezes, e o ValidPark depois
 * confirmou que o número existia.
 *
 * Uma regra que não vale sempre não pode ser bloqueio. A divergência agora
 * paga uma consulta ao site, que é quem sabe a resposta:
 *
 *   site confirma a entrada  -> segue, o número só não carrega a data
 *   site não conhece o número -> aí sim é dígito trocado
 *
 * Config e estado são reais: o cenário guarda e devolve.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const GRUPO = '120363431499963963@g.us'; // AIBM 2
const PESSOA = '5511999999999@s.whatsapp.net';

// O caso real: número sequencial, data impressa de verdade.
const TICKET = '011111000259';
const IMPRESSO = '2026-09-18T17:42:51-03:00';

require('./cenario').montar({ hangares: { 'aibm-2': {} } });

let respostaDaConsulta = { status: 'consulta_ok', jaValidado: false, entrada: '18/09/2026 17:42:51' };
let chamouConsulta = 0;
let placaValidada = null;

const child = require('child_process');
child.execFileSync = (_cmd, args) => {
  const arquivo = path.basename(args[0]);
  if (arquivo === 'consultar-ticket.js') { chamouConsulta += 1; return JSON.stringify(respostaDaConsulta); }
  if (arquivo === 'validate-ticket.js') {
    placaValidada = args[3];
    return JSON.stringify({ status: 'validado', ticket: args[2], placa: args[3], mensagemWhatsapp: `✅ Ticket ${args[2]} validado.`, vagasDisponiveis: 30, totalVagas: 41 });
  }
  throw new Error(`script inesperado: ${arquivo}`);
};

// processar-mensagem.js captura `lerTicket` por desestruturação ao carregar, e
// trocar a função depois não teria efeito nenhum. O stub é instalado UMA vez e
// lê desta variável, que os casos ajustam.
let respostaDoOcr = {
  status: 'ocr_ok',
  ticket: TICKET,
  dataEmissaoIso: IMPRESSO,
  // Reproduz o que o modelo devolveu de verdade: leu número e data corretos,
  // mas eles não conferem entre si porque este número não carrega data.
  conferencia: { ok: false, doNumero: '11/11 00:02:59', doPapel: '18/09 17:42:51', motivo: 'número diz 11/11 00:02:59 e papel diz 18/09 17:42:51' },
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

const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));

const foto = () => ({ data: {
  key: { remoteJid: GRUPO, fromMe: false, id: `T${Math.random()}`, participant: PESSOA },
  pushName: 'estacionamento', message: { imageMessage: { caption: '', mimetype: 'image/jpeg' } },
} });

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  if (ok) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

// Este teste valida o MESMO ticket em vários casos, e a proteção contra ticket
// duplicado pegaria do segundo em diante, antes da conferência que se quer
// medir. Zerar o histórico entre os casos isola o assunto.
const zerarHistorico = () => fs.writeFileSync(path.join(RAIZ, 'data/validacoes.jsonl'), '');

async function main() {
  console.log('O CASO REAL: site confirma a entrada — valida');
  const bom = await processar(foto(), {});
  conferir('não recusa', bom.status !== 'ocr_numero_suspeito', `veio "${bom.status}"`);
  conferir('valida', bom.status === 'validado', `veio "${bom.status}"`);
  // Uma só: a conferência aproveita a consulta que o fluxo já fazia antes de
  // validar, em vez de abrir um segundo navegador.
  conferir('resolveu com a consulta que já existia', chamouConsulta === 1, `${chamouConsulta} consulta(s)`);
  conferir('validou com o número lido', bom.ticket === TICKET);

  console.log('\nSite não conhece o número — aí sim é dígito trocado');
  zerarHistorico();
  respostaDaConsulta = { status: 'ticket_nao_encontrado', mensagemWhatsapp: 'não achei' };
  const ruim = await processar(foto(), {});
  conferir('recusa', ruim.status === 'ocr_numero_suspeito', `veio "${ruim.status}"`);
  conferir('pede foto de novo', /reenviar a foto/i.test(ruim.mensagemWhatsapp || ''));
  conferir('aciona a administração', ruim.notificarAdmin === true);
  conferir('o detalhe explica as duas pontas',
    /não conferem entre si/.test(ruim.mensagem || '') && /não foi encontrado/.test(ruim.mensagem || ''),
    ruim.mensagem);

  console.log('\nSite conhece, mas com OUTRA entrada — número de outra pessoa');
  zerarHistorico();
  respostaDaConsulta = { status: 'consulta_ok', jaValidado: false, entrada: '15/09/2026 08:10:00' };
  const trocado = await processar(foto(), {});
  conferir('recusa', trocado.status === 'ocr_numero_suspeito', `veio "${trocado.status}"`);
  conferir('o detalhe mostra a entrada do site', /15\/09\/2026 08:10:00/.test(trocado.mensagem || ''), trocado.mensagem);

  console.log('\nDiferença de segundos não é divergência');
  zerarHistorico();
  respostaDaConsulta = { status: 'consulta_ok', jaValidado: false, entrada: '18/09/2026 17:43:40' };
  const perto = await processar(foto(), {});
  conferir('valida', perto.status === 'validado', `veio "${perto.status}"`);

  console.log('\nQuando número e data CONFEREM, não paga consulta extra');
  zerarHistorico();
  chamouConsulta = 0;
  respostaDoOcr = { status: 'ocr_ok', ticket: '011809174251', dataEmissaoIso: IMPRESSO, conferencia: { ok: true } };
  respostaDaConsulta = { status: 'consulta_ok', jaValidado: false, entrada: '18/09/2026 17:42:51' };
  const direto = await processar(foto(), {});
  conferir('valida', direto.status === 'validado', `veio "${direto.status}"`);
  conferir('mesma quantidade de consultas de sempre', chamouConsulta === 1, `${chamouConsulta} consulta(s)`);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main()
  .catch((e) => { console.error('teste quebrou:', e); falhas += 1; })
  .finally(() => process.exit(falhas ? 1 : 0));
