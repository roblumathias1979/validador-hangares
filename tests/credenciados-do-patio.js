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
const CREDENCIADOS = [
  { CARTAO: '5150185', USUARIO: 'HANGAR 1 JOAO BATISTA', DATAHORA: '2026-09-29T03:49:46', PLACA: '', GRUPO: 'HANGAR1', BOLSAO: 'HANGAR-1' },
  { CARTAO: '9613365', USUARIO: 'HANGAR 1', DATAHORA: '2026-09-28T16:30:32', PLACA: '', GRUPO: 'HANGAR1', BOLSAO: 'HANGAR-1' },
  { CARTAO: '9440971', USUARIO: 'SOLOJET JUMPER ABC1D23', DATAHORA: '2026-09-28T11:43:46', PLACA: '', GRUPO: 'HANGAR SOLOJET', BOLSAO: 'HANGAR SOLOJET' },
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
  conferir('mantém a contagem do ValidPark', /Credenciados no pátio agora: \*2\*/.test(m), m);

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
  conferir('e continua dando a contagem', /Credenciados no pátio agora/.test(semFoto));

  console.log('\nPátio sem vínculo configurado');
  escrever(1);
  const semVinculo = montarMensagemCredenciados({ id: 'x', hangar: 'X', bolsaoTechparking: '' }, CONTAGEM);
  conferir('não afirma que não há credenciados', !/Nenhum credenciado/.test(semVinculo), semVinculo);
  conferir('pede a configuração', /informar o bolsão/i.test(semVinculo), semVinculo);

  console.log('\nPátio ligado, mas sem ninguém dentro');
  const vazio = montarMensagemCredenciados({ id: 'y', hangar: 'Y', bolsaoTechparking: 'CONCORDE' }, { ...CONTAGEM, credenciados: 0 });
  conferir('afirma com segurança que não há', /Nenhum credenciado neste pátio/.test(vazio), vazio);

  console.log('\nQuando as duas fontes discordam, o bot conta');
  const discorda = montarMensagemCredenciados(HANGAR_1, { ...CONTAGEM, credenciados: 7 });
  conferir('mostra a divergência', /ValidPark conta 7 e esta lista tem 2/.test(discorda), discorda);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
} finally {
  devolver();
}

process.exit(falhas ? 1 : 0);
