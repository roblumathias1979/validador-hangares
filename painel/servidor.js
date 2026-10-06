#!/usr/bin/env node
/**
 * painel/servidor.js — painel de controle do validador.
 *
 * Mostra o estado de cada hangar e permite editar os campos de configuração
 * que são seguros de mexer pela web.
 *
 * DECISÕES QUE EXPLICAM O DESENHO
 *
 * Escuta só em 127.0.0.1. Nada deste sistema está exposto à internet — a porta
 * do n8n é fechada e a Evolution só atende localhost —, e um painel que
 * controla validação de estacionamento, com efeito financeiro, não é lugar
 * para abrir a primeira brecha. O acesso é por túnel SSH:
 *
 *     ssh -i ~/.ssh/validador.pem -L 8081:127.0.0.1:8081 ubuntu@<IP>
 *     e então abrir http://localhost:8081 no navegador
 *
 * Para expor de verdade depois é preciso domínio, TLS e revisar a autenticação
 * — está registrado no painel/README.md.
 *
 * Cada alteração vira um COMMIT. O config/hangares.json é versionado (correção
 * de 09/09/2026, depois que a versão fora do git divergiu em silêncio e deixou
 * produção semanas com seletores quebrados). Se o painel editasse o arquivo sem
 * commitar, o próximo `git pull` no servidor conflitaria ou sobrescreveria, e
 * voltaríamos ao mesmo problema. Commitando, o git segue sendo a fonte da
 * verdade e o histórico vira auditoria: quem mudou a cota, quando, de quanto
 * para quanto.
 *
 * O servidor NÃO tem credencial de escrita no GitHub, então o push não
 * acontece — o painel mostra quantos commits estão pendentes de envio.
 *
 * Campos que NÃO são editáveis aqui, de propósito:
 *   - credenciais dos hangares: ficam no .env, nunca numa tela web
 *   - seletores CSS: são código disfarçado de configuração; mexer sem testar
 *     quebra o hangar em silêncio
 *   - dados do Asaas: erro ali emite cobrança para o CNPJ errado
 */

const fs = require('fs');
const http = require('http');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(RAIZ, '.env'), override: true });

const CONFIG = path.join(RAIZ, 'config', 'hangares.json');
const ENV = path.join(RAIZ, '.env');
const PORTA = Number(process.env.PAINEL_PORTA) || 8081;
const SENHA = process.env.PAINEL_SENHA || '';

const { obterUsoMensal, obterRestante } = require(path.join(RAIZ, 'scripts', 'lib', 'cota-fora-prazo'));
const cotaMensal = require('../scripts/lib/cota-mensal');
const evolution = require('../scripts/lib/evolution');
// Gravar o config é compartilhado com o bot: ver a nota em salvar-config.js.
const { salvarEComitar } = require('../scripts/lib/salvar-config');
const bloqueados = require('../scripts/lib/tickets-bloqueados');
const { enviarTexto } = require('../scripts/lib/evolution');
const validacoesPendentes = require('../scripts/lib/validacoes-pendentes');
const consultasPendentes = require('../scripts/lib/consultas-pendentes');
const cotaForaPrazo = require('../scripts/lib/cota-fora-prazo');
const { carregarConfig, buscarHangar } = require('../scripts/lib/hangar');
const registro = require(path.join(RAIZ, 'scripts', 'lib', 'registro'));
const { lerJson } = require(path.join(RAIZ, 'scripts', 'lib', 'trava-arquivo'));
const usuarios = require('./usuarios');
const referencias = require(path.join(RAIZ, 'scripts', 'lib', 'referencias'));
const SAUDE = path.join(RAIZ, 'data', 'saude.json');
const fiscalizacao = require(path.join(RAIZ, 'scripts', 'lib', 'fiscalizacao'));
const { salvarAtomico } = require(path.join(RAIZ, 'scripts', 'lib', 'trava-arquivo'));
const SNAPSHOT_TECHPARKING = path.join(RAIZ, 'data', 'techparking-snapshot.json');
const REGRAS_FISCALIZACAO = path.join(RAIZ, 'config', 'fiscalizacao.json');
const registroRonda = require(path.join(RAIZ, 'scripts', 'lib', 'registro-fiscalizacao'));
const { lerPlacas } = require(path.join(RAIZ, 'scripts', 'lib', 'ler-placas'));

// Teto do slider do ValidPark. 20 dias é exatamente o limite — não há folga, e
// pedir mais faz o site recusar a validação inteira.
const MAX_DIAS = 20;
const MAX_HORAS = 24;

const REGEX_PLACA = /^[A-Z]{3}(\d{4}|\d[A-Z]\d{2})$/;

// ---------------------------------------------------------------- utilidades

function lerConfig() {
  return JSON.parse(fs.readFileSync(CONFIG, 'utf-8'));
}

/**
 * O .env como objeto, lido do disco a cada chamada.
 *
 * Serve para saber QUAIS variáveis existem. O painel nunca mostra valor de
 * credencial, e é por isso que esta leitura fica pontual em vez de virar estado.
 */
function lerEnv() {
  try {
    const mapa = {};
    for (const linha of fs.readFileSync(ENV, 'utf-8').split('\n')) {
      const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
      if (m) mapa[m[1]] = m[2].trim();
    }
    return mapa;
  } catch (e) {
    return {};
  }
}

/**
 * Acrescenta credenciais ao .env. NUNCA sobrescreve: se a variável já existe,
 * recusa em vez de trocar por cima.
 *
 * Trocar a senha de um hangar em funcionamento pela tela de CRIAR hangar seria
 * um acidente caro e silencioso — o pátio pararia de validar e o motivo estaria
 * num arquivo que ninguém abre. Alterar credencial segue sendo trabalho de quem
 * tem acesso ao servidor, de propósito.
 */
