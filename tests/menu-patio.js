#!/usr/bin/env node
/**
 * "Como está meu pátio?" oferece escolha em vez de despejar tudo.
 *
 * A resposta completa é longa: contadores, tickets validados e a lista de
 * credenciados, que em alguns pátios passa de vinte nomes. Quem só queria
 * saber das vagas recebia tudo.
 *
 * O ponto que merece teste é a FRONTEIRA: quem já disse o que quer não pode
 * receber o menu, e quem perguntou genericamente não pode receber o despejo.
 */

const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const GRUPO = '120363431859218622@g.us'; // Solojet
const PESSOA = '5511999999999@s.whatsapp.net';

require('./cenario').montar({ hangares: { solojet: {} } });

// O que a consulta ao site devolveu — e com qual formato foi pedida.
let formatoPedido = null;
const consultar = require(path.join(RAIZ, 'scripts', 'consultar-patio.js'));
consultar.consultarPatio = async (_id, opcoes) => {
  formatoPedido = (opcoes || {}).formato;
  return { status: 'patio_ok', disponiveis: 30, total: 90, mensagemWhatsapp: `resposta-${formatoPedido}` };
};

const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));

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

async function main() {
  console.log('Pergunta genérica: oferece o menu, sem consultar o site');
  formatoPedido = null;
  const menu = await processar(texto('como está meu pátio?'), {});
  conferir('responde com o menu', menu.status === 'menu_patio', `veio "${menu.status}"`);
  conferir('não consultou o site ainda', formatoPedido === null, `pediu "${formatoPedido}"`);
  conferir('oferece as três opções', /1\*? — Credenciados/.test(menu.mensagemWhatsapp) && /3\*? — Ambos/.test(menu.mensagemWhatsapp), menu.mensagemWhatsapp);

  console.log('\nResposta que não é 1, 2 nem 3');
  const confuso = await processar(texto('sei lá'), {});
  conferir('reforça sem adivinhar', confuso.status === 'menu_patio_nao_entendido', `veio "${confuso.status}"`);
  conferir('ainda não consultou', formatoPedido === null);

  console.log('\nCada escolha pede o formato certo');
  for (const [resposta, esperado] of [['1', 'credenciados'], ['2', 'tickets'], ['3', 'ambos']]) {
    await processar(texto('status do pátio'), {});
    formatoPedido = null;
    const r = await processar(texto(resposta), {});
    conferir(`"${resposta}" -> ${esperado}`, formatoPedido === esperado, `pediu "${formatoPedido}"`);
    conferir(`"${resposta}" devolve a resposta`, r.mensagemWhatsapp === `resposta-${esperado}`, r.mensagemWhatsapp);
  }

  console.log('\nPalavras também valem');
  await processar(texto('status do pátio'), {});
  formatoPedido = null;
  await processar(texto('ambos'), {});
  conferir('"ambos" funciona', formatoPedido === 'ambos', `pediu "${formatoPedido}"`);

  console.log('\nQuem JÁ disse o que quer pula o menu');
  formatoPedido = null;
  const direto = await processar(texto('quais são os credenciados no pátio?'), {});
  conferir('não mostra menu', direto.status !== 'menu_patio', `veio "${direto.status}"`);
  conferir('vai direto aos credenciados', formatoPedido === 'credenciados', `pediu "${formatoPedido}"`);

  formatoPedido = null;
  const tickets = await processar(texto('me mostre os tickets validados'), {});
  conferir('tickets também vai direto', tickets.status !== 'menu_patio' && formatoPedido === 'tickets', `pediu "${formatoPedido}"`);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main()
  .catch((e) => { console.error('teste quebrou:', e); falhas += 1; })
  .finally(() => process.exit(falhas ? 1 : 0));
