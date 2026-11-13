/**
 * extrair-quadros.js — tira fotos (quadros) de um vídeo, para servirem de
 * referência do pátio. O modelo de visão que confere o local recebe IMAGENS, não
 * vídeo; então, para aproveitar um vídeo, o bot extrai alguns quadros espaçados
 * ao longo dele (com o `ffmpeg` do servidor) e os trata como fotos.
 *
 * Qualidade: um vídeo andando traz quadros borrados. Para cada "fatia" do vídeo
 * extrai-se três candidatos muito próximos e fica o de maior tamanho em JPEG —
 * quadro nítido tem mais detalhe, comprime menos e pesa mais do que o borrado do
 * mesmo instante. É uma heurística barata, não um juiz: por isso o bot MOSTRA os
 * quadros no grupo antes de a administração aprovar.
 *
 * Sem shell: os argumentos vão direto ao ffmpeg (nada do vídeo vira comando).
 * Arquivos temporários ficam numa pasta 0700, apagada no fim, dê o que der.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const child = require('child_process');

const MAX_SEGUNDOS = 60;
const MAX_BYTES_VIDEO = 30 * 1024 * 1024;
const LARGURA_MAX = 1280;

function erro(codigo, mensagem) { const e = new Error(mensagem); e.codigo = codigo; return e; }

function rodar(executar, cmd, args) {
  try {
    return executar(cmd, args, { encoding: 'utf-8', timeout: 60000, maxBuffer: 10 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (e && e.code === 'ENOENT') throw erro('sem_ffmpeg', 'O programa ffmpeg não está instalado no servidor.');
    throw erro('ffmpeg', `ffmpeg falhou: ${String((e && (e.stderr || e.message)) || e).slice(0, 200)}`);
  }
}

/** Instantes (s) do centro de cada fatia: 5 quadros em 10 s -> 1, 3, 5, 7 e 9. */
function instantes(duracao, quantidade) {
  return Array.from({ length: quantidade }, (_, k) => (duracao * (k + 0.5)) / quantidade);
}

/**
 * @param {string} base64     o vídeo, em base64
 * @param {object} opcoes     { quantidade (padrão 5), executar (para teste) }
 * @returns {Array<{base64, mimetype, instante}>} em ordem de tempo
 */
function extrairQuadros(base64, { quantidade = 5, executar = child.execFileSync } = {}) {
  const bytes = Buffer.from(base64 || '', 'base64');
  if (!bytes.length) throw erro('vazio', 'O vídeo veio vazio.');
  if (bytes.length > MAX_BYTES_VIDEO) throw erro('grande', `O vídeo tem ${(bytes.length / 1048576).toFixed(0)} MB — o limite é ${MAX_BYTES_VIDEO / 1048576} MB.`);

  const pasta = fs.mkdtempSync(path.join(os.tmpdir(), 'quadros-'));
  try {
    fs.chmodSync(pasta, 0o700);
    const entrada = path.join(pasta, 'entrada.mp4');
    fs.writeFileSync(entrada, bytes, { mode: 0o600 });

    const saida = rodar(executar, 'ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', entrada]);
    const duracao = parseFloat(String(saida).trim());
    if (!Number.isFinite(duracao) || duracao <= 0) throw erro('ilegivel', 'Não consegui ler a duração do vídeo.');
    if (duracao > MAX_SEGUNDOS + 1) throw erro('longo', `O vídeo tem ${Math.round(duracao)} s — o limite é ${MAX_SEGUNDOS} s.`);

    const delta = Math.min(0.5, duracao / (quantidade * 6));
    const quadros = [];
    instantes(duracao, quantidade).forEach((t, k) => {
      let melhor = null;
      [-delta, 0, delta].forEach((d, c) => {
        const instante = Math.min(Math.max(t + d, 0), Math.max(duracao - 0.1, 0));
        const arq = path.join(pasta, `q${k}-${c}.jpg`);
        try {
          rodar(executar, 'ffmpeg', ['-nostdin', '-loglevel', 'error', '-ss', instante.toFixed(2), '-i', entrada, '-frames:v', '1',
            '-vf', `scale='min(${LARGURA_MAX},iw)':-2`, '-q:v', '3', '-y', arq]);
        } catch (e) { if (e.codigo === 'sem_ffmpeg') throw e; return; }
        if (!fs.existsSync(arq)) return;
        const tamanho = fs.statSync(arq).size;
        if (tamanho > 0 && (!melhor || tamanho > melhor.tamanho)) melhor = { arq, tamanho, instante };
      });
      if (melhor) quadros.push({ base64: fs.readFileSync(melhor.arq).toString('base64'), mimetype: 'image/jpeg', instante: Number(melhor.instante.toFixed(2)) });
    });
    if (!quadros.length) throw erro('ffmpeg', 'Não consegui extrair nenhum quadro do vídeo.');
    return quadros;
  } finally {
    fs.rmSync(pasta, { recursive: true, force: true });
  }
}

module.exports = { extrairQuadros, instantes, MAX_SEGUNDOS, MAX_BYTES_VIDEO };
