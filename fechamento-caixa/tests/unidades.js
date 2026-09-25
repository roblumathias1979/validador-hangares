#!/usr/bin/env node
/**
 * identificarUnidade (desenho de 25/09/2026: um grupo de WhatsApp por
 * unidade, igual ao validador de hangares). O grupo é AUTORITATIVO — o que
 * importa testar é que 1) grupo cadastrado sempre decide a unidade, 2) grupo
 * não cadastrado lança erro claro (config incompleta, não culpa do
 * cliente), e 3) uma foto que parece ser de outra unidade (nome impresso
 * divergente) vira ALERTA, nunca troca a unidade decidida pelo grupo.
 */

const path = require('path');
const { identificarUnidade, buscarUnidadePorGrupo } = require(path.join(__dirname, '..', 'scripts', 'lib', 'unidades'));

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  if (ok) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

const CONFIG = {
  unidades: [
    { id: 'norte', nome: 'Estacionamento Norte', apelidos: ['norte'], grupoWhatsappId: '111@g.us' },
    { id: 'sul', nome: 'Estacionamento Sul', apelidos: ['sul'], grupoWhatsappId: '222@g.us' },
  ],
};

console.log('Grupo cadastrado decide a unidade, sem precisar de mais nada');
{
  const r = identificarUnidade(CONFIG, { grupoId: '111@g.us' });
  conferir('identificada', r.status === 'identificada', r.status);
  conferir('unidade certa', r.unidade.id === 'norte');
  conferir('confiança alta só com o grupo', r.confianca === 'alta', r.confianca);
  conferir('sem alerta quando não há nome impresso pra comparar', r.alerta === null);
}

console.log('\nNome impresso concorda com o grupo -> sem alerta');
{
  const r = identificarUnidade(CONFIG, { grupoId: '222@g.us', unidadeImpressa: 'Estacionamento Sul' });
  conferir('unidade do grupo', r.unidade.id === 'sul');
  conferir('confiança alta', r.confianca === 'alta');
  conferir('sem alerta', r.alerta === null);
}

console.log('\nNome impresso é de OUTRA unidade cadastrada -> alerta, mas a unidade continua sendo a do grupo');
{
  const r = identificarUnidade(CONFIG, { grupoId: '111@g.us', unidadeImpressa: 'Estacionamento Sul' });
  conferir('unidade continua sendo a do GRUPO (norte), não a do nome impresso', r.unidade.id === 'norte', r.unidade.id);
  conferir('confiança cai para baixa', r.confianca === 'baixa', r.confianca);
  conferir('alerta presente', typeof r.alerta === 'string' && r.alerta.length > 0, r.alerta);
}

console.log('\nNome impresso não bate com NADA cadastrado -> sem alerta (não é contradição, só texto desconhecido)');
{
  const r = identificarUnidade(CONFIG, { grupoId: '111@g.us', unidadeImpressa: 'Posto Qualquer' });
  conferir('unidade do grupo', r.unidade.id === 'norte');
  conferir('sem alerta', r.alerta === null, r.alerta);
}

console.log('\nGrupo não cadastrado -> erro claro (config incompleta), não devolve unidade nenhuma');
{
  let lancou = false;
  try {
    identificarUnidade(CONFIG, { grupoId: '999@g.us' });
  } catch (erro) {
    lancou = /não está cadastrado/.test(erro.message);
  }
  conferir('lança com mensagem explicando', lancou);
}

console.log('\nbuscarUnidadePorGrupo sozinho: mesmo comportamento');
{
  conferir('acha a unidade certa', buscarUnidadePorGrupo(CONFIG, '222@g.us').id === 'sul');
  let lancou = false;
  try { buscarUnidadePorGrupo(CONFIG, ''); } catch (e) { lancou = true; }
  conferir('grupo vazio lança', lancou);
}

console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
process.exit(falhas ? 1 : 0);
