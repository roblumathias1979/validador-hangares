const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

function carregarConfig() {
  const configPath = path.join(__dirname, '..', '..', 'config', 'hangares.json');
  if (!fs.existsSync(configPath)) {
    throw new Error(`Arquivo de configuração não encontrado: ${configPath}. Esse arquivo é versionado no repositório — se está faltando, o checkout está incompleto ou o arquivo foi apagado localmente (recupere com: git checkout -- config/hangares.json).`);
  }
  return JSON.parse(fs.readFileSync(configPath, 'utf-8'));
}

function buscarHangar(config, hangarId) {
  const hangar = config.hangares.find((h) => h.id === hangarId);
  if (!hangar) {
    throw new Error(`Hangar "${hangarId}" não encontrado em config/hangares.json`);
  }
  return hangar;
}

// Um único número de WhatsApp recebe os tickets de TODOS os hangares — o que
// separa um do outro é o GRUPO de onde a mensagem veio. Esse grupo decide qual
// login do ValidPark será usado (usuarioEnvVar/senhaEnvVar do hangar), então
// errar aqui significa validar o ticket na conta do hangar errado, ocupando
// vaga do pátio errado. Não é um erro cosmético.
//
// A fonte única do mapeamento é o campo `grupoWhatsappId` de
// config/hangares.json. Antes essa tabela vivia DUPLICADA dentro do nó
// "Identificar Hangar" do workflow do n8n, cujo comentário mandava "adicionar
// uma linha aqui E uma entrada em config/hangares.json" — a mesma duplicação
// que deixou os seletores de slider divergirem e produção sem conseguir
// validar nada.
function buscarHangarPorGrupo(config, grupoId) {
  const id = (grupoId || '').trim();
  if (!id) {
    throw new Error('ID do grupo de WhatsApp não informado — sem ele não há como saber de qual hangar é o ticket.');
  }

  // Hangar com grupoWhatsappId vazio ainda não foi cadastrado, e precisa ficar
  // fora da busca: senão um grupoId vazio casaria com ele por engano.
  const cadastrados = config.hangares.filter((h) => (h.grupoWhatsappId || '').trim());
  const achados = cadastrados.filter((h) => h.grupoWhatsappId.trim() === id);

  if (achados.length > 1) {
    throw new Error(`Grupo "${id}" está cadastrado em mais de um hangar (${achados.map((h) => h.id).join(', ')}) em config/hangares.json — cada grupo tem que pertencer a um único hangar.`);
  }
  if (achados.length === 0) {
    const conhecidos = cadastrados.length
      ? cadastrados.map((h) => `${h.id}=${h.grupoWhatsappId}`).join(', ')
      : 'nenhum hangar tem grupoWhatsappId preenchido ainda';
    throw new Error(`Grupo "${id}" não está cadastrado em config/hangares.json (grupos conhecidos: ${conhecidos}).`);
  }
  return achados[0];
}

async function login(page, hangar) {
  const seletores = hangar.seletores || {};
  const usuario = process.env[hangar.usuarioEnvVar];
  const senha = process.env[hangar.senhaEnvVar];
  if (!usuario || !senha) {
    throw new Error(`Credenciais ausentes para "${hangar.id}" (variáveis ${hangar.usuarioEnvVar} / ${hangar.senhaEnvVar}).`);
  }

  await page.goto(hangar.validadorUrl, { waitUntil: 'networkidle' });
  await page.fill(seletores.campoUsuario, usuario);
  await page.fill(seletores.campoSenha, senha);
  await page.click(seletores.botaoLogin);
  await page.waitForLoadState('networkidle');
}

module.exports = { carregarConfig, buscarHangar, buscarHangarPorGrupo, login };
