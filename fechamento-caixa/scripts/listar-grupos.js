#!/usr/bin/env node
// Uso: node scripts/listar-grupos.js
//
// Lista os grupos de WhatsApp de que o bot já participa (via Evolution API)
// e sugere, para cada um, qual unidade de config/unidades.json ele parece
// ser (casando o nome do grupo contra nome/apelidos cadastrados) — só um
// palpite para facilitar o preenchimento manual de `grupoWhatsappId`, nunca
// grava nada sozinho.
//
// PRECISA RODAR NO SERVIDOR (ou onde EVOLUTION_URL for alcançável): a
// Evolution API deste projeto é a mesma instância do validador de hangares,
// que roda no EC2, não em ambiente de desenvolvimento local.

const { listarGrupos } = require('./lib/evolution');
const { carregarConfig, buscarPorTexto } = require('./lib/unidades');

async function main() {
  let grupos;
  try {
    grupos = await listarGrupos();
  } catch (erro) {
    console.error(`Não consegui listar os grupos: ${erro.message}`);
    console.error('Confira se EVOLUTION_URL/EVOLUTION_INSTANCE/EVOLUTION_API_KEY estão preenchidos no .env deste projeto (fechamento-caixa/.env) e se este processo roda onde a Evolution é alcançável.');
    process.exitCode = 1;
    return;
  }

  const config = carregarConfig();
  const donos = new Map(
    config.unidades
      .filter((u) => (u.grupoWhatsappId || '').trim())
      .map((u) => [u.grupoWhatsappId.trim(), u])
  );

  if (!grupos.length) {
    console.log('A Evolution não devolveu nenhum grupo — confira se o número do bot já foi adicionado aos grupos de fechamento.');
    return;
  }

  console.log(`${grupos.length} grupo(s) encontrados:\n`);
  for (const g of grupos) {
    const donoAtual = donos.get(g.id);
    const sugestao = donoAtual ? null : buscarPorTexto(config, g.nome);
    const status = donoAtual
      ? `já cadastrado -> ${donoAtual.id}`
      : sugestao
      ? `sugestão: ${sugestao.id} (nome do grupo bate com "${sugestao.nome}")`
      : 'sem sugestão — nome do grupo não bate com nenhuma unidade cadastrada';
    console.log(`${g.id}  |  ${g.nome}`);
    console.log(`  ${status}\n`);
  }

  const semGrupo = config.unidades.filter((u) => !(u.grupoWhatsappId || '').trim());
  if (semGrupo.length) {
    console.log(`Unidades ainda SEM grupoWhatsappId: ${semGrupo.map((u) => u.id).join(', ')}`);
  }
}

main();
