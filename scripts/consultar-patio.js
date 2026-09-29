#!/usr/bin/env node
// Uso: node scripts/consultar-patio.js <hangarId> [--sem-cache]
//
// Lê a situação do pátio no ValidPark: vagas livres, ocupadas, quantos são
// ticket e quantos são credenciado, mais a lista de tickets validados que o
// site mostra.
//
// Pensado para responder no WhatsApp quando alguém pergunta o status do pátio.
//
// CACHE DE 60 SEGUNDOS, e não é detalhe: cada consulta abre um Chromium e faz
// login, o que leva ~10s e pesa numa máquina de 2 GB. Sem cache, três pessoas
// perguntando ao mesmo tempo num grupo derrubariam o servidor — e a resposta
// seria idêntica, porque o pátio não muda a cada segundo.
//
// Só leitura: não valida nem altera nada.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');
const { carregarConfig, buscarHangar, login } = require('./lib/hangar');
const snapshot = require('./lib/snapshot-techparking');
const { lerData } = require('./lib/fiscalizacao');

const CACHE = path.join(__dirname, '..', 'data', 'cache-patio.json');
const CACHE_MS = 60 * 1000;

const REGEX_CONTADORES = {
  total: /Total de vagas:\s*(\d+)/i,
  // Aceita negativo: o site mostra "Disponiveis: -1" quando o pátio passa da
  // capacidade. Ver a nota em validate-ticket.js — lá isso desligava o guarda.
  disponiveis: /Dispon[íi]veis:\s*(-?\d+)/i,
  utilizadas: /Utilizadas:\s*(\d+)/i,
  tickets: /Tickets:\s*(\d+)/i,
  credenciados: /Credenciados:\s*(\d+)/i,
};

/**
 * O site junta todos os cards validados num único elemento, com os campos
 * separados por quebra de linha. Cada entrada começa em "Placa:", então é por
 * aí que separamos — não há um seletor por card.
 */
function extrairValidados(texto) {
  return (texto || '')
    .split(/(?=Placa:)/g)
    .map((bloco) => bloco.replace(/\s+/g, ' ').trim())
    .filter((bloco) => bloco.startsWith('Placa:'))
    .map((bloco) => ({
      placa: (bloco.match(/Placa:\s*([^\s|]+)/i) || [])[1] || null,
      entrada: (bloco.match(/Entrada:\s*([\d/]+\s[\d:]+)/i) || [])[1] || null,
      tolerancia: (bloco.match(/Toler[âa]ncia:\s*([\d/]+\s[\d:]+)/i) || [])[1] || null,
      validadoPor: (bloco.match(/Validado por:\s*([^\s|]+)/i) || [])[1] || null,
      // O número do ticket aparece solto no fim do card, depois de tudo.
      ticket: (bloco.match(/\b(\d{12})\b/) || [])[1] || null,
    }));
}

function lerCache(hangarId) {
  try {
    const c = JSON.parse(fs.readFileSync(CACHE, 'utf-8'))[hangarId];
    if (c && Date.now() - new Date(c.em).getTime() < CACHE_MS) return c;
  } catch (e) { /* sem cache */ }
  return null;
}

function gravarCache(hangarId, dados) {
  try {
    let tudo = {};
    try { tudo = JSON.parse(fs.readFileSync(CACHE, 'utf-8')); } catch (e) { /* novo */ }
    tudo[hangarId] = dados;
    fs.mkdirSync(path.dirname(CACHE), { recursive: true });
    fs.writeFileSync(CACHE, JSON.stringify(tudo, null, 2));
  } catch (e) { /* cache é otimização; falhar aqui não pode derrubar a consulta */ }
}

