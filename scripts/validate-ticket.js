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
const { carregarConfig, buscarHangar, login, salvarAsaasCustomerId } = require('./lib/hangar');
const { calcularValorPermanencia, formatarReais } = require('./lib/precos');
const { obterRestante, consumirUmaValidacao } = require('./lib/cota-fora-prazo');
const { criarCobrancaBoleto, temDadosParaCriarCliente } = require('./lib/asaas');
const { registrarFaturamento } = require('./lib/faturamento');

// Prazo padrão do boleto gerado no Asaas quando o faturamento é acionado.
// Ainda não confirmado com o usuário qual deve ser o prazo real de
// vencimento — 5 dias é um placeholder razoável, fácil de ajustar depois.
const DIAS_VENCIMENTO_BOLETO = 5;

function dataVencimentoBoleto() {
  const data = new Date();
  data.setDate(data.getDate() + DIAS_VENCIMENTO_BOLETO);
  return data.toISOString().slice(0, 10); // YYYY-MM-DD, formato exigido pelo Asaas
}

// Limites confirmados dos sliders "+ Horas" / "+ Dias" no modal do ValidPark.
const SLIDER_MAX_HORAS = 24;
const SLIDER_MAX_DIAS = 20;

// Contador de vagas do pátio, que o site renderiza como
// "Total de vagas: 90 | Disponiveis: 30". Atenção: o site escreve
// "Disponiveis" SEM acento — o [íi] cobre as duas grafias caso mudem.
// Uma constante só para que a espera e a leitura do número não possam
// divergir de padrão (ver COMO_ESPERAR_VAGAS abaixo).
const REGEX_VAGAS_DISPONIVEIS = /Dispon[íi]veis:\s*(\d+)/i;
const TIMEOUT_VAGAS_MS = 15000;

// Depois de clicar em VALIDAR, o ValidPark usa o MESMO toast
// (.Toastify__toast) para sucesso E para erro. Ou seja: o que decide o
// resultado não é "apareceu um toast", é o TEXTO dele.
const REGEX_TOAST_SUCESSO = /validad[oa]\s+com\s+sucesso/i;
const REGEX_TOAST_JA_UTILIZADO = /j[áa]\s+foi\s+utilizado/i;
// O site tem um typo em "tolêrancia" — o [eê] cobre os dois casos.
const REGEX_TOAST_SEM_TOLERANCIA = /digite\s+uma\s+tol[eê]r[âa]ncia/i;
const TIMEOUT_RESULTADO_MS = 10000;

// O ValidPark preenche campos de erro "vazios" com caracteres zero-width:
// eles contam como conteúdo e deixam o elemento visível, mas não são texto
// legível. Sem limpar isso, um campo vazio se passa por mensagem de erro.
function textoLegivel(texto) {
  return (texto || '').replace(/[\u200B-\u200D\uFEFF]/g, '').trim();
}

// Decide o resultado de uma tentativa de validação a partir dos sinais lidos
// da tela. Separada de validarTicket() de propósito: é a parte que já errou
// (ver o comentário na chamada) e a única testável sem tocar o site real.
//
// A ordem importa. O toast é consultado primeiro porque é o único sinal que
// diz O QUE aconteceu; o erro inline só vale se tiver texto legível de
// verdade; e o modal fechado é a última reserva.
function classificarResultadoValidacao({ toastTexto, erroInline, modalFechado }) {
  if (REGEX_TOAST_SUCESSO.test(toastTexto)) {
    return { status: 'validado', mensagem: toastTexto };
  }
  if (REGEX_TOAST_JA_UTILIZADO.test(toastTexto)) {
    return { status: 'ticket_ja_utilizado', mensagem: toastTexto };
  }
  if (REGEX_TOAST_SEM_TOLERANCIA.test(toastTexto)) {
    return { status: 'tolerancia_obrigatoria', mensagem: toastTexto };
  }
  if (toastTexto) {
    return { status: 'erro_validacao', mensagem: toastTexto };
  }
  if (erroInline) {
    return { status: 'erro_validacao', mensagem: erroInline };
  }
  if (modalFechado) {
    return {
      status: 'validado',
      mensagem: 'Modal fechou após validar, sem toast legível — tratado como sucesso.',
    };
  }
  return {
    status: 'indeterminado',
    mensagem: 'Nenhum sinal de sucesso ou erro apareceu no tempo esperado.',
  };
}

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

