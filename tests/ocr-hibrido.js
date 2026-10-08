#!/usr/bin/env node
/**
 * OCR do ticket em modo híbrido (08/10/2026): o Haiku 5.5 (barato) lê primeiro
 * e, quando NÃO lê com certeza, o lerTicket cai no Sonnet 5 (robusto). A/B com
 * 4 tickets reais mostrou o Haiku lendo igual nas fotos boas e falhando só na
 * de cabeça pra baixo — sempre do lado seguro (não leu, nunca leu errado).
 *
 * O que este teste protege:
 * 1. Haiku lê com certeza → uma chamada só (não gasta o Sonnet à toa).
 * 2. Haiku falha → cai no Sonnet e devolve a leitura dele.
 * 3. Hangar com conferência de local (antifraude AIBM) → vai DIRETO no Sonnet.
 * 4. Problema de serviço (sem crédito) → não insiste no outro modelo (mesma
 *    conta, mesma chave) e devolve ocr_indisponivel.
 *
 * Roda sem rede: https (Anthropic) é substituído e varia a resposta por modelo.
 */

const path = require('path');
const { PassThrough } = require('stream');

process.env.EVOLUTION_API_KEY = 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');

// Não depender de fotos de referência em disco para o caso do AIBM.
const referencias = require(path.join(RAIZ, 'scripts', 'lib', 'referencias.js'));
referencias.imagensParaConferencia = () => [];

const HAIKU = 'claude-haiku-5-5';
const SONNET = 'claude-sonnet-5';

function corpoBom(ticket, data) {
  return JSON.stringify({
    content: [{ type: 'text', text: JSON.stringify({ ticket, dataEmissaoDDMMAAHHMMSS: data, temTicket: true, confianca: 'alta', motivo: '' }) }],
    usage: { input_tokens: 100, output_tokens: 20 },
  });
}
const CORPO_RUIM = JSON.stringify({ content: [{ type: 'text', text: 'desculpe, não consegui ler' }], usage: { input_tokens: 100, output_tokens: 10 } });
const CORPO_CREDITO = JSON.stringify({ type: 'error', error: { type: 'invalid_request_error', message: 'Your credit balance is too low' } });

// https stub: captura o corpo da requisição, lê o `model` e deixa cada caso
// decidir o que responder por modelo. Também conta a ordem das chamadas.
let chamadas = [];
let responder = () => ({ status: 200, corpo: corpoBom('010610140815', '06/10/26 14:08:15') });
const https = require('https');
https.request = (_opcoes, cb) => {
  let body = '';
  return {
    on() { return this; },
    write(c) { body += c; },
    end() {
      let modelo = '?';
      try { modelo = JSON.parse(body).model; } catch (e) { /* ignora */ }
      chamadas.push(modelo);
      const { status, corpo } = responder(modelo);
      const resp = new PassThrough();
      resp.statusCode = status;
      process.nextTick(() => { cb(resp); resp.end(corpo); });
    },
    setTimeout() {}, destroy() {},
  };
};

const ocr = require(path.join(RAIZ, 'scripts', 'ocr-ticket.js'));
process.env.ANTHROPIC_API_KEY = 'chave-de-teste'; // depois do require (dotenv override)

const IMG = { base64: 'ZmFsc28=', mediaType: 'image/jpeg' };

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

async function main() {
  console.log('1) Haiku lê com certeza → uma chamada só');
  chamadas = [];
  responder = () => ({ status: 200, corpo: corpoBom('010610140815', '06/10/26 14:08:15') });
  let r = await ocr.lerTicket({ ...IMG, hangar: null });
  conferir('leu', r.status === 'ocr_ok', `veio "${r.status}"`);
  conferir('ticket certo', r.ticket === '010610140815');
  conferir('foi o Haiku', r.modelo === HAIKU, r.modelo);
  conferir('não chamou o Sonnet', chamadas.length === 1 && chamadas[0] === HAIKU, chamadas.join(','));

  console.log('\n2) Haiku falha → cai no Sonnet');
  chamadas = [];
  responder = (m) => (/haiku/.test(m) ? { status: 200, corpo: CORPO_RUIM } : { status: 200, corpo: corpoBom('010710065711', '07/10/26 06:57:11') });
  r = await ocr.lerTicket({ ...IMG, hangar: null });
  conferir('acabou lendo', r.status === 'ocr_ok', `veio "${r.status}"`);
  conferir('leitura é a do Sonnet', r.ticket === '010710065711' && r.modelo === SONNET, `${r.ticket}/${r.modelo}`);
  conferir('tentou Haiku e depois Sonnet, nessa ordem', chamadas.join(',') === `${HAIKU},${SONNET}`, chamadas.join(','));

  console.log('\n3) Hangar com conferência de local → direto no Sonnet');
  chamadas = [];
  responder = () => ({ status: 200, corpo: corpoBom('010610140815', '06/10/26 14:08:15') });
  r = await ocr.lerTicket({ ...IMG, hangar: { id: 'aibm', exigeFotoVeiculoNoLocal: true } });
  conferir('leu', r.status === 'ocr_ok', `veio "${r.status}"`);
  conferir('não passou pelo Haiku', chamadas.length === 1 && chamadas[0] === SONNET, chamadas.join(','));

  console.log('\n4) Sem crédito → não insiste no outro modelo');
  chamadas = [];
  responder = () => ({ status: 400, corpo: CORPO_CREDITO });
  r = await ocr.lerTicket({ ...IMG, hangar: null });
  conferir('devolve ocr_indisponivel', r.status === 'ocr_indisponivel', `veio "${r.status}"`);
  conferir('causa é falta de crédito', r.causa === 'sem_credito', r.causa);
  conferir('uma chamada só (não repete no Sonnet)', chamadas.length === 1, chamadas.join(','));

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main().catch((e) => { console.error('teste quebrou:', e); falhas += 1; }).finally(() => process.exit(falhas ? 1 : 0));