function montarMensagem(hangar, d) {
  const linhas = [`📊 *${hangar.hangar || hangar.id}*`, ''];

  if (d.total !== null) {
    linhas.push(`Vagas: ${d.disponiveis} livres de ${d.total}`);
    if (d.utilizadas !== null) {
      const detalhe = [
        d.tickets !== null ? `${d.tickets} por ticket` : null,
        d.credenciados !== null ? `${d.credenciados} credenciados` : null,
      ].filter(Boolean).join(', ');
      linhas.push(`Ocupadas: ${d.utilizadas}${detalhe ? ` (${detalhe})` : ''}`);
    }
  } else {
    linhas.push('Não consegui ler o contador de vagas do site.');
  }

  if (d.validados.length) {
    linhas.push('', `*Tickets validados* (${d.validados.length} mais recentes):`);
    // Limite de 10 na mensagem: o site mostra ~21, e uma mensagem com todos
    // fica ilegível no celular. O resto continua no json, para o painel.
    for (const v of d.validados.slice(0, 10)) {
      linhas.push(`• ${v.ticket || '(sem número)'} — ${v.placa || 'sem placa'}${v.tolerancia ? ` — até ${v.tolerancia}` : ''}`);
    }
    if (d.validados.length > 10) linhas.push(`_(e mais ${d.validados.length - 10})_`);
  } else {
    linhas.push('', 'Nenhum ticket validado aparece na lista do site agora.');
  }

  if (d.doCache) linhas.push('', '_dados de até 1 minuto atrás_');
  return linhas.join('\n');
}

/**
 * Desde quando o veículo está no pátio.
 *
 * A data do TECHPARKING vem SEM FUSO ("2026-09-29T03:49:46") e é hora de
 * Jundiaí; o servidor roda em UTC. Ler sem fuso erraria três horas e mostraria
 * madrugada onde é fim de tarde — por isso passa por `lerData`, que é o mesmo
 * tratamento que a fiscalização já faz.
 *
 * Mostra a HORA quando é de hoje, e a data junto quando não é. Muitos
 * credenciados estão no pátio há dias, e "07:12" sozinho faria parecer que
 * chegaram hoje de manhã. O tempo decorrido vem junto porque é o que responde
 * de fato a "há quanto tempo esse carro está aí".
 */
function desdeQuando(texto) {
  const d = lerData(texto);
  if (!d) return '';

  const SP = { timeZone: 'America/Sao_Paulo' };
  const dia = (x) => x.toLocaleDateString('pt-BR', SP);
  const hora = d.toLocaleTimeString('pt-BR', { ...SP, hour: '2-digit', minute: '2-digit' });
  const ehHoje = dia(d) === dia(new Date());

  const horas = (Date.now() - d.getTime()) / 3600000;
  const decorrido = horas < 1 ? `${Math.max(1, Math.round(horas * 60))}min`
    : horas < 48 ? `${Math.round(horas)}h`
      : `${Math.round(horas / 24)}d`;

  return ` _(desde ${ehHoje ? hora : `${dia(d)} ${hora}`}, ${decorrido})_`;
}

/**
 * Resposta para quem pergunta QUEM são os credenciados.
 *
 * O ValidPark mostra apenas a CONTAGEM deles — não há lista, tabela ou seletor
 * com os nomes ou placas (verificado varrendo a página em 16/09/2026). Dos
 * tickets validados existe a lista completa; dos credenciados, só o número.
 *
 * Dizer isso é melhor que responder outra coisa no lugar: quem perguntou fica
 * sabendo onde procurar, em vez de achar que o bot falhou.
 */
