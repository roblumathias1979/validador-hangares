#!/usr/bin/env node
/**
 * O canal de validações: bot enfileira, coletor puxa, resultado volta.
 *
 * A validação de ticket vencido roda no aeroporto, não aqui — então a fila é
 * como o bot e o coletor conversam. O que este teste protege:
 *
 * 1. Uma validação puxada NÃO é puxada de novo (senão o mesmo ticket valida
 *    duas vezes, que é o erro que o projeto inteiro combate).
 * 2. Uma entrega cujo resultado se perdeu VOLTA à fila — melhor repetir que
 *    dar por feito o que não foi.
 * 3. O resultado marca a validação e guarda o grupo a avisar.
 *
 * O arquivo da fila é real: o teste guarda e devolve.
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const fila = require(path.join(RAIZ, 'scripts', 'lib', 'validacoes-pendentes.js'));
const ARQ = fila.ARQUIVO;
const guardado = fs.existsSync(ARQ) ? fs.readFileSync(ARQ, 'utf-8') : null;
const devolver = () => {
  if (guardado === null) { try { fs.unlinkSync(ARQ); } catch (e) { /* já não existe */ } }
  else fs.writeFileSync(ARQ, guardado);
};
process.on('exit', devolver);

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  if (ok) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

try {
  fs.writeFileSync(ARQ, '{}');

  console.log('Enfileirar e puxar');
  const v = fila.enfileirar({ ticket: '012809072451', grupoId: 'g@g.us', hangarId: 'aibm', motivo: 'cota' });
  conferir('nasce pendente', v.estado === 'pendente');
  const primeira = fila.retirarParaProcessar();
  conferir('o coletor recebe a validação', primeira.length === 1 && primeira[0].ticket === '012809072451');

  console.log('\nNão entrega a mesma duas vezes');
  const segunda = fila.retirarParaProcessar();
  conferir('a segunda leitura vem vazia', segunda.length === 0, `veio ${segunda.length}`);

  console.log('\nResultado marca como feito e sabe o grupo');
  const marcada = fila.registrarResultado(v.id, { ok: true, codigo: 200, resposta: 'ok' });
  conferir('vira feito', marcada.estado === 'feito');
  conferir('guardou o grupo a avisar', marcada.grupoId === 'g@g.us');
  conferir('sai da fila do coletor', fila.retirarParaProcessar().length === 0);

  console.log('\nEntrega perdida volta à fila depois do tempo de reentrega');
  const v2 = fila.enfileirar({ ticket: '012809081706', grupoId: 'g@g.us' });
  fila.retirarParaProcessar(); // entrega, marca processando, mas "ninguém reporta"
  conferir('não volta enquanto é recente', fila.retirarParaProcessar().length === 0);
  // Envelhece a entrega além do limite de reentrega.
  const todas = JSON.parse(fs.readFileSync(ARQ, 'utf-8'));
  todas[v2.id].entregueEm = new Date(Date.now() - fila.REENTREGA_MS - 1000).toISOString();
  fs.writeFileSync(ARQ, JSON.stringify(todas));
  const revolta = fila.retirarParaProcessar();
  conferir('resposta perdida reentra na fila', revolta.length === 1 && revolta[0].id === v2.id);

  console.log('\nSimulação viaja no pedido');
  const sim = fila.enfileirar({ ticket: '012809091027', simular: true });
  conferir('marca de simulação preservada', fila.retirarParaProcessar().find(x => x.id === sim.id).simular === true);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
} finally {
  devolver();
}

process.exit(falhas ? 1 : 0);