// Decide o que fazer com um ticket fora do prazo de 2h: pedir pra usar 1 das
// validações fora do prazo do mês, pedir autorização de faturamento (cota
// esgotada), pedir a foto que falta, ou seguir validando (cota consumida /
// faturamento já autorizado). Separada de validarTicket() de propósito — é a
// parte testável sem tocar no site nem no Asaas.
//
// Regra de precedência (11/09/2026, confirmada com o usuário): a cota mensal
// (5 validações fora do prazo por hangar) SEMPRE tem prioridade sobre
// faturar. Se `autorizarFaturamento` vier true mas ainda sobrar cota, isso é
// tratado como estado inconsistente (ex: tela desatualizada do cliente) e o
// sistema ignora o pedido de faturamento, oferecendo a cota de graça em vez
// de cobrar por engano.
function decidirAcaoForaDoPrazo({ hangar, ticket, horasDecorridas, usarCotaForaPrazo, autorizarFaturamento, fotoAutorizacao, dadosCadastrais }) {
  const restante = obterRestante(hangar);

  if (autorizarFaturamento && restante <= 0) {
    const valor = calcularValorPermanencia(horasDecorridas);
    if (!fotoAutorizacao) {
      return {
        acao: 'falta_foto',
        valor,
        mensagemWhatsapp: `⚠️ Para autorizar o faturamento do ticket ${ticket} (R$ ${formatarReais(valor)}) preciso que você envie uma FOTO junto com a autorização. Pode reenviar com a foto?`,
      };
    }
    // Muitos hangares nunca faturaram antes (confirmado com o usuário,
    // 12/09/2026) e não têm cliente cadastrado no Asaas. Em vez de falhar,
    // pedimos os dados cadastrais — o cliente é criado na hora (ver
    // scripts/lib/asaas.js) e o customerId fica salvo em
    // config/hangares.json pra não precisar perguntar de novo.
    if (!temDadosParaCriarCliente(hangar, dadosCadastrais)) {
      return {
        acao: 'faltam_dados_cadastrais',
        valor,
        mensagemWhatsapp: `⚠️ Para faturar o ticket ${ticket} (R$ ${formatarReais(valor)}) preciso cadastrar o hangar "${hangar.hangar}" no Asaas — ainda não tem cliente registrado. Pode me passar o CNPJ, a razão social e um email de contato?`,
      };
    }
    return { acao: 'faturar', valor };
  }

  if (usarCotaForaPrazo && restante > 0) {
    return { acao: 'usar_cota' };
  }

  if (restante > 0) {
    return {
      acao: 'perguntar_cota',
      restante,
      mensagemWhatsapp: `⚠️ Ticket ${ticket} está fora do prazo de ${hangar.prazoValidacaoHoras}h da emissão. Você ainda tem ${restante} validação(ões) fora do prazo disponível(is) este mês — quer usar 1 delas para validar este ticket mesmo assim? Responda SIM para usar.`,
    };
  }

  const valor = calcularValorPermanencia(horasDecorridas);
  return {
    acao: 'perguntar_faturamento',
    valor,
    mensagemWhatsapp: `⚠️ Ticket ${ticket} está fora do prazo de ${hangar.prazoValidacaoHoras}h da emissão, e a cota de validações fora do prazo deste mês já acabou. Tempo de permanência: ${horasDecorridas.toFixed(1)}h. Valor: R$ ${formatarReais(valor)}. Você autoriza a One Park faturar e emitir o boleto para o hangar? Se sim, responda com uma FOTO confirmando a autorização.`,
  };
}

