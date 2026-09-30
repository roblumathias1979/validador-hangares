#!/usr/bin/env node
/**
 * totalDinheiroPorUnidade: dinheiro se acumula entre fechamentos (não é
 * depositado todo dia) num "Envelope" físico que a unidade também usa para
 * vales e compra de insumos (confirmado pelo usuário, 30/09/2026) — por isso
 * a soma que a gente calcula não é a única verdade: quando a unidade informa
 * o saldo físico real do Envelope (por texto), isso vira um CHECKPOINT, e só
 * contamos o que acontece DEPOIS dele.
 *
 * Escreve/restaura data/fechamentos.jsonl e data/complementos.jsonl de
 * verdade — mesmo padrão já usado no validador de hangares para testes que
 * tocam arquivo real.
 */

const fs = require('fs');
const path = require('path');

const {
  DATA_PATH, DATA_PATH_COMPLEMENTOS,
  gravarFechamento, gravarComplemento, totalDinheiroPorUnidade,
} = require(path.join(__dirname, '..', 'scripts', 'lib', 'armazenamento'));

function backup(caminho) {
  const guardado = fs.existsSync(caminho) ? fs.readFileSync(caminho, 'utf-8') : null;
  return () => {
    if (guardado === null) { try { fs.unlinkSync(caminho); } catch (e) { /* já não existe */ } }
    else fs.writeFileSync(caminho, guardado);
  };
}
const restaurarFechamentos = backup(DATA_PATH);
const restaurarComplementos = backup(DATA_PATH_COMPLEMENTOS);

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  if (ok) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

// Timestamps crescentes e controlados, para não depender de Date.now() real
// entre chamadas (poderiam empatar no mesmo milissegundo).
let relogio = new Date('2026-09-01T12:00:00.000Z').getTime();
function proximoInstante() {
  relogio += 60000; // +1 minuto a cada chamada
  return new Date(relogio).toISOString();
}

try {
  fs.mkdirSync(path.dirname(DATA_PATH), { recursive: true });
  fs.writeFileSync(DATA_PATH, '');
  fs.writeFileSync(DATA_PATH_COMPLEMENTOS, '');

  const fechamento = (over) => ({
    id: `teste-${Math.random()}`, unidadeId: 'norte', unidadeNome: 'Estacionamento Norte',
    relatorio: { situacao: 'fechado', recebidoDinheiro: 100 },
    documentoAnexo: { tipo: 'nenhum' },
    criadoEm: proximoInstante(),
    ...over,
  });
  const complemento = (over) => ({
    id: `complemento-${Math.random()}`, unidadeId: 'norte', unidadeNome: 'Estacionamento Norte',
    valorRecebido: null, fundoDeCaixa: null, envelope: null,
    criadoEm: proximoInstante(),
    ...over,
  });

  console.log('Sem nenhum complemento ainda: soma tudo desde sempre (comportamento antigo)');
  gravarFechamento(fechamento());
  gravarFechamento(fechamento());
  {
    const [norte] = totalDinheiroPorUnidade();
    conferir('2 fechamentos de R$100 acumulam R$200', norte.totalRecebido === 200, norte.totalRecebido);
    conferir('sem checkpoint ainda, saldo esperado = tudo recebido', norte.saldoEmCaixa === 200, norte.saldoEmCaixa);
    conferir('ultimoCheckpoint é null', norte.ultimoCheckpoint === null);
  }

  console.log('\nFechamento PARCIAL não entra na soma (é rascunho do mesmo período)');
  gravarFechamento(fechamento({ relatorio: { situacao: 'parcial', recebidoDinheiro: 9999 } }));
  {
    const [norte] = totalDinheiroPorUnidade();
    conferir('parcial ignorado, total continua R$200', norte.totalRecebido === 200, norte.totalRecebido);
  }

  console.log('\nDepósito bancário (por FOTO do envelope) desconta do saldo esperado, sem checkpoint de texto');
  gravarFechamento(fechamento({
    relatorio: { situacao: 'fechado', recebidoDinheiro: 50 },
    documentoAnexo: { tipo: 'deposito_bancario', deposito: { banco: 'Santander', valor: 180 } },
  }));
  {
    const [norte] = totalDinheiroPorUnidade();
    conferir('total recebido soma os 3 fechamentos finais (100+100+50)', norte.totalRecebido === 250, norte.totalRecebido);
    conferir('saldo em caixa = recebido - depositado (250-180=70)', norte.saldoEmCaixa === 70, norte.saldoEmCaixa);
  }

  console.log('\nUnidade informa o Envelope por TEXTO -> vira checkpoint, some o histórico anterior da soma');
  gravarComplemento(complemento({ envelope: 214, valorRecebido: 37, fundoDeCaixa: 200 }));
  {
    const [norte] = totalDinheiroPorUnidade();
    conferir('saldo agora É o envelope informado (214), ignorando a soma anterior (que dizia 70)', norte.saldoEmCaixa === 214, norte.saldoEmCaixa);
    conferir('nada contado ainda depois do checkpoint', norte.totalRecebido === 0, norte.totalRecebido);
    conferir('ultimoCheckpoint registrado', norte.ultimoCheckpoint && norte.ultimoCheckpoint.envelope === 214, JSON.stringify(norte.ultimoCheckpoint));
  }

  console.log('\nFechamento DEPOIS do checkpoint soma normalmente a partir dele');
  gravarFechamento(fechamento({ relatorio: { situacao: 'fechado', recebidoDinheiro: 30 } }));
  {
    const [norte] = totalDinheiroPorUnidade();
    conferir('soma só o que veio depois do checkpoint (30)', norte.totalRecebido === 30, norte.totalRecebido);
    conferir('saldo = checkpoint (214) + recebido depois (30) = 244', norte.saldoEmCaixa === 244, norte.saldoEmCaixa);
  }

  console.log('\nFechamento ANTES do checkpoint (fora de ordem) não é contado de novo');
  gravarFechamento(fechamento({ relatorio: { situacao: 'fechado', recebidoDinheiro: 999 }, criadoEm: '2026-09-01T12:00:01.000Z' }));
  {
    const [norte] = totalDinheiroPorUnidade();
    conferir('fechamento antigo demais não altera o saldo pós-checkpoint', norte.saldoEmCaixa === 244, norte.saldoEmCaixa);
  }

  console.log('\nUnidades diferentes não se misturam');
  gravarFechamento(fechamento({ unidadeId: 'sul', unidadeNome: 'Estacionamento Sul', relatorio: { situacao: 'fechado', recebidoDinheiro: 500 } }));
  {
    const todas = totalDinheiroPorUnidade();
    conferir('duas unidades distintas na lista', todas.length === 2, todas.length);
    const sul = todas.find((u) => u.unidadeId === 'sul');
    conferir('sul não herda nada do norte', sul.totalRecebido === 500 && sul.ultimoCheckpoint === null, JSON.stringify(sul));
  }

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
} finally {
  restaurarFechamentos();
  restaurarComplementos();
}

process.exit(falhas ? 1 : 0);
