const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env') });

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'hangares.json');

function carregarConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Arquivo de configuração não encontrado: ${CONFIG_PATH}. Esse arquivo é versionado no repositório — se está faltando, o checkout está incompleto ou o arquivo foi apagado localmente (recupere com: git checkout -- config/hangares.json).`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

// Persiste o customerId do Asaas criado na hora (ver scripts/lib/asaas.js —
// hangar sem cadastro prévio, dados cadastrais informados pelo cliente na
// autorização de faturamento) de volta em config/hangares.json, pra não
// precisar pedir CNPJ/razão social de novo da próxima vez que esse hangar
// precisar faturar.
function salvarAsaasCustomerId(hangarId, customerId) {
  const config = carregarConfig();
  const hangar = config.hangares.find((h) => h.id === hangarId);
  if (!hangar) return;
  hangar.asaas = hangar.asaas || {};
  hangar.asaas.customerId = customerId;
  fs.writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
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

  // O clique NÃO navega pra uma página nova — é um SPA (React): o resultado
  // do login chega por uma chamada assíncrona (POST /api-token-auth/ + GETs
  // de /tickets e /patios) que troca a tela via re-render, sem disparar
  // evento de navegação. `waitForLoadState('networkidle')` (usado aqui antes)
  // é uma CORRIDA nesse cenário — CONFIRMADO de verdade em 12/09/2026: um
  // login do hangar "indaia" com token emitido e dados reais do pátio
  // retornados foi lido como "usuário ou senha incorretos" porque o texto da
  // tela foi checado antes do React re-renderizar com o resultado real.
  // Por isso esperamos por um sinal explícito — o painel carregado (mesmo
  // elemento usado para ler vagas disponíveis) OU a mensagem de erro
  // ficando VISÍVEL (diferente de só existir no DOM: a mensagem de erro já
  // vem estática no HTML da tela de login, escondida via CSS, e
  // `textContent()` não distingue isso — só waitForSelector, que respeita
  // visibilidade por padrão, evita o falso positivo).
  const resultado = await Promise.race([
    page.waitForSelector(seletores.areaVagasDisponiveis, { state: 'visible', timeout: 15000 }).then(() => 'sucesso'),
    page.waitForSelector('text=/usu[áa]rio ou senha incorretos?/i', { state: 'visible', timeout: 15000 }).then(() => 'erro'),
  ]).catch(() => 'indeterminado');

  if (resultado === 'erro') {
    throw new Error(`Login falhou para o hangar "${hangar.id}" — usuário ou senha incorretos (usuário: ${usuario}).`);
  }
  if (resultado === 'indeterminado') {
    throw new Error(`Não foi possível confirmar o login do hangar "${hangar.id}" em 15s — nem o painel nem a mensagem de erro apareceram.`);
  }
}

module.exports = { carregarConfig, buscarHangar, buscarHangarPorGrupo, login, salvarAsaasCustomerId };
