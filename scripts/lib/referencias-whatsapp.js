/**
 * referencias-whatsapp.js — troca das fotos de referência de um pátio pelo
 * WhatsApp da administração, com área de espera e cópia das fotos anteriores.
 *
 * As fotos de referência (lib/referencias.js, data/referencias/<hangar>/) são o
 * que o bot compara com a foto do veículo do cliente. Fotos erradas enfraquecem
 * ou travam a conferência de local do pátio, então a troca é em DUAS etapas:
 *   1) as fotos mandadas no grupo vão para uma ÁREA DE ESPERA
 *      (data/referencias-pendentes/<hangar>/) — nada muda ainda;
 *   2) só no SIM da administração `aplicar` copia as atuais para
 *      data/referencias-anteriores/<hangar>/<data>/ e põe as novas no lugar.
 *
 * Por que a área de espera é uma PASTA e não a pendência: as fotos de um álbum
 * chegam quase juntas, cada uma processada por um processo diferente. Guardar a
 * lista na pendência faria cada processo reescrever a lista do outro e perder
 * fotos; um arquivo por foto não tem essa corrida.
 *
 * Vídeos de referência (só para consulta humana) NÃO são tocados na troca.
 */

const fs = require('fs');
const path = require('path');
const referencias = require('./referencias');

const DADOS = path.join(__dirname, '..', '..', 'data');
const PENDENTES = path.join(DADOS, 'referencias-pendentes');
const ANTERIORES = path.join(DADOS, 'referencias-anteriores');
const COPIAS_GUARDADAS = 3; // cópias das fotos anteriores, por pátio

const EXT = { 'image/jpeg': '.jpg', 'image/png': '.png', 'image/webp': '.webp' };
const MIME = { '.jpg': 'image/jpeg', '.png': 'image/png', '.webp': 'image/webp' };

function seguro(hangarId) {
  const s = String(hangarId || '').replace(/[^a-z0-9._-]/gi, '');
  if (!s || s.startsWith('.')) throw new Error('Identificador de hangar inválido.');
  return s;
}

/** Quantas imagens de referência o pátio tem hoje (as que entram na conferência). */
function contarAtuais(hangarId) {
  return referencias.listar(hangarId).filter((a) => a.usadoNaConferencia).length;
}

function listarPendentes(hangarId) {
  const pasta = path.join(PENDENTES, seguro(hangarId));
  try { return fs.readdirSync(pasta).sort().map((n) => path.join(pasta, n)); } catch (e) { return []; }
}

/**
 * Põe uma foto na área de espera. Recusa o que não for imagem aceita ou passar
 * do limite de tamanho. Devolve {ok, total} ou {ok:false, motivo}.
 */
function guardarPendente(hangarId, { mimetype, base64, idMensagem }) {
  const ext = EXT[mimetype];
  if (!ext) return { ok: false, motivo: 'Só aceito imagem JPEG, PNG ou WebP.' };
  const dados = Buffer.from(base64 || '', 'base64');
  if (!dados.length) return { ok: false, motivo: 'A foto veio vazia.' };
  if (dados.length > referencias.MAX_BYTES) {
    return { ok: false, motivo: `A foto tem ${(dados.length / 1048576).toFixed(1)} MB — o limite é ${referencias.MAX_BYTES / 1048576} MB.` };
  }
  const pasta = path.join(PENDENTES, seguro(hangarId));
  fs.mkdirSync(pasta, { recursive: true, mode: 0o700 });
  const id = String(idMensagem || Math.random()).replace(/[^a-z0-9]/gi, '').slice(0, 24) || 'foto';
  // O prefixo de hora mantém a ordem de chegada; o id da mensagem evita colisão
  // entre fotos do mesmo álbum e torna a regravação da mesma foto idempotente.
  const nome = `${String(Date.now()).padStart(14, '0')}-${id}${ext}`;
  const existente = fs.readdirSync(pasta).find((n) => n.endsWith(`-${id}${ext}`));
  if (!existente) fs.writeFileSync(path.join(pasta, nome), dados, { mode: 0o600 });
  return { ok: true, total: fs.readdirSync(pasta).length };
}

function limparPendentes(hangarId) {
  fs.rmSync(path.join(PENDENTES, seguro(hangarId)), { recursive: true, force: true });
}

/**
 * Troca as fotos do pátio pelas pendentes (as `MAX_IMAGENS` primeiras). As atuais
 * vão para uma cópia datada antes de sair; se algo falhar no meio, as atuais são
 * recolocadas e o erro sobe — o pátio nunca fica sem fotos por causa da troca.
 */
function aplicar(hangarId, agora = new Date()) {
  const id = seguro(hangarId);
  const novas = listarPendentes(id).slice(0, referencias.MAX_IMAGENS);
  if (!novas.length) throw new Error('Não há fotos novas para aplicar.');

  const atuais = referencias.listar(id).filter((a) => a.usadoNaConferencia);
  const copia = path.join(ANTERIORES, id, agora.toISOString().replace(/[:.]/g, '-'));
  if (atuais.length) {
    fs.mkdirSync(copia, { recursive: true, mode: 0o700 });
    for (const a of atuais) fs.writeFileSync(path.join(copia, a.nome), referencias.conteudo(id, a.nome).dados);
  }

  try {
    for (const a of atuais) referencias.apagar(id, a.nome);
    for (const arq of novas) {
      referencias.guardar(id, { mimetype: MIME[path.extname(arq).toLowerCase()], base64: fs.readFileSync(arq).toString('base64'), rotulo: 'whatsapp' });
    }
  } catch (erro) {
    // Desfaz: tira o que entrou e devolve as de antes, COPIANDO os arquivos de volta
    // com os nomes originais — sem passar pela função que acabou de falhar.
    for (const a of referencias.listar(id).filter((x) => x.usadoNaConferencia)) { try { referencias.apagar(id, a.nome); } catch (e) { /* já saiu */ } }
    const pasta = path.join(DADOS, 'referencias', id);
    fs.mkdirSync(pasta, { recursive: true });
    for (const a of atuais) { try { fs.copyFileSync(path.join(copia, a.nome), path.join(pasta, a.nome)); } catch (e) { /* melhor esforço */ } }
    throw new Error(`Não consegui trocar as fotos (${erro.message}). Mantive as de antes.`);
  }

  limparPendentes(id);
  // Guarda só as últimas cópias.
  try {
    const pasta = path.join(ANTERIORES, id);
    const todas = fs.readdirSync(pasta).sort();
    for (const velha of todas.slice(0, Math.max(0, todas.length - COPIAS_GUARDADAS))) fs.rmSync(path.join(pasta, velha), { recursive: true, force: true });
  } catch (e) { /* sem cópias antigas: nada a podar */ }
  return { novas: novas.length, substituidas: atuais.length, copia: atuais.length ? copia : null };
}

module.exports = { contarAtuais, listarPendentes, guardarPendente, limparPendentes, aplicar, PENDENTES, ANTERIORES, COPIAS_GUARDADAS };
