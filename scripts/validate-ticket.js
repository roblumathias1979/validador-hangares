#!/usr/bin/env node
// Uso: node scripts/validate-ticket.js <hangarId> <numeroTicket> <placa> [dataEmissaoIso] [horasAdicionais] [diasAdicionais]
// Lê config/hangares.json, loga no validador do hangar, digita o ticket
// (o que abre um modal pedindo a placa do veículo) e confirma a validação.
// Se `dataEmissaoIso` for informado e o hangar tiver `prazoValidacaoHoras`
// configurado, bloqueia a validação sem nem abrir o navegador quando o
// ticket estiver fora do prazo (ex: emitido há mais de 2h).
//
// `horasAdicionais`/`diasAdicionais`: usado tanto para um ticket novo quanto
// para um ticket JÁ validado/ativo cujo cliente atrasou a saída — é o mesmo
// modal e o mesmo botão VALIDAR nos dois casos, só que com os sliders
// "+ Horas" / "+ Dias" movidos antes de confirmar, para estender a
// tolerância em vez de só validar pela primeira vez.
//
// Pensado para ser chamado a partir de um nó "Execute Command" do n8n,
// que recebe um JSON no stdout com o resultado.

const { chromium } = require('playwright');
const { carregarConfig, buscarHangar, login } = require('./lib/hangar');

// Limites confirmados dos sliders "+ Horas" / "+ Dias" no modal do ValidPark.
const SLIDER_MAX_HORAS = 24;
const SLIDER_MAX_DIAS = 20;

function validarFormatoTicket(hangar, ticket) {
  const regexStr = hangar.formatoTicket && hangar.formatoTicket.regex;
  if (!regexStr) return true; // formato ainda não definido — não bloquear
  return new RegExp(regexStr).test(ticket);
}

function dentroDoPrazo(hangar, dataEmissaoIso) {
  const prazoHoras = hangar.prazoValidacaoHoras;
  if (!prazoHoras || !dataEmissaoIso) return { ok: true }; // regra não configurada ou data não informada — não bloquear

  const emissao = new Date(dataEmissaoIso);
  if (Number.isNaN(emissao.getTime())) {
    throw new Error(`Data de emissão inválida: "${dataEmissaoIso}"`);
  }

  const horasDecorridas = (Date.now() - emissao.getTime()) / (1000 * 60 * 60);
  return {
    ok: horasDecorridas <= prazoHoras,
    horasDecorridas,
  };
}

async function ajustarSlider(page, seletorInputRange, quantidade) {
  if (!quantidade) return;
  if (!seletorInputRange) {
    throw new Error('Seletor do slider não configurado, mas horas/dias adicionais foram solicitados.');
  }
  // O slider é um MUI Slider com um <input type="range"> real por baixo do
  // thumb visível. Focar o thumb e apertar seta (ArrowRight) NÃO funciona —
  // testado e confirmado que o valor nunca muda (aria-valuenow fica em 0).
  // .fill() no próprio input funciona (confirmado com uma validação real).
  await page.locator(seletorInputRange).fill(String(quantidade));
}

