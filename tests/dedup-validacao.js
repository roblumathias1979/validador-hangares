#!/usr/bin/env node
/**
 * Dedup da fila de validações: o mesmo ticket não pode entrar (nem validar)
 * duas vezes. Protege contra o webhook gêmeo que, na contingência, chegou a
 * validar o mesmo ticket duas vezes (01/10/2026). O que este teste garante:
 *
 * 1. Enfileirar o mesmo ticket já pendente devolve a MESMA validação (jaExistia).
 * 2. Uma validação que FALHOU não bloqueia — re-tentar cria uma nova.
 * 3. Tickets diferentes seguem independentes.
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
require('./cenario').montar({}); // traz a trava de "não rodar ao vivo"

const EXTRA = ['data/validacoes-pendentes.json'];
const guardado = {};
for (const a of EXTRA) { const p = path.join(RAIZ, a); guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; }
process.on('exit', () => { for (const a of EXTRA) { const p = path.join(RAIZ, a); if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) {} } else fs.writeFileSync(p, guardado[a]); } });
for (const a of EXTRA) fs.writeFileSync(path.join(RAIZ, a), '{}');

const fila = require(path.join(RAIZ, 'scripts', 'lib', 'validacoes-pendentes.js'));

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

console.log('Mesmo ticket pendente: reaproveita, não duplica');
const a1 = fila.enfileirar({ ticket: 'DUP1', hangarId: 'solojet', motivo: 'contingencia' });
const a2 = fila.enfileirar({ ticket: 'DUP1', hangarId: 'solojet', motivo: 'contingencia' });
conferir('segundo diz que já existia', a2.jaExistia === true);
conferir('é a mesma validação (mesma id)', a1.id === a2.id, `${a1.id} vs ${a2.id}`);
conferir('só um item na fila para o ticket', fila.listar().filter((v) => v.ticket === 'DUP1').length === 1);

console.log('\nMesmo ticket em processamento: ainda dedup');
fila.retirarParaProcessar(); // marca DUP1 como processando
const a3 = fila.enfileirar({ ticket: 'DUP1', hangarId: 'solojet', motivo: 'contingencia' });
conferir('dedup enquanto processa', a3.jaExistia === true && a3.id === a1.id);

console.log('\nValidação que FALHOU não bloqueia nova tentativa');
fila.registrarResultado(a1.id, { ok: false, codigo: 500, resposta: 'erro' });
const a4 = fila.enfileirar({ ticket: 'DUP1', hangarId: 'solojet', motivo: 'contingencia' });
conferir('falha libera re-tentar (nova id)', !a4.jaExistia && a4.id !== a1.id, JSON.stringify({ jaExistia: a4.jaExistia }));

console.log('\nSucesso recente dedup; ticket diferente é independente');
const b1 = fila.enfileirar({ ticket: 'DUP2', hangarId: 'alljet', motivo: 'contingencia' });
fila.retirarParaProcessar();
fila.registrarResultado(b1.id, { ok: true, codigo: 200, resposta: 'ok' });
const b2 = fila.enfileirar({ ticket: 'DUP2', hangarId: 'alljet', motivo: 'contingencia' });
conferir('não re-valida um sucesso recente', b2.jaExistia === true && b2.id === b1.id);
const c1 = fila.enfileirar({ ticket: 'OUTRO', hangarId: 'alljet', motivo: 'contingencia' });
conferir('ticket diferente entra normal', !c1.jaExistia && c1.ticket === 'OUTRO');

console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
process.exit(falhas ? 1 : 0);
