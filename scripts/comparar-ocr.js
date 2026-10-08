#!/usr/bin/env node
/**
 * comparar-ocr.js — A/B do OCR do ticket entre modelos.
 *
 * Por quê: o OCR do ticket é caminho CRÍTICO (ler o número errado valida o
 * ticket de outra pessoa), então antes de trocar o Sonnet por um modelo mais
 * barato a gente mede nas fotos REAIS: os dois leem o mesmo número e a mesma
 * data? Quanto custa cada um? Quanto demora?
 *
 * Uso:
 *   node scripts/comparar-ocr.js foto1.jpg [foto2.jpg ...]
 *   node scripts/comparar-ocr.js --modelos claude-sonnet-5,claude-haiku-5-5 foto.jpg
 *
 * Precisa da ANTHROPIC_API_KEY no .env (a mesma do OCR). Gasta créditos de
 * verdade — uma chamada por modelo por foto.
 */

const fs = require('fs');
const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

const { chamarClaude, PROMPT, extrairJson, paraIso, conferirTicketComData, MODELO } = require('./ocr-ticket');

// Preços por 1 milhão de tokens (USD) — tabela oficial da Anthropic.
// Mantida junto da lib de créditos; aqui só o que o comparador precisa.
const PRECOS = {
  'claude-opus-5-5': { in: 4, out: 20 },
  'claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5-5': { in: 2, out: 10 },
  'claude-sonnet-5': { in: 2, out: 10 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

const TIPOS = { '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp', '.gif': 'image/gif' };

function custoUsd(modelo, usage) {
  const p = PRECOS[modelo];
  if (!p || !usage) return null;
  return ((usage.input_tokens || 0) * p.in + (usage.output_tokens || 0) * p.out) / 1e6;
}

function dinheiro(usd) {
  if (usd == null) return '—';
  return `US$ ${usd.toFixed(5)}`;
}

async function rodarUm(modelo, imagem) {
  const t0 = Date.now();
  const resposta = await chamarClaude({ ...imagem, prompt: PROMPT, modelo });
  const ms = Date.now() - t0;
  const texto = (resposta.content || []).map((b) => b.text || '').join('');
  let lido = {};
  try { lido = extrairJson(texto); } catch (e) { lido = { _erro: 'json inválido' }; }
  const ticket = (lido.ticket || '').trim() || null;
  const dataIso = paraIso(lido.dataEmissaoDDMMAAHHMMSS);
  return {
    modelo,
    ticket,
    dataImpressa: lido.dataEmissaoDDMMAAHHMMSS || null,
    dataIso,
    confianca: lido.confianca || null,
    confere: ticket && lido.dataEmissaoDDMMAAHHMMSS ? conferirTicketComData(ticket, lido.dataEmissaoDDMMAAHHMMSS).ok : null,
    custo: custoUsd(modelo, resposta.usage),
    ms,
    usage: resposta.usage || null,
    erro: lido._erro || null,
  };
}

async function main() {
  const args = process.argv.slice(2);
  let modelos = ['claude-sonnet-5', 'claude-haiku-5-5'];
  const fotos = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === '--modelos') { modelos = args[i + 1].split(',').map((s) => s.trim()); i += 1; }
    else fotos.push(args[i]);
  }
  if (!fotos.length) {
    console.error('Uso: node scripts/comparar-ocr.js [--modelos a,b] foto1.jpg [foto2.jpg ...]');
    process.exit(1);
  }
  console.log(`Comparando modelos: ${modelos.join('  ×  ')}`);
  console.log(`(produção hoje: ${MODELO})\n`);

  const totais = Object.fromEntries(modelos.map((m) => [m, { custo: 0, ms: 0, n: 0 }]));
  let divergencias = 0;

  for (const foto of fotos) {
    const ext = path.extname(foto).toLowerCase();
    if (!fs.existsSync(foto)) { console.log(`✗ ${foto}: arquivo não encontrado\n`); continue; }
    if (!TIPOS[ext]) { console.log(`✗ ${foto}: extensão não suportada (${ext})\n`); continue; }
    const imagem = { mediaType: TIPOS[ext], dados: fs.readFileSync(foto).toString('base64') };

    console.log(`📄 ${path.basename(foto)}`);
    const resultados = [];
    for (const m of modelos) {
      try {
        const r = await rodarUm(m, imagem);
        resultados.push(r);
        totais[m].custo += r.custo || 0; totais[m].ms += r.ms; totais[m].n += 1;
        const marca = r.confere === false ? ' ⚠ número×data não batem' : '';
        console.log(`   ${m.padEnd(20)} ticket=${String(r.ticket).padEnd(13)} data=${String(r.dataImpressa).padEnd(18)} conf=${String(r.confianca).padEnd(6)} ${dinheiro(r.custo).padEnd(12)} ${r.ms}ms${marca}${r.erro ? ` [${r.erro}]` : ''}`);
      } catch (e) {
        console.log(`   ${m.padEnd(20)} ERRO: ${e.message}`);
      }
    }
    // Concordância entre o primeiro modelo (referência) e os demais.
    const ref = resultados[0];
    for (const r of resultados.slice(1)) {
      const mesmoTicket = ref.ticket === r.ticket;
      const mesmaData = ref.dataIso === r.dataIso;
      if (mesmoTicket && mesmaData) {
        console.log(`   = ${r.modelo} concorda com ${ref.modelo} (ticket e data idênticos)`);
      } else {
        divergencias += 1;
        console.log(`   ✗ ${r.modelo} DIVERGE de ${ref.modelo}: ${mesmoTicket ? '' : 'ticket diferente '}${mesmaData ? '' : 'data diferente'}`);
      }
    }
    console.log('');
  }

  console.log('── Resumo ─────────────────────────────');
  for (const m of modelos) {
    const t = totais[m];
    if (!t.n) continue;
    const mediaMs = Math.round(t.ms / t.n);
    console.log(`${m.padEnd(20)} ${dinheiro(t.custo).padEnd(12)} total  |  ${dinheiro(t.custo / t.n)}/foto  |  ${mediaMs}ms/foto`);
  }
  // Economia do mais barato vs o primeiro (referência).
  const ref = modelos[0];
  for (const m of modelos.slice(1)) {
    if (!totais[ref].n || !totais[m].n || !totais[ref].custo) continue;
    const fator = totais[ref].custo / totais[m].custo;
    console.log(`→ ${m} é ~${fator.toFixed(1)}x mais barato que ${ref}`);
  }
  console.log(divergencias
    ? `\n⚠ ${divergencias} divergência(s) de leitura. NÃO troque o modelo de produção até entender cada uma — é caminho crítico.`
    : '\n✓ Nenhuma divergência: os modelos leram o mesmo número e a mesma data em todas as fotos.');
}

main().catch((e) => { console.error('comparador quebrou:', e); process.exit(1); });
