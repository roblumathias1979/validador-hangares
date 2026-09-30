#!/usr/bin/env node
/**
 * Testa só a parte que NÃO depende de rede (a chamada real à API do PagBank
 * ainda não tem credenciais para testar de verdade — ver
 * scripts/lib/pagseguro-edi.js): a data de "ontem" em São Paulo, e como o
 * cartão declarado num fechamento real é somado para comparar depois.
 *
 * Escreve/restaura data/fechamentos.jsonl de verdade.
 */

const fs = require('fs');
const path = require('path');

const { DATA_PATH, gravarFechamento } = require(path.join(__dirname, '..', 'scripts', 'lib', 'armazenamento'));
const { dataDeOntemEmSaoPaulo, cartaoDeclaradoNoDia } = require(path.join(__dirname, '..', 'scripts', 'auditar-dia-anterior'));

const guardado = fs.existsSync(DATA_PATH) ? fs.readFileSync(DATA_PATH, 'utf-8') : null;
const restaurar = () => {
  if (guardado === null) { try { fs.unlinkSync(DATA_PATH); } catch (e) { /* já não existe */ } }
  else fs.writeFileSync(DATA_PATH, guardado);
};

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  if (ok) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

console.log('dataDeOntemEmSaoPaulo atravessa a virada do dia certo (UTC-3 fixo, sem horário de verão)');
conferir('10h UTC (7h em SP, já é dia novo) -> dia anterior', dataDeOntemEmSaoPaulo(new Date('2026-10-01T10:00:00Z')) === '2026-09-30');
conferir('01h UTC (22h em SP, AINDA é o dia anterior em SP) -> antes de ontem', dataDeOntemEmSaoPaulo(new Date('2026-10-01T01:00:00Z')) === '2026-09-29');

try {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, '');

  console.log('\ncartaoDeclaradoNoDia soma a tabela de formas (real: Hotel Nacional Inn, fechamento nº 363)');
  gravarFechamento({
    id: 'teste-1', unidadeId: 'hotel-nacional-inn', unidadeNome: 'Hotel Nacional Inn',
    relatorio: {
      situacao: 'fechado', recebidoCartao: 700,
      formasDePagamento: [{ forma: 'A Faturar', valor: 30 }, { forma: 'MAQ. CARTAO', valor: 700 }],
    },
    documentoAnexo: { tipo: 'nenhum' }, criadoEm: '2026-09-30T18:00:00.000Z',
  });
  conferir('soma da tabela (700), não o valorFaturado inteiro', cartaoDeclaradoNoDia('hotel-nacional-inn', '2026-09-30') === 700);

  console.log('\nDia sem nenhum fechamento devolve null (não confunde com zero)');
  conferir('sem fechamento em 2026-09-29 -> null', cartaoDeclaradoNoDia('hotel-nacional-inn', '2026-09-29') === null);

  console.log('\nFechamento PARCIAL não conta (é rascunho, não fechamento do dia)');
  gravarFechamento({
    id: 'teste-2', unidadeId: 'argentina-mall', unidadeNome: 'Argentina Mall',
    relatorio: { situacao: 'parcial', recebidoCartao: 9999, formasDePagamento: [{ forma: 'MAQ. CARTAO', valor: 9999 }] },
    documentoAnexo: { tipo: 'nenhum' }, criadoEm: '2026-09-30T12:00:00.000Z',
  });
  conferir('parcial não conta -> null', cartaoDeclaradoNoDia('argentina-mall', '2026-09-30') === null);

  console.log('\nSem tabela de formas, cai no campo-resumo recebidoCartao');
  gravarFechamento({
    id: 'teste-3', unidadeId: 'vila-mariana', unidadeNome: 'Vila Mariana',
    relatorio: { situacao: 'fechado', recebidoCartao: 250, formasDePagamento: [] },
    documentoAnexo: { tipo: 'nenhum' }, criadoEm: '2026-09-30T20:00:00.000Z',
  });
  conferir('cai no recebidoCartao (250)', cartaoDeclaradoNoDia('vila-mariana', '2026-09-30') === 250);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
} finally {
  restaurar();
}

process.exit(falhas ? 1 : 0);
