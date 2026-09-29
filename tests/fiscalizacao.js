#!/usr/bin/env node
/**
 * Regras da fiscalização de rua: placa → pátio → mensalista e lotação.
 *
 * O snapshot imita o formato real das rotas do TECHPARKING (visto em
 * 28/09/2026), incluindo as inconsistências que o módulo precisa aguentar:
 * espaço no fim do nome do pátio, "Hangar-1" contra "HANGAR-1", placa em
 * minúscula, AAA0000 e datas sem fuso.
 *
 * Funções puras: nada de disco, nada a restaurar.
 */

const f = require('../scripts/lib/fiscalizacao');

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  if (ok) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

const REGRAS = { patiosMensalistas: ['HANGAR SOLOJET', 'ALLJET'], placasGenericas: ['AAA0000'], snapshotVelhoMinutos: 5 };
// 15:00 em Jundiaí = 18:00 UTC.
const AGORA = new Date('2026-09-28T18:00:00Z');

const snapshot = (extra = {}) => ({
  recebidoEm: '2026-09-28T17:59:00Z',
  patios: [
    { IDPATIO: 30, PATIO: 'HANGAR SOLOJET ', VAGAS: 4, VAGAS_USADAS: 2383 },
    { IDPATIO: 13, PATIO: 'ALLJET ', VAGAS: 1, VAGAS_USADAS: -18 },
    { IDPATIO: 18, PATIO: 'AIBM', VAGAS: 12, VAGAS_USADAS: 687 },
    { IDPATIO: 8, PATIO: 'HANGAR-1', VAGAS: 57, VAGAS_USADAS: 1896 },
  ],
  avulsos: [
    { CARTAO: '012809143748', USUARIO: 'HANGAR SOLOJET', DATA_ENT: '2026-09-28T14:37:56', TOLERANCIA: '2026-10-18T14:36:45', PLACA: 'Bor6666' },
    { CARTAO: '012809140554', USUARIO: 'AIBM', DATA_ENT: '2026-09-28T14:04:13', TOLERANCIA: '2026-10-18T14:04:13', PLACA: 'AIB1234' },
    { CARTAO: '012809130540', USUARIO: 'AVULSO', DATA_ENT: '2026-09-28T13:05:49', TOLERANCIA: '2026-09-28T13:20:49', PLACA: 'ROT1A11' },
    // Tolerância 14:59 local, um minuto antes de AGORA.
    { CARTAO: '012809120000', USUARIO: 'HANGAR SOLOJET', DATA_ENT: '2026-09-28T12:00:00', TOLERANCIA: '2026-09-28T14:59:00', PLACA: 'VEN9999' },
    { CARTAO: '012809110000', USUARIO: 'ALLJET ', DATA_ENT: '2026-09-28T11:00:00', TOLERANCIA: '2026-10-18T11:00:00', PLACA: 'ALJ1111' },
    { CARTAO: '012809100000', USUARIO: 'ALLJET', DATA_ENT: '2026-09-28T10:00:00', TOLERANCIA: '2026-10-18T10:00:00', PLACA: 'AAA0000' },
    { CARTAO: '012809090000', USUARIO: 'AIBM', DATA_ENT: '2026-09-28T09:00:00', TOLERANCIA: '2026-10-18T09:00:00', PLACA: 'JULI123' },
    // Digitada no formato antigo; o veículo já tem a Mercosul (ABC1234 → ABC1C34).
    { CARTAO: '012809080000', USUARIO: 'HANGAR SOLOJET', DATA_ENT: '2026-09-28T08:00:00', TOLERANCIA: '2026-10-18T08:00:00', PLACA: 'ABC-1234' },
  ],
  credenciados: [
    { CARTAO: '5152623', USUARIO: 'PLANE  ONIX GCG9175', DATAHORA: '2026-09-28T09:00:00', PLACA: '', GRUPO: 'HANGAR1', BOLSAO: 'Hangar-1' },
    { CARTAO: '12831953', USUARIO: 'SOLOJET BARBARA', DATAHORA: '2026-09-28T08:00:00', PLACA: '', GRUPO: 'HANGAR SOLOJET', BOLSAO: 'HANGAR SOLOJET ' },
    ...(extra.credenciados || []),
  ],
});

console.log('Placa');
conferir('normaliza minúscula e hífen', f.normalizarPlaca('abc-1d23') === 'ABC1D23');
conferir('recusa quatro letras', f.normalizarPlaca('JULI123') === null);
conferir('antiga e Mercosul têm a mesma chave', f.chavePlaca('ABC1234') === f.chavePlaca('ABC1C34'));
conferir('Mercosul diferente não colide', f.chavePlaca('ABC1D34') !== f.chavePlaca('ABC1234'));