async function validarTicket(hangarId, ticket, placa, dataEmissaoIso, horasAdicionais = 0, diasAdicionais = 0) {
  const config = carregarConfig();
  const hangar = buscarHangar(config, hangarId);

  if (!hangar.validadorUrl) {
    throw new Error(`URL do validador não definida para o hangar "${hangarId}". Preencha config/hangares.json.`);
  }
  if (!validarFormatoTicket(hangar, ticket)) {
    return {
      status: 'formato_invalido',
      hangar: hangarId,
      ticket,
      mensagem: 'Número de ticket não bate com o formato esperado.',
      mensagemWhatsapp: '⚠️ Não consegui reconhecer o número do ticket direito. Pode reenviar a foto ou digitar o número manualmente?',
      notificarAdmin: false,
    };
  }

  if (horasAdicionais > SLIDER_MAX_HORAS || diasAdicionais > SLIDER_MAX_DIAS) {
    return {
      status: 'valor_invalido',
      hangar: hangarId,
      ticket,
      mensagem: `Extensão pedida (${horasAdicionais}h / ${diasAdicionais}d) acima do limite do slider (máx ${SLIDER_MAX_HORAS}h / ${SLIDER_MAX_DIAS}d).`,
      mensagemWhatsapp: `⚠️ Não é possível estender o ticket ${ticket} por esse tempo — o máximo permitido é ${SLIDER_MAX_HORAS} horas ou ${SLIDER_MAX_DIAS} dias.`,
      notificarAdmin: false,
    };
  }

  const prazo = dentroDoPrazo(hangar, dataEmissaoIso);
  if (!prazo.ok) {
    return {
      status: 'fora_do_prazo',
      hangar: hangarId,
      ticket,
      mensagem: `Ticket emitido há ${prazo.horasDecorridas.toFixed(1)}h — acima do limite de ${hangar.prazoValidacaoHoras}h para validação.`,
      mensagemWhatsapp: `⚠️ Ticket ${ticket} está fora do prazo de ${hangar.prazoValidacaoHoras} horas da emissão para validação.`,
      notificarAdmin: false,
    };
  }

  const seletores = hangar.seletores || {};
  for (const campo of ['campoUsuario', 'campoSenha', 'botaoLogin', 'campoTicket', 'modalDialog', 'campoPlaca', 'botaoValidar', 'areaVagasDisponiveis']) {
    if (!seletores[campo]) {
      throw new Error(`Seletor "${campo}" não definido para o hangar "${hangarId}". Preencha config/hangares.json depois de inspecionar o site real.`);
    }
  }

  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await login(page, hangar);

    // Validar um ticket ocupa uma vaga até o veículo sair — não adianta
    // validar se não há vaga disponível no pátio.
    const vagasTexto = await page.textContent(seletores.areaVagasDisponiveis);
    const vagasMatch = (vagasTexto || '').match(/Dispon[íi]veis:\s*(\d+)/i);
    if (vagasMatch) {
      const vagasDisponiveis = Number(vagasMatch[1]);
      if (vagasDisponiveis <= 0) {
        return {
          status: 'sem_vagas',
          hangar: hangarId,
          ticket,
          mensagem: 'Nenhuma vaga disponível no pátio no momento.',
          mensagemWhatsapp: `⚠️ Não há vagas disponíveis no pátio no momento. Procure o totem de autopagamento no terminal do aeroporto para validação e pagamento.`,
          notificarAdmin: false,
        };
      }
    }
    // Se o texto não bateu com o padrão esperado, não bloqueia — melhor
    // seguir e deixar o próprio site recusar do que travar tudo por causa
    // de uma mudança de texto na tela.

    // Digitar o ticket abre um modal pedindo a placa do veículo — ou, se o
    // ticket já foi usado (mesmo por outro hangar, já que o número vem de um
    // totem compartilhado do aeroporto), mostra um toast em vez do modal.
    await page.fill(seletores.campoTicket, ticket);
    await page.keyboard.press('Enter');

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
        status: jaUtilizado ? 'ticket_ja_utilizado' : 'erro_validacao',
        hangar: hangarId,
        ticket,
        mensagem: resultadoBusca.texto,
        mensagemWhatsapp: jaUtilizado
          ? `⚠️ Ticket ${ticket} já foi utilizado anteriormente — não pode ser validado de novo.`
          : `⚠️ Não foi possível validar o ticket ${ticket}: ${resultadoBusca.texto}`,
        notificarAdmin: false,
      };
    }

    if (resultadoBusca.tipo !== 'modal') {
      return {
        status: 'ticket_nao_encontrado',
        hangar: hangarId,
        ticket,
        mensagem: 'Modal do ticket não abriu — o ticket pode não existir, ou o gatilho (Enter) mudou no site.',
        mensagemWhatsapp: `⚠️ Ticket ${ticket} não encontrado — verifique o número e tente novamente.`,
        notificarAdmin: false,
      };
    }

    await page.fill(seletores.campoPlaca, placa);

    if (horasAdicionais) {
      await ajustarSlider(page, seletores.sliderHorasThumb, horasAdicionais);
    }
    if (diasAdicionais) {
      await ajustarSlider(page, seletores.sliderDiasThumb, diasAdicionais);
    }

    await page.click(seletores.botaoValidar);

    // Esperar por: erro inline, toast de erro, ou o modal fechar (sucesso).
    const resultado = await Promise.race([
      page.waitForSelector(seletores.areaErroInline, { state: 'visible', timeout: 8000 })
        .then(async (el) => ({ status: 'erro_validacao', mensagem: (await el.textContent() || '').trim() })),
      seletores.areaErroToast
        ? page.waitForSelector(seletores.areaErroToast, { state: 'visible', timeout: 8000 })
            .then(async (el) => ({ status: 'erro_validacao', mensagem: (await el.textContent() || '').trim() }))
        : new Promise(() => {}),
      page.waitForSelector(seletores.modalDialog, { state: 'hidden', timeout: 8000 })
        .then(() => ({ status: 'validado', mensagem: 'Modal fechou após validar — confirmado como sucesso (novo card aparece em .card-ticket-validados).' })),
    ]).catch(() => ({ status: 'indeterminado', mensagem: 'Nenhum sinal de sucesso/erro apareceu no tempo esperado.' }));

    const extensaoTexto = [
      horasAdicionais ? `${horasAdicionais}h` : null,
      diasAdicionais ? `${diasAdicionais}d` : null,
    ].filter(Boolean).join(' e ');

    const mensagensWhatsapp = {
      validado: extensaoTexto
        ? `✅ Ticket ${ticket} validado com sucesso. Placa: ${placa}. Tolerância estendida em ${extensaoTexto}.`
        : `✅ Ticket ${ticket} validado com sucesso. Placa: ${placa}.`,
      erro_validacao: `⚠️ Não foi possível validar o ticket ${ticket}: ${resultado.mensagem}. Confira a placa e tente novamente.`,
      indeterminado: `⚠️ Não conseguimos confirmar a validação do ticket ${ticket}. Nossa equipe foi avisada e vai verificar manualmente.`,
    };

    return {
      status: resultado.status,
      hangar: hangarId,
      ticket,
      placa,
      mensagem: resultado.mensagem,
      mensagemWhatsapp: mensagensWhatsapp[resultado.status],
      notificarAdmin: resultado.status === 'indeterminado',
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const [hangarId, ticket, placa, dataEmissaoIso, horasAdicionaisStr, diasAdicionaisStr] = process.argv.slice(2);
  if (!hangarId || !ticket || !placa) {
    console.error('Uso: node scripts/validate-ticket.js <hangarId> <numeroTicket> <placa> [dataEmissaoIso] [horasAdicionais] [diasAdicionais]');
    process.exit(1);
  }

  const horasAdicionais = Number(horasAdicionaisStr) || 0;
  const diasAdicionais = Number(diasAdicionaisStr) || 0;

  try {
    const resultado = await validarTicket(hangarId, ticket, placa, dataEmissaoIso, horasAdicionais, diasAdicionais);
    console.log(JSON.stringify(resultado));
  } catch (erro) {
    console.log(JSON.stringify({
      status: 'erro',
      hangar: hangarId,
      ticket,
      placa,
      mensagem: erro.message,
      mensagemWhatsapp: `⚠️ Não conseguimos processar a validação do ticket ${ticket} no momento. Nossa equipe foi avisada.`,
      notificarAdmin: true,
    }));
    process.exit(1);
  }
}

main();
