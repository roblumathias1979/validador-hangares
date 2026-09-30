#!/usr/bin/env node
/**
 * retiradas.js: a sequência motivo -> comprovante? -> foto precisa persistir
 * entre chamadas (cada mensagem do WhatsApp é um processo novo) e não pode
 * misturar a pendência de uma unidade com a de outra.
 *
 * Escreve/restaura data/retiradas-pendentes.json e data/retiradas.jsonl de
 * verdade.
 */

const fs = require('fs');
const path = require('path');

const {
  PENDENCIAS_PATH, HISTORICO_PATH,
  abrirPendencia, buscarPendencia, atualizarPendencia, encerrarPendencia,
  listarHistorico, interpretarSimNao,
} = require(path.join(__dirname, '..', 'scripts', 'lib', 'retiradas'));

function backup(caminho) {
  const guardado = fs.existsSync(caminho) ? fs.readFileSync(caminho, 'utf-8') : null;
  return () => {
    if (guardado === null) { try { fs.unlinkSync(caminho); } catch (e) { /* já não existe */ } }
    else fs.writeFileSync(caminho, guardado);
  };
}
const restaurarPendencias = backup(PENDENCIAS_PATH);
const restaurarHistorico = backup(HISTORICO_PATH);

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  if (ok) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

try {
  fs.mkdirSync(path.dirname(PENDENCIAS_PATH), { recursive: true });
  fs.writeFileSync(PENDENCIAS_PATH, '{}');
  fs.writeFileSync(HISTORICO_PATH, '');

  console.log('interpretarSimNao é restrito (não aceita "ok"/emoji como resposta)');
  conferir('"sim" -> sim', interpretarSimNao('sim') === 'sim');
  conferir('"Não." (com ponto e maiúscula) -> nao', interpretarSimNao('Não.') === 'nao');
  conferir('"ok" -> null (não é uma resposta válida)', interpretarSimNao('ok') === null);

  console.log('\nSequência completa: motivo -> comprovante sim -> foto');
  abrirPendencia('vila-mariana', { valorRetirada: 109, complementoId: 'c1', unidadeNome: 'Vila Mariana', grupoId: '1@g.us' });
  {
    const p = buscarPendencia('vila-mariana');
    conferir('estado inicial é aguardando_motivo', p.estado === 'aguardando_motivo', p.estado);
  }
  atualizarPendencia('vila-mariana', { estado: 'aguardando_comprovante', motivo: 'compra de peça' });
  {
    const p = buscarPendencia('vila-mariana');
    conferir('motivo gravado e estado avançou', p.motivo === 'compra de peça' && p.estado === 'aguardando_comprovante', JSON.stringify(p));
  }
  const registroFinal = encerrarPendencia('vila-mariana', { comprovante: 'data/comprovantes-retirada/vila-mariana/123.jpg' });
  conferir('registro final carrega motivo e comprovante', registroFinal.motivo === 'compra de peça' && registroFinal.comprovante.endsWith('.jpg'), JSON.stringify(registroFinal));
  conferir('pendência removida depois de encerrada', buscarPendencia('vila-mariana') === null);
  conferir('foi para o histórico', listarHistorico({ unidadeId: 'vila-mariana' }).length === 1);

  console.log('\nSequência sem comprovante: motivo -> não');
  abrirPendencia('argentina-mall', { valorRetirada: 50, complementoId: 'c2', unidadeNome: 'Argentina Mall', grupoId: '2@g.us' });
  atualizarPendencia('argentina-mall', { estado: 'aguardando_comprovante', motivo: 'vale funcionário' });
  const semComprovante = encerrarPendencia('argentina-mall', { comprovante: null });
  conferir('registrado sem comprovante, sem travar', semComprovante.comprovante === null && semComprovante.motivo === 'vale funcionário', JSON.stringify(semComprovante));

  console.log('\nUnidades diferentes não se misturam (pendência de uma não vaza pra outra)');
  abrirPendencia('norte', { valorRetirada: 10, complementoId: 'c3', unidadeNome: 'Norte', grupoId: '3@g.us' });
  {
    const norte = buscarPendencia('norte');
    const vila = buscarPendencia('vila-mariana'); // já foi encerrada acima
    conferir('norte tem pendência própria', norte && norte.estado === 'aguardando_motivo');
    conferir('vila-mariana não tem mais pendência (já resolvida)', vila === null);
  }

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
} finally {
  restaurarPendencias();
  restaurarHistorico();
}

process.exit(falhas ? 1 : 0);