console.log('\nDatas sem fuso são hora de Jundiaí');
conferir('14:59 local é 17:59 UTC', f.lerData('2026-09-28T14:59:00').toISOString() === '2026-09-28T17:59:00.000Z');

const indice = f.montarIndice(snapshot(), REGRAS);
const av = (p) => f.avaliar(p, indice, REGRAS, AGORA);

console.log('\nPátio mensalista dentro da lotação');
const bor = av('BOR6666');
conferir('regular', bor.situacao === 'regular', `veio ${bor.situacao}`);
conferir('diz o pátio', bor.patio === 'HANGAR SOLOJET');
conferir('diz a fonte', bor.vinculos[0].fonte === 'digitada');
conferir('placa antiga digitada bate com a Mercosul lida', av('ABC1C34').situacao === 'regular', `veio ${av('ABC1C34').situacao}`);

console.log('\nLotação é contada nas listas, não no VAGAS_USADAS');
conferir('Solojet: 2 tickets válidos + 1 vencido + 1 credenciado = 4', f.lotacaoDe(indice, 'HANGAR SOLOJET').ocupadas === 4,
  `veio ${f.lotacaoDe(indice, 'HANGAR SOLOJET').ocupadas}`);

console.log('\nPátio mensalista acima da lotação');
// Alljet tem 1 vaga e 2 tickets (um deles com AAA0000, que ocupa mesmo sem placa útil).
const alj = av('ALJ1111');
conferir('excedido', alj.situacao === 'excedido', `veio ${alj.situacao}`);
conferir('mostra vagas e ocupadas', alj.lotacao && alj.lotacao.vagas === 1 && alj.lotacao.ocupadas === 2);

console.log('\nPátio que não é mensalista');
const aibm = av('AIB1234');
conferir('irregular', aibm.situacao === 'irregular', `veio ${aibm.situacao}`);
conferir('motivo: deveria estar no hangar', aibm.motivo === 'fora_do_hangar' && aibm.patio === 'AIBM');

console.log('\nCredenciado com a placa no nome');
const gcg = av('GCG9175');
conferir('acha pelo nome', gcg.vinculos.length === 1 && gcg.vinculos[0].fonte === 'nome');
conferir('Hangar-1 não é mensalista', gcg.situacao === 'irregular' && gcg.motivo === 'fora_do_hangar');

console.log('\nTicket vencido e rotativo');
const ven = av('VEN9999');
conferir('vencido', ven.situacao === 'irregular' && ven.motivo === 'ticket_vencido', `veio ${ven.situacao}/${ven.motivo}`);
const rot = av('ROT1A11');
conferir('rotativo sem validação', rot.situacao === 'irregular' && rot.motivo === 'rotativo', `veio ${rot.situacao}/${rot.motivo}`);

console.log('\nPlacas que não servem');
conferir('AAA0000 não vira vínculo', av('AAA0000').situacao === 'sem_vinculo');
conferir('JULI123 conta como inválida', indice.estatisticas.ticketsPlacaInvalida === 1);
conferir('desconhecida pede conferência', av('XYZ9876').situacao === 'sem_vinculo');
conferir('leitura ruim', av('12').situacao === 'placa_invalida');

console.log('\nPlaca de cadastro vence a do nome; LPR é marcado');
const comCadastro = f.montarIndice(snapshot({ credenciados: [
  { CARTAO: '1', USUARIO: 'FULANO QQQ1111', PLACA: 'cad2b22', BOLSAO: 'ALLJET' },
  { CARTAO: '2', USUARIO: 'CICLANO', PLACA: 'LPR3C33', PLACA_LPR: true, BOLSAO: 'ALLJET' },
] }), REGRAS);
conferir('usa o campo PLACA', f.avaliar('CAD2B22', comCadastro, REGRAS, AGORA).vinculos[0]?.fonte === 'cadastro');
conferir('ignora a do nome quando há cadastro', f.avaliar('QQQ1111', comCadastro, REGRAS, AGORA).situacao === 'sem_vinculo');
conferir('fonte lpr', f.avaliar('LPR3C33', comCadastro, REGRAS, AGORA).vinculos[0]?.fonte === 'lpr');

console.log('\nDados velhos');
conferir('1 minuto não é velho', bor.dados.velho === false);
conferir('10 minutos é velho', f.avaliar('BOR6666', indice, REGRAS, new Date('2026-09-28T18:10:00Z')).dados.velho === true);
const semData = f.montarIndice({ ...snapshot(), recebidoEm: null }, REGRAS);
conferir('sem data é velho', f.avaliar('BOR6666', semData, REGRAS, AGORA).dados.velho === true);

console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
process.exitCode = falhas ? 1 : 0;
