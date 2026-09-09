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

module.exports = { carregarConfig, buscarHangar, login };