function acrescentarCredenciais(pares) {
  const atual = lerEnv();
  for (const [nome] of pares) {
    if (atual[nome]) throw new Error(`${nome} já existe no .env — não vou sobrescrever. Altere no servidor.`);
  }
  fs.appendFileSync(ENV, `\n# ${new Date().toISOString().slice(0, 10)} — criado pelo painel\n`
    + pares.map(([nome, valor]) => `${nome}=${valor}`).join('\n') + '\n');
}

function git(args) {
  return execFileSync('git', args, { cwd: RAIZ, encoding: 'utf-8' }).trim();
}

function commitsPendentes() {
  try {
    return Number(git(['rev-list', '--count', 'origin/main..HEAD'])) || 0;
  } catch (e) {
    return null; // sem origin acessível: não é erro fatal, só não sabemos
  }
}

/**
 * Grava o config e commita. A mensagem registra exatamente o que mudou, para
 * o histórico servir de auditoria sem precisar abrir o diff.
 */
// ------------------------------------------------------------------ validação

/**
 * Cada campo editável tem regra própria. Devolve o valor normalizado ou lança
 * com uma mensagem que explica o limite — o painel mostra ao usuário.
 */
const CAMPOS = {
  // Teto de validações do mês INTEIRO, diferente da cota fora do prazo logo
  // abaixo. Vazio significa SEM TETO, que é o caso de quase todos — por isso
  // o campo aceita string vazia em vez de exigir um número grande.
  cotaMensalValidacoes: (v) => {
    if (v === '' || v === null) return null;
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 10000) throw new Error('Cota mensal deve ser um inteiro de 0 a 10000, ou vazio para sem limite.');
    return n;
  },
  cotaMensalForaPrazo: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 100) throw new Error('Cota deve ser um inteiro de 0 a 100.');
    return n;
  },
  diasValidacaoPadrao: (v) => {
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > MAX_DIAS) {
      throw new Error(`Dias deve ser inteiro de 0 a ${MAX_DIAS} (teto do slider do ValidPark).`);
    }
    return n;
  },
  prazoValidacaoHoras: (v) => {
    if (v === '' || v === null) return null;
    const n = Number(v);
    if (!Number.isFinite(n) || n <= 0 || n > 240) throw new Error('Prazo deve ser um número de horas entre 0 e 240, ou vazio.');
    return n;
  },
  placaGenerica: (v) => {
    const s = String(v || '').toUpperCase().replace(/[\s-]/g, '');
    if (s === '') return '';
    if (!REGEX_PLACA.test(s)) throw new Error('Placa deve estar no formato AAA1234 ou AAA1A23.');
    return s;
  },
  grupoWhatsappId: (v) => {
    const s = String(v || '').trim();
    if (s === '') return '';
    if (!s.endsWith('@g.us')) throw new Error('ID de grupo deve terminar em @g.us.');
    return s;
  },
  grupoAdministracao: (v) => {
    const s = String(v || '').trim();
    if (s === '') return '';
    if (!s.endsWith('@g.us') && !s.endsWith('@s.whatsapp.net')) {
      throw new Error('Destino deve terminar em @g.us (grupo) ou @s.whatsapp.net (pessoa).');
    }
    return s;
  },
  exigeFotoVeiculoNoLocal: (v) => v === true || v === 'true',
  perguntarIdentificacao: (v) => v === true || v === 'true',
  avisarPatioCheio: (v) => v === true || v === 'true',
  bolsaoTechparking: (v) => String(v || '').trim(),
  permiteValidarForaDoPrazo: (v) => v === true || v === 'true',
  avisarVagasAbaixoDe: (v) => {
    if (v === '' || v === null) return null; // vazio = calcula 10% do total
    const n = Number(v);
    if (!Number.isInteger(n) || n < 0 || n > 500) throw new Error('Aviso de vagas deve ser um inteiro de 0 a 500, ou vazio para automático.');
    return n;
  },
};

// --------------------------------------------------------------------- estado

