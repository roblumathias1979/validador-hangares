#!/usr/bin/env node
// Uso: node scripts/identificar-hangar.js <grupoWhatsappId> [hangarIdDireto]
//
// Descobre de qual hangar é uma mensagem, a partir do GRUPO de WhatsApp de
// onde ela veio. O número de WhatsApp que recebe os tickets é o MESMO para
// todos os hangares — o grupo é a única coisa que os separa, e é ele que
// decide qual login do ValidPark será usado (cada hangar tem o seu, via
// usuarioEnvVar/senhaEnvVar em config/hangares.json).
//
// Errar essa identificação não é cosmético: valida o ticket na conta do
// hangar errado e ocupa vaga do pátio errado, com efeito financeiro.
//
// O segundo argumento (`hangarIdDireto`) existe só para teste manual, quando
// se chama o webhook com `hangarId` no corpo em vez de um grupo real — é o
// que os exemplos de curl do README fazem. Quando ele é usado, a saída marca
// `origem: "hangar_id_direto"`, para que esse desvio seja visível em vez de
// silencioso. ⚠️ Enquanto o webhook do n8n não tiver autenticação, esse
// caminho permite escolher o hangar de fora; ver a nota de segurança em
// docs/perguntas-abertas.md.
//
// Imprime UM json em stdout, no mesmo padrão dos outros scripts, para ser
// consumido por um nó "Execute Command" do n8n.

const { carregarConfig, buscarHangar, buscarHangarPorGrupo } = require('./lib/hangar');

function identificar(grupoId, hangarIdDireto) {
  const config = carregarConfig();
  const grupo = (grupoId || '').trim();
  const direto = (hangarIdDireto || '').trim();

  if (!grupo && direto) {
    const hangar = buscarHangar(config, direto); // lança se o id não existir
    return {
      status: 'hangar_identificado',
      hangarId: hangar.id,
      hangar: hangar.hangar,
      origem: 'hangar_id_direto',
      mensagem: `Hangar informado diretamente como "${hangar.id}" (sem grupo de WhatsApp) — caminho de teste manual.`,
    };
  }

  const hangar = buscarHangarPorGrupo(config, grupo);
  return {
    status: 'hangar_identificado',
    hangarId: hangar.id,
    hangar: hangar.hangar,
    grupoWhatsappId: hangar.grupoWhatsappId,
    origem: 'grupo_whatsapp',
  };
}

function main() {
  const [grupoId, hangarIdDireto] = process.argv.slice(2);
  try {
    console.log(JSON.stringify(identificar(grupoId, hangarIdDireto)));
  } catch (erro) {
    // Grupo não cadastrado é problema de configuração, não do cliente: ele não
    // tem como resolver, então a administração precisa ser avisada.
    console.log(JSON.stringify({
      status: 'hangar_nao_identificado',
      grupoWhatsappId: (grupoId || '').trim() || null,
      mensagem: erro.message,
      mensagemWhatsapp: '⚠️ Não consegui identificar de qual hangar é esta mensagem. Nossa equipe foi avisada e vai verificar.',
      notificarAdmin: true,
    }));
    // Sai com 0 DE PROPÓSITO, mesmo em falha: quem decide o que fazer é o nó
    // seguinte do n8n, lendo o campo `status` do json. Sair com código != 0
    // faria o resultado depender de como o nó "Execute Command" trata código
    // de saída — comportamento que não está verificado neste projeto — e a
    // mensagem se perderia antes de chegar ao Code node.
    // (Os outros dois scripts ainda usam process.exit(1) em erro; vale
    // conferir se o nó deles engole o json nesse caso. Anotado nos docs.)
  }
}

if (require.main === module) {
  main();
}

module.exports = { identificar };
