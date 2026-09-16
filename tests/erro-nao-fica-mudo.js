#!/usr/bin/env node
/**
 * Regressão de 16/09/2026 — o grupo do AIBM 1 ficou MUDO.
 *
 * O cliente mandou o ticket e não recebeu absolutamente nada. Duas falhas
 * somadas, e é a soma que torna o caso grave:
 *
 *  1. `infoLocalVazio` era usado ~45 linhas ACIMA da sua declaração `const`.
 *     Erro de zona morta temporal: só explode quando aquele ramo roda, e ele só
 *     roda nos hangares com foto obrigatória quando a consulta prévia diz que o
 *     ticket NÃO serve. Por isso passou nos testes — os tickets de teste serviam.
 *
 *  2. O catch de topo respondia `responder: false`, alegando não ter grupoId
 *     confiável. Tinha: bastava ler o payload. O bug virou silêncio, e silêncio
 *     no WhatsApp é lido como "está processando" — o cliente espera em vez de
 *     procurar a administração.
 *
 * Os dois testes abaixo cobrem cada uma das falhas.
 *
 * Roda sem rede: a Evolution, o OCR e os scripts filhos são substituídos.
 */

const path = require('path');

// O script exige essas variáveis para falar com a Evolution. Nada aqui usa a
// rede — os valores só precisam existir.
process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const GRUPO_AIBM1 = '120363430127934870@g.us';

// --- substituições, instaladas ANTES de carregar o script sob teste ---------

const child = require('child_process');
child.execFileSync = (_cmd, args) => {
  const arquivo = path.basename(args[0]);
  if (arquivo === 'consultar-ticket.js') {
    // O caso que quebrava: o ticket não serve.
    return JSON.stringify({
      status: 'prazo_excedido_no_site',
      jaValidado: false,
      mensagemWhatsapp: 'Esse ticket está fora do prazo de validação.',
      notificarAdmin: true,
    });
  }
  throw new Error(`script inesperado no teste: ${arquivo}`);
};

const ocr = require(path.join(RAIZ, 'scripts', 'ocr-ticket.js'));
ocr.lerTicket = async () => ({
  status: 'ocr_ok',
  ticket: '011609999999',
  dataEmissaoIso: new Date().toISOString(),
  local: 'compativel',
  localMotivo: null,
  cenario: null,
});

// A Evolution nunca é chamada: http.request devolve uma imagem de mentira.
const http = require('http');
http.request = (_opcoes, cb) => {
  const resposta = new (require('stream').PassThrough)();
  resposta.statusCode = 200;
  process.nextTick(() => {
    cb(resposta);
    resposta.end(JSON.stringify({ base64: 'ZmFsc28=', mimetype: 'image/jpeg' }));
  });
  return { on() { return this; }, write() {}, end() {}, setTimeout() {}, destroy() {} };
};

const { processar, resultadoDeErro } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));

// --- payload de uma foto de ticket mandada no grupo do AIBM 1 --------------

function base64(obj) {
  return Buffer.from(JSON.stringify(obj), 'utf-8').toString('base64');
}

function payloadFoto() {
  return {
    data: {
      key: { remoteJid: GRUPO_AIBM1, fromMe: false, id: 'TESTE1', participant: '5511999999999@s.whatsapp.net' },
      pushName: 'Teste',
      message: { imageMessage: { caption: '', mimetype: 'image/jpeg' } },
    },
  };
}

// --- testes ----------------------------------------------------------------

let falhas = 0;
function conferir(nome, condicao, detalhe) {
  if (condicao) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
}

async function main() {
  console.log('Ticket que não serve, em hangar que exige foto do veículo:');
  const r = await processar(payloadFoto(), {});

  conferir('não estoura com erro interno', r.status !== 'erro',
    r.status === 'erro' ? r.mensagem : '');
  conferir('devolve o motivo real da recusa', r.status === 'prazo_excedido_no_site', `veio "${r.status}"`);
  conferir('responde ao cliente', r.responder === true);
  conferir('sabe para qual grupo responder', r.grupoId === GRUPO_AIBM1);
  conferir('avisa a administração', r.notificarAdmin === true);

  console.log('\nQuando mesmo assim estoura, o grupo não pode ficar mudo:');
  const erro = resultadoDeErro(new Error('bug qualquer'), base64(payloadFoto()));
  conferir('responde ao cliente', erro.responder === true);
  conferir('para o grupo certo', erro.grupoId === GRUPO_AIBM1);
  conferir('avisa a administração', erro.notificarAdmin === true);

  console.log('\nMas segue mudo fora dos grupos que atendemos:');
  const alheio = resultadoDeErro(new Error('bug qualquer'),
    base64({ data: { key: { remoteJid: '120363000000000000@g.us', fromMe: false } } }));
  conferir('não responde em grupo desconhecido', alheio.responder === false);
  const privado = resultadoDeErro(new Error('bug qualquer'),
    base64({ data: { key: { remoteJid: '5511999999999@s.whatsapp.net', fromMe: false } } }));
  conferir('não responde em conversa privada', privado.responder === false);
  conferir('não responde com payload ilegível', resultadoDeErro(new Error('x'), 'nao-e-base64-json').responder === false);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
  process.exit(falhas ? 1 : 0);
}

main().catch((e) => { console.error('teste quebrou:', e); process.exit(1); });
