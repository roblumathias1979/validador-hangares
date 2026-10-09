#!/usr/bin/env node
/**
 * avisar-atualizado.js — depois do "atualizar servidor" (opção instalar), espera
 * o sistema se recompor e conta ao grupo que pediu o que aconteceu: quantos
 * pacotes entraram, se sobrou algo e se vale reiniciar.
 *
 * Só age com data/atualizacao-pedido.json recente. Chamado no fim da unidade
 * infra/atualizar-servidor.service. Sempre sai com código 0.
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(RAIZ, '.env'), override: true });

const ARQUIVO = path.join(RAIZ, 'data', 'atualizacao-pedido.json');
const VALIDADE_MS = 60 * 60 * 1000;
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
  const { rodar } = require('./lib/auto-conserto');
  const atualizacoes = require('./lib/atualizacoes');

  // O Docker e o n8n reiniciam durante o upgrade: espera voltarem antes de avisar.
  const limite = Date.now() + ESPERA_MAX_MS;
  let checagens = {};
  while (Date.now() < limite) {
    try { checagens = (await monitor.verificar()).checagens || {}; } catch (e) { checagens = {}; }
    if (checagens.whatsapp && checagens.whatsapp.ok && checagens.n8n && checagens.n8n.ok) break;
    await dormir(INTERVALO_MS);
  }
  const ruins = Object.entries(checagens).filter(([, v]) => v && v.ok === false).map(([k]) => k);

  const r = atualizacoes.verificar(rodar);
  const linhas = [];
  if (r.erro) {
    linhas.push('⚠️ A atualização terminou, mas não consegui conferir o resultado.', 'Mande *atualizar servidor* → *1* para ver o que sobrou.');
  } else {
    const instalados = Math.max(0, Number(pedido.antes || 0) - r.instalaveis);
    linhas.push(r.instalaveis ? `⚠️ Atualização feita: *${instalados}* pacote(s) instalado(s), mas *${r.instalaveis}* não entraram. Mande *atualizar servidor* → *1* para ver.` : `✅ Atualização concluída: *${instalados}* pacote(s) instalado(s).`);
    if (r.seguradas.length) linhas.push(`⏳ ${r.seguradas.length} em liberação gradual do Ubuntu (entram sozinhos).`);
    if (ruins.length) linhas.push(`⚠️ Ainda com problema em: ${ruins.join(', ')}. Mande *consertar*.`);
    else linhas.push('Tudo no ar.');
    const vale = r.reinicioPendente || (pedido.sensiveis || []).some((x) => /Kernel|AppArmor|Docker/.test(x));
    if (vale) linhas.push('', '🔁 Vale *reiniciar o servidor* para aplicar tudo: mande *reiniciar sistema* → *2*.');
  }

  try {
    await enviarTexto(pedido.grupoId, linhas.join('\n'));
    fs.unlinkSync(ARQUIVO);
  } catch (e) {
    console.log(JSON.stringify({ status: 'erro', mensagem: `não consegui avisar o grupo: ${e.message}` }));
  }
}

main().catch((e) => console.log(JSON.stringify({ status: 'erro', mensagem: e.message }))).then(() => process.exit(0));
