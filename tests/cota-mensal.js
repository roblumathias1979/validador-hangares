#!/usr/bin/env node
/**
 * Teto de 20 validações por mês no VOASP, renovando sozinho na virada.
 *
 * O ponto que merece teste não é contar até 20 — é a VIRADA. A renovação é
 * automática porque a contagem é por mês de calendário sobre o próprio
 * histórico: não existe contador a zerar, o mês simplesmente vira. Se isso
 * estiver errado, o hangar fica travado no dia 1º e ninguém entende por quê.
 *
 * E o fuso importa: o servidor roda em UTC e o aeroporto em São Paulo. Sem
 * tratar isso, das 21h do último dia do mês em diante a cota já teria virado,
 * dando três horas de cota nova antes da hora.
 *
 * O histórico é real: o teste guarda e devolve.
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const HISTORICO = path.join(RAIZ, 'data', 'validacoes.jsonl');
const guardado = fs.existsSync(HISTORICO) ? fs.readFileSync(HISTORICO, 'utf-8') : null;
const restaurar = () => {
  if (guardado === null) { try { fs.unlinkSync(HISTORICO); } catch (e) { /* já não existe */ } }
  else fs.writeFileSync(HISTORICO, guardado);
};

const cota = require(path.join(RAIZ, 'scripts', 'lib', 'cota-mensal.js'));

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  if (ok) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

// Escreve `quantas` validações do hangar no instante dado.
function gravar(hangarId, quantas, iso) {
  const linhas = Array.from({ length: quantas }, (_, i) =>
    JSON.stringify({ em: iso, hangarId, status: 'validado', ticket: `0116090000${String(i).padStart(2, '0')}` }));
  fs.appendFileSync(HISTORICO, linhas.join('\n') + '\n');
}

const VOASP = { id: 'voasp', hangar: 'VOASP', cotaMensalValidacoes: 20 };

try {
  fs.mkdirSync(path.dirname(HISTORICO), { recursive: true });
  fs.writeFileSync(HISTORICO, '');

  console.log('Sem cota configurada: nunca bloqueia');
  const semCota = cota.situacao({ id: 'solojet' });
  conferir('não tem teto', semCota.temCota === false);
  conferir('nunca esgota', semCota.esgotada === false);

  console.log('\nContagem dentro do mês');
  const SETEMBRO = '2026-09-10T14:00:00-03:00';
  gravar('voasp', 19, SETEMBRO);
  let s = cota.situacao(VOASP, new Date(SETEMBRO));
  conferir('19 usadas, 1 restante', s.usadas === 19 && s.restantes === 1, `usadas=${s.usadas}`);
  conferir('ainda não esgotou', s.esgotada === false);
  conferir('avisa o cliente perto do fim', /Restam 1 de 20/.test(cota.notaParaCliente(s)));

  gravar('voasp', 1, SETEMBRO);
  s = cota.situacao(VOASP, new Date(SETEMBRO));
  conferir('na vigésima, esgotou', s.esgotada === true && s.restantes === 0);
  conferir('a mensagem cita o limite e o mês', /20 validações/.test(cota.mensagemEsgotada(VOASP, s)) && /2026-09/.test(cota.mensagemEsgotada(VOASP, s)));

  console.log('\nOutro hangar não gasta a cota do VOASP');
  gravar('solojet', 30, SETEMBRO);
  s = cota.situacao(VOASP, new Date(SETEMBRO));
  conferir('segue em 20 usadas', s.usadas === 20, `usadas=${s.usadas}`);

  console.log('\nVirada do mês: renova sozinha');
  const OUTUBRO = '2026-10-01T09:00:00-03:00';
  s = cota.situacao(VOASP, new Date(OUTUBRO));
  conferir('zera em outubro', s.usadas === 0 && s.restantes === 20, `usadas=${s.usadas}`);
  conferir('volta a permitir', s.esgotada === false);

  console.log('\nFuso: a virada é em São Paulo, não em UTC');
  // 01/10 00:30 UTC = 30/09 21:30 em São Paulo — ainda setembro.
  conferir('30/09 21:30 em SP ainda é setembro', cota.mesAtual('2026-10-01T00:30:00Z') === '2026-09',
    cota.mesAtual('2026-10-01T00:30:00Z'));
  const aindaSetembro = cota.situacao(VOASP, new Date('2026-10-01T00:30:00Z'));
  conferir('e a cota continua esgotada nessas 3 horas', aindaSetembro.esgotada === true);
  // 01/10 03:30 UTC = 01/10 00:30 em São Paulo — outubro.
  conferir('01/10 00:30 em SP já é outubro', cota.mesAtual('2026-10-01T03:30:00Z') === '2026-10',
    cota.mesAtual('2026-10-01T03:30:00Z'));

  console.log('\nTentativa recusada não gasta cota');
  fs.writeFileSync(HISTORICO, '');
  fs.appendFileSync(HISTORICO, JSON.stringify({ em: SETEMBRO, hangarId: 'voasp', status: 'sem_vagas', ticket: '011609000099' }) + '\n');
  conferir('sem_vagas não conta', cota.situacao(VOASP, new Date(SETEMBRO)).usadas === 0);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
} finally {
  restaurar();
}

process.exit(falhas ? 1 : 0);