function montarMensagemCredenciados(hangar, d) {
  const linhas = [`📊 *${hangar.hangar || hangar.id}*`, ''];
  if (d.credenciados !== null) {
    linhas.push(`Credenciados no pátio agora: *${d.credenciados}*`);
    if (d.utilizadas !== null && d.tickets !== null) {
      linhas.push(`(das ${d.utilizadas} vagas ocupadas, ${d.tickets} são por ticket)`);
    }
  } else {
    linhas.push('Não consegui ler a contagem de credenciados no site.');
  }

  // A LISTA não existe no ValidPark — só o total. Ela vem da API do
  // TECHPARKING, no aeroporto, por uma ponte que pode não estar de pé. Quando
  // está, responde o que sempre faltou; quando não está, o bot diz o que sabe
  // e por que não sabe o resto, em vez de fingir que a informação não existe.
  const c = snapshot.credenciadosDoPatio(hangar.bolsaoTechparking);
  if (c.semVinculo) {
    linhas.push('', '_A lista de nomes não está ligada a este pátio. A administração precisa informar o bolsão correspondente no painel._');
  } else if (!c.existe) {
    linhas.push('', '_A lista de nomes ainda não chegou do sistema do aeroporto._');
  } else if (!c.fresca) {
    // Dizer "está velho" em vez de mostrar: uma lista de meia hora atrás faz
    // quem pergunta decidir errado achando que está informado.
    linhas.push('', `_A lista de nomes está desatualizada (última atualização há ${Math.round(c.idadeMs / 60000)} min). Não vou mostrá-la para não induzir a erro._`);
  } else if (!c.lista.length) {
    linhas.push('', 'Nenhum credenciado neste pátio no momento.');
  } else {
    linhas.push('', `*Quem está no pátio* (${c.lista.length}):`);
    for (const p of c.lista.slice(0, 20)) {
      linhas.push(`• ${p.nome || '(sem nome)'}${p.placa ? ` — ${p.placa}` : ''}${desdeQuando(p.desde)}`);
    }
    if (c.lista.length > 20) linhas.push(`_(e mais ${c.lista.length - 20})_`);
    // A discrepância é informação, não defeito a esconder: as duas fontes são
    // sistemas diferentes e podem estar em momentos diferentes.
    if (d.credenciados !== null && d.credenciados !== c.lista.length) {
      linhas.push('', `_O ValidPark conta ${d.credenciados} e esta lista tem ${c.lista.length} — os dois sistemas podem estar defasados entre si._`);
    }
  }

  if (d.doCache) linhas.push('', '_dados de até 1 minuto atrás_');
  return linhas.join('\n');
}

async function consultarPatio(hangarId, { usarCache = true, formato = 'status' } = {}) {
  const hangar = buscarHangar(carregarConfig(), hangarId);

  if (usarCache) {
    const c = lerCache(hangarId);
    if (c) {
      const m = formato === 'credenciados' ? montarMensagemCredenciados : montarMensagem;
      return { ...c, doCache: true, mensagemWhatsapp: m(hangar, { ...c, doCache: true }) };
    }
  }

  const seletores = hangar.seletores || {};
  const navegador = await chromium.launch({ headless: true });
  try {
    const pagina = await navegador.newPage();
    await pagina.goto(hangar.validadorUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await login(pagina, hangar);

    // Mesma espera da validação: o site preenche o contador depois do login, e
    // ler cedo demais devolve string vazia.
    await pagina.locator(seletores.areaVagasDisponiveis)
      .filter({ hasText: REGEX_CONTADORES.disponiveis })
      .first().waitFor({ timeout: 15000 }).catch(() => {});

    const textoContador = (await pagina.textContent(seletores.areaVagasDisponiveis).catch(() => '')) || '';
    const numeros = {};
    for (const [nome, re] of Object.entries(REGEX_CONTADORES)) {
      const m = textoContador.match(re);
      numeros[nome] = m ? Number(m[1]) : null;
    }

    const textoValidados = (await pagina.locator('.card-ticket-validados').first().innerText().catch(() => '')) || '';
    const validados = extrairValidados(textoValidados);

    const dados = { status: 'patio_ok', hangar: hangarId, ...numeros, validados, em: new Date().toISOString() };
    gravarCache(hangarId, dados);
    const montar = formato === 'credenciados' ? montarMensagemCredenciados : montarMensagem;
    return { ...dados, doCache: false, mensagemWhatsapp: montar(hangar, { ...dados, doCache: false }) };
  } finally {
    await navegador.close();
  }
}

async function main() {
  const [hangarId, ...flags] = process.argv.slice(2);
  if (!hangarId) {
    console.log(JSON.stringify({
      status: 'parametros_invalidos',
      mensagem: 'Uso: node scripts/consultar-patio.js <hangarId> [--sem-cache]',
      mensagemWhatsapp: '⚠️ Não conseguimos consultar o pátio no momento. Nossa equipe foi avisada.',
      notificarAdmin: true,
    }));
    return;
  }
  try {
    console.log(JSON.stringify(await consultarPatio(hangarId, { usarCache: !flags.includes('--sem-cache') })));
  } catch (erro) {
    console.log(JSON.stringify({
      status: 'erro',
      hangar: hangarId,
      mensagem: erro.message,
      mensagemWhatsapp: '⚠️ Não consegui consultar o pátio agora. Nossa equipe foi avisada.',
      notificarAdmin: true,
    }));
  }
}

if (require.main === module) {
  main();
}

module.exports = { consultarPatio, extrairValidados, montarMensagem, montarMensagemCredenciados };
