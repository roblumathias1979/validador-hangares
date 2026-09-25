#!/usr/bin/env node
// Uso: node scripts/exportar-planilha.js [caminhoSaida.csv] [--unidade=id] [--desde=ISO] [--ate=ISO]
//
// Gera uma planilha (CSV) a partir de data/fechamentos.jsonl. Sem argumento
// de caminho, imprime o CSV em stdout — útil para o painel gerar o arquivo
// sob demanda sem precisar gravar nada em disco.

const fs = require('fs');
const { listarFechamentos } = require('./lib/armazenamento');

const COLUNAS = [
  'criadoEm', 'unidadeId', 'unidadeNome', 'situacao', 'numeroRelatorio', 'periodoDe', 'periodoAte',
  'valorFaturado', 'recebidoCartao', 'recebidoDinheiro', 'recebidoOutraForma',
  'conferenciaInterna', 'diferencaInterna',
  'documentoAnexoTipo', 'conferenciaMaquininha', 'diferencaMaquininha',
  'confiancaIdentificacao', 'remetenteTelefone', 'legenda',
];

function csvEscape(valor) {
  const s = valor === null || valor === undefined ? '' : String(valor);
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function paraLinha(r) {
  const rel = r.relatorio || {};
  const interna = r.conferenciaInterna || {};
  const anexo = r.documentoAnexo || {};
  const maq = r.conferenciaMaquininha || {};
  // A diferença "que interessa" da conferência interna é a da checagem que
  // deu inconsistente; se nenhuma deu, mostra a do resumo (quando existir).
  const checagemInterna = Object.values(interna.checagens || {}).find((c) => c.status === 'inconsistente')
    || (interna.checagens || {}).resumoVsFaturado || {};
  return [
    r.criadoEm, r.unidadeId, r.unidadeNome, rel.situacao, rel.numero, rel.periodoDe, rel.periodoAte,
    rel.valorFaturado, rel.recebidoCartao, rel.recebidoDinheiro, rel.recebidoOutraForma,
    interna.status, checagemInterna.diferenca,
    anexo.tipo, maq.status, maq.diferenca,
    (r.identificacao || {}).confianca, (r.origem || {}).remetenteTelefone, (r.origem || {}).legenda,
  ].map(csvEscape).join(';');
}

function gerarCsv(filtros = {}) {
  const linhas = listarFechamentos(filtros).map(paraLinha);
  return [COLUNAS.join(';'), ...linhas].join('\n');
}

function main() {
  const args = process.argv.slice(2);
  const caminhoSaida = args.find((a) => !a.startsWith('--'));
  const filtros = {};
  for (const a of args) {
    const m = a.match(/^--(unidade|desde|ate)=(.*)$/);
    if (m) filtros[{ unidade: 'unidadeId', desde: 'desde', ate: 'ate' }[m[1]]] = m[2];
  }

  const csv = gerarCsv(filtros);
  if (caminhoSaida) {
    fs.writeFileSync(caminhoSaida, csv);
    console.error(`Planilha gerada em ${caminhoSaida} (${csv.split('\n').length - 1} fechamento(s)).`);
  } else {
    process.stdout.write(csv);
  }
}

if (require.main === module) {
  main();
}

module.exports = { gerarCsv };
