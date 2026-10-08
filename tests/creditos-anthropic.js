#!/usr/bin/env node
/**
 * Medidor de saldo estimado dos créditos da Anthropic (08/10/2026).
 *
 * A Anthropic não tem API de saldo, então o bot ESTIMA: conta o custo de cada
 * chamada (pelos tokens que a resposta traz) e subtrai do crédito que a
 * administração diz ter carregado. Protege:
 * 1. a conta de custo por modelo (tabela de preços);
 * 2. registrarUso somando gasto, tokens e o por-dia;
 * 3. definirCredito gravando o carregado e zerando o gasto (novo período);
 * 4. estado devolvendo saldo = carregado − gasto, e o alerta de saldo baixo;
 * 5. o parser de "recarreguei US$ 50" (sem confundir "recarregar sistema");
 * 6. a sentinela do monitor refletindo o saldo.
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const ARQ = path.join(RAIZ, 'data', 'uso-anthropic.json');
const guardado = fs.existsSync(ARQ) ? fs.readFileSync(ARQ, 'utf-8') : null;
process.on('exit', () => { if (guardado === null) { try { fs.unlinkSync(ARQ); } catch (e) {} } else fs.writeFileSync(ARQ, guardado); });
fs.writeFileSync(ARQ, '{}');

delete process.env.ANTHROPIC_ALERTA_USD; // usa o padrão (5), salvo onde o teste muda

const cred = require(path.join(RAIZ, 'scripts', 'lib', 'creditos-anthropic.js'));

let falhas = 0;
const perto = (a, b) => Math.abs(a - b) < 1e-9;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

console.log('1) Custo por modelo');
conferir('Haiku 5.5: 1M entrada = US$ 0,10', perto(cred.custoUsd('claude-haiku-5-5', { input_tokens: 1e6, output_tokens: 0 }).custo, 0.10));
conferir('Sonnet 5: 1M saída = US$ 10', perto(cred.custoUsd('claude-sonnet-5', { input_tokens: 0, output_tokens: 1e6 }).custo, 10));
conferir('modelo desconhecido marca aproximado', cred.custoUsd('modelo-novo-xyz', { input_tokens: 1e6, output_tokens: 0 }).aproximado === true);
conferir('sem usage custa 0', cred.custoUsd('claude-haiku-5-5', null).custo === 0);

console.log('\n2) registrarUso acumula');
fs.writeFileSync(ARQ, '{}');
cred.registrarUso({ modelo: 'claude-haiku-5-5', usage: { input_tokens: 1e6, output_tokens: 0 } }); // 0,10
cred.registrarUso({ modelo: 'claude-haiku-5-5', usage: { input_tokens: 0, output_tokens: 1e6 } }); // 0,50
let e = cred.estado();
conferir('gasto somou (0,10 + 0,50)', perto(e.gastoUsd, 0.60), String(e.gastoUsd));
conferir('contou 2 chamadas', e.chamadas === 2, String(e.chamadas));
conferir('somou tokens de entrada', e.tokensEntrada === 1e6);
conferir('registrou no por-dia de hoje', perto(e.porDia[new Date().toISOString().slice(0, 10)], 0.60));
conferir('sem crédito informado, saldo é null', e.saldoUsd === null);

console.log('\n3) definirCredito grava e zera o gasto');
cred.definirCredito(50);
e = cred.estado();
conferir('crédito = 50', e.creditoUsd === 50);
conferir('gasto zerou', e.gastoUsd === 0);
conferir('saldo = 50', e.saldoUsd === 50);

console.log('\n4) gasto some do saldo');
cred.registrarUso({ modelo: 'claude-sonnet-5', usage: { input_tokens: 1e6, output_tokens: 1e6 } }); // 2 + 10 = 12
e = cred.estado();
conferir('gasto = 12', perto(e.gastoUsd, 12), String(e.gastoUsd));
conferir('saldo = 38', perto(e.saldoUsd, 38), String(e.saldoUsd));
conferir('não está baixo (limite 5)', cred.estaBaixo() === false);

console.log('\n5) alerta de saldo baixo');
cred.definirCredito(3); // abaixo do limite padrão (5)
conferir('estaBaixo = true', cred.estaBaixo() === true);
process.env.ANTHROPIC_ALERTA_USD = '1';
conferir('limite configurável: 3 > 1, não baixo', cred.estaBaixo() === false);
delete process.env.ANTHROPIC_ALERTA_USD;

console.log('\n6) parser de "recarreguei US$ X"');
conferir('US$ 50', cred.valorRecargaDoTexto('recarreguei US$ 50') === 50);
conferir('$50', cred.valorRecargaDoTexto('coloquei $50 de credito') === 50);
conferir('50 dolares', cred.valorRecargaDoTexto('recarreguei 50 dolares') === 50);
conferir('100 usd', cred.valorRecargaDoTexto('adicionei 100 usd') === 100);
conferir('número solto em frase de recarga', cred.valorRecargaDoTexto('recarreguei 75') === 75);
conferir('"recarregar sistema" NÃO vira valor', cred.valorRecargaDoTexto('recarregar sistema') === null);
conferir('"status do sistema" NÃO vira valor', cred.valorRecargaDoTexto('status do sistema') === null);
conferir('decimal com vírgula', cred.valorRecargaDoTexto('recarreguei US$ 49,90') === 49.90);

console.log('\n7) sentinela do monitor reflete o saldo (sem alarmar, saldo alto)');
(async () => {
  fs.writeFileSync(ARQ, '{}');
  cred.definirCredito(100);
  cred.registrarUso({ modelo: 'claude-haiku-5-5', usage: { input_tokens: 1e6, output_tokens: 0 } }); // 0,10
  const monitor = require(path.join(RAIZ, 'scripts', 'monitor-saude.js'));
  const atual = { em: new Date().toISOString() };
  await monitor.acompanharCreditos(null, atual);
  conferir('guardou o saldo no estado do monitor', perto(atual.creditos.saldoUsd, 99.90), String(atual.creditos && atual.creditos.saldoUsd));
  conferir('não marcou aviso (saldo alto)', !atual.creditos.ultimoAvisoEm);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
  process.exit(falhas ? 1 : 0);
})();