async function validarTicket(hangarId, ticket, placa, dataEmissaoIso, horasAdicionais = 0, diasAdicionais = 0, opcoesForaDoPrazo = {}) {
  const { usarCotaForaPrazo = false, autorizarFaturamento = false, fotoAutorizacao = '', dadosCadastrais } = opcoesForaDoPrazo;
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
  let notaForaDoPrazo = '';
  let faturamentoInfo = null;

  if (!prazo.ok) {
    const decisao = decidirAcaoForaDoPrazo({
      hangar,
      ticket,
      horasDecorridas: prazo.horasDecorridas,
      usarCotaForaPrazo,
      autorizarFaturamento,
      fotoAutorizacao,
      dadosCadastrais,
    });

    if (decisao.acao === 'perguntar_cota') {
      return {
        status: 'fora_do_prazo_requer_decisao',
        hangar: hangarId,
        ticket,
        restanteCota: decisao.restante,
        mensagem: `Ticket emitido há ${prazo.horasDecorridas.toFixed(1)}h — acima do limite de ${hangar.prazoValidacaoHoras}h. Restam ${decisao.restante} validações fora do prazo este mês.`,
        mensagemWhatsapp: decisao.mensagemWhatsapp,
        notificarAdmin: false,
      };
    }

    if (decisao.acao === 'perguntar_faturamento') {
      return {
        status: 'fora_do_prazo_requer_autorizacao_faturamento',
        hangar: hangarId,
        ticket,
        valor: decisao.valor,
        mensagem: `Cota fora do prazo esgotada. Valor calculado: R$ ${formatarReais(decisao.valor)}.`,
        mensagemWhatsapp: decisao.mensagemWhatsapp,
        notificarAdmin: false,
      };
    }

    if (decisao.acao === 'falta_foto') {
      return {
        status: 'fora_do_prazo_falta_foto_autorizacao',
        hangar: hangarId,
        ticket,
        valor: decisao.valor,
        mensagem: 'Autorização de faturamento recebida sem foto anexada.',
        mensagemWhatsapp: decisao.mensagemWhatsapp,
        notificarAdmin: false,
      };
    }

    if (decisao.acao === 'faltam_dados_cadastrais') {
      return {
        status: 'fora_do_prazo_requer_dados_cadastrais',
        hangar: hangarId,
        ticket,
        valor: decisao.valor,
        mensagem: `Hangar "${hangarId}" sem cliente Asaas cadastrado e sem CNPJ/razão social informados para criar um.`,
        mensagemWhatsapp: decisao.mensagemWhatsapp,
        notificarAdmin: false,
      };
    }

    if (decisao.acao === 'usar_cota') {
      const restanteDepois = consumirUmaValidacao(hangar);
      notaForaDoPrazo = ` Validação fora do prazo usada (restam ${restanteDepois} este mês).`;
    }

    if (decisao.acao === 'faturar') {
      try {
        const cobranca = await criarCobrancaBoleto({
          hangar,
          valor: decisao.valor,
          descricao: `Validação fora do prazo — ticket ${ticket} (${hangar.hangar})`,
          dataVencimento: dataVencimentoBoleto(),
          dadosCadastraisNovoCliente: dadosCadastrais,
        });
        if (cobranca.clienteCriadoAgora) {
          // Cliente do Asaas criado agora pela primeira vez (hangar não
          // tinha cadastro) — salva o id em config/hangares.json pra não
          // pedir CNPJ/razão social de novo da próxima vez.
          salvarAsaasCustomerId(hangarId, cobranca.customerId);
        }
        registrarFaturamento({
          hangarId,
          ticket,
          horasDecorridas: prazo.horasDecorridas,
          valor: decisao.valor,
          fotoAutorizacao,
          asaasPaymentId: cobranca.id,
          boletoUrl: cobranca.bankSlipUrl || cobranca.invoiceUrl || null,
        });
        faturamentoInfo = { valor: decisao.valor, asaasPaymentId: cobranca.id, boletoUrl: cobranca.bankSlipUrl || cobranca.invoiceUrl || null };
        notaForaDoPrazo = ` Faturamento de R$ ${formatarReais(decisao.valor)} autorizado e boleto emitido (nº ${cobranca.id}) para o hangar.`;
      } catch (erro) {
        return {
          status: 'faturamento_erro',
          hangar: hangarId,
          ticket,
          valor: decisao.valor,
          mensagem: erro.message,
          mensagemWhatsapp: `⚠️ Não conseguimos emitir o boleto para o ticket ${ticket}: ${erro.message}. Nossa equipe foi avisada.`,
          notificarAdmin: true,
        };
      }
    }
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
    //
    // COMO_ESPERAR_VAGAS: o site preenche esse contador de forma ASSÍNCRONA,
    // depois do login. Ler logo após o login (como era feito aqui antes)
    // devolvia string vazia em ~2 de 3 execuções — o regex não batia, o
    // `if (vagasMatch)` abaixo era pulado e a proteção de pátio cheio ficava
    // silenciosamente desligada, ou seja, o bot validaria sem vaga. Por isso
    // esperamos o elemento existir E já conter o número antes de ler.
    // O `.filter({ hasText })` também cobre o caso do elemento ser
    // re-renderizado (observado: `count()` dá 0 no instante seguinte ao login).
    await page
      .locator(seletores.areaVagasDisponiveis)
      .filter({ hasText: REGEX_VAGAS_DISPONIVEIS })
      .first()
      .waitFor({ timeout: TIMEOUT_VAGAS_MS })
      .catch(() => {}); // timeout: cai no tratamento de "não bateu", logo abaixo

    const vagasTexto = await page
      .textContent(seletores.areaVagasDisponiveis)
      .catch(() => null);
    const vagasMatch = (vagasTexto || '').match(REGEX_VAGAS_DISPONIVEIS);
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
    // Se, mesmo depois da espera, o texto não bateu com o padrão, não
    // bloqueia — melhor seguir do que travar tudo por causa de uma mudança
    // de texto na tela. Diferente de antes, agora isso só acontece se o
    // formato realmente mudar (ou o site demorar mais de TIMEOUT_VAGAS_MS),
    // não por corrida de carregamento.

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

    // Três sinais aparecem aqui, e DOIS deles são traiçoeiros. Confirmado em
    // 09/09/2026 com uma validação real de +5 dias que FUNCIONOU no site
    // (tolerância foi de 09/09 para 14/09) mas foi reportada como
    // erro_validacao, com mensagem vazia, para o cliente:
    //
    // 1. O toast serve para sucesso E para erro. A versão anterior corria os
    //    seletores entre si e tratava "apareceu um toast" como erro — logo,
    //    reportaria falha justamente quando a validação deu certo.
    // 2. O campo de erro inline fica "visível" mesmo no sucesso, contendo só
    //    um caractere zero-width. Foi ele que ganhou a corrida e produziu o
    //    falso negativo.
    // 3. O modal fechar indica sucesso, mas não é sempre o primeiro sinal —
    //    numa corrida ele perde para os outros dois.
    //
    // Não há mais corrida entre seletores: esperamos o toast, que é o único
    // que diz O QUE aconteceu, e classificamos PELO CONTEÚDO. O modal
    // fechado entra só como reserva, quando nenhum toast legível aparece.
    const toastLocator = seletores.areaErroToast
      ? page.locator(seletores.areaErroToast).first()
      : null;

    const toastTexto = toastLocator
      ? await toastLocator
          .waitFor({ state: 'visible', timeout: TIMEOUT_RESULTADO_MS })
          .then(() => toastLocator.textContent())
          .then(textoLegivel)
          .catch(() => '') // nenhum toast no tempo esperado — usa a reserva
      : '';

    const erroInline = textoLegivel(
      await page.locator(seletores.areaErroInline).first().textContent().catch(() => null)
    );
    const modalFechado = !(await page
      .locator(seletores.modalDialog)
      .first()
      .isVisible()
      .catch(() => false));

    const resultado = classificarResultadoValidacao({ toastTexto, erroInline, modalFechado });

    const extensaoTexto = [
      horasAdicionais ? `${horasAdicionais}h` : null,
      diasAdicionais ? `${diasAdicionais}d` : null,
    ].filter(Boolean).join(' e ');

    const mensagensWhatsapp = {
      validado: (extensaoTexto
        ? `✅ Ticket ${ticket} validado com sucesso. Placa: ${placa}. Tolerância estendida em ${extensaoTexto}.`
        : `✅ Ticket ${ticket} validado com sucesso. Placa: ${placa}.`) + notaForaDoPrazo,
      erro_validacao: `⚠️ Não foi possível validar o ticket ${ticket}: ${resultado.mensagem}. Confira a placa e tente novamente.`,
      ticket_ja_utilizado: `⚠️ Ticket ${ticket} já foi utilizado anteriormente — não pode ser validado de novo.`,
      // O ValidPark exige horas/dias > 0 para QUALQUER validação — não só
      // para ticket com tolerância vencida, como se acreditava até
      // 09/09/2026 (ver docs/perguntas-abertas.md). Confirmado testando um
      // ticket emitido 45s antes: recusou com os sliders em 0. Por isso a
      // mensagem não afirma que algo venceu; ela só pede o tempo, que o bot
      // precisa perguntar ao cliente em todos os casos.
      tolerancia_obrigatoria: `⚠️ Para validar o ticket ${ticket} preciso saber quanto tempo você ainda vai ficar com o veículo no hangar — o sistema não valida sem essa informação. Pode me dizer?`,
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
      ...(faturamentoInfo ? { faturamento: faturamentoInfo } : {}),
    };
  } finally {
    await browser.close();
  }
}

