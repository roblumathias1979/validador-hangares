#!/usr/bin/env node
/**
 * O pedido aberto vence em 5 minutos.
 *
 * O pedido é uma AUTORIZAÇÃO: enquanto existe, a próxima foto daquela pessoa
 * naquele grupo vale como foto do veículo e pode validar um ticket. O prazo é o
 * que limita essa janela, então ele merece teste — um erro aqui não quebra
 * nada visivelmente, só deixa a autorização aberta mais tempo do que se pensa.
 *
 * O arquivo de estado é real: o teste guarda e devolve.
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const ARQUIVO = path.join(RAIZ, 'data', 'pendencias.json');
const guardado = fs.existsSync(ARQUIVO) ? fs.readFileSync(ARQUIVO, 'utf-8') : null;
const restaurar = () => {
  if (guardado === null) { try { fs.unlinkSync(ARQUIVO); } catch (e) { /* já não existe */ } }
  else fs.writeFileSync(ARQUIVO, guardado);
};

const pendencias = require(path.join(RAIZ, 'scripts', 'lib', 'pendencias.js'));

const GRUPO = '120363430127934870@g.us';
const PESSOA = '5511999999999@s.whatsapp.net';

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  if (ok) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

// Envelhece o pedido mexendo em criadoEm: esperar de verdade custaria 5
// minutos de teste, e o que importa é a regra, não o relógio.
function envelhecer(minutos) {
  const estado = JSON.parse(fs.readFileSync(ARQUIVO, 'utf-8'));
  for (const k of Object.keys(estado)) estado[k].criadoEm -= minutos * 60 * 1000;
  fs.writeFileSync(ARQUIVO, JSON.stringify(estado));
}

try {
  fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
  fs.writeFileSync(ARQUIVO, '{}');

  conferir('a validade é de 5 minutos', pendencias.VALIDADE_MS === 5 * 60 * 1000,
    `são ${pendencias.VALIDADE_MS / 60000} min`);

  pendencias.registrar(GRUPO, PESSOA, { ticket: '011609000001', hangarId: 'aibm', tipo: 'foto_local' });
  conferir('recém-criado está aberto', (pendencias.buscar(GRUPO, PESSOA) || {}).ticket === '011609000001');

  envelhecer(4);
  conferir('com 4 minutos ainda vale', pendencias.buscar(GRUPO, PESSOA) !== null);

  envelhecer(2); // total: 6 minutos
  conferir('com 6 minutos já venceu', pendencias.buscar(GRUPO, PESSOA) === null);
  conferir('vencido não pode ser consumido', pendencias.consumir(GRUPO, PESSOA) === null);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
} finally {
  restaurar();
}

process.exit(falhas ? 1 : 0);