function montarEstado(usuario = null) {
  const config = lerConfig();
  const resumo = registro.resumoPorHangar();
  const hangares = config.hangares.map((h) => ({
    id: h.id,
    nome: h.hangar || h.id,
    grupoWhatsapp: h.grupoWhatsapp || null,
    grupoWhatsappId: h.grupoWhatsappId || '',
    grupoAdministracao: h.grupoAdministracao || '',
    placaGenerica: h.placaGenerica || '',
    cotaMensalForaPrazo: h.cotaMensalForaPrazo ?? null,
    diasValidacaoPadrao: h.diasValidacaoPadrao ?? null,
    prazoValidacaoHoras: h.prazoValidacaoHoras ?? null,
    exigeFotoVeiculoNoLocal: h.exigeFotoVeiculoNoLocal === true,
    perguntarIdentificacao: h.perguntarIdentificacao === true,
    // Ausente significa LIGADO: o aviso é o comportamento padrão, e só quem
    // desliga explicitamente fica sem ele.
    avisarPatioCheio: h.avisarPatioCheio !== false,
    bolsaoTechparking: h.bolsaoTechparking || '',
    // Ausente significa DESLIGADO: fora do prazo não se valida, e ligar é
    // decisão consciente de quem conhece a consequência.
    permiteValidarForaDoPrazo: h.permiteValidarForaDoPrazo === true,
    avisarVagasAbaixoDe: h.avisarVagasAbaixoDe ?? null,
    // Lido do ARQUIVO, não de process.env. O painel é um processo longo: ele
    // carrega o .env ao subir e fica com aquela foto. Foi assim que o VOASP
    // apareceu como "sem credencial" depois de as variáveis serem adicionadas
    // (17/09/2026) — e é o que aconteceria com todo hangar criado por aqui.
    temCredencial: Boolean(lerEnv()[h.usuarioEnvVar]),
    temAsaas: Boolean((h.asaas || {}).customerId),
    // Só os hangares com grupo cadastrado recebem mensagem; os demais são
    // recusados na entrada.
    ativo: Boolean((h.grupoWhatsappId || '').trim()),
    cotaUsada: obterUsoMensal(h.id),
    cotaRestante: obterRestante(h),
    // Cota do mês inteiro. `null` em limite significa sem teto — o painel
    // precisa distinguir "sem limite" de "limite zero", que são opostos.
    cotaMensalValidacoes: h.cotaMensalValidacoes ?? null,
    mes: (() => { const m = cotaMensal.situacao(h); return { limite: m.limite, usadas: m.usadas, restantes: m.restantes, esgotada: m.esgotada, competencia: m.mes }; })(),
    historico: resumo[h.id] || { total: 0, validados: 0, comCota: 0, ultimo: null },
  }));

  // Contingência do ValidPark: global, não por hangar (o site cai para todos).
  // Ligada, a validação dentro do prazo passa a validar pelo coletor.
  const cont = config.contingenciaValidPark || {};

  return {
    hangares,
    contingencia: { ativo: cont.ativo === true, desde: cont.desde || null, por: cont.por || null },
    resumo: {
      total: hangares.length,
      ativos: hangares.filter((h) => h.ativo).length,
      semCredencial: hangares.filter((h) => !h.temCredencial).length,
      semAdmin: hangares.filter((h) => h.ativo && !h.grupoAdministracao).length,
    },
    commitsPendentes: commitsPendentes(),
    // Escrito por scripts/monitor-saude.js a cada 5 minutos. É a via que
    // funciona mesmo com o WhatsApp caído — justamente quando o aviso por
    // WhatsApp não pode chegar.
    saude: lerJson(SAUDE, null),
    usuario,
    semUsuarios: !usuarios.existeAlgum(),
    geradoEm: new Date().toISOString(),
  };
}

// ---------------------------------------------------------------------- HTTP

/**
 * Autentica pelo cadastro de usuários. Devolve o usuário ou null.
 *
 * PAINEL_SENHA continua valendo como RESGATE, e só enquanto não houver nenhum
 * usuário cadastrado. Sem isso, o primeiro acesso seria impossível — e se o
 * último usuário fosse perdido, a única saída seria editar arquivo por SSH.
 * Assim que o primeiro usuário existe, a senha única para de funcionar.
 */
function autorizado(req) {
  const cabecalho = req.headers.authorization || '';
  if (!cabecalho.startsWith('Basic ')) return null;
  const decodificado = Buffer.from(cabecalho.slice(6), 'base64').toString();
  const corte = decodificado.indexOf(':');
  const nome = corte >= 0 ? decodificado.slice(0, corte) : '';
  const valor = corte >= 0 ? decodificado.slice(corte + 1) : '';

  if (!usuarios.existeAlgum()) {
    if (!SENHA) return null;
    // Comparação de tempo constante evita vazar o tamanho/prefixo da senha por
    // diferença de tempo de resposta.
    const a = Buffer.from(valor || '');
    const b = Buffer.from(SENHA);
    const bate = a.length === b.length && require('crypto').timingSafeEqual(a, b);
    return bate ? { nome: '(senha de resgate)', somenteLeitura: false, resgate: true } : null;
  }

  return usuarios.autenticar(nome, valor);
}

function json(res, codigo, corpo) {
  const texto = JSON.stringify(corpo);
  res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(texto) });
  res.end(texto);
}

function lerCorpo(req) {
  return new Promise((resolve, reject) => {
    let dados = '';
    req.on('data', (c) => {
      dados += c;
      // 6 MB: uma foto de 3 MB vira ~4 MB em base64, mais folga para o json.
      if (dados.length > 6 * 1024 * 1024) reject(new Error('Corpo grande demais.'));
    });
    req.on('end', () => {
      try { resolve(dados ? JSON.parse(dados) : {}); } catch (e) { reject(new Error('Corpo não é json válido.')); }
    });
    req.on('error', reject);
  });
}

// ------------------------------------------------------------ fiscalização

/**
 * O coletor do aeroporto é uma máquina, não uma pessoa: autentica por token
 * próprio, e não por um usuário do painel. Dar a ele um login de gente
 * deixaria uma senha de pessoa gravada num arquivo em outra máquina, e trocar
 * essa senha derrubaria o coletor sem ninguém perceber.
 *
 * O token só abre UMA rota, a que grava o snapshot. Vazado, o estrago máximo
 * é alguém forjar a lista de tickets. Sério, mas nada que valide ticket ou
 * mexa em configuração.
 */
function coletorAutorizado(req) {
  const token = process.env.TECHPARKING_COLETOR_TOKEN || '';
  const cabecalho = req.headers.authorization || '';
  if (!token || !cabecalho.startsWith('Bearer ')) return false;
  const a = Buffer.from(cabecalho.slice(7));
  const b = Buffer.from(token);
  return a.length === b.length && require('crypto').timingSafeEqual(a, b);
}

// O índice é montado uma vez por snapshot, não por consulta: a câmera
// pergunta várias vezes por minuto, e o snapshot muda a cada minuto.
let indiceEmCache = { chave: null, indice: null };
function indiceFiscalizacao() {
  const regras = lerJson(REGRAS_FISCALIZACAO, {});
  let mtime = 0;
  try { mtime = fs.statSync(SNAPSHOT_TECHPARKING).mtimeMs; } catch (e) { /* ainda não chegou nada */ }
  const regrasMtime = fs.statSync(REGRAS_FISCALIZACAO).mtimeMs;
  const chave = `${mtime}:${regrasMtime}`;
  if (indiceEmCache.chave !== chave) {
    indiceEmCache = { chave, indice: fiscalizacao.montarIndice(lerJson(SNAPSHOT_TECHPARKING, {}), regras) };
  }
  return { indice: indiceEmCache.indice, regras };
}

