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

  // Uma tentativa a mais quando o login fica INDETERMINADO.
  //
  // Em 16/09/2026 uma consulta do AIBM 1 falhou sozinha, no meio de dezenas
  // que funcionaram: o painel não apareceu em 15s e o cliente recebeu "não
  // conseguimos consultar", com a administração acionada. Rodado à mão logo
  // depois, o mesmo ticket respondeu em 5s, quatro vezes seguidas. A máquina
  // tem 2 GB e já usa swap; com o Chromium disputando memória, 15s deixa de
  // ser folgado e vira aposta.
  //
  // Repetir só faz sentido no indeterminado. Senha errada é senha errada —
  // insistir gastaria mais 25s para dar a mesma resposta, e em site que trava
  // conta após tentativas seguidas seria pior que inútil.
  const TENTATIVAS = 2;
  let ultimoErro = null;

  for (let tentativa = 1; tentativa <= TENTATIVAS; tentativa += 1) {
    const espera = tentativa === 1 ? 15000 : 25000;
    const resultado = await tentarLogin(page, hangar, seletores, usuario, senha, espera);

    if (resultado === 'sucesso') return;
    if (resultado === 'erro') {
      throw new Error(`Login falhou para o hangar "${hangar.id}" — usuário ou senha incorretos (usuário: ${usuario}).`);
    }
    const pista = await registrarDiagnostico(page, hangar, tentativa, usuario, senha);
    ultimoErro = `Não foi possível confirmar o login do hangar "${hangar.id}" em ${espera / 1000}s `
      + `(tentativa ${tentativa} de ${TENTATIVAS}) — nem o painel nem a mensagem de erro apareceram.${pista}`;
  }

  throw new Error(ultimoErro);
}

/**
 * Guarda o que o navegador estava vendo quando o login não confirmou.
 *
 * Existe porque em 16/09/2026 o login do AIBM 1 falhou três vezes dentro do
 * fluxo do bot enquanto, rodado à mão, acertava nove de nove. Sem enxergar a
 * tela do momento da falha, investigar virou adivinhação: memória? CPU? o site?
 * Uma imagem do que estava na tela responde em segundos o que duas hipóteses
 * erradas não responderam.
 *
 * Nunca deixa a falha do diagnóstico virar a falha do login — o erro real é o
 * que interessa, e mascará-lo seria pior que não ter diagnóstico nenhum.
 */
async function registrarDiagnostico(page, hangar, tentativa, usuario, senha) {
  try {
    const pasta = path.join(__dirname, '..', '..', 'data', 'diagnostico');
    fs.mkdirSync(pasta, { recursive: true });

    const carimbo = new Date().toISOString().replace(/[:.]/g, '-');
    const base = path.join(pasta, `login-${hangar.id}-${carimbo}-t${tentativa}`);

    const url = page.url();
    const titulo = await page.title().catch(() => null);
    // Sinal mais direto do que uma imagem: se o campo de usuário ainda está na
    // tela, o login não passou; se sumiu, passou e o painel é que não carregou.
    const aindaNoLogin = await page.locator((hangar.seletores || {}).campoUsuario || 'input')
      .first().isVisible().catch(() => null);

    // Quantos caracteres de fato chegaram aos campos. NUNCA o conteúdo: só o
    // tamanho, comparado com o que devia estar lá. Distingue duas causas que
    // produzem exatamente a mesma tela — `fill` que entregou o texto pela
    // metade num campo React, e credencial que o site recusou por inteiro.
    const preenchido = {};
    for (const [nome, seletor, esperado] of [
      ['usuario', (hangar.seletores || {}).campoUsuario, usuario],
      ['senha', (hangar.seletores || {}).campoSenha, senha],
    ]) {
      if (!seletor) continue;
      const lido = await page.inputValue(seletor).catch(() => null);
      preenchido[nome] = lido === null
        ? 'não consegui ler'
        : `${lido.length} de ${esperado.length} caracteres${lido.length === esperado.length ? '' : ' — INCOMPLETO'}`;
    }

    await page.screenshot({ path: `${base}.png`, fullPage: false }).catch(() => {});
    fs.writeFileSync(`${base}.json`, JSON.stringify({
      hangar: hangar.id, tentativa, em: new Date().toISOString(), url, titulo, aindaNoLogin, preenchido,
    }, null, 2));

    limparDiagnosticosAntigos(pasta);
    return ` [tela: ${titulo || 'sem título'} | ${aindaNoLogin === true ? 'ainda na tela de login' : aindaNoLogin === false ? 'passou do login, painel não carregou' : 'estado incerto'} | ${path.basename(base)}.png]`;
  } catch (e) {
    return '';
  }
}

// Fotos de tela acumulam num disco pequeno. 40 arquivos (20 falhas) é mais
// histórico do que qualquer investigação precisa.
function limparDiagnosticosAntigos(pasta, manter = 40) {
  try {
    const arquivos = fs.readdirSync(pasta).sort();
    for (const nome of arquivos.slice(0, Math.max(0, arquivos.length - manter))) {
      fs.unlinkSync(path.join(pasta, nome));
    }
  } catch (e) { /* limpeza é higiene, não pode quebrar nada */ }
}

async function tentarLogin(page, hangar, seletores, usuario, senha, espera) {
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
  return Promise.race([
    page.waitForSelector(seletores.areaVagasDisponiveis, { state: 'visible', timeout: espera }).then(() => 'sucesso'),
    // NÃO casar por "usuário": a tela escreve "Usúario" — o acento está no U,
    // não no A. A regex anterior (`usu[áa]rio`) nunca casou com o site real, e
    // o efeito foi pior que um erro visível: toda recusa de credencial era
    // classificada como "não consegui confirmar", esperava os 15s inteiros,
    // tentava de novo e chegava ao cliente como falha de sistema. O erro ficou
    // escondido até uma foto de tela mostrar a mensagem escrita na página.
    //
    // Agora casa pelo trecho sem acento nenhum, que é o que o site tem de
    // estável — e sobrevive ao dia em que corrigirem a grafia.
    page.waitForSelector('text=/ou\\s+senha\\s+incorret/i', { state: 'visible', timeout: espera }).then(() => 'erro'),
  ]).catch(() => 'indeterminado');
}

module.exports = { carregarConfig, buscarHangar, buscarHangarPorGrupo, login, salvarAsaasCustomerId };
