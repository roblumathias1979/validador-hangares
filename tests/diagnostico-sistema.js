#!/usr/bin/env node
/**
 * Diagnóstico pelo grupo de administração: "por que não está funcionando?"
 * devolve o status de cada parte e o que dá para fazer. O que este teste protege:
 *
 * 1. A pergunta no grupo admin dispara o diagnóstico (status 'diagnostico').
 * 2. O relatório reflete o estado real (ValidPark fora → 🔴 e sugere contingência;
 *    coletor sem foto fresca → 🔴).
 * 3. Com tudo no ar, diz que está tudo funcionando.
 *
 * `monitor-saude.verificar` (WhatsApp/n8n/disco) é trocado por um dublê, para o
 * teste não depender de rede nem do estado real da máquina.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const ADMGRUPO = '120363432317888806@g.us'; // grupo de administração (adminsWhatsapp)
const PESSOA = '5511999999999@s.whatsapp.net';

require('./cenario').montar({});

const EXTRA = ['data/saude.json', 'data/techparking-snapshot.json'];
const guardado = {};
for (const a of EXTRA) { const p = path.join(RAIZ, a); guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; }
process.on('exit', () => { for (const a of EXTRA) { const p = path.join(RAIZ, a); if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) {} } else fs.writeFileSync(p, guardado[a]); } });

const SNAP = path.join(RAIZ, 'data', 'techparking-snapshot.json');
const SAUDE = path.join(RAIZ, 'data', 'saude.json');
function escreverSnapshot(idadeMin) {
  fs.writeFileSync(SNAP, JSON.stringify({ recebidoEm: new Date(Date.now() - idadeMin * 60000).toISOString(), patios: [], avulsos: [], credenciados: [] }));
}
function escreverSaudeValidpark(ok) {
  fs.writeFileSync(SAUDE, JSON.stringify({ em: new Date().toISOString(), saudavel: true, checagens: {}, validpark: { ok, detalhe: ok ? 'login e leitura ok' : 'não respondeu', em: new Date().toISOString() } }));
}

// Dublê do verificar() do monitor de saúde (WhatsApp/n8n/disco).
const monitor = require(path.join(RAIZ, 'scripts', 'monitor-saude.js'));
let checagensFake = { whatsapp: { ok: true, detalhe: 'conectada' }, n8n: { ok: true, detalhe: 'respondendo' }, disco: { ok: true, detalhe: '10 GB livres' } };
monitor.verificar = async () => ({ em: new Date().toISOString(), saudavel: true, checagens: checagensFake, problemas: [] });

const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));
const CONFIG = path.join(RAIZ, 'config', 'hangares.json');
const setContingencia = (ativo) => { const c = JSON.parse(fs.readFileSync(CONFIG, 'utf-8')); c.contingenciaValidPark = { ...(c.contingenciaValidPark || {}), ativo }; fs.writeFileSync(CONFIG, `${JSON.stringify(c, null, 2)}\n`); };

const texto = (t) => ({ data: { key: { remoteJid: ADMGRUPO, fromMe: false, id: `D${Math.random()}`, participant: PESSOA }, pushName: 'Admin', message: { conversation: t } } });

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

async function main() {
  console.log('ValidPark fora + coletor fresco + contingência off');
  escreverSnapshot(1);          // coletor ok (1 min)
  escreverSaudeValidpark(false); // ValidPark fora
  setContingencia(false);
  const r = await processar(texto('por que não está funcionando o validador?'), {});
  conferir('dispara o diagnóstico', r.status === 'diagnostico', `veio "${r.status}"`);
  conferir('tem cabeçalho de status', /Status do validador/.test(r.mensagemWhatsapp || ''));
  conferir('marca o ValidPark como fora', /🔴 ValidPark/.test(r.mensagemWhatsapp));
  conferir('sugere ligar a contingência', /ligar contingência/i.test(r.mensagemWhatsapp));
  conferir('coletor aparece ok', /🟢 Coletor/.test(r.mensagemWhatsapp));

  console.log('\nValidPark fora + contingência JÁ ligada: não insiste, diz que está coberto');
  escreverSaudeValidpark(false);
  setContingencia(true);
  const r2 = await processar(texto('status do sistema'), {});
  conferir('reconhece que a contingência cobre', /contingência está ligada/i.test(r2.mensagemWhatsapp), r2.mensagemWhatsapp);

  console.log('\nColetor sem foto fresca: aponta o coletor');
  escreverSnapshot(30);          // coletor parado (30 min)
  escreverSaudeValidpark(true);  // ValidPark ok
  setContingencia(false);
  const r3 = await processar(texto('o que houve?'), {});
  conferir('marca o coletor como fora', /🔴 Coletor/.test(r3.mensagemWhatsapp));
  conferir('sugere verificar o coletor', /coletor-aeroporto/i.test(r3.mensagemWhatsapp));

  console.log('\nTudo no ar: diz que está tudo funcionando');
  escreverSnapshot(1);
  escreverSaudeValidpark(true);
  setContingencia(false);
  checagensFake = { whatsapp: { ok: true, detalhe: 'conectada' }, n8n: { ok: true, detalhe: 'respondendo' }, disco: { ok: true, detalhe: '10 GB livres' } };
  const r4 = await processar(texto('diagnóstico'), {});
  conferir('diz que está tudo no ar', /tudo no ar/i.test(r4.mensagemWhatsapp), r4.mensagemWhatsapp);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main().catch((e) => { console.error('teste quebrou:', e); falhas += 1; }).finally(() => process.exit(falhas ? 1 : 0));