/**
 * Uma linha no histórico da ronda por placa, por fiscal, a cada 5 minutos. A
 * câmera lê a mesma placa a cada quadro enquanto ela está enquadrada; sem
 * esse filtro, parar dez segundos diante de uma moto gravaria cinco linhas.
 */
const ultimaAnotacao = new Map();
let ultimoExpurgo = 0;
function anotarRonda(usuario, resultado, { origem, local = null }, imagem, regras) {
  const chave = `${usuario.nome}|${resultado.placa}`;
  const agora = Date.now();
  if (agora - (ultimaAnotacao.get(chave) || 0) < 5 * 60 * 1000) return;
  ultimaAnotacao.set(chave, agora);

  const vermelho = resultado.situacao === 'irregular' || resultado.situacao === 'excedido';
  const foto = vermelho && imagem ? registroRonda.guardarFoto(resultado.placa, imagem) : null;
  registroRonda.registrar({
    usuario: usuario.nome,
    origem,
    placa: resultado.placa,
    situacao: resultado.situacao,
    motivo: resultado.motivo || null,
    patio: resultado.patio || null,
    lotacao: resultado.lotacao ? `${resultado.lotacao.ocupadas}/${resultado.lotacao.vagas}` : null,
    local,
    foto,
  });
  if (agora - ultimoExpurgo > 3600000) {
    ultimoExpurgo = agora;
    registroRonda.expurgar(regras.diasGuardarRonda ?? 30);
  }
}

