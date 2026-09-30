#!/usr/bin/env node
/**
 * Testa só a parte que NÃO depende de rede (a interpretação do TIPO/período
 * pelo Claude ainda não dá para testar sem chamar a API de verdade — ver
 * scripts/lib/consulta-caixa.js): resolverAlvo (unidade/cofre a partir do
 * texto livre) e dinheiroRecebidoNoPeriodo (soma por período).
 *
 * Escreve/restaura data/fechamentos.jsonl e data/complementos.jsonl de
 * verdade.
 */

const fs = require('fs');
const path = require('path');

const {
  DATA_PATH, DATA_PATH_COMPLEMENTOS,
  gravarFechamento, gravarComplemento, dinheiroRecebidoNoPeriodo,
} = require(path.join(__dirname, '..', 'scripts', 'lib', 'armazenamento'));
const { resolverAlvo } = require(path.join(__dirname, '..', 'scripts', 'lib', 'consulta-caixa'));

const CONFIG = {
  unidades: [
    { id: 'hotel-nacional-inn', nome: 'Hotel Nacional Inn', apelidos: ['nacional inn', 'nacional'], cofre: 'Poços de Caldas' },
    { id: 'rua-paraiba', nome: 'Rua Paraíba', apelidos: ['rua paraiba', 'paraiba'], cofre: 'Poços de Caldas' },
    { id: 'vila-mariana', nome: 'Vila Mariana', apelidos: ['vila mariana'], cofre: null },
  ],
};

const guardar = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null);
const restaurar = (p, conteudo) => {
  if (conteudo === null) { try { fs.unlinkSync(p); } catch (e) { /* já não existe */ } }
  else fs.writeFileSync(p, conteudo);
};
const guardadoFechamentos = guardar(DATA_PATH);
const guardadoComplementos = guardar(DATA_PATH_COMPLEMENTOS);

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  if (ok) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

console.log('resolverAlvo casa unidade por apelido dentro de uma pergunta inteira');
conferir(
  '"quanto tem de dinheiro na nacional inn?" -> Hotel Nacional Inn',
  (resolverAlvo(CONFIG, 'quanto tem de dinheiro na nacional inn?') || {}).unidadeIds?.[0] === 'hotel-nacional-inn'
);

console.log('\nresolverAlvo casa COFRE (agrupa as unidades daquele cofre)');
{
  const r = resolverAlvo(CONFIG, 'quanto tem no cofre de pocos de caldas');
  conferir('tipo cofre', (r || {}).tipo === 'cofre');
  conferir('as 2 unidades de Poços de Caldas, nenhuma outra', JSON.stringify((r.unidadeIds || []).sort()) === JSON.stringify(['hotel-nacional-inn', 'rua-paraiba']));
}

console.log('\nresolverAlvo casa "todas as unidades"');
conferir(
  '3 unidades cadastradas',
  (resolverAlvo(CONFIG, 'quanto tem de dinheiro em todas as unidades') || {}).unidadeIds?.length === 3
);

console.log('\nresolverAlvo devolve null quando não reconhece nada (nunca adivinha)');
conferir('texto sem unidade nem cofre -> null', resolverAlvo(CONFIG, 'quanto tem de dinheiro no posto ali da esquina') === null);

try {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, '');
  fs.writeFileSync(DATA_PATH_COMPLEMENTOS, '');

  console.log('\ndinheiroRecebidoNoPeriodo soma FOTO (recebidoDinheiro) dentro do período');
  gravarFechamento({
    id: 't1', unidadeId: 'hotel-nacional-inn', unidadeNome: 'Hotel Nacional Inn',
    relatorio: { situacao: 'fechado', recebidoDinheiro: 100 },
    criadoEm: '2026-09-10T15:00:00.000Z', // 10/09 em SP
  });
  gravarFechamento({
    id: 't2', unidadeId: 'hotel-nacional-inn', unidadeNome: 'Hotel Nacional Inn',
    relatorio: { situacao: 'fechado', recebidoDinheiro: 999 },
    criadoEm: '2026-08-31T15:00:00.000Z', // FORA do período (antes)
  });
  gravarFechamento({
    id: 't3', unidadeId: 'hotel-nacional-inn', unidadeNome: 'Hotel Nacional Inn',
    relatorio: { situacao: 'parcial', recebidoDinheiro: 500 },
    criadoEm: '2026-09-10T16:00:00.000Z', // parcial não conta
  });
  gravarComplemento({
    unidadeId: 'hotel-nacional-inn', unidadeNome: 'Hotel Nacional Inn',
    valorRecebido: 37, criadoEm: '2026-09-15T18:00:00.000Z', // dentro do período
  });
  gravarComplemento({
    unidadeId: 'rua-paraiba', unidadeNome: 'Rua Paraíba',
    valorRecebido: 50, criadoEm: '2026-09-12T12:00:00.000Z',
  });

  const r = dinheiroRecebidoNoPeriodo({ unidadeIds: ['hotel-nacional-inn', 'rua-paraiba'], desde: '2026-09-01', ate: '2026-09-30' });
  conferir('Nacional Inn: 100 (foto) + 37 (texto) = 137, sem contar parcial nem o de agosto', r.porUnidade['hotel-nacional-inn'] === 137);
  conferir('Rua Paraíba: só o complemento de 50', r.porUnidade['rua-paraiba'] === 50);
  conferir('total: 187', r.total === 187);

  console.log('\ndinheiroRecebidoNoPeriodo respeita fronteira de dia em São Paulo (UTC-3)');
  const r2 = dinheiroRecebidoNoPeriodo({ unidadeIds: ['hotel-nacional-inn'], desde: '2026-09-10', ate: '2026-09-10' });
  conferir('só o fechamento do dia 10 (100), não o de agosto nem o complemento do dia 15', r2.porUnidade['hotel-nacional-inn'] === 100);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
} finally {
  restaurar(DATA_PATH, guardadoFechamentos);
  restaurar(DATA_PATH_COMPLEMENTOS, guardadoComplementos);
}

process.exit(falhas ? 1 : 0);