async function main() {
  const [
    hangarId, ticket, placa, dataEmissaoIso, horasAdicionaisStr, diasAdicionaisStr,
    usarCotaForaPrazoStr, autorizarFaturamentoStr, fotoAutorizacao,
    cnpjHangar, razaoSocialHangar, emailHangar,
  ] = process.argv.slice(2);
  if (!hangarId || !ticket || !placa) {
    console.error('Uso: node scripts/validate-ticket.js <hangarId> <numeroTicket> <placa> [dataEmissaoIso] [horasAdicionais] [diasAdicionais] [usarCotaForaPrazo] [autorizarFaturamento] [fotoAutorizacao] [cnpjHangar] [razaoSocialHangar] [emailHangar]');
    process.exit(1);
  }

  const horasAdicionais = Number(horasAdicionaisStr) || 0;
  const diasAdicionais = Number(diasAdicionaisStr) || 0;
  const opcoesForaDoPrazo = {
    usarCotaForaPrazo: usarCotaForaPrazoStr === 'true',
    autorizarFaturamento: autorizarFaturamentoStr === 'true',
    fotoAutorizacao: fotoAutorizacao || '',
    dadosCadastrais: {
      cnpj: cnpjHangar || '',
      razaoSocial: razaoSocialHangar || '',
      email: emailHangar || '',
    },
  };

  try {
    const resultado = await validarTicket(hangarId, ticket, placa, dataEmissaoIso, horasAdicionais, diasAdicionais, opcoesForaDoPrazo);
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

// Executa como CLI só quando chamado direto; sob require() apenas exporta,
// para que a classificação possa ser testada sem abrir o navegador.
if (require.main === module) {
  main();
}

module.exports = { classificarResultadoValidacao, textoLegivel, decidirAcaoForaDoPrazo };
