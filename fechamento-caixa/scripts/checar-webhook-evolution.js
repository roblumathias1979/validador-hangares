#!/usr/bin/env node
// Uso: node scripts/checar-webhook-evolution.js
//
// SÓ LEITURA — não muda nada. Mostra a configuração ATUAL do webhook da
// instância da Evolution API (a mesma usada pelo validador de hangares em
// produção), para decidir com segurança como plugar o fechamento de caixa
// sem quebrar o que já está no ar. Evolution normalmente só aceita UMA URL
// de webhook por instância — por isso não dá para simplesmente trocá-la
// pela URL do fechamento de caixa sem primeiro saber o que está lá hoje.

const http = require('http');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

const EVOLUTION_URL = process.env.EVOLUTION_URL || 'http://127.0.0.1:8080';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'validador-hangares';

function buscarWebhook() {
  return new Promise((resolve, reject) => {
    const chave = process.env.EVOLUTION_API_KEY;
    if (!chave) { reject(new Error('EVOLUTION_API_KEY não configurada no .env.')); return; }
    const url = new URL(`/webhook/find/${EVOLUTION_INSTANCE}`, EVOLUTION_URL);
    const req = http.get(
      { hostname: url.hostname, port: url.port, path: url.pathname, headers: { apikey: chave } },
      (res) => {
        let corpo = '';
        res.on('data', (c) => { corpo += c; });
        res.on('end', () => {
          try { resolve({ status: res.statusCode, dados: JSON.parse(corpo) }); }
          catch (e) { reject(new Error(`Resposta não-json (HTTP ${res.statusCode}): ${corpo.slice(0, 300)}`)); }
        });
      }
    );
    req.on('error', reject);
  });
}

async function main() {
  try {
    const { status, dados } = await buscarWebhook();
    console.log(`HTTP ${status}\n`);
    console.log(JSON.stringify(dados, null, 2));
  } catch (erro) {
    console.error(`Não consegui consultar o webhook: ${erro.message}`);
    process.exitCode = 1;
  }
}

main();
