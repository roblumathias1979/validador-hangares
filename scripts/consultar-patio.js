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

/**
 * Acrescenta uma lista inteira, cortando só pelo LIMITE DO WHATSAPP.
 *
 * Antes havia um teto fixo — 10 tickets, 20 credenciados — e o "e mais N" no
 * fim. Mas o "Ver mais" do WhatsApp expande o que foi ENVIADO: os itens que o
 * bot cortou nunca saíram daqui, então tocar nele não revelava nada. Quem
 * precisava da lista completa não tinha como chegar nela.
 *
 * O teto real é o da mensagem do WhatsApp, 4096 caracteres. Reservamos folga
 * para o cabeçalho e os avisos que vêm depois, e só então cortamos — dizendo
 * quantos ficaram de fora, que aí é limite de verdade e não escolha nossa.
 */
const LIMITE_WHATSAPP = 4096;
const FOLGA_CABECALHO = 600;

function acrescentarLista(linhas, itens, formatar) {
  const jaUsado = linhas.join('\n').length;
  let orcamento = LIMITE_WHATSAPP - FOLGA_CABECALHO - jaUsado;
  let mostrados = 0;

  for (const item of itens) {
    const linha = formatar(item);
    if (linha.length + 1 > orcamento) break;
    linhas.push(linha);
    orcamento -= linha.length + 1;
    mostrados += 1;
  }

  if (mostrados < itens.length) {
    linhas.push(`_(mais ${itens.length - mostrados} não couberam nesta mensagem)_`);
  }
  return mostrados;
}

/**
 * A mensagem do pátio, com as partes que foram pedidas.
 *
 * `partes` é 'tickets', 'credenciados' ou 'ambos'. Os CONTADORES vão sempre:
 * são duas linhas e respondem a pergunta mais comum — quantas vagas restam —
 * sem que ninguém precise pedir.
 */
function montarMensagemPatio(hangar, d, partes = 'ambos') {
  const linhas = [`📊 *${hangar.hangar || hangar.id}*`, ''];
  acrescentarContadores(linhas, d);
  if (partes === 'tickets' || partes === 'ambos') acrescentarValidados(linhas, d);
  if (partes === 'credenciados' || partes === 'ambos') acrescentarCredenciados(linhas, hangar, d);
  if (d.doCache) linhas.push('', '_dados de até 1 minuto atrás_');
  return linhas.join('\n');
}

/** Vagas e ocupação. Vão sempre: respondem a pergunta mais comum em 2 linhas. */
function acrescentarContadores(linhas, d) {
  if (d.total === null) {
    linhas.push('Não consegui ler o contador de vagas do site.');
    return;
  }
  linhas.push(`Vagas: ${d.disponiveis} livres de ${d.total}`);
  if (d.utilizadas === null) return;
  const detalhe = [
    d.tickets !== null ? `${d.tickets} por ticket` : null,
    d.credenciados !== null ? `${d.credenciados} credenciados` : null,
  ].filter(Boolean).join(', ');
  linhas.push(`Ocupadas: ${d.utilizadas}${detalhe ? ` (${detalhe})` : ''}`);
}

/** Os tickets que o ValidPark mostra como validados. */
function acrescentarValidados(linhas, d) {
  if (!d.validados.length) {
    linhas.push('', 'Nenhum ticket validado aparece na lista do site agora.');
    return;
  }
  linhas.push('', `*Tickets validados* (${d.validados.length}):`);
  acrescentarLista(linhas, d.validados, (v) =>
    `• ${v.ticket || '(sem número)'} — ${v.placa || 'sem placa'}${v.tolerancia ? ` — até ${v.tolerancia}` : ''}`);
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
/** Quem está no pátio, da foto que o coletor do aeroporto manda. */
function acrescentarCredenciados(linhas, hangar, d) {
  // A LISTA não existe no ValidPark — só o total. Ela vem da API do
  // TECHPARKING, no aeroporto, por uma ponte que pode não estar de pé. Quando
  // está, responde o que sempre faltou; quando não está, o bot diz o que sabe
  // e por que não sabe o resto, em vez de fingir que a informação não existe.
  const c = snapshot.credenciadosDoPatio(hangar.bolsaoTechparking);
  if (c.semVinculo) {
    linhas.push('', '_A lista de nomes não está ligada a este pátio. A administração precisa informar o bolsão correspondente no painel._');
    return;
  }
  if (!c.existe) {
    linhas.push('', '_A lista de nomes ainda não chegou do sistema do aeroporto._');
    return;
  }
  if (!c.fresca) {
    // Dizer "está velho" em vez de mostrar: uma lista de meia hora atrás faz
    // quem pergunta decidir errado achando que está informado.
    linhas.push('', `_A lista de nomes está desatualizada (última atualização há ${Math.round(c.idadeMs / 60000)} min). Não vou mostrá-la para não induzir a erro._`);
    return;
  }
  if (!c.lista.length) {
    linhas.push('', 'Nenhum credenciado neste pátio no momento.');
    return;
  }

  linhas.push('', `*Credenciados no pátio* (${c.lista.length}):`);
  acrescentarLista(linhas, c.lista, (p) =>
    `• ${p.nome || '(sem nome)'}${p.placa ? ` — ${p.placa}` : ''}${desdeQuando(p.desde)}`);

  // Divergência entre as duas fontes: só avisa quando é GRANDE o bastante para
  // significar alguma coisa.
  //
  // Um ou dois de diferença é o normal: a leitura do ValidPark e a foto do
  // aeroporto acontecem em instantes diferentes, e basta um carro entrar no
  // meio. O aviso disparou com 15 contra 16 num teste real (29/09/2026), e
  // minutos depois as duas fontes diziam 16 — não havia nada errado, só um
  // carro em movimento. Avisar disso todo dia ensina a ignorar o aviso, e aí
  // ele não serve quando a diferença for de verdade.
  const diferenca = Math.abs((d.credenciados ?? 0) - c.lista.length);
  if (d.credenciados !== null && diferenca >= 3) {
    linhas.push('', `_O ValidPark conta ${d.credenciados} e esta lista tem ${c.lista.length}. `
      + 'Diferença grande demais para ser só o intervalo entre as leituras — vale conferir._');
  }
}

/** Compatibilidade: o formato "só credenciados" continua existindo. */
function montarMensagemCredenciados(hangar, d) {
  return montarMensagemPatio(hangar, d, 'credenciados');
}

/** Compatibilidade: o formato "só tickets". */
function montarMensagem(hangar, d) {
  return montarMensagemPatio(hangar, d, 'tickets');
}

/** Traduz o formato pedido nas partes da mensagem. */
function partesDe(formato) {
  if (formato === 'credenciados') return 'credenciados';
  if (formato === 'ambos') return 'ambos';
  return 'tickets';
}

async function consultarPatio(hangarId, { usarCache = true, formato = 'status' } = {}) {
  const hangar = buscarHangar(carregarConfig(), hangarId);

  if (usarCache) {
    const c = lerCache(hangarId);
    if (c) {
      return { ...c, doCache: true, mensagemWhatsapp: montarMensagemPatio(hangar, { ...c, doCache: true }, partesDe(formato)) };
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
    return { ...dados, doCache: false, mensagemWhatsapp: montarMensagemPatio(hangar, { ...dados, doCache: false }, partesDe(formato)) };
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

module.exports = { consultarPatio, extrairValidados, montarMensagem, montarMensagemCredenciados, montarMensagemPatio };
