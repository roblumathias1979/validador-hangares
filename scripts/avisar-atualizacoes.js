#!/usr/bin/env node
/**
 * avisar-atualizacoes.js — uma vez por mês, avisa a administração se o servidor
 * tem atualização para instalar ou está esperando reinício. Sem pendência, não
 * manda nada. Quem instala é o comando "atualizar servidor"; aqui só se AVISA.
 *
 * Roda por systemd timer (infra/avisar-atualizacoes.timer). Sempre sai com 0.
 */

const path = require('path');

const RAIZ = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(RAIZ, '.env'), override: true });

const { carregarConfig } = require('./lib/hangar');
const { destinosAdmin } = require('./lib/admins');
const { enviarTexto } = require('./lib/evolution');
const { rodar } = require('./lib/auto-conserto');
const atualizacoes = require('./lib/atualizacoes');

async function main() {
  const texto = atualizacoes.mensagemAvisoMensal(atualizacoes.verificar(rodar));
  if (!texto) { console.log(JSON.stringify({ status: 'ok', mensagem: 'sem pendência, nada enviado' })); return; }

  const enviados = [];
  for (const destino of destinosAdmin(carregarConfig())) {
    try { await enviarTexto(destino, texto); enviados.push(destino); } catch (e) {
      console.log(JSON.stringify({ status: 'erro', mensagem: `não consegui avisar ${destino}: ${e.message}` }));
    }
  }
  console.log(JSON.stringify({ status: 'ok', mensagem: `aviso enviado a ${enviados.length} destino(s)` }));
}

main().catch((e) => console.log(JSON.stringify({ status: 'erro', mensagem: e.message }))).then(() => process.exit(0));
