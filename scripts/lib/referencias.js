/**
 * referencias.js — fotos de referência do pátio de cada hangar.
 *
 * Usadas pelos hangares com `exigeFotoVeiculoNoLocal` (hoje AIBM 1 e 2) para
 * conferir se a foto do cliente foi tirada no lugar certo.
 *
 * POR QUE ISTO EXISTE
 * Até 16/09/2026 a conferência comparava a foto do cliente apenas com uma
 * DESCRIÇÃO EM TEXTO do pátio. Funciona, mas depende de alguém descrever bem o
 * lugar e manter o texto atualizado. Com as fotos, o modelo compara imagem com
 * imagem, que é o que uma pessoa faria.
 *
 * O texto NÃO foi descartado: ele continua guiando o que olhar (piso, parede,
 * cobertura). Foto sem texto deixaria o modelo decidir sozinho o que é
 * relevante; texto sem foto depende de uma descrição perfeita. Os dois juntos
 * é o que mais se aproxima de "olhe esta foto e diga se é o mesmo lugar".
 *
 * ONDE FICA: data/referencias/<hangarId>/, fora do git. São fotos do pátio,
 * dado operacional que muda quando o lugar muda — não configuração.
 *
 * VÍDEO: aceito para consulta humana, mas NÃO entra na conferência automática.
 * O modelo de visão recebe imagens, não vídeo. Isso está sinalizado no painel
 * para ninguém subir um vídeo achando que melhora a checagem.
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..', 'data', 'referencias');

// 3 fotos por hangar: o suficiente para cobrir ângulos diferentes do mesmo
// pátio sem inflar demais cada chamada ao modelo — cada imagem entra na conta.
const MAX_IMAGENS = 3;
const MAX_BYTES = 3 * 1024 * 1024;

const TIPOS = {
  'image/jpeg': { ext: '.jpg', imagem: true },
  'image/png': { ext: '.png', imagem: true },
  'image/webp': { ext: '.webp', imagem: true },
  'video/mp4': { ext: '.mp4', imagem: false },
  'video/quicktime': { ext: '.mov', imagem: false },
};

function pastaDe(hangarId) {
  // hangarId vem do config, mas nunca confie: um id com ".." escaparia da
  // pasta de dados e escreveria em qualquer lugar do servidor.
  const seguro = String(hangarId || '').replace(/[^a-z0-9._-]/gi, '');
  if (!seguro || seguro.startsWith('.')) throw new Error('Identificador de hangar inválido.');
  return path.join(RAIZ, seguro);
}

function listar(hangarId) {
  const pasta = pastaDe(hangarId);
  let nomes = [];
  try { nomes = fs.readdirSync(pasta); } catch (e) { return []; }
  return nomes.sort().map((nome) => {
    const info = fs.statSync(path.join(pasta, nome));
    const ext = path.extname(nome).toLowerCase();
    const tipo = Object.entries(TIPOS).find(([, v]) => v.ext === ext);
    return {
      nome,
      bytes: info.size,
      em: info.mtime.toISOString(),
      mimetype: tipo ? tipo[0] : 'application/octet-stream',
      // Só as imagens entram na conferência automática.
      usadoNaConferencia: tipo ? tipo[1].imagem : false,
    };
  });
}

function guardar(hangarId, { mimetype, base64, rotulo }) {
  const tipo = TIPOS[mimetype];
  if (!tipo) throw new Error(`Tipo não aceito: ${mimetype}. Use JPEG, PNG, WebP, MP4 ou MOV.`);

  const dados = Buffer.from(base64, 'base64');
  if (!dados.length) throw new Error('Arquivo vazio.');
  if (dados.length > MAX_BYTES) {
    throw new Error(`Arquivo de ${(dados.length / 1048576).toFixed(1)} MB — o limite é ${MAX_BYTES / 1048576} MB.`);
  }

  const atuais = listar(hangarId);
  if (tipo.imagem && atuais.filter((a) => a.usadoNaConferencia).length >= MAX_IMAGENS) {
    throw new Error(`Já há ${MAX_IMAGENS} imagens de referência. Apague uma antes de subir outra — cada imagem entra em toda chamada ao modelo.`);
  }

  const pasta = pastaDe(hangarId);
  fs.mkdirSync(pasta, { recursive: true });
  const limpo = String(rotulo || 'referencia').toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 30) || 'referencia';
  const nome = `${Date.now()}-${limpo}${tipo.ext}`;
  fs.writeFileSync(path.join(pasta, nome), dados);
  return { nome, bytes: dados.length, usadoNaConferencia: tipo.imagem };
}

function apagar(hangarId, nome) {
  // Mesmo cuidado do hangarId: o nome vem da tela e não pode apontar para fora.
  if (!/^[a-z0-9._-]+$/i.test(nome || '') || nome.includes('..')) throw new Error('Nome de arquivo inválido.');
  const alvo = path.join(pastaDe(hangarId), nome);
  if (!fs.existsSync(alvo)) throw new Error('Arquivo não encontrado.');
  fs.unlinkSync(alvo);
  return { apagado: nome };
}

function conteudo(hangarId, nome) {
  if (!/^[a-z0-9._-]+$/i.test(nome || '') || nome.includes('..')) throw new Error('Nome de arquivo inválido.');
  const alvo = path.join(pastaDe(hangarId), nome);
  const ext = path.extname(nome).toLowerCase();
  const tipo = Object.entries(TIPOS).find(([, v]) => v.ext === ext);
  return { dados: fs.readFileSync(alvo), mimetype: tipo ? tipo[0] : 'application/octet-stream' };
}

/**
 * As imagens que devem acompanhar a chamada ao modelo, já em base64.
 * Vídeos ficam de fora: o modelo de visão não os recebe.
 */
function imagensParaConferencia(hangarId) {
  return listar(hangarId)
    .filter((a) => a.usadoNaConferencia)
    .map((a) => {
      const c = conteudo(hangarId, a.nome);
      return { mimetype: c.mimetype, base64: c.dados.toString('base64'), nome: a.nome };
    });
}

module.exports = { listar, guardar, apagar, conteudo, imagensParaConferencia, MAX_IMAGENS, MAX_BYTES, TIPOS };
