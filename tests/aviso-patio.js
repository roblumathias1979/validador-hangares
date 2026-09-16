#!/usr/bin/env node
/**
 * Regras do aviso de pátio: avisa a partir de 5 vagas, reavisa a cada 3h.
 *
 * Testa a TRAVESSIA, que é o que o módulo tem de não óbvio — avisar toda vez
 * que lê geraria uma enxurrada, e avisar só uma vez esconderia a piora.
 *
 * O estado é um arquivo real, então o teste guarda o que havia e devolve no
 * fim. Sem isso, rodar o teste apagaria o histórico de avisos e o hangar que
 * já tinha sido avisado receberia tudo de novo.
 */

const fs = require('fs');
const path = require('path');

const ARQUIVO = path.join(__dirname, '..', 'data', 'aviso-patio.json');
const anterior = fs.existsSync(ARQUIVO) ? fs.readFileSync(ARQUIVO, 'utf-8') : null;
const restaurar = () => {
  if (anterior === null) { try { fs.unlinkSync(ARQUIVO); } catch (e) { /* já não existe */ } }
  else fs.writeFileSync(ARQUIVO, anterior);
};

const aviso = require('../scripts/lib/aviso-patio');

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  if (ok) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

// Cada caso usa um hangar próprio: o estado é por hangar, e reaproveitar um id
// faria um caso interferir no seguinte.
const h = (id) => ({ id, hangar: id });

try {
  fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
  fs.writeFileSync(ARQUIVO, '{}');

  console.log('Limite: avisa a partir de 5 vagas livres');
  conferir('6 vagas não avisa', aviso.avaliar(h('t1'), 6, 40) === null);
  conferir('5 vagas avisa', (aviso.avaliar(h('t2'), 5, 40) || {}).acao === 'quase_cheio');
  conferir('1 vaga avisa', (aviso.avaliar(h('t3'), 1, 40) || {}).acao === 'quase_cheio');
  conferir('0 vagas é lotado', (aviso.avaliar(h('t4'), 0, 40) || {}).acao === 'lotado');
  conferir('vagas negativas são lotado', (aviso.avaliar(h('t5'), -1, 37) || {}).acao === 'lotado');
  conferir('limite vale para pátio pequeno', aviso.limiteDe({ totalVagas: 12 }) === 5);
  conferir('limite vale para pátio grande', aviso.limiteDe({ totalVagas: 90 }) === 5);
  conferir('ajuste por hangar continua valendo', aviso.limiteDe({ avisarVagasAbaixoDe: 8 }) === 8);

  console.log('\nTravessia: avisa na mudança, não a cada leitura');
  conferir('primeira vez avisa', (aviso.avaliar(h('t6'), 4, 40) || {}).acao === 'quase_cheio');
  conferir('segunda leitura igual fica calada', aviso.avaliar(h('t6'), 4, 40) === null);
  conferir('piorar para lotado avisa de novo', (aviso.avaliar(h('t6'), 0, 40) || {}).acao === 'lotado');
  conferir('continuar lotado fica calado', aviso.avaliar(h('t6'), 0, 40) === null);
  conferir('normalizar avisa', (aviso.avaliar(h('t6'), 20, 40) || {}).acao === 'normalizou');
  conferir('normal seguido fica calado', aviso.avaliar(h('t6'), 20, 40) === null);

  console.log('\nReaviso a cada 3 horas enquanto continuar baixo');
  conferir('constante de reaviso é 3h', aviso.REAVISO_MS === 3 * 3600 * 1000);
  aviso.avaliar(h('t7'), 3, 40);
  conferir('logo depois não repete', aviso.avaliar(h('t7'), 3, 40) === null);
  // Envelhece o último aviso em 3h01 e confirma que volta a falar.
  const estado = JSON.parse(fs.readFileSync(ARQUIVO, 'utf-8'));
  estado.t7.avisadoEm = new Date(Date.now() - (3 * 3600 * 1000 + 60000)).toISOString();
  fs.writeFileSync(ARQUIVO, JSON.stringify(estado));
  conferir('passadas 3h, reavisa', (aviso.avaliar(h('t7'), 3, 40) || {}).acao === 'quase_cheio');

  console.log('\nSimulação não grava');
  const antesSim = fs.readFileSync(ARQUIVO, 'utf-8');
  aviso.avaliar(h('t8'), 1, 40, { persistir: false });
  conferir('estado intacto após simular', fs.readFileSync(ARQUIVO, 'utf-8') === antesSim);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
} finally {
  restaurar();
}

process.exit(falhas ? 1 : 0);
