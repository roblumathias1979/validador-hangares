#!/usr/bin/env node
// Uso: node scripts/consultar-cota-fora-prazo.js <hangarId>
// Responde quantas validações fora do prazo de 2h ainda restam este mês
// para o hangar (ver scripts/lib/cota-fora-prazo.js e a seção sobre
// faturamento em docs/perguntas-abertas.md). Não mexe em nada — só leitura.
//
// Pensado para a opção "quantos tickets ainda posso liberar fora do prazo"
// do menu do bot no WhatsApp.

const { carregarConfig, buscarHangar } = require('./lib/hangar');
const { obterRestante, COTA_PADRAO } = require('./lib/cota-fora-prazo');

function consultarCotaForaPrazo(hangarId) {
  const config = carregarConfig();
  const hangar = buscarHangar(config, hangarId);

  const total = Number.isFinite(hangar.cotaMensalForaPrazo) ? hangar.cotaMensalForaPrazo : COTA_PADRAO;
  const restante = obterRestante(hangar);

  return {
    status: 'consulta_cota_ok',
    hangar: hangarId,
    restante,
    total,
    mensagemWhatsapp: restante > 0
      ? `ℹ️ Restam ${restante} de ${total} validações fora do prazo de 2h disponíveis este mês para este hangar.`
      : `⚠️ A cota de ${total} validações fora do prazo de 2h deste mês já acabou. Um ticket fora do prazo agora precisa de faturamento (ver docs/perguntas-abertas.md).`,
  };
}

function main() {
  const [hangarId] = process.argv.slice(2);
  if (!hangarId) {
    console.error('Uso: node scripts/consultar-cota-fora-prazo.js <hangarId>');
    process.exit(1);
  }

  try {
    console.log(JSON.stringify(consultarCotaForaPrazo(hangarId)));
  } catch (erro) {
    console.log(JSON.stringify({
      status: 'erro',
      hangar: hangarId,
      mensagem: erro.message,
      mensagemWhatsapp: '⚠️ Não conseguimos consultar a cota de validações fora do prazo no momento. Nossa equipe foi avisada.',
      notificarAdmin: true,
    }));
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = { consultarCotaForaPrazo };
