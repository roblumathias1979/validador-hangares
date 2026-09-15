#!/usr/bin/env node
// Uso: node scripts/consultar-ticket.js <hangarId> <numeroTicket>
// Consulta um ticket SEM validar: abre o modal do ticket (mesmo modal usado
// para validar), lê Entrada/Tolerância, fecha o modal sem confirmar nada, e
// checa na lista de tickets validados da tela se ele já foi confirmado.
// Não mexe em placa, vagas ou sliders — é só leitura.
//
// Pensado para responder as opções "consultar se foi validado" e "consultar
// se está com validade ativa" do menu do bot no WhatsApp (a terceira opção,
// "validar o ticket", usa scripts/validate-ticket.js).

const { chromium } = require('playwright');
const { carregarConfig, buscarHangar, login } = require('./lib/hangar');

async function consultarTicket(hangarId, ticket) {
  const config = carregarConfig();
  const hangar = buscarHangar(config, hangarId);

  if (!hangar.validadorUrl) {
    throw new Error(`URL do validador não definida para o hangar "${hangarId}". Preencha config/hangares.json.`);
  }

  const seletores = hangar.seletores || {};
  for (const campo of ['campoUsuario', 'campoSenha', 'botaoLogin', 'campoTicket', 'modalDialog']) {
    if (!seletores[campo]) {
      throw new Error(`Seletor "${campo}" não definido para o hangar "${hangarId}". Preencha config/hangares.json depois de inspecionar o site real.`);
    }
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await login(page, hangar);

    await page.fill(seletores.campoTicket, ticket);
    await page.keyboard.press('Enter');

    // Além do modal (ticket existe, ainda não usado), o site pode responder
    // com um toast "Este ticket já foi utilizado!" — SEM abrir o modal. Isso
    // acontece mesmo para tickets de outros hangares (o número do ticket é
    // de um totem compartilhado do aeroporto, não exclusivo deste hangar),
    // então não aparece na lista '.card-ticket-validados' deste hangar.
    const resultadoBusca = await Promise.race([
      page.waitForSelector(seletores.modalDialog, { state: 'visible', timeout: 10000 })
        .then(() => ({ tipo: 'modal' })),
      seletores.areaErroToast
        ? page.waitForSelector(seletores.areaErroToast, { state: 'visible', timeout: 10000 })
            .then(async (el) => ({ tipo: 'toast', texto: (await el.textContent() || '').trim() }))
        : new Promise(() => {}),
    ]).catch(() => ({ tipo: 'nenhum' }));

    if (resultadoBusca.tipo === 'toast') {
      const jaUtilizado = /j[áa]\s+foi\s+utilizado/i.test(resultadoBusca.texto);
      return {
        status: 'consulta_ok',
        hangar: hangarId,
        ticket,
        jaValidado: jaUtilizado ? true : null,
        ativo: jaUtilizado ? false : null,
        mensagem: resultadoBusca.texto,
        mensagemWhatsapp: jaUtilizado
          ? `⚠️ Ticket ${ticket} já foi utilizado anteriormente (validado por este ou outro hangar).`
          : `⚠️ Não conseguimos consultar o ticket ${ticket}: ${resultadoBusca.texto}`,
      };
    }

    if (resultadoBusca.tipo !== 'modal') {
      return {
        status: 'ticket_nao_encontrado',
        hangar: hangarId,
        ticket,
        mensagemWhatsapp: `⚠️ Ticket ${ticket} não encontrado — verifique o número e tente novamente.`,
      };
    }

    // Campos "Entrada" e "Tolerância" são os dois primeiros <input> do modal
    // (somente leitura) — não têm id fixo, então lemos pela ordem dentro do
    // formulário, que é estável desde que o layout do modal não mude.
    const camposReadonly = page.locator(`${seletores.modalDialog} .modal-body input`);
    const entradaTexto = await camposReadonly.nth(0).inputValue().catch(() => '');
    const toleranciaTexto = await camposReadonly.nth(1).inputValue().catch(() => '');

    // Ticket já validado? Confere na lista de cards da tela principal
    // (fica atrás do modal, mas ainda presente no DOM). IMPORTANTE: a
    // "Tolerância" mostrada no MODAL é um valor de referência para uma NOVA
    // extensão (Entrada + 15min por padrão), não o prazo real já concedido —
    // confirmado comparando com o card, que tinha uma tolerância bem maior.
    // Por isso, para ticket já validado, usamos a tolerância do CARD, não a
    // do modal.
    const cardDoTicket = page.locator('.card-ticket-validados article').filter({ hasText: ticket });
    const jaValidado = await cardDoTicket.count().then((n) => n > 0).catch(() => false);

    let toleranciaReal = toleranciaTexto;
    if (jaValidado) {
      const textoCard = await cardDoTicket.first().textContent().catch(() => '');
      const matchTolerancia = (textoCard || '').match(/Toler[âa]ncia:\s*([\d/]+\s+[\d:]+)/i);
      if (matchTolerancia) {
        toleranciaReal = matchTolerancia[1];
      }
    }

    if (seletores.botaoFecharModal) {
      await page.click(seletores.botaoFecharModal).catch(() => {});
    }

    const tolerancia = parseDataBr(toleranciaReal);
    const ativo = tolerancia ? tolerancia.getTime() > Date.now() : null;

    let mensagemWhatsapp;
    if (jaValidado && ativo) {
      mensagemWhatsapp = `✅ Ticket ${ticket} já foi validado e está com validade ativa até ${toleranciaReal}.`;
    } else if (jaValidado && ativo === false) {
      mensagemWhatsapp = `⚠️ Ticket ${ticket} foi validado, mas a validade já expirou (venceu em ${toleranciaReal}).`;
    } else if (!jaValidado && ativo === false) {
      mensagemWhatsapp = `⚠️ Ticket ${ticket} ainda não foi validado e o prazo de tolerância de 15 minutos já venceu (${toleranciaReal}).`;
    } else {
      // Todo ticket impresso já sai com ~15min de tolerância gratuita. O bot
      // dizia aqui "ainda não precisa validar", o que na prática mandava o
      // cliente esperar — errado para quem vai deixar o veículo no hangar e
      // ficar: esse cliente precisa validar JÁ na entrada.
      //
      // Nada nunca impediu isso: validate-ticket.js não checa essa janela
      // (só formato, prazo de 2h e vagas) e o workflow do n8n decide por
      // `opcao === 3`, sem condição de tempo. O que faltava era a mensagem
      // não empurrar o cliente para depois.
      //
      // Cuidado ao validar aqui: com os sliders em 0 o site concede apenas a
      // tolerância padrão, que vence em minutos. Daí a mensagem pedir quanto
      // tempo o cliente vai ficar — a resposta alimenta
      // horasAdicionais/diasAdicionais do validate-ticket.js.
      mensagemWhatsapp = `ℹ️ Ticket ${ticket} ainda está na tolerância gratuita, que vai até ${toleranciaReal}. Se você for sair antes disso, não precisa validar nada. Se for deixar o veículo no hangar, me diga quanto tempo pretende ficar que eu já valido agora — não precisa esperar.`;
    }

    return {
      status: 'consulta_ok',
      hangar: hangarId,
      ticket,
      entrada: entradaTexto,
      tolerancia: toleranciaReal,
      jaValidado,
      ativo,
      mensagemWhatsapp,
    };
  } finally {
    await browser.close();
  }
}

