/**
 * pdf-movimentacao.js — relatório de entrada/saída dos credenciados em PDF.
 *
 * Monta um HTML (com o logo do estacionamento) e renderiza em PDF pelo mesmo
 * Chromium que o projeto já usa para validar. Fica em um módulo próprio para a
 * geração do PDF não se misturar à lógica do bot e para o teste poder trocá-la.
 *
 * O PDF mostra TUDO (não corta em 40 como a mensagem de texto): num relatório, a
 * lista completa é justamente o que se quer.
 */

const fs = require('fs');
const path = require('path');

const LOGO = path.join(__dirname, '..', '..', 'painel', 'logo-1park.png');

let logoCache; // data URI, lido uma vez
function logoDataUri() {
  if (logoCache !== undefined) return logoCache;
  try { logoCache = `data:image/png;base64,${fs.readFileSync(LOGO).toString('base64')}`; }
  catch (e) { logoCache = ''; }
  return logoCache;
}

const escapar = (s) => String(s == null ? '' : s)
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

// Hora do dia a partir da datahora ("2026-10-06T11:15:23" → "11:15"); em faixa de
// vários dias, antepõe a data.
function horaDe(iso, umDia) {
  const s = String(iso || '');
  const h = (s.match(/T(\d{2}:\d{2})/) || [])[1] || '--:--';
  if (umDia) return h;
  const d = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  return d ? `${d[3]}/${d[2]} ${h}` : h;
}

function tabela(titulo, cor, lista, umDia, comEvento) {
  if (!lista.length) return '';
  const linhas = lista.map((m) => `<tr><td class="h">${escapar(horaDe(m.datahora, umDia))}</td>`
    + `<td>${escapar(m.nome || m.cartao || '—')}</td>`
    + (comEvento ? `<td class="ev">${escapar(m.evento)}</td>` : '') + '</tr>').join('');
  return `<h2 style="color:${cor}">${escapar(titulo)} <span class="cont">(${lista.length})</span></h2>`
    + `<table><thead><tr><th>Hora</th><th>Credenciado</th>${comEvento ? '<th>Evento</th>' : ''}</tr></thead>`
    + `<tbody>${linhas}</tbody></table>`;
}

function montarHtml({ hangar, tipo, nomeFiltro, periodoLabel, movimentos, limparNome }) {
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const umDia = !/ a | máx| dias$/.test(periodoLabel || '');
  const movs = (movimentos || []).map((m) => ({ ...m, nome: limparNome ? limparNome(m.nome, hangar) : m.nome }));
  const porHora = (a, b) => String(a.datahora).localeCompare(String(b.datahora));
  const entradas = movs.filter((m) => /entrada/.test(norm(m.evento))).sort(porHora);
  const saidas = movs.filter((m) => /saida/.test(norm(m.evento))).sort(porHora);
  const outros = movs.filter((m) => !/entrada|saida/.test(norm(m.evento))).sort(porHora);
  const assunto = nomeFiltro ? `Entradas e saídas de ${escapar(nomeFiltro)}` : (tipo === 'tudo' ? 'Movimentação' : 'Entradas e saídas');
  const geradoEm = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
  const logo = logoDataUri();

  return `<!doctype html><html><head><meta charset="utf-8"><style>
    * { box-sizing: border-box; }
    body { font: 12px/1.45 -apple-system, "Segoe UI", Roboto, Arial, sans-serif; color: #1a1d21; margin: 0; }
    .cab { display: flex; align-items: center; gap: 14px; border-bottom: 2px solid #1f232a; padding-bottom: 10px; margin-bottom: 14px; }
    .cab img { height: 42px; }
    .cab .t h1 { margin: 0; font-size: 18px; }
    .cab .t div { color: #667085; font-size: 12px; margin-top: 2px; }
    .resumo { color: #333; font-size: 12px; margin: 0 0 10px; }
    h2 { font-size: 13px; margin: 16px 0 6px; }
    .cont { color: #667085; font-weight: normal; font-size: 11px; }
    table { width: 100%; border-collapse: collapse; }
    th, td { text-align: left; padding: 4px 8px; border-bottom: 1px solid #e5e8ec; font-size: 12px; }
    th { background: #f3f5f7; color: #475467; font-size: 11px; text-transform: uppercase; letter-spacing: .3px; }
    td.h { white-space: nowrap; color: #475467; width: 90px; }
    td.ev { color: #667085; }
    .rodape { margin-top: 18px; color: #98a2b3; font-size: 10px; border-top: 1px solid #e5e8ec; padding-top: 6px; }
    .vazio { color: #667085; font-style: italic; }
  </style></head><body>
    <div class="cab">
      ${logo ? `<img src="${logo}" alt="1Park">` : ''}
      <div class="t"><h1>${assunto}</h1><div>${escapar(hangar.hangar || hangar.id)} · ${escapar(periodoLabel || 'hoje')}</div></div>
    </div>
    <p class="resumo"><b>${entradas.length}</b> entrada(s) · <b>${saidas.length}</b> saída(s)${outros.length ? ` · <b>${outros.length}</b> outro(s)` : ''}</p>
    ${movs.length ? '' : '<p class="vazio">Nenhum registro no período.</p>'}
    ${tabela('🟢 Entradas', '#067647', entradas, umDia, false)}
    ${tabela('🔴 Saídas', '#b42318', saidas, umDia, false)}
    ${tipo === 'tudo' ? tabela('Outros', '#475467', outros, umDia, true) : ''}
    <div class="rodape">Relatório gerado pelo validador 1Park em ${escapar(geradoEm)}.</div>
  </body></html>`;
}

// Gera o PDF e devolve em base64. `limparNome` (opcional) tira o prefixo do
// hangar do nome, igual à mensagem do WhatsApp.
async function gerarPdfMovimentacao({ hangar, tipo, nomeFiltro, periodoLabel, movimentos, limparNome }) {
  const html = montarHtml({ hangar, tipo, nomeFiltro, periodoLabel, movimentos, limparNome });
  const { chromium } = require('playwright');
  const navegador = await chromium.launch({ headless: true });
  try {
    const pagina = await navegador.newPage();
    await pagina.setContent(html, { waitUntil: 'load' });
    const buffer = await pagina.pdf({
      format: 'A4', printBackground: true,
      margin: { top: '14mm', bottom: '14mm', left: '12mm', right: '12mm' },
    });
    return buffer.toString('base64');
  } finally {
    await navegador.close();
  }
}

module.exports = { gerarPdfMovimentacao, montarHtml };
