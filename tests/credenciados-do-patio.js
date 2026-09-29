#!/usr/bin/env node
/**
 * "Quais são os credenciados no pátio?" — a lista vem do TECHPARKING.
 *
 * O ValidPark só mostra a CONTAGEM; a lista nunca existiu ali. Ela vem da API
 * do aeroporto, por uma ponte que pode não estar de pé — e é isso que este
 * teste protege: cada estado do dado tem uma resposta própria, e mostrar uma
 * lista velha é o pior deles.
 *
 * Uma lista de meia hora atrás faz quem pergunta quem está no pátio AGORA
 * decidir errado achando que está informado.
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const ARQ = path.join(RAIZ, 'data', 'techparking-snapshot.json');
const guardado = fs.existsSync(ARQ) ? fs.readFileSync(ARQ, 'utf-8') : null;
const devolver = () => {
  if (guardado === null) { try { fs.unlinkSync(ARQ); } catch (e) { /* já não existe */ } }
  else fs.writeFileSync(ARQ, guardado);
};
process.on('exit', devolver);

const { montarMensagemCredenciados } = require(path.join(RAIZ, 'scripts', 'consultar-patio.js'));

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  if (ok) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

// Registros na forma exata da API do aeroporto.
// As datas do TECHPARKING vêm SEM FUSO e são hora de Jundiaí. Relativas a
// agora, para o teste não depender do calendário: uma entrada de hoje cedo e
// outra de dias atrás, que é a diferença que a mensagem precisa mostrar.
const semFuso = (msAtras) => {
  const d = new Date(Date.now() - msAtras);
  const p = (n) => String(n).padStart(2, '0');
  // Formata em horário de São Paulo, que é como a API do aeroporto escreve.
  const [data, hora] = d.toLocaleString('sv-SE', { timeZone: 'America/Sao_Paulo' }).split(' ');
  return `${data}T${hora}`;
};
const HA_3_HORAS = semFuso(3 * 3600 * 1000);
const HA_5_DIAS = semFuso(5 * 24 * 3600 * 1000);

const CREDENCIADOS = [
  { CARTAO: '5150185', USUARIO: 'HANGAR 1 JOAO BATISTA', DATAHORA: HA_3_HORAS, PLACA: '', GRUPO: 'HANGAR1', BOLSAO: 'HANGAR-1' },
  { CARTAO: '9613365', USUARIO: 'HANGAR 1', DATAHORA: HA_5_DIAS, PLACA: '', GRUPO: 'HANGAR1', BOLSAO: 'HANGAR-1' },
  { CARTAO: '9440971', USUARIO: 'SOLOJET JUMPER ABC1D23', DATAHORA: HA_3_HORAS, PLACA: '', GRUPO: 'HANGAR SOLOJET', BOLSAO: 'HANGAR SOLOJET' },
];
const escrever = (minutosAtras) => fs.writeFileSync(ARQ, JSON.stringify({
  recebidoEm: new Date(Date.now() - minutosAtras * 60 * 1000).toISOString(),
  patios: [], avulsos: [], credenciados: CREDENCIADOS,
}));

const HANGAR_1 = { id: 'hangar-1', hangar: 'Hangar 1', bolsaoTechparking: 'HANGAR-1' };
const CONTAGEM = { credenciados: 2, utilizadas: 5, tickets: 3, doCache: false };

try {
  console.log('Foto fresca: responde a lista que o ValidPark nunca teve');
  escrever(1);
  const m = montarMensagemCredenciados(HANGAR_1, CONTAGEM);
  conferir('lista os nomes', /HANGAR 1 JOAO BATISTA/.test(m), m);
  conferir('mostra a placa quando está no nome', /ABC1D23/.test(m) === false, 'não deve trazer o do Solojet');
  conferir('não traz credenciado de outro pátio', !/JUMPER/.test(m));
  conferir('mantém a contagem do ValidPark', /2 credenciados/.test(m), m);

  console.log('\nDesde quando cada um está no pátio');
  conferir('mostra o tempo decorrido', /3h\)/.test(m), m);
  // Quem está há dias precisa da DATA: só a hora faria parecer que chegou hoje.
  conferir('quem chegou hoje mostra só a hora', /\(desde \d{2}:\d{2}, 3h\)/.test(m), m);
  conferir('quem está há dias mostra a data', /\(desde \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}, 5d\)/.test(m), m);

  console.log('\nFoto velha: diz que está velha em vez de mostrar');
  escrever(45);
  const velha = montarMensagemCredenciados(HANGAR_1, CONTAGEM);
  conferir('não lista', !/JOAO BATISTA/.test(velha));
  conferir('avisa a defasagem', /desatualizada/i.test(velha), velha);
  conferir('diz de quanto tempo', /4[0-9] min/.test(velha), velha);

  console.log('\nSem foto nenhuma: a ponte ainda não enviou');
  try { fs.unlinkSync(ARQ); } catch (e) { /* já não existe */ }
  const semFoto = montarMensagemCredenciados(HANGAR_1, CONTAGEM);
  conferir('explica que não chegou', /ainda não chegou/i.test(semFoto), semFoto);
  conferir('e continua dando a contagem', /2 credenciados/.test(semFoto), semFoto);

  console.log('\nPátio sem vínculo configurado');
  escrever(1);
  const semVinculo = montarMensagemCredenciados({ id: 'x', hangar: 'X', bolsaoTechparking: '' }, CONTAGEM);
  conferir('não afirma que não há credenciados', !/Nenhum credenciado/.test(semVinculo), semVinculo);
  conferir('pede a configuração', /informar o bolsão/i.test(semVinculo), semVinculo);

  console.log('\nPátio ligado, mas sem ninguém dentro');
  const vazio = montarMensagemCredenciados({ id: 'y', hangar: 'Y', bolsaoTechparking: 'CONCORDE' }, { ...CONTAGEM, credenciados: 0 });
  conferir('afirma com segurança que não há', /Nenhum credenciado neste pátio/.test(vazio), vazio);

  console.log('\nDivergência pequena é normal e não vira aviso');
  // Um carro entrando entre a leitura do site e a foto do aeroporto já produz
  // diferença de 1. Avisar disso todo dia ensina a ignorar o aviso.
  for (const n of [1, 2, 3, 4]) {
    const m2 = montarMensagemCredenciados(HANGAR_1, { ...CONTAGEM, credenciados: n });
    const avisou = /Diferença grande demais/.test(m2);
    const esperado = Math.abs(n - 2) >= 3;
    conferir(`ValidPark ${n} x lista 2 -> ${esperado ? 'avisa' : 'silêncio'}`, avisou === esperado, m2);
  }

  console.log('\nDivergência grande vira aviso');
  const discorda = montarMensagemCredenciados(HANGAR_1, { ...CONTAGEM, credenciados: 7 });
  conferir('mostra os dois números', /ValidPark conta 7 e esta lista tem 2/.test(discorda), discorda);
  conferir('e diz que vale conferir', /vale conferir/.test(discorda));

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
} finally {
  devolver();
}

process.exit(falhas ? 1 : 0);