// Converte "18/11/2025 13:37:47" (formato visto no ValidPark, hora de
// São Paulo) para Date. IMPORTANTE: precisa do offset -03:00 explícito —
// sem ele, o Date fica sujeito ao fuso horário do processo Node (no
// servidor, isso é UTC), o que desloca tudo em 3h e faz tickets recentes
// parecerem vencidos quando na verdade ainda estão dentro da tolerância.
function parseDataBr(texto) {
  const match = (texto || '').match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!match) return null;
  const [, dia, mes, ano, hora, min, seg] = match;
  return new Date(`${ano}-${mes}-${dia}T${hora}:${min}:${seg}-03:00`);
}

async function main() {
  const [hangarId, ticket] = process.argv.slice(2);
  if (!hangarId || !ticket) {
    console.log(JSON.stringify({
      status: 'parametros_invalidos',
      mensagem: 'Uso: node scripts/consultar-ticket.js <hangarId> <numeroTicket>',
      mensagemWhatsapp: '⚠️ Não conseguimos consultar o ticket no momento. Nossa equipe foi avisada.',
      notificarAdmin: true,
    }));
    return;
  }

  try {
    const resultado = await consultarTicket(hangarId, ticket);
    console.log(JSON.stringify(resultado));
  } catch (erro) {
    console.log(JSON.stringify({
      status: 'erro',
      hangar: hangarId,
      ticket,
      mensagem: erro.message,
      mensagemWhatsapp: `⚠️ Não conseguimos consultar o ticket ${ticket} no momento. Nossa equipe foi avisada.`,
      notificarAdmin: true,
    }));
    // Sai com 0 DE PROPÓSITO, mesmo em falha: quem decide o que fazer é o nó
    // seguinte do n8n, lendo o campo `status` do json. Código != 0 faz o nó
    // "Execute Command" tratar como falha e engolir o json — a mensagem se
    // perderia antes de chegar ao cliente. Mesmo padrão de identificar-hangar.js.
  }
}

main();
