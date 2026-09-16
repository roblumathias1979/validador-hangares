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
require('dotenv').config({ path: path.join(RAIZ, '.env') });

const CONFIG = path.join(RAIZ, 'config', 'hangares.json');
const PORTA = Number(process.env.PAINEL_PORTA) || 8081;
const SENHA = process.env.PAINEL_SENHA || '';

const { obterUsoMensal, obterRestante } = require(path.join(RAIZ, 'scripts', 'lib', 'cota-fora-prazo'));
const registro = require(path.join(RAIZ, 'scripts', 'lib', 'registro'));
const { lerJson } = require(path.join(RAIZ, 'scripts', 'lib', 'trava-arquivo'));
const usuarios = require('./usuarios');
const SAUDE = path.join(RAIZ, 'data', 'saude.json');

// Teto do slider do ValidPark. 20 dias é exatamente o limite — não há folga, e
// pedir mais faz o site recusar a validação inteira.
const MAX_DIAS = 20;
const MAX_HORAS = 24;

const REGEX_PLACA = /^[A-Z]{3}(\d{4}|\d[A-Z]\d{2})$/;

// ---------------------------------------------------------------- utilidades

function lerConfig() {
  return JSON.parse(fs.readFileSync(CONFIG, 'utf-8'));
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
function salvarEComitar(config, resumo) {
  const antes = fs.readFileSync(CONFIG, 'utf-8');
  fs.writeFileSync(CONFIG, `${JSON.stringify(config, null, 2)}\n`);
  try {
    git(['add', 'config/hangares.json']);
    git([
      '-c', 'user.name=Painel do Validador',
      '-c', 'user.email=painel@validador.local',
      'commit', '-m', `Painel: ${resumo}`,
    ]);
    return { commitado: true, commit: git(['rev-parse', '--short', 'HEAD']) };
  } catch (erro) {
    // Falhou o commit: desfaz a escrita para o arquivo não ficar divergindo do
    // git em silêncio, que é justamente o que queremos evitar.
    fs.writeFileSync(CONFIG, antes);
    throw new Error(`Não consegui commitar, alteração desfeita: ${erro.message.slice(0, 200)}`);
  }
}

// ------------------------------------------------------------------ validação

/**
 * Cada campo editável tem regra própria. Devolve o valor normalizado ou lança
 * com uma mensagem que explica o limite — o painel mostra ao usuário.
 */
const CAMPOS = {
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
    temCredencial: Boolean(process.env[h.usuarioEnvVar]),
    temAsaas: Boolean((h.asaas || {}).customerId),
    // Só os hangares com grupo cadastrado recebem mensagem; os demais são
    // recusados na entrada.
    ativo: Boolean((h.grupoWhatsappId || '').trim()),
    cotaUsada: obterUsoMensal(h.id),
    cotaRestante: obterRestante(h),
    historico: resumo[h.id] || { total: 0, validados: 0, comCota: 0, ultimo: null },
  }));

  return {
    hangares,
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
      if (dados.length > 100000) reject(new Error('Corpo grande demais.'));
    });
    req.on('end', () => {
      try { resolve(dados ? JSON.parse(dados) : {}); } catch (e) { reject(new Error('Corpo não é json válido.')); }
    });
    req.on('error', reject);
  });
}

const servidor = http.createServer(async (req, res) => {
  const usuario = autorizado(req);
  if (!usuario) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Validador"' });
    res.end('Acesso restrito.');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  // Escrita exige conta com permissão. Checado aqui, num lugar só, em vez de
  // em cada rota — esquecer numa rota nova seria fácil demais.
  if (req.method !== 'GET' && usuario.somenteLeitura) {
    json(res, 403, { erro: 'Sua conta é somente leitura.' });
    return;
  }

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      const html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8');
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(html);
      return;
    }

    if (url.pathname === '/api/usuarios') {
      if (req.method === 'GET') {
        json(res, 200, { usuarios: usuarios.listar(), minSenha: usuarios.MIN_SENHA, eu: usuario.nome });
        return;
      }
      if (req.method === 'POST') {
        const c = await lerCorpo(req);
        try {
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

    if (req.method === 'GET' && url.pathname === '/api/estado') {
      json(res, 200, montarEstado(usuario));
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
