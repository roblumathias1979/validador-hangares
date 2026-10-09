/**
 * servidor-info.js — a saúde da MÁQUINA (memória, swap, disco, carga, tempo
 * ligado, reinício pendente), para o "status do sistema" e para o monitor.
 *
 * `ler` mede (só leitura, instantâneo); `avaliar` decide cores e problemas a
 * partir dos números — pura, testável sem tocar no servidor.
 *
 * Limites (09/10/2026), escolhidos para avisar COM FOLGA — o monitor antigo só
 * reclamava de disco com menos de 1 GB livre, tarde demais:
 *  - disco: vermelho a partir de 85% usado ou menos de 2 GB livres; amarelo 70%;
 *  - memória disponível: vermelho abaixo de 300 MB; amarelo abaixo de 500 MB;
 *  - swap: amarelo acima de 50% (swap alto sem falta de memória não derruba nada);
 *  - carga: amarelo acima de 1,5 por CPU.
 */

const fs = require('fs');
const os = require('os');

function parseMeminfo(txt) {
  const kb = (nome) => { const m = String(txt || '').match(new RegExp(`^${nome}:\\s+(\\d+)`, 'm')); return m ? Number(m[1]) : 0; };
  return { memTotalMb: kb('MemTotal') / 1024, memDispMb: kb('MemAvailable') / 1024, swapTotalMb: kb('SwapTotal') / 1024, swapLivreMb: kb('SwapFree') / 1024 };
}

/** Saída de `df -Pk /` -> {discoTotalGb, discoLivreGb, discoUsoPct}. */
function parseDf(txt) {
  const l = String(txt || '').trim().split('\n').pop().split(/\s+/);
  const total = Number(l[1]) / 1024 / 1024;
  const livre = Number(l[3]) / 1024 / 1024;
  const usoPct = Number(String(l[4] || '').replace('%', ''));
  return { discoTotalGb: total, discoLivreGb: livre, discoUsoPct: Number.isFinite(usoPct) ? usoPct : null };
}

/** Lê a máquina. Nunca lança: o que não deu para medir vem como null. */
function ler() {
  const info = { erro: null };
  try { Object.assign(info, parseMeminfo(fs.readFileSync('/proc/meminfo', 'utf-8'))); } catch (e) { info.erro = `memória: ${e.message}`; }
  try {
    const out = require('child_process').execFileSync('df', ['-Pk', '/'], { encoding: 'utf-8', timeout: 10000 });
    Object.assign(info, parseDf(out));
  } catch (e) { info.erro = `${info.erro ? `${info.erro}; ` : ''}disco: ${e.message}`; }
  info.carga1 = os.loadavg()[0];
  info.cpus = os.cpus().length || 1;
  info.ligadoSeg = os.uptime();
  info.reinicioPendente = fs.existsSync('/var/run/reboot-required');
  return info;
}

const f1 = (n) => Number(n).toFixed(1).replace('.', ',');
const gb = (mb) => `${f1(mb / 1024)} GB`;

function checarMemoria(i) {
  if (!i || !i.memTotalMb) return { ok: true, detalhe: 'não medida' };
  const ok = i.memDispMb >= 300;
  return { ok, detalhe: `${Math.round(i.memDispMb)} MB disponíveis de ${gb(i.memTotalMb)}` };
}

function checarDisco(i) {
  if (!i || i.discoUsoPct == null) return { ok: false, detalhe: 'não consegui medir' };
  const ok = i.discoUsoPct < 85 && i.discoLivreGb >= 2;
  return { ok, detalhe: `${i.discoUsoPct}% usado, ${f1(i.discoLivreGb)} GB livres` };
}

function tempoLigado(seg) {
  const min = Math.floor(seg / 60);
  if (min < 60) return `${Math.max(1, min)} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h`;
  return `${Math.floor(h / 24)} dias`;
}

/** {linhas, problemas}: o bloco "Servidor" do status. */
function avaliar(i) {
  const linhas = [];
  const problemas = [];
  if (!i) return { linhas: ['⚪ Não consegui ler o servidor agora.'], problemas };

  if (i.memTotalMb) {
    const uso = Math.round(100 - (i.memDispMb / i.memTotalMb) * 100);
    const cor = i.memDispMb < 300 ? '🔴' : i.memDispMb < 500 ? '🟡' : '🟢';
    linhas.push(`${cor} Memória: ${Math.round(i.memDispMb)} MB livres de ${gb(i.memTotalMb)} (${uso}% em uso)`);
    if (cor === '🔴') problemas.push('memoria');
    if (i.swapTotalMb) {
      const sw = Math.round(100 - (i.swapLivreMb / i.swapTotalMb) * 100);
      linhas.push(`${sw > 50 ? '🟡' : '🟢'} Swap: ${sw}% em uso`);
    }
  }
  if (i.discoUsoPct != null) {
    const cor = i.discoUsoPct >= 85 || i.discoLivreGb < 2 ? '🔴' : i.discoUsoPct >= 70 ? '🟡' : '🟢';
    linhas.push(`${cor} Disco: ${i.discoUsoPct}% usado, ${f1(i.discoLivreGb)} GB livres`);
    if (cor === '🔴') problemas.push('disco');
  }
  if (typeof i.carga1 === 'number') {
    linhas.push(`${i.carga1 / (i.cpus || 1) > 1.5 ? '🟡' : '🟢'} Carga: ${f1(i.carga1)}`);
  }
  if (typeof i.ligadoSeg === 'number') linhas.push(`⚪ Ligado há ${tempoLigado(i.ligadoSeg)}`);
  linhas.push(i.reinicioPendente
    ? '🟡 Reinício pendente — mande *reiniciar sistema* → *2* num horário calmo'
    : '🟢 Reinício pendente: não');
  return { linhas, problemas };
}

module.exports = { parseMeminfo, parseDf, ler, avaliar, checarMemoria, checarDisco, tempoLigado };
