#!/usr/bin/env node
/**
 * avisar-religado.js — depois de um "reiniciar sistema" pedido pelo WhatsApp,
 * espera o sistema subir e manda "voltei" ao grupo que pediu.
 *
 * Só age quando há data/reinicio-pedido.json recente (gravado pelo comando).
 * Reinício que ninguém pediu — queda de energia da AWS, por exemplo — não gera
 * mensagem aqui; esse caso é do monitor-saude, que roda 2 min depois do boot.
 *
 * Quem chama: infra/reiniciar-servicos.service (no fim dos reinícios) e
 * infra/avisar-religado.service (no boot). Sempre sai com código 0.
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(RAIZ, '.env'), override: true });

const ARQUIVO = path.join(RAIZ, 'data', 'reinicio-pedido.json');
const VALIDADE_MS = 20 * 60 * 1000; // pedido mais velho que isso é lixo
const ESPERA_MAX_MS = 4 * 60 * 1000;
const INTERVALO_MS = 10 * 1000;

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let pedido = null;
  try { pedido = JSON.parse(fs.readFileSync(ARQUIVO, 'utf-8')); } catch (e) { return; }
  if (!pedido || !pedido.grupoId || Date.now() - Number(pedido.em || 0) > VALIDADE_MS) {
    try { fs.unlinkSync(ARQUIVO); } catch (e) { /* ok */ }
    return;
  }

  const monitor = require('./monitor-saude');
  const { enviarTexto } = require('./lib/evolution');

  // Espera o WhatsApp (e o n8n) responderem: avisar antes disso falharia.
  const limite = Date.now() + ESPERA_MAX_MS;
  let checagens = {};
  while (Date.now() < limite) {
    try { checagens = (await monitor.verificar()).checagens || {}; } catch (e) { checagens = {}; }
    if (checagens.whatsapp && checagens.whatsapp.ok && checagens.n8n && checagens.n8n.ok) break;
    await dormir(INTERVALO_MS);
  }

  const ruins = Object.entries(checagens).filter(([, v]) => v && v.ok === false).map(([k]) => k);
  const oQue = pedido.tipo === 'servidor' ? 'servidor' : 'serviços';
  const texto = ruins.length
    ? `⚠️ Reinício dos ${oQue} concluído, mas ainda com problema em: ${ruins.join(', ')}.\nMande *consertar* ou *investigar*.`
    : `✅ Voltei! Reinício dos ${oQue} concluído e tudo no ar.`;

  try {
    await enviarTexto(pedido.grupoId, texto);
    fs.unlinkSync(ARQUIVO);
  } catch (e) {
    // Mantém o arquivo: a próxima chamada (boot ou monitor) tenta de novo até vencer a validade.
    console.log(JSON.stringify({ status: 'erro', mensagem: `não consegui avisar o grupo: ${e.message}` }));
  }
}

main().catch((e) => console.log(JSON.stringify({ status: 'erro', mensagem: e.message }))).then(() => process.exit(0));