const servidor = http.createServer(async (req, res) => {
  // Antes da autenticação de usuário, e só esta rota: ver coletorAutorizado.
  if (req.method === 'POST' && req.url === '/api/techparking/snapshot') {
    if (!coletorAutorizado(req)) { json(res, 401, { erro: 'Token do coletor inválido.' }); return; }
    try {
      const corpo = await lerCorpo(req);
      for (const campo of ['patios', 'avulsos', 'credenciados']) {
        if (!Array.isArray(corpo[campo])) { json(res, 400, { erro: `"${campo}" precisa ser uma lista.` }); return; }
      }
      // Guarda só o que a fiscalização usa. O coletor não deve mandar mais
      // nada, mas isso não depende dele.
      salvarAtomico(SNAPSHOT_TECHPARKING, {
        recebidoEm: new Date().toISOString(),
        coletadoEm: corpo.coletadoEm || null,
        patios: corpo.patios,
        avulsos: corpo.avulsos,
        credenciados: corpo.credenciados,
      });
      json(res, 200, { ok: true, patios: corpo.patios.length, avulsos: corpo.avulsos.length, credenciados: corpo.credenciados.length });
    } catch (erro) {
      json(res, 400, { erro: erro.message });
    }
    return;
  }

  // O coletor PUXA as validações autorizadas (ticket vencido liberado por cota
  // ou por você). Autenticado com o mesmo token do coletor, e antes do login de
  // painel: é máquina, não pessoa.
  if (req.method === 'GET' && req.url === '/api/techparking/validacoes') {
    if (!coletorAutorizado(req)) { json(res, 401, { erro: 'Token do coletor inválido.' }); return; }
    json(res, 200, { validacoes: validacoesPendentes.retirarParaProcessar() });
    return;
  }

  // E REPORTA o resultado. O grupo do cliente é avisado aqui, quando a resposta
  // chega — é o desfecho do "autorizado, validando...".
  if (req.method === 'POST' && req.url === '/api/techparking/validacao-resultado') {
    if (!coletorAutorizado(req)) { json(res, 401, { erro: 'Token do coletor inválido.' }); return; }
    try {
      const corpo = await lerCorpo(req);
      const v = validacoesPendentes.registrarResultado(corpo.id, corpo);
      if (v) {
        // Validação que FALHOU e tinha gasto cota: devolve a cota. Sem isto, o
        // cliente perderia uma validação por uma falha do lado do aeroporto.
        if (v.resultado && !v.resultado.ok && v.motivo === 'cota' && v.hangarId && !v.simular) {
          try { cotaForaPrazo.devolverUmaValidacao(buscarHangar(carregarConfig(), v.hangarId)); }
          catch (e) { /* devolução é o melhor esforço; o erro real já vai ao grupo */ }
        }
        if (v.grupoId) {
          // Na contingência o bot pode estar ESPERANDO para responder na hora
          // (como o ValidPark). A reivindicação resolve a corrida: se o bot já
          // avisou o grupo, o servidor não repete; senão, avisa aqui.
          const aviso = validacoesPendentes.reivindicarAviso(corpo.id);
          if (aviso.pronto && aviso.reivindicado) {
            const msg = v.resultado.ok
              ? `✅ Ticket ${v.ticket} validado com sucesso.${v.simular ? ' (teste — nada foi alterado)' : ''}`
              : `⚠️ Não consegui validar o ticket ${v.ticket} agora. Nossa equipe foi avisada${v.motivo === 'cota' ? ' e a validação da cota foi devolvida' : ''}.`;
            try { await enviarTexto(v.grupoId, msg); } catch (e) { /* o resultado já ficou registrado */ }
          }
        }
      }
      json(res, 200, { ok: true });
    } catch (erro) {
      json(res, 400, { erro: erro.message });
    }
    return;
  }

  // Consultas de histórico (entrada/saída de credenciados): o coletor PUXA aqui.
  if (req.method === 'GET' && req.url === '/api/techparking/consultas') {
    if (!coletorAutorizado(req)) { json(res, 401, { erro: 'Token do coletor inválido.' }); return; }
    json(res, 200, { consultas: consultasPendentes.retirarParaProcessar() });
    return;
  }

  // E REPORTA o resultado (a lista já filtrada por hangar). O bot está
  // esperando esse resultado para responder no grupo; aqui só guardamos.
  if (req.method === 'POST' && req.url === '/api/techparking/consulta-resultado') {
    if (!coletorAutorizado(req)) { json(res, 401, { erro: 'Token do coletor inválido.' }); return; }
    try {
      const corpo = await lerCorpo(req);
      consultasPendentes.registrarResultado(corpo.id, corpo.resultado || corpo);
      json(res, 200, { ok: true });
    } catch (erro) {
      json(res, 400, { erro: erro.message });
    }
    return;
  }

  const usuario = autorizado(req);
  if (!usuario) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Validador"' });
    res.end('Acesso restrito.');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // Escrita exige conta com permissão. Checado aqui, num lugar só, em vez de
  // em cada rota — esquecer numa rota nova seria fácil demais.
  //
  // A exceção é a leitura de placa: é POST só porque a imagem não cabe numa
  // URL, e não altera configuração nem validação. O fiscal na rua usa conta
  // somente leitura, de propósito.
  if (req.method !== 'GET' && usuario.somenteLeitura && url.pathname !== '/api/fiscalizacao/ler') {
    json(res, 403, { erro: 'Sua conta é somente leitura.' });
    return;
  }

  try {
    if (req.method === 'GET' && url.pathname === '/fiscalizar') {
      const html = fs.readFileSync(path.join(__dirname, 'fiscalizar.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
      return;
    }

    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    // Logo. Arquivo servido em vez de embutido em base64 no HTML: são 23 KB
    // que o navegador guarda em cache, contra 31 KB re-enviados a cada
    // carregamento da página — e o painel recarrega a cada salvar.
    //
    // Caminho fixo, sem parâmetro: não há como pedir outro arquivo por aqui.
    if (req.method === 'GET' && url.pathname === '/logo-1park.png') {
      const arquivo = path.join(__dirname, 'logo-1park.png');
      if (!fs.existsSync(arquivo)) { json(res, 404, { erro: 'Logo não encontrado.' }); return; }
      const dados = fs.readFileSync(arquivo);
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Content-Length': dados.length,
        'Cache-Control': 'public, max-age=86400',
      });
      res.end(dados);
      return;
    }

    if (url.pathname.startsWith('/api/referencias/')) {
      const partes = url.pathname.slice('/api/referencias/'.length).split('/');
      const hangarId = decodeURIComponent(partes[0] || '');

      if (req.method === 'GET' && partes[1]) {
        // Serve o arquivo para a miniatura aparecer na tela.
        const c = referencias.conteudo(hangarId, decodeURIComponent(partes[1]));
        res.writeHead(200, { 'Content-Type': c.mimetype, 'Cache-Control': 'private, max-age=300' });
        res.end(c.dados);
        return;
      }
      if (req.method === 'GET') { json(res, 200, { arquivos: referencias.listar(hangarId), max: referencias.MAX_IMAGENS }); return; }
      if (req.method === 'POST') {
        const c = await lerCorpo(req);
        try {
          if (c.acao === 'apagar') { json(res, 200, { ok: true, ...referencias.apagar(hangarId, c.nome) }); return; }
          json(res, 200, { ok: true, ...referencias.guardar(hangarId, c) });
        } catch (e) { json(res, 400, { erro: e.message }); }
        return;
      }
    }

    if (url.pathname === '/api/usuarios') {
      if (req.method === 'GET') {
        json(res, 200, { usuarios: usuarios.listar(), minSenha: usuarios.MIN_SENHA, eu: usuario.nome });
        return;
      }
      if (req.method === 'POST') {
        const c = await lerCorpo(req);
        try {
          if (c.acao === 'definirEmail') { json(res, 200, { ok: true, ...usuarios.definirEmail(c.nome, c.email) }); return; }
          if (c.acao === 'trocarSenha') { json(res, 200, { ok: true, ...usuarios.trocarSenha(c.nome, c.senha) }); return; }
          if (c.acao === 'remover') {
            // Remover a si mesmo derrubaria a própria sessão no meio do uso.
            if (c.nome === usuario.nome) { json(res, 400, { erro: 'Você não pode remover a própria conta.' }); return; }
            json(res, 200, { ok: true, ...usuarios.remover(c.nome) }); return;
          }
          json(res, 200, { ok: true, ...usuarios.criar(c) });
        } catch (e) { json(res, 400, { erro: e.message }); }
        return;
      }
    }

    if (req.method === 'GET' && url.pathname === '/api/validacoes') {
      const limite = Math.min(Number(url.searchParams.get('limite')) || 50, 500);
      json(res, 200, {
        eventos: registro.ultimos(limite, {
          hangarId: url.searchParams.get('hangar') || undefined,
          apenasValidados: url.searchParams.get('apenasValidados') === 'true',
        }),
        retencaoDias: registro.RETENCAO_DIAS,
      });
      return;
    }

    // Grupos do WhatsApp disponíveis, para ativar um hangar sem colar o id de
    // 22 dígitos à mão. Diz quais já pertencem a algum hangar: reaproveitar um
    // grupo faria os tickets de um pátio caírem na conta de outro.
    if (req.method === 'GET' && url.pathname === '/api/grupos') {
      const config = lerConfig();
      const donos = new Map(config.hangares
        .filter((h) => (h.grupoWhatsappId || '').trim())
        .map((h) => [h.grupoWhatsappId.trim(), { id: h.id, nome: h.hangar || h.id }]));
      try {
        const grupos = await evolution.listarGrupos();
        json(res, 200, { grupos: grupos.map((g) => ({ ...g, hangar: donos.get(g.id) || null })) });
      } catch (erro) {
        // Não é 500: a Evolution fora do ar não é erro do painel, e a tela
        // precisa continuar oferecendo o campo manual.
        json(res, 200, { grupos: null, erro: erro.message });
      }
      return;
    }

    // Tickets travados por tentativa em pátio cheio, esperando decisão.
    if (req.method === 'GET' && url.pathname === '/api/bloqueados') {
      json(res, 200, { bloqueados: bloqueados.listar() });
      return;
    }

    // Decide sobre um ticket travado: liberar ou manter bloqueado.
    //
    // As duas saídas existem porque as duas são decisão. Só "autorizar" deixava
    // o caso recusado em aberto para sempre, sem ninguém saber se tinha sido
    // analisado — e o cliente esperando um retorno que nunca vinha.
    //
    // Fica registrado QUEM decidiu: tem efeito financeiro, e decisão sem dono
    // não se audita depois.
    if (req.method === 'POST' && (url.pathname === '/api/bloqueado-autorizar' || url.pathname === '/api/bloqueado-negar')) {
      const autorizar = url.pathname.endsWith('autorizar');
      const { ticket } = await lerCorpo(req);
      let r;
      try {
        r = autorizar
          ? bloqueados.autorizar(String(ticket || '').trim(), usuario.nome)
          : bloqueados.manterBloqueado(String(ticket || '').trim(), usuario.nome);
      } catch (e) {
        json(res, 400, { erro: e.message });
        return;
      }

      // O cliente está esperando no grupo. Pelo WhatsApp a decisão já o
      // avisava; pelo painel não avisava ninguém, e a pessoa ficava sem
      // desfecho — mesma decisão, dois comportamentos diferentes.
      let aviso = { enviado: false, motivo: 'sem grupo de origem' };
      if (r.grupoId) {
        try {
          await enviarTexto(r.grupoId, autorizar
            ? `✅ O ticket ${r.ticket} foi *autorizado* pela administração. Pode mandá-lo novamente para validar.`
            : `🚫 O ticket ${r.ticket} *não foi autorizado* pela administração. Para pagar, use o totem de autopagamento no terminal do aeroporto.`);
          aviso = { enviado: true };
        } catch (e) {
          // A decisão já vale. Falhar aqui perde o aviso, não o efeito — e a
          // tela diz que o grupo não foi avisado, para alguém fazer à mão.
          aviso = { enviado: false, motivo: String(e.message || e).slice(0, 160) };
        }
      }

      json(res, 200, { ok: true, autorizado: autorizar, ticket: r.ticket, por: usuario.nome, aviso });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/estado') {
      json(res, 200, montarEstado(usuario));
      return;
    }

    // Criar o grupo do WhatsApp e já ligá-lo ao pátio.
    //
    // Fecha o ciclo: criar pátio -> criar grupo -> receber. Antes era preciso
    // sair do painel, criar o grupo no celular, voltar e selecioná-lo.
    if (req.method === 'POST' && url.pathname === '/api/grupo-novo') {
      const { hangarId, nome, participantes } = await lerCorpo(req);

      const config = lerConfig();
      const hangar = config.hangares.find((h) => h.id === hangarId);
      if (!hangar) { json(res, 404, { erro: `Pátio "${hangarId}" não existe.` }); return; }
      if ((hangar.grupoWhatsappId || '').trim()) {
        json(res, 400, { erro: `"${hangar.hangar}" já tem grupo. Troque pelo seletor, se for o caso.` });
        return;
      }

      const nomeGrupo = String(nome || '').trim();
      if (!nomeGrupo) { json(res, 400, { erro: 'Informe o nome do grupo.' }); return; }

      // O telefone da administração entra sempre: é quem recebe os avisos do
      // pátio, e um grupo sem ninguém da casa não serve para nada. Os demais
      // vêm do formulário.
      const lista = [hangar.grupoAdministracao, ...(Array.isArray(participantes) ? participantes : String(participantes || '').split(/[\s,;]+/))]
        .map((p) => String(p || '').split('@')[0].replace(/\D/g, ''))
        .filter(Boolean);
      const unicos = [...new Set(lista)];
      if (!unicos.length) {
        json(res, 400, { erro: 'Informe ao menos um telefone com DDD (ex.: 11999998888) — o WhatsApp não cria grupo só com o bot.' });
        return;
      }

      let grupo;
      try {
        grupo = await evolution.criarGrupo({ nome: nomeGrupo, participantes: unicos });
      } catch (e) { json(res, 400, { erro: e.message }); return; }

      // O grupo existe no WhatsApp a partir daqui. Se o cadastro falhar, o
      // grupo NÃO é desfeito — por isso ele é salvo em seguida, e uma falha
      // aqui precisa dizer o id para ninguém ficar com um grupo órfão.
      try {
        hangar.grupoWhatsapp = grupo.nome;
        hangar.grupoWhatsappId = grupo.id;
        const r = salvarEComitar(config, `${hangar.hangar} — grupo "${grupo.nome}" criado e ativado`);
        json(res, 200, { ok: true, grupo, ...r });
      } catch (e) {
        json(res, 500, {
          erro: `O grupo "${nomeGrupo}" FOI criado no WhatsApp (${grupo.id}), mas não consegui cadastrá-lo: ${e.message}. `
            + 'Selecione-o na lista para ativar.',
        });
      }
      return;
    }

    // Excluir pátio.
    //
    // Só sai do config. NÃO apaga, de propósito:
    //  - o HISTÓRICO, que é dado de auditoria. Se alguém contestar uma cobrança
    //    do mês passado, a prova não pode ter sumido junto com o cadastro.
    //  - as CREDENCIAIS no .env. Apagar é irreversível daqui, e um pátio
    //    excluído por engano volta sem precisar do login de novo.
    //  - as FOTOS de referência, pelo mesmo motivo.
    //
    // E é reversível: a exclusão vira commit, como toda alteração do painel.
    if (req.method === 'POST' && url.pathname === '/api/hangar-excluir') {
      const { id, confirmacao } = await lerCorpo(req);
      const config = lerConfig();
      const hangar = config.hangares.find((h) => h.id === id);
      if (!hangar) { json(res, 404, { erro: `Pátio "${id}" não existe.` }); return; }

      // Digitar o identificador é a trava. Um botão de excluir dentro do cartão
      // que se está editando é clicável por engano; digitar "aibm-2" não é.
      if (String(confirmacao || '').trim() !== hangar.id) {
        json(res, 400, { erro: `Para excluir, digite exatamente "${hangar.id}".` });
        return;
      }

      const estavaAtivo = Boolean((hangar.grupoWhatsappId || '').trim());
      config.hangares = config.hangares.filter((h) => h.id !== id);
      const r = salvarEComitar(config, `pátio "${hangar.hangar}" (${hangar.id}) excluído`);
      json(res, 200, {
        ok: true,
        id: hangar.id,
        estavaAtivo,
        // O que sobrou fica dito: são os arquivos que alguém precisaria limpar
        // à mão se quisesse mesmo apagar tudo.
        mantido: {
          historico: registro.ultimos(99999, { hangarId: hangar.id }).length,
          credenciais: [hangar.usuarioEnvVar, hangar.senhaEnvVar],
        },
        ...r,
      });
      return;
    }

    // Criar pátio. Até 17/09/2026 isso era edição de arquivo no servidor, e todo
    // pátio novo passava por quem tem acesso SSH.
    if (req.method === 'POST' && url.pathname === '/api/hangar-novo') {
      const { id, nome, usuario, senha } = await lerCorpo(req);

      // Minúsculas por gentileza: quem digita "Hangar-Aristek" quer o mesmo
      // pátio que "hangar-aristek", e o formulário já sugere a forma certa.
      const idLimpo = String(id || '').trim().toLowerCase();
      // O id vira nome de pasta (data/referencias/<id>) e de variável de
      // ambiente. A regra evita um id com barra escrevendo fora da pasta de
      // dados, e um com ponto gerando uma variável que o shell não aceita.
      if (!/^[a-z][a-z0-9-]{1,30}$/.test(idLimpo)) {
        json(res, 400, { erro: 'Identificador deve começar com letra e ter de 2 a 31 caracteres: só letras, números e hífen.' });
        return;
      }
      const nomeLimpo = String(nome || '').trim();
      if (!nomeLimpo) { json(res, 400, { erro: 'Informe o nome do pátio.' }); return; }

      const config = lerConfig();
      if (config.hangares.some((h) => h.id === idLimpo)) {
        json(res, 400, { erro: `Já existe um pátio com o identificador "${idLimpo}".` });
        return;
      }

      const PREFIXO = idLimpo.toUpperCase().replace(/-/g, '_');
      const usuarioEnvVar = `${PREFIXO}_USUARIO`;
      const senhaEnvVar = `${PREFIXO}_SENHA`;

      // Credenciais são opcionais: dá para cadastrar o pátio agora e receber o
      // login depois. Sem elas o pátio nasce marcado "sem credencial".
      const temLogin = Boolean(String(usuario || '').trim() && String(senha || '').trim());
      if (temLogin) {
        try {
          acrescentarCredenciais([[usuarioEnvVar, String(usuario).trim()], [senhaEnvVar, String(senha).trim()]]);
        } catch (e) { json(res, 400, { erro: e.message }); return; }
      }

      // URL, seletores e formato de ticket são idênticos em todos os hangares —
      // o ValidPark é um site só. Copiar do config, e não de uma cópia no
      // código, evita que os dois divirjam quando o site mudar.
      const modelo = config.hangares[0];
      config.hangares.push({
        id: idLimpo,
        hangar: nomeLimpo,
        grupoWhatsapp: '',
        grupoWhatsappId: '',
        validadorUrl: modelo.validadorUrl,
        usuarioEnvVar,
        senhaEnvVar,
        seletores: JSON.parse(JSON.stringify(modelo.seletores)),
        formatoTicket: JSON.parse(JSON.stringify(modelo.formatoTicket)),
        placaGenerica: 'AAA0000',
        prazoValidacaoHoras: modelo.prazoValidacaoHoras,
        // Herdado de quem já opera: sem destino de aviso, um problema que
        // precisa de gente não chega a ninguém.
        grupoAdministracao: (config.hangares.find((h) => (h.grupoAdministracao || '').trim()) || {}).grupoAdministracao || '',
        cotaMensalForaPrazo: 2,
        asaas: { customerId: '', cnpj: '', razaoSocial: '', email: '' },
        diasValidacaoPadrao: modelo.diasValidacaoPadrao,
        exigeFotoVeiculoNoLocal: false,
      });

      const r = salvarEComitar(config, `pátio "${nomeLimpo}" criado (${idLimpo})`);
      json(res, 200, { ok: true, id: idLimpo, usuarioEnvVar, senhaEnvVar, credenciais: temLogin, ...r });
      return;
    }

    // Liga/desliga a contingência do ValidPark. É global (o site cai para
    // todos os hangares), então fica fora de /api/hangar/. Registra quem e
    // quando, para a auditoria saber de onde veio a decisão.
    if (req.method === 'POST' && url.pathname === '/api/contingencia') {
      const corpo = await lerCorpo(req);
      const ativo = corpo.ativo === true || corpo.ativo === 'true';
      const config = lerConfig();
      const atual = config.contingenciaValidPark || {};
      if ((atual.ativo === true) === ativo) { json(res, 200, { semMudanca: true, contingencia: atual }); return; }
      // Espalha o atual para preservar 'autorizados' (números que ligam a
      // contingência pelo WhatsApp) — só ativo/desde/por mudam aqui.
      config.contingenciaValidPark = {
        ...atual,
        ativo,
        desde: ativo ? new Date().toISOString() : null,
        por: ativo ? (usuario.nome || null) : null,
      };
      const r = salvarEComitar(config, `Contingência ValidPark ${ativo ? 'LIGADA' : 'desligada'} por ${usuario.nome || '—'}`);
      json(res, 200, { ok: true, contingencia: config.contingenciaValidPark, ...r, commitsPendentes: commitsPendentes() });
      return;
    }

    if (req.method === 'POST' && url.pathname.startsWith('/api/hangar/')) {
      const id = decodeURIComponent(url.pathname.slice('/api/hangar/'.length));
      const mudancas = await lerCorpo(req);
      const config = lerConfig();
      const hangar = config.hangares.find((h) => h.id === id);
      if (!hangar) { json(res, 404, { erro: `Hangar "${id}" não existe.` }); return; }

      const aplicadas = [];
      for (const [campo, valor] of Object.entries(mudancas)) {
        if (!CAMPOS[campo]) { json(res, 400, { erro: `Campo "${campo}" não é editável pelo painel.` }); return; }
        let novo;
        try { novo = CAMPOS[campo](valor); } catch (e) { json(res, 400, { erro: e.message, campo }); return; }
        const antigo = hangar[campo];
        if (String(antigo ?? '') !== String(novo ?? '')) {
          aplicadas.push(`${campo}: ${JSON.stringify(antigo ?? null)} -> ${JSON.stringify(novo)}`);
          hangar[campo] = novo;
        }
      }

      if (aplicadas.length === 0) { json(res, 200, { semMudanca: true }); return; }

      const r = salvarEComitar(config, `${hangar.hangar || id} — ${aplicadas.join('; ')}`);
      json(res, 200, { ok: true, aplicadas, ...r, commitsPendentes: commitsPendentes() });
      return;
    }

    // Consulta da câmera: GET, então vale para conta somente leitura também.
    // O fiscal na rua não precisa poder mexer em configuração.
    if (req.method === 'GET' && url.pathname === '/api/fiscalizacao/placa') {
      const { indice, regras } = indiceFiscalizacao();
      const resultado = fiscalizacao.avaliar(url.searchParams.get('p'), indice, regras);
      if (resultado.placa) anotarRonda(usuario, resultado, { origem: 'digitada' }, null, regras);
      json(res, 200, resultado);
      return;
    }

    // Quadro da câmera: lê as placas e já devolve a situação de cada uma, numa
    // ida só. Duas idas (ler, depois consultar) dobrariam a espera no 4G.
    if (req.method === 'POST' && url.pathname === '/api/fiscalizacao/ler') {
      const { indice, regras } = indiceFiscalizacao();
      const bloqueio = registroRonda.liberarLeitura(usuario.nome, regras);
      if (bloqueio) {
        json(res, 429, { erro: bloqueio === 'teto_diario' ? 'Limite diário de leituras atingido.' : 'Leituras rápidas demais.', motivo: bloqueio });
        return;
      }
      const corpo = await lerCorpo(req);
      const imagem = typeof corpo.imagem === 'string' ? corpo.imagem.replace(/^data:image\/\w+;base64,/, '') : '';
      if (imagem.length < 1000) { json(res, 400, { erro: 'Imagem ausente ou pequena demais.' }); return; }

      const lidas = await lerPlacas(imagem, { modelo: regras.modeloLeitura });
      const local = Number.isFinite(corpo.lat) && Number.isFinite(corpo.lng) ? { lat: corpo.lat, lng: corpo.lng, precisao: corpo.precisao ?? null } : null;
      const placas = lidas.placas.map((p) => {
        const resultado = { ...fiscalizacao.avaliar(p.placa, indice, regras), veiculo: p.veiculo };
        anotarRonda(usuario, resultado, { origem: 'camera', local }, imagem, regras);
        return resultado;
      });
      json(res, 200, { placas, descartadas: lidas.descartadas.length, recusado: !!lidas.recusado, leiturasHoje: registroRonda.leiturasHoje() });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/fiscalizacao/estado') {
      const { indice, regras } = indiceFiscalizacao();
      json(res, 200, {
        dados: fiscalizacao.avaliar('', indice, regras).dados,
        estatisticas: indice.estatisticas,
        mensalistas: (regras.patiosMensalistas || []).map((p) => fiscalizacao.lotacaoDe(indice, p) || { nome: p, vagas: null, ocupadas: 0 }),
      });
      return;
    }

    json(res, 404, { erro: 'Rota não encontrada.' });
  } catch (erro) {
    json(res, 500, { erro: erro.message });
  }
});

if (require.main === module) {
  if (!SENHA) {
    console.error('PAINEL_SENHA não configurada no .env — o painel não sobe sem senha.');
    process.exit(1);
  }
  // 127.0.0.1 explícito: sem isto o Node escuta em todas as interfaces e o
  // painel ficaria exposto assim que a porta fosse liberada no security group.
  servidor.listen(PORTA, '127.0.0.1', () => {
    console.log(`Painel em http://127.0.0.1:${PORTA} (apenas local — use túnel SSH)`);
  });
}

module.exports = { montarEstado, CAMPOS, servidor };
