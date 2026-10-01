#!/usr/bin/env node
// Uso: node scripts/processar-mensagem.js <payloadBase64> [--enviar]
//
// Recebe o corpo do webhook da Evolution API (o evento messages.upsert,
// codificado em base64 para não sofrer com escape de JSON no shell) e conduz
// o fluxo inteiro: interpreta a mensagem, identifica o hangar pelo grupo,
// baixa a foto, lê o ticket por OCR, consulta e, se for o caso, valida.
//
// POR QUE UM SCRIPT SÓ, E NÃO VÁRIOS NÓS DO n8n
// Os nós de código do n8n rodam em sandbox e não conseguem importar os
// arquivos deste projeto. Espalhar a lógica por lá obrigaria a COPIAR funções
// como interpretarMensagem() para dentro do workflow — a mesma duplicação que
// manteve a tabela GRUPO_PARA_HANGAR fora de sincronia com config/hangares.json
// e deixou produção quebrada por semanas. Aqui o n8n é um cano fino: recebe o
// webhook, chama este script, e pronto. Toda a lógica fica em código
// versionado e testável.
//
// A imagem nunca toca o disco: vem da Evolution em base64 e segue direto para
// o OCR em memória. Foto de cliente é dado pessoal, e arquivo temporário tem o
// hábito de sobrar quando algo falha no meio.
//
// Sem --enviar o script apenas devolve o json com a resposta calculada, sem
// mandar nada para o WhatsApp. É assim que dá para testar o fluxo inteiro sem
// escrever numa conversa real.

const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

const { carregarConfig, buscarHangarPorGrupo } = require('./lib/hangar');
const { comTravaAsync } = require('./lib/trava-arquivo');
const { interpretarMensagem, extrairPlaca, interpretarEscolhaPatio, interpretarComandoContingencia, normalizar } = require('./lib/whatsapp');
// O cliente da Evolution vive em lib/evolution.js: o painel também precisa
// mandar mensagem, e duas cópias do mesmo cliente divergiriam — inclusive no
// `Connection: close`, que existe por um bug real de socket reaproveitado.
const { chamarEvolution, enviarTexto } = require('./lib/evolution');
const { avaliarLocal } = require('./lib/conferir-local');
const pendencias = require('./lib/pendencias');
const registro = require('./lib/registro');
const avisoPatio = require('./lib/aviso-patio');
const fotosUsadas = require('./lib/fotos-usadas');
const cotaMensal = require('./lib/cota-mensal');
const cotaForaPrazo = require('./lib/cota-fora-prazo');
const filaValidacoes = require('./lib/validacoes-pendentes');
const filaFaturamentos = require('./lib/faturamentos-pendentes');
const { calcularValorPermanencia, formatarReais } = require('./lib/precos');
const asaas = require('./lib/asaas');
const { salvarEComitar } = require('./lib/salvar-config');
const bloqueados = require('./lib/tickets-bloqueados');
const snapshotTechparking = require('./lib/snapshot-techparking');
const { dentroDoPrazo } = require('./validate-ticket');
const { lerTicket, lerLocal } = require('./ocr-ticket');
const { consultarPatio } = require('./consultar-patio');

const EVOLUTION_URL = process.env.EVOLUTION_URL || 'http://127.0.0.1:8080';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'validador-hangares';

async function baixarImagemBase64(messageId) {
  const r = await chamarEvolution(
    `/chat/getBase64FromMediaMessage/${EVOLUTION_INSTANCE}`,
    { message: { key: { id: messageId } }, convertToMp4: false }
  );
  if (!r || !r.base64) {
    throw new Error(`Evolution não devolveu a imagem da mensagem ${messageId}.`);
  }
  return { base64: r.base64, mediaType: r.mimetype || 'image/jpeg' };
}

// Os dois scripts de ticket são CLIs com contrato de json em stdout. Chamamos
// como processo em vez de importar de propósito: é exatamente o que o n8n
// fazia antes, então o comportamento observado em produção não muda.
function rodarScript(arquivo, args) {
  const saida = execFileSync('node', [path.join(__dirname, arquivo), ...args], {
    encoding: 'utf-8',
    maxBuffer: 10 * 1024 * 1024,
  });
  const linhas = saida.trim().split('\n').filter(Boolean);
  return JSON.parse(linhas[linhas.length - 1]);
}

// Contingência LIGADA? Lida do arquivo a cada validação (o bot roda por
// mensagem, então não há cache a envelhecer): o painel liga/desliga e vale já.
function contingenciaLigada() {
  try {
    return carregarConfig().contingenciaValidPark?.ativo === true;
  } catch (e) {
    // Sem config não há bot; o erro aparece em outro lugar. Aqui, não contingência.
    return false;
  }
}

/**
 * Validação quando o ValidPark está fora do ar (contingência manual LIGADA).
 *
 * Em vez de abrir o site, enfileira para o coletor do aeroporto validar pelo
 * TECHPARKING, no pátio DO PRÓPRIO HANGAR (não no #1PARK) — o id vem do
 * snapshot, e assim a validação fica no nome certo, como seria no ValidPark.
 *
 * Mantém a guarda anti-fraude do pátio cheio: sem o ValidPark para contar as
 * vagas, usa a lotação do snapshot. E só valida com o snapshot FRESCO — se o
 * coletor também estiver mudo, não há como conferir vaga nem confiar no pátio,
 * então recusa honestamente em vez de validar no escuro.
 *
 * É assíncrona: o cliente ouve "validando" e a confirmação chega quando o
 * coletor reporta (o servidor avisa o grupo então, como na cota e no faturamento).
 */
function validarPorContingencia(hangar, msg, pedido) {
  const patio = snapshotTechparking.patioDoBolsao(hangar.bolsaoTechparking);

  // Sem foto fresca do pátio não dá para validar com segurança: nem o pátio
  // (id) nem a lotação (vaga) são confiáveis. O ValidPark caiu E o coletor
  // está mudo — é o pior caso, e validar no escuro é o que o projeto evita.
  if (!patio.fresca) {
    return {
      status: 'contingencia_sem_dados', hangarId: hangar.id, grupoId: msg.grupoId, ticket: pedido.ticket,
      mensagem: `Contingência LIGADA, mas sem snapshot fresco do pátio (${patio.existe ? `${Math.round((patio.idadeMs || 0) / 60000)}min` : 'nenhuma foto'}). Validação do ticket ${pedido.ticket} não pôde ser feita.`,
      mensagemWhatsapp: `⚠️ Estou validando pelo sistema do aeroporto (o ValidPark está em manutenção), mas não consegui confirmar o pátio agora. Nossa equipe foi avisada e vai validar o ticket ${pedido.ticket} manualmente.`,
      notificarAdmin: true, responder: true, etapa: 'contingencia',
    };
  }

  // Pátio não mapeado na foto: sem id, o coletor cairia no #1PARK e a
  // validação sairia no nome errado. Melhor parar e chamar gente.
  if (!patio.existe || patio.id == null) {
    return {
      status: 'contingencia_patio_desconhecido', hangarId: hangar.id, grupoId: msg.grupoId, ticket: pedido.ticket,
      mensagem: `Contingência LIGADA, mas o bolsão "${hangar.bolsaoTechparking || '(vazio)'}" não casou com nenhum pátio do snapshot. Ticket ${pedido.ticket} não validado.`,
      mensagemWhatsapp: `⚠️ Estou validando pelo sistema do aeroporto, mas não localizei o pátio deste hangar. Nossa equipe foi avisada e vai validar o ticket ${pedido.ticket} manualmente.`,
      notificarAdmin: true, responder: true, etapa: 'contingencia',
    };
  }

  // Pátio cheio: mesma guarda do "sem_vagas" do ValidPark — trava e chama gente.
  if (patio.temVaga === false) {
    try {
      bloqueados.bloquear(pedido.ticket, {
        hangarId: hangar.id, hangarNome: hangar.hangar || hangar.id,
        grupoId: msg.grupoId, remetente: msg.remetente,
        vagasDisponiveis: patio.vagas != null && patio.ocupadas != null ? patio.vagas - patio.ocupadas : null,
      });
      const registro = bloqueados.estaBloqueado(pedido.ticket);
      return {
        status: 'sem_vagas', hangarId: hangar.id, grupoId: msg.grupoId, ticket: pedido.ticket,
        mensagemWhatsapp: bloqueados.mensagemParaCliente(pedido.ticket),
        mensagem: `Contingência: pátio ${patio.label} sem vaga (${patio.ocupadas}/${patio.vagas}). Ticket bloqueado.\n`
          + bloqueados.trilha(registro, { quandoLegivel }),
        notificarAdmin: true, responder: true, etapa: 'contingencia',
      };
    } catch (erro) {
      return {
        status: 'sem_vagas', hangarId: hangar.id, grupoId: msg.grupoId, ticket: pedido.ticket,
        mensagemWhatsapp: `⚠️ O pátio aparece sem vaga agora. Nossa equipe foi avisada.`,
        mensagem: `Contingência: pátio cheio, e o bloqueio falhou: ${erro.message}`,
        notificarAdmin: true, responder: true, etapa: 'contingencia',
      };
    }
  }

  // Enfileira para o coletor, no pátio do hangar, com o prazo padrão dele.
  try {
    filaValidacoes.enfileirar({
      ticket: pedido.ticket, grupoId: msg.grupoId, hangarId: hangar.id,
      patioId: patio.id, patioLabel: patio.label,
      dias: hangar.diasValidacaoPadrao ?? null,
      placa: pedido.placa,
      motivo: 'contingencia',
      autorizadoPor: msg.remetente || null,
    });
  } catch (erro) {
    return {
      status: 'erro', hangarId: hangar.id, grupoId: msg.grupoId, ticket: pedido.ticket,
      mensagem: `Contingência: falha ao enfileirar — ${erro.message}`,
      mensagemWhatsapp: `⚠️ Não consegui registrar a validação do ticket ${pedido.ticket} agora. Nossa equipe foi avisada.`,
      notificarAdmin: true, responder: true, etapa: 'contingencia',
    };
  }

  let mensagem = `✅ Recebi o ticket ${pedido.ticket}. O ValidPark está em manutenção, então vou validar pelo sistema do aeroporto — aviso aqui assim que confirmar.`;
  if (pedido.placaEhGenerica) {
    mensagem += ` (vou usar a placa padrão ${pedido.placa}, porque não veio placa na foto — se precisar corrigir, fale com a administração.)`;
  }
  if (pedido.identificacao) mensagem += `\n\n🏷️ Identificado como: *${pedido.identificacao}*`;

  return {
    status: 'contingencia_enfileirada', hangarId: hangar.id, grupoId: msg.grupoId, ticket: pedido.ticket,
    patioTechparking: patio.label,
    mensagemWhatsapp: mensagem,
    mensagem: `Contingência: ticket ${pedido.ticket} enfileirado para o coletor no pátio ${patio.label} (id ${patio.id}).`,
    notificarAdmin: false, responder: true, etapa: 'contingencia',
  };
}

// Roda validate-ticket.js e monta a resposta. `usarCota` vem true quando o
// cliente respondeu SIM à pergunta sobre gastar uma validação fora do prazo.
function validar(hangar, msg, pedido, usarCota, faturamento = {}) {
  // CONTINGÊNCIA: ValidPark fora do ar. A validação normal (dentro do prazo)
  // não vai ao site — vai pelo coletor, no pátio do próprio hangar. Cota
  // (usarCota) e faturamento (faturamento.autorizar) têm seus próprios caminhos
  // assíncronos e não passam por aqui, então ficam de fora da contingência.
  if (!usarCota && !faturamento.autorizar && contingenciaLigada()) {
    return validarPorContingencia(hangar, msg, pedido);
  }

  const validacao = rodarScript('validate-ticket.js', [
    hangar.id, pedido.ticket, pedido.placa, pedido.dataEmissaoIso || '',
    '0', '0', usarCota ? 'true' : '',
    faturamento.autorizar ? 'true' : '',
    faturamento.fotoAutorizacao || '',
  ]);

  // Pátio cheio: trava o ticket até a administração decidir.
  //
  // Se não há vaga, o carro daquele ticket provavelmente não está ali. Pode ser
  // honesto — a pessoa chegou e não achou lugar — mas é também o formato exato
  // de uma fraude, e o sistema não sabe distinguir os dois. Para e chama gente.
  if (validacao.status === 'sem_vagas') {
    try {
      bloqueados.bloquear(pedido.ticket, {
        hangarId: hangar.id,
        hangarNome: hangar.hangar || hangar.id,
        grupoId: msg.grupoId,
        remetente: msg.remetente,
        vagasDisponiveis: validacao.vagasDisponiveis ?? null,
      });
      validacao.mensagemWhatsapp = bloqueados.mensagemParaCliente(pedido.ticket);
      const registro = bloqueados.estaBloqueado(pedido.ticket);
      validacao.mensagem = 'Tentativa em pátio SEM VAGAS. Ticket bloqueado em todos os pátios.\n'
        + bloqueados.trilha(registro, { quandoLegivel });
    } catch (erro) {
      // Falhar aqui não pode esconder a recusa por falta de vaga, que é a
      // informação que o cliente precisa de qualquer jeito.
      validacao.erroBloqueio = erro.message;
    }
  }

  let mensagem = validacao.mensagemWhatsapp;
  if (validacao.status === 'validado' && pedido.placaEhGenerica) {
    mensagem += ` (validei com a placa padrão ${pedido.placa} porque não veio placa na legenda da foto — se precisar corrigir, fale com a administração. Da próxima vez, escreva a placa junto ao enviar a foto.)`;
  }

  // Quanto sobrou da cota do mês, para o hangar que tem teto. Só perto do fim:
  // "restam 18 de 20" no começo do mês é ruído numa mensagem que a pessoa lê de
  // passagem, esperando apenas saber se validou. A contagem é feita DEPOIS da
  // validação para já incluir esta — dizer "restam 5" logo após gastar a
  // quinta-de-trás confundiria quem for conferir.
  if (validacao.status === 'validado') {
    mensagem += cotaMensal.notaParaCliente(cotaMensal.situacao(hangar));
    // Repetir a identificação na confirmação é o recibo de quem respondeu: dá
    // para perceber ali mesmo que saiu trocada, em vez de descobrir no relatório.
    if (pedido.identificacao) mensagem += `\n\n🏷️ Identificado como: *${pedido.identificacao}*`;
  }

  // Pergunta feita: guardar o pedido para que a resposta do cliente tenha a
  // que se referir. Sem isto, o "SIM" chegava sem contexto e o bot não fazia
  // nada — a pergunta prometia algo que o sistema não sabia completar.
  if (validacao.status === 'fora_do_prazo_requer_decisao') {
    pendencias.registrar(msg.grupoId, msg.remetenteId, { ...pedido, hangarId: hangar.id, tipo: 'usar_cota' });
  }

  // Cota do mês esgotada: o bot informa isso, mostra o valor e pergunta se
  // pode liberar o ticket e faturar. A pendência guarda o pedido para a
  // resposta ter a que se referir — mesma mecânica da cota.
  //
  // ⚠️ A chave do Asaas é de PRODUÇÃO (docs/perguntas-abertas.md): o boleto
  // emitido aqui é real. Por isso a autorização continua exigindo FOTO, que é
  // a evidência de quem autorizou — regra de negócio confirmada em 12/09/2026
  // e mantida de propósito. "SIM" sozinho não fatura.
  if (validacao.status === 'fora_do_prazo_requer_autorizacao_faturamento'
      || validacao.status === 'fora_do_prazo_falta_foto_autorizacao') {
    pendencias.registrar(msg.grupoId, msg.remetenteId, {
      ...pedido, hangarId: hangar.id, tipo: 'autorizar_faturamento', valor: validacao.valor,
    });
  }

  // Faltam CNPJ/razão social/email para criar o cliente no Asaas. Extrair isso
  // de texto livre de WhatsApp seria frágil, e o erro aqui emite nota para o
  // CNPJ errado — cai para uma pessoa resolver.
  if (validacao.status === 'fora_do_prazo_requer_dados_cadastrais') {
    validacao.notificarAdmin = true;
  }

  return {
    status: validacao.status,
    hangarId: hangar.id,
    grupoId: msg.grupoId,
    ticket: pedido.ticket,
    placa: pedido.placa,
    placaEhGenerica: pedido.placaEhGenerica,
    identificacao: pedido.identificacao || null,
    mensagemWhatsapp: mensagem,
    notificarAdmin: validacao.notificarAdmin === true,
    responder: true,
    etapa: usarCota ? 'validacao_com_cota' : 'validacao',
  };
}

/**
 * `aoReceber` é chamado assim que sabemos que a mensagem é uma foto de ticket
 * num grupo conhecido — antes do trabalho lento (baixar a imagem, OCR, abrir o
 * navegador no ValidPark), que junto passa fácil de um minuto. Sem isso o
 * cliente fica sem retorno nenhum e reenvia a foto, o que dispara o fluxo de
 * novo em paralelo.
 *
 * Recebe uma função em vez de mandar direto daqui para processar() continuar
 * testável: sem callback, nada é enviado a ninguém.
 */
// Situações em que o cliente não tem o que fazer e alguém precisa agir. A
// lista é explícita de propósito: escalar demais vira ruído e a administração
// para de ler; escalar de menos deixa o cliente parado esperando.
//
// Ficam FORA os casos que o próprio cliente resolve — foto ilegível, número
// não encontrado, formato inválido, foto fora do local — porque para esses a
// resposta já diz o que fazer e reenviar resolve.
const STATUS_QUE_ESCALAM = new Set([
  'sem_vagas',              // pátio cheio — e trava o ticket
  'ticket_bloqueado',       // ticket travado esperando autorização
  'prazo_excedido_no_site', // ValidPark recusa por idade do ticket
  'fora_do_prazo',          // passou das horas do hangar; resolve-se à mão
  'erro_validacao',         // recusa que não soubemos classificar
  'ocr_numero_suspeito',    // número e data discordam E o site não confirma
  'valor_invalido',         // horas/dias acima do limite do slider
  'indeterminado',          // clicou em validar e o site não confirmou nada
  'erro',                   // exceção no meio do caminho
]);

/**
 * Para os casos acima: avisa o cliente de que a administração foi acionada e
 * marca o resultado para notificação. A explicação específica é mantida — o
 * cliente saber POR QUE parou evita que ele reenvie a foto várias vezes.
 */
// Estes já dizem no próprio texto que foram encaminhados — a frase padrão do
// escalonamento viraria repetição na mesma mensagem.
const NAO_REPETEM_ENCAMINHAMENTO = new Set(['sem_vagas', 'ticket_bloqueado']);

function escalar(resultado, remetente) {
  if (!STATUS_QUE_ESCALAM.has(resultado.status)) return resultado;

  const base = resultado.mensagemWhatsapp
    || '⚠️ Não consegui concluir a validação deste ticket.';
  resultado.mensagemWhatsapp = NAO_REPETEM_ENCAMINHAMENTO.has(resultado.status)
    ? base
    : `${base}\n\nJá estou encaminhando para o administrador resolver.`;
  resultado.notificarAdmin = true;
  resultado.escalado = true;
  resultado.responder = true;
  if (remetente) resultado.remetente = remetente;
  return resultado;
}

/**
 * Manda o aviso para a administração quando o resultado pede gente.
 *
 * Até 15/09/2026 isso não existia: `notificarAdmin: true` era só um campo no
 * json, e o nó "Notificar Admin" do workflow era um noOp — ou seja, os casos
 * que dependiam de uma pessoa ficavam sem pessoa nenhuma.
 *
 * O destino é `grupoAdministracao` do hangar em config/hangares.json. Aceita
 * tanto um grupo (…@g.us) quanto um número direto (…@s.whatsapp.net): o envio
 * é o mesmo, e alguns hangares podem preferir avisar uma pessoa em vez de um
 * grupo.
 */
async function avisarAdmin(hangar, resultado, aoNotificarAdmin) {
  const destino = (hangar && hangar.grupoAdministracao || '').trim();

  if (!destino) {
    // Fica registrado no json em vez de falhar em silêncio: sem isso, um
    // problema que precisa de gente desaparece sem deixar rastro.
    resultado.adminNaoConfigurado = true;
    return;
  }
  if (!aoNotificarAdmin) return;

  const linhas = [
    `⚠️ Validador — hangar ${hangar.hangar || hangar.id}`,
    `Situação: ${resultado.status}`,
    resultado.remetente ? `Cliente: ${resultado.remetente}` : null,
    resultado.ticket ? `Ticket: ${resultado.ticket}` : null,
    resultado.placa ? `Placa: ${resultado.placa}` : null,
    resultado.valor ? `Valor: R$ ${resultado.valor}` : null,
    resultado.mensagem ? `Detalhe: ${resultado.mensagem}` : null,
    `Grupo de origem: ${resultado.grupoId}`,
    // Ticket travado espera uma decisão SUA. Sem esta linha o alerta seria
    // informação, e informação sozinha deixa o cliente parado no pátio.
    resultado.status === 'sem_vagas'
      ? `\nResponda aqui *SIM* para autorizar a validação do ticket ${resultado.ticket}, ou *NÃO* para mantê-lo bloqueado.`
      : null,
  ].filter(Boolean);

  try {
    await aoNotificarAdmin(destino, linhas.join('\n'));
    resultado.adminAvisado = true;
  } catch (erro) {
    resultado.adminAvisado = false;
    resultado.erroAvisoAdmin = erro.message;
  }
}

async function processar(body, opcoes = {}) {
  const resultado = await comSerializacao(body, () => conduzir(body, opcoes));

  // interpretarMensagem é pura e barata; chamá-la de novo aqui evita ter que
  // carregar o remetente por todos os pontos de retorno de conduzir().
  const quem = interpretarMensagem(body).remetente;
  escalar(resultado, quem);
  if (!resultado.remetente && quem) resultado.remetente = quem;

  // Histórico do que o bot fez com o ticket. Fica aqui, no invólucro, para
  // valer para TODOS os caminhos de saída — validação, consulta, recusa,
  // faturamento — em vez de precisar lembrar de chamar em cada return.
  // Nunca lança: o ticket já pode ter sido validado, e o cliente precisa da
  // resposta mais do que nós do registro.
  registro.registrar(resultado);

  // A decisão da administração precisa CHEGAR AO GRUPO onde o cliente está
  // esperando. Sem isso, o "aguardando autorização" ficaria sem desfecho: o
  // administrador responderia no privado e a pessoa no pátio nunca saberia.
  if (resultado.avisarGrupoDeOrigem && resultado.grupoDeOrigem && opcoes.aoNotificarAdmin) {
    try {
      await opcoes.aoNotificarAdmin(resultado.grupoDeOrigem, resultado.avisarGrupoDeOrigem);
      resultado.grupoAvisado = true;
    } catch (erro) {
      // A decisão já está registrada e vale. Falhar aqui perde o aviso, não o
      // efeito — e o administrador vê na resposta que o grupo não foi avisado.
      resultado.grupoAvisado = false;
      resultado.erroAvisoGrupo = erro.message;
    }
  }

  // Aviso de pátio cheio. Usa o número que a validação ou a consulta JÁ leram —
  // sem login extra.
  //
  // Vai para o GRUPO dos clientes, por escolha do usuário em 16/09/2026: quem
  // está no grupo é quem vai chegar com o carro, e saber que o pátio está no
  // limite muda o que essa pessoa faz. Não duplicamos no privado da
  // administração para não dizer a mesma coisa em dois lugares.
  if (Number.isFinite(resultado.vagasDisponiveis)) {
    try {
      const hangarAviso = buscarHangarPorGrupo(carregarConfig(), resultado.grupoId);
      const aviso = avisoPatio.avaliar(hangarAviso, resultado.vagasDisponiveis, resultado.totalVagas);

      if (aviso) {
        resultado.avisoPatio = aviso.acao;
        if (opcoes.aoNotificarAdmin) {
          await opcoes.aoNotificarAdmin(resultado.grupoId, avisoPatio.mensagemAdmin(aviso))
            .catch(() => { resultado.avisoPatioEnviado = false; });
        }
      }

      // A nota curta na confirmação só entra quando NÃO houve alerta agora.
      // Com alerta, o grupo acabou de receber a informação completa, e repetir
      // na linha seguinte seria dizer duas vezes a mesma coisa.
      if (!aviso && resultado.mensagemWhatsapp && resultado.status === 'validado') {
        resultado.mensagemWhatsapp += avisoPatio.notaParaCliente(
          resultado.vagasDisponiveis,
          avisoPatio.limiteDe({ ...hangarAviso, totalVagas: resultado.totalVagas }),
          hangarAviso
        );
      }
    } catch (e) { /* aviso é acessório: nunca pode derrubar a resposta */ }
  }

  if (resultado.notificarAdmin) {
    // O hangar só é conhecido quando a mensagem chegou de um grupo cadastrado;
    // fora disso não há para quem avisar.
    let hangar = null;
    try {
      hangar = buscarHangarPorGrupo(carregarConfig(), resultado.grupoId);
    } catch (e) { /* grupo desconhecido: cai no adminNaoConfigurado abaixo */ }
    await avisarAdmin(hangar, resultado, opcoes.aoNotificarAdmin);
  }

  return resultado;
}

/**
 * Serializa o processamento por PESSOA. Duas mensagens da mesma pessoa no mesmo
 * grupo são tratadas uma de cada vez; de pessoas diferentes seguem em paralelo.
 *
 * Existe por um caso real (16/09/2026): fotos enviadas em álbum chegam com ~1
 * segundo de diferença, e cada uma leva ~10s para processar. Sem serializar, a
 * segunda foto começava antes de a primeira registrar a pendência — as duas
 * eram tratadas como ticket, e o fluxo de dois passos se perdia.
 *
 * Falhar a trava não pode impedir o atendimento: nesse caso segue sem
 * serializar, que é o comportamento de antes.
 */
async function comSerializacao(body, fn) {
  const msg = interpretarMensagem(body);
  if (msg.ignorar || !msg.grupoId || !msg.remetenteId) return fn();
  const chave = path.join(
    __dirname, '..', 'data', 'filas',
    `${msg.grupoId}-${msg.remetenteId}`.replace(/[^a-z0-9.@-]/gi, '_')
  );
  try {
    return await comTravaAsync(chave, fn);
  } catch (e) {
    return fn();
  }
}

async function conduzir(body, { aoReceber } = {}) {
  const msg = interpretarMensagem(body);

  if (msg.ignorar) {
    return { status: 'ignorado', motivo: msg.motivoIgnorar, grupoId: msg.grupoId, responder: false };
  }

  // Privado: só serve para a administração decidir sobre ticket bloqueado.
  if (msg.tipo === 'texto_privado') {
    return await responderAutorizacaoPrivada(msg);
  }

  // Grupo de administração: os comandos do privado valem a partir de um grupo
  // listado como admin (contingência, faturamento, ticket travado) E dá para
  // consultar qualquer pátio, nomeando o hangar. É um grupo criado só para
  // isso — por isso vai ao handler da administração, e não ao fluxo de hangar
  // (um grupo admin não é um hangar, e buscarHangarPorGrupo nem o encontraria).
  if (ehFonteAdmin(carregarConfig(), msg.grupoId)) {
    return await responderNoGrupoAdmin(msg, aoReceber);
  }

  const hangar = buscarHangarPorGrupo(carregarConfig(), msg.grupoId);

  // ---- pedido de situação do pátio ----
  // Vem ANTES das pendências: quem tem um ticket em aberto também pode querer
  // saber das vagas, e responder "ainda preciso da foto" a uma pergunta sobre
  // o pátio seria ignorar o que foi perguntado.
  // Liga e desliga a pergunta de identificação pelo próprio grupo.
  //
  // Quem opera o pátio está no grupo, não no painel — pedir que abra o
  // navegador para uma chave que se resolve numa frase é atrito à toa.
  //
  // QUALQUER PESSOA DO GRUPO pode. A identificação é conveniência de registro,
  // não controle antifraude: desligá-la não libera validação nenhuma. Em troca
  // da permissão aberta, toda mudança avisa a administração dizendo QUEM
  // mudou — auditoria em vez de cadeado, que é o equilíbrio certo para uma
  // chave deste peso.
  if (msg.tipo === 'texto' && msg.comandoIdentificacao !== null && msg.comandoIdentificacao !== undefined) {
    const querLigado = msg.comandoIdentificacao;
    const jaEsta = hangar.perguntarIdentificacao === true;
    if (jaEsta === querLigado) {
      return {
        status: 'identificacao_sem_mudanca', hangarId: hangar.id, grupoId: msg.grupoId,
        mensagemWhatsapp: `A pergunta de identificação já está *${querLigado ? 'ativada' : 'desativada'}* neste pátio.`,
        notificarAdmin: false, responder: true, etapa: 'comando_identificacao',
      };
    }

    const config = carregarConfig();
    config.hangares.find((h) => h.id === hangar.id).perguntarIdentificacao = querLigado;
    try {
      salvarEComitar(config, `${hangar.hangar} — identificação ${querLigado ? 'ativada' : 'desativada'} por ${msg.remetente || 'alguém do grupo'}`, 'Bot do WhatsApp');
    } catch (erro) {
      return {
        status: 'erro', hangarId: hangar.id, grupoId: msg.grupoId, mensagem: erro.message,
        mensagemWhatsapp: '⚠️ Não consegui salvar a alteração. Nossa equipe foi avisada.',
        notificarAdmin: true, responder: true, etapa: 'comando_identificacao',
      };
    }

    return {
      status: 'identificacao_alterada', hangarId: hangar.id, grupoId: msg.grupoId,
      identificacaoAtiva: querLigado,
      mensagem: `Identificação ${querLigado ? 'ATIVADA' : 'DESATIVADA'} por ${msg.remetente || 'alguém do grupo'}.`,
      mensagemWhatsapp: querLigado
        ? '✅ Pergunta de identificação *ativada*.\n\nAo mandar o ticket sem a placa na legenda, vou perguntar se você quer identificá-lo com nome, carro ou placa.'
        : '✅ Pergunta de identificação *desativada*.\n\nOs tickets passam a ser validados direto, sem a pergunta. A placa na legenda continua valendo.',
      // Mudança de configuração sempre avisa quem administra — é o que
      // sustenta deixar o comando aberto a todo o grupo.
      notificarAdmin: true, responder: true, etapa: 'comando_identificacao',
    };
  }

  // "O ticket do João foi validado?" — busca no histórico DESTE pátio.
  //
  // Vem antes do pátio e das pendências: é pergunta, não resposta, e tratá-la
  // como um "sim" solto seria gastar cota por causa de uma dúvida.
  if (msg.tipo === 'texto' && msg.consultaValidacao) {
    const termo = msg.consultaValidacao.termo;
    if (!termo) {
      return {
        status: 'consulta_sem_termo', hangarId: hangar.id, grupoId: msg.grupoId,
        mensagemWhatsapp: 'Posso verificar — me diga o que procurar: o *nome*, a *placa* ou o *número do ticket*.',
        notificarAdmin: false, responder: true, etapa: 'consulta_validacao',
      };
    }

    const achados = registro.procurar(hangar.id, termo);
    const validados = achados.filter((a) => a.status === 'validado');

    let texto;
    if (!achados.length) {
      texto = `Não encontrei nada com *${termo}* no histórico deste pátio.\n\n`
        + `_O histórico guarda ${registro.RETENCAO_DIAS} dias e só o que passou por aqui — validação feita à mão no site não aparece._`;
    } else if (!validados.length) {
      // Achou o ticket, mas ele não chegou a validar. Dizer "não foi validado"
      // e parar deixaria a pessoa sem saber o que houve.
      const u = achados[0];
      texto = `Encontrei *${termo}*, mas **não** foi validado.\n\n`
        + `Última tentativa: ${quandoLegivel(u.em)} — situação: ${u.status}.`;
    } else {
      texto = `✅ Sim, ${validados.length === 1 ? 'foi validado' : `foram ${validados.length} validações`}:\n\n`
        + validados.map((v) => `• ${quandoLegivel(v.em)} — ticket ${v.ticket || '—'}`
          + `${v.placa && !v.placaEhGenerica ? `, placa ${v.placa}` : ''}`
          + `${v.identificacao ? ` (${v.identificacao})` : ''}`).join('\n');
    }

    return {
      status: 'consulta_validacao', hangarId: hangar.id, grupoId: msg.grupoId,
      termo, encontrados: achados.length, validados: validados.length,
      mensagemWhatsapp: texto, notificarAdmin: false, responder: true, etapa: 'consulta_validacao',
    };
  }

  if (msg.tipo === 'texto' && msg.pedidoPatio) {
    // Pergunta GENÉRICA ("como está meu pátio") ganha menu em vez de despejo.
    //
    // A resposta completa é longa: contadores, tickets validados e a lista de
    // credenciados, que em alguns pátios passa de vinte nomes. Quem só queria
    // saber das vagas recebia tudo isso. Perguntar custa uma mensagem e devolve
    // exatamente o que foi pedido.
    //
    // Quem JÁ disse o que quer — "quais os credenciados", "os tickets
    // validados" — pula o menu: repetir a pergunta a quem já respondeu é
    // burocracia.
    if (msg.pedidoPatio === 'status') {
      pendencias.registrar(msg.grupoId, msg.remetenteId, { hangarId: hangar.id, tipo: 'escolha_patio' });
      return {
        status: 'menu_patio', hangarId: hangar.id, grupoId: msg.grupoId,
        mensagemWhatsapp: `📊 *${hangar.hangar || hangar.id}* — o que você quer ver?\n\n`
          + '*1* — Credenciados no pátio\n'
          + '*2* — Tickets validados\n'
          + '*3* — Ambos\n\n'
          + 'Responda com o número.',
        notificarAdmin: false, responder: true, etapa: 'menu_patio',
      };
    }

    if (aoReceber) {
      try { await aoReceber(msg.grupoId, '🔎 Consultando o pátio...'); } catch (e) { /* aviso é conforto */ }
    }
    const patio = await consultarPatio(hangar.id, { formato: msg.pedidoPatio });
    return {
      status: patio.status,
      hangarId: hangar.id,
      grupoId: msg.grupoId,
      mensagemWhatsapp: patio.mensagemWhatsapp,
      notificarAdmin: patio.notificarAdmin === true,
      responder: true,
      etapa: `status_patio_${msg.pedidoPatio}`,
      vagasDisponiveis: patio.disponiveis ?? null,
      totalVagas: patio.total ?? null,
    };
  }

  // ---- resposta a uma pergunta anterior ----
  if (msg.tipo === 'texto') {
    const pendente = pendencias.buscar(msg.grupoId, msg.remetenteId);

    // Sem pendência, é conversa normal do grupo: ignorar em silêncio. O bot
    // não pode responder a toda mensagem trocada entre as pessoas ali.
    if (!pendente) {
      return { status: 'ignorado', motivo: 'texto sem pendência para esta pessoa', grupoId: msg.grupoId, responder: false };
    }

    // Placa digitada quando a pergunta em aberto era outra.
    //
    // Aconteceu no primeiro teste do VOASP (17/09/2026): o cliente mandou o
    // ticket, o bot perguntou da cota, e a placa veio em seguida como mensagem
    // separada. Ela caiu no "não entendi", e a validação seguiu sem placa.
    // Guardar a placa e repetir a pergunta aproveita o que a pessoa quis dizer,
    // em vez de descartar e pedir de novo.
    //
    // Fica de fora quando a pergunta em aberto É sobre identificação: ali a
    // placa não chegou fora de hora, ela é a resposta — "identifique com nome,
    // carro ou placa" e a pessoa mandou a placa. Tratá-la como correção faria
    // o bot repetir a pergunta que acabara de ser respondida.
    const perguntaEraIdentificacao = pendente.tipo === 'informar_identificacao' || pendente.tipo === 'quer_identificar';
    if (msg.resposta === null && pendente.tipo !== 'foto_local' && !perguntaEraIdentificacao) {
      const placaLida = extrairPlaca(msg.texto);
      if (placaLida && placaLida !== pendente.placa) {
        pendencias.registrar(msg.grupoId, msg.remetenteId, { ...pendente, placa: placaLida, placaEhGenerica: false });
        return {
          status: 'placa_anotada', hangarId: hangar.id, grupoId: msg.grupoId,
          ticket: pendente.ticket, placa: placaLida,
          mensagemWhatsapp: `Anotei a placa *${placaLida}* para o ticket ${pendente.ticket}.\n\n`
            + 'Confirma a validação? Responda *SIM* ou *NÃO*.',
          notificarAdmin: false, responder: true, etapa: 'resposta',
        };
      }
    }

    // Pendência de foto não se responde com texto: reforça o que falta em vez
    // de tratar "sim" como resposta a uma pergunta que não foi feita.
    if (pendente.tipo === 'foto_local') {
      return {
        status: 'aguardando_foto_veiculo', hangarId: hangar.id, grupoId: msg.grupoId, ticket: pendente.ticket,
        mensagemWhatsapp: `Ainda preciso da FOTO do veículo estacionado no hangar para validar o ticket ${pendente.ticket}. Mande a foto mostrando um pouco do entorno.`,
        notificarAdmin: false, responder: true, etapa: 'resposta',
      };
    }

    const ehFaturamento = pendente.tipo === 'autorizar_faturamento';
    const ehCotaMensal = pendente.tipo === 'usar_cota_mensal';

    // Cliente desistindo do faturamento por texto (a foto é o caminho do SIM).
    if (pendente.tipo === 'faturar_fora_prazo') {
      if (msg.resposta === 'nao') {
        pendencias.descartar(msg.grupoId, msg.remetenteId);
        return {
          status: 'cancelado_pelo_cliente', hangarId: hangar.id, grupoId: msg.grupoId, ticket: pendente.ticket,
          mensagemWhatsapp: `Tudo bem, não faturei o ticket ${pendente.ticket}. `
            + 'Para pagar, use o totem de autopagamento no terminal do aeroporto.',
          notificarAdmin: false, responder: true, etapa: 'resposta',
        };
      }
      return {
        status: 'faturamento_aguardando_foto', hangarId: hangar.id, grupoId: msg.grupoId, ticket: pendente.ticket,
        mensagemWhatsapp: `Para faturar o ticket ${pendente.ticket} preciso da *FOTO* de autorização. `
          + 'Mande a foto, ou responda *NÃO* para deixar pra lá.',
        notificarAdmin: false, responder: true, etapa: 'resposta',
      };
    }

    // Decisão do cliente sobre usar a cota fora do prazo.
    if (pendente.tipo === 'usar_cota_fora_prazo') {
      if (msg.resposta === 'nao') {
        pendencias.descartar(msg.grupoId, msg.remetenteId);
        return {
          status: 'cancelado_pelo_cliente', hangarId: hangar.id, grupoId: msg.grupoId, ticket: pendente.ticket,
          // O faturamento entra aqui no próximo passo; por ora orienta ao totem.
          mensagemWhatsapp: `Tudo bem, não validei o ticket ${pendente.ticket}. `
            + 'Para pagar, use o totem de autopagamento no terminal do aeroporto.',
          notificarAdmin: false, responder: true, etapa: 'resposta',
        };
      }
      if (msg.resposta !== 'sim') {
        return {
          status: 'resposta_nao_entendida', hangarId: hangar.id, grupoId: msg.grupoId, ticket: pendente.ticket,
          mensagemWhatsapp: `Não entendi. Para validar o ticket ${pendente.ticket} usando uma das validações fora do prazo, responda SIM. Para deixar pra lá, responda NÃO.`,
          notificarAdmin: false, responder: true, etapa: 'resposta',
        };
      }

      // SIM: consome a cota SOB TRAVA e enfileira a validação para o coletor.
      const pedido = pendencias.consumir(msg.grupoId, msg.remetenteId);
      if (!pedido) {
        return { status: 'ignorado', motivo: 'pendência já consumida por outra mensagem', grupoId: msg.grupoId, responder: false };
      }
      const consumo = cotaForaPrazo.consumirUmaValidacao(hangar);
      if (!consumo.dentroDaCota) {
        // A cota acabou entre a pergunta e o SIM (outra pessoa gastou a última).
        // consumir já debitou, então devolve antes de recusar.
        cotaForaPrazo.devolverUmaValidacao(hangar);
        return {
          status: 'cota_esgotada', hangarId: hangar.id, grupoId: msg.grupoId, ticket: pedido.ticket,
          mensagemWhatsapp: `A última validação fora do prazo deste pátio acabou de ser usada. `
            + 'Nossa equipe foi avisada.',
          notificarAdmin: true, responder: true, etapa: 'resposta',
        };
      }

      try {
        filaValidacoes.enfileirar({
          ticket: pedido.ticket,
          grupoId: msg.grupoId,
          hangarId: hangar.id,
          motivo: 'cota',
          autorizadoPor: msg.remetente || null,
        });
      } catch (erro) {
        // Não conseguiu enfileirar: devolve a cota, senão o cliente perde uma
        // validação por uma falha nossa.
        cotaForaPrazo.devolverUmaValidacao(hangar);
        return {
          status: 'erro', hangarId: hangar.id, grupoId: msg.grupoId, ticket: pedido.ticket,
          mensagem: erro.message,
          mensagemWhatsapp: '⚠️ Não consegui registrar a validação agora. Nossa equipe foi avisada.',
          notificarAdmin: true, responder: true, etapa: 'resposta',
        };
      }

      const rest = cotaForaPrazo.obterRestante(hangar);
      return {
        status: 'fora_do_prazo_enfileirado', hangarId: hangar.id, grupoId: msg.grupoId, ticket: pedido.ticket,
        usouCotaForaPrazo: true,
        // A validação roda no aeroporto no próximo ciclo do coletor; o cliente
        // é avisado quando ficar pronta (o servidor avisa ao receber o
        // resultado). Aqui só confirmamos o recebimento.
        mensagemWhatsapp: `✅ Autorizado. Vou validar o ticket ${pedido.ticket} — aviso aqui assim que estiver pronto.\n\n`
          + `_(usada 1 validação fora do prazo; restam ${rest} neste mês)_`,
        notificarAdmin: false, responder: true, etapa: 'validacao_cota_fora_prazo',
      };
    }

    // Resposta ao menu do pátio: 1, 2, 3 ou a palavra.
    if (pendente.tipo === 'escolha_patio') {
      const escolha = interpretarEscolhaPatio(msg.texto);
      if (!escolha) {
        return {
          status: 'menu_patio_nao_entendido', hangarId: hangar.id, grupoId: msg.grupoId,
          mensagemWhatsapp: 'Não entendi. Responda *1* para credenciados, *2* para tickets validados ou *3* para ambos.',
          notificarAdmin: false, responder: true, etapa: 'menu_patio',
        };
      }
      pendencias.consumir(msg.grupoId, msg.remetenteId);
      if (aoReceber) {
        try { await aoReceber(msg.grupoId, '🔎 Consultando o pátio...'); } catch (e) { /* aviso é conforto */ }
      }
      const patio = await consultarPatio(hangar.id, { formato: escolha });
      return {
        status: patio.status, hangarId: hangar.id, grupoId: msg.grupoId,
        mensagemWhatsapp: patio.mensagemWhatsapp,
        notificarAdmin: patio.notificarAdmin === true, responder: true,
        etapa: `status_patio_${escolha}`,
        vagasDisponiveis: patio.disponiveis ?? null,
        totalVagas: patio.total ?? null,
      };
    }

    // O texto É a identificação: nome, carro ou placa, como a pessoa quiser.
    if (pendente.tipo === 'informar_identificacao') {
      const identificacao = (msg.texto || '').trim().slice(0, 80);
      if (!identificacao) {
        return {
          status: 'identificacao_vazia', hangarId: hangar.id, grupoId: msg.grupoId, ticket: pendente.ticket,
          mensagemWhatsapp: `Não entendi. Mande o nome do cliente, o carro ou a placa para identificar o ticket ${pendente.ticket}.`,
          notificarAdmin: false, responder: true, etapa: 'pedido_identificacao',
        };
      }
      const pedido = pendencias.consumir(msg.grupoId, msg.remetenteId);
      if (!pedido) {
        return { status: 'ignorado', motivo: 'pendência já consumida por outra mensagem', grupoId: msg.grupoId, responder: false };
      }
      pedido.identificacao = identificacao;
      // Se o que a pessoa escreveu FOR uma placa, ela também vale como placa da
      // validação — "placa ABC1D23" resolve as duas coisas de uma vez, e pedir
      // de novo seria burocracia.
      const placaNoTexto = extrairPlaca(identificacao);
      if (placaNoTexto && pedido.placaEhGenerica) {
        pedido.placa = placaNoTexto;
        pedido.placaEhGenerica = false;
      }
      return seguirAposIdentificar(hangar, msg, pedido);
    }

    // "SIM, quero identificar" — pede o texto.
    if (pendente.tipo === 'quer_identificar') {
      if (msg.resposta === 'sim') {
        pendencias.registrar(msg.grupoId, msg.remetenteId, { ...pendente, tipo: 'informar_identificacao' });
        return {
          status: 'aguardando_identificacao', hangarId: hangar.id, grupoId: msg.grupoId, ticket: pendente.ticket,
          mensagemWhatsapp: 'Certo. Mande o *nome do cliente*, o *carro* ou a *placa*.',
          notificarAdmin: false, responder: true, etapa: 'pedido_identificacao',
        };
      }
      if (msg.resposta === 'nao') {
        const pedido = pendencias.consumir(msg.grupoId, msg.remetenteId);
        if (!pedido) {
          return { status: 'ignorado', motivo: 'pendência já consumida por outra mensagem', grupoId: msg.grupoId, responder: false };
        }
        return seguirAposIdentificar(hangar, msg, pedido);
      }
      // Texto que não é sim nem não pode MUITO BEM ser a identificação —
      // alguém que já sabe o fluxo responde "João da Silva" direto. Aproveitar
      // é melhor que exigir um SIM antes de aceitar o que já foi dito.
      const direto = (msg.texto || '').trim().slice(0, 80);
      if (direto) {
        const pedido = pendencias.consumir(msg.grupoId, msg.remetenteId);
        if (!pedido) {
          return { status: 'ignorado', motivo: 'pendência já consumida por outra mensagem', grupoId: msg.grupoId, responder: false };
        }
        pedido.identificacao = direto;
        const placaNoTexto = extrairPlaca(direto);
        if (placaNoTexto && pedido.placaEhGenerica) {
          pedido.placa = placaNoTexto;
          pedido.placaEhGenerica = false;
        }
        return seguirAposIdentificar(hangar, msg, pedido);
      }
    }

    if (msg.resposta === 'nao') {
      pendencias.descartar(msg.grupoId, msg.remetenteId);
      return {
        status: 'cancelado_pelo_cliente', hangarId: hangar.id, grupoId: msg.grupoId,
        ticket: pendente.ticket,
        mensagemWhatsapp: ehFaturamento
          ? `Tudo bem, não vou faturar nem validar o ticket ${pendente.ticket}. Se mudar de ideia, é só mandar a foto de novo.`
          : ehCotaMensal
            ? `Tudo bem, não validei o ticket ${pendente.ticket} e a cota do mês continua intacta. Se mudar de ideia, é só mandar a foto de novo.`
            : `Tudo bem, não validei o ticket ${pendente.ticket}. Se mudar de ideia, é só mandar a foto de novo.`,
        notificarAdmin: false, responder: true, etapa: 'resposta',
      };
    }

    // SIM no faturamento não basta: falta a foto de autorização. A pendência
    // fica de pé esperando a foto, senão o "sim" se perderia e o cliente
    // teria que recomeçar.
    if (msg.resposta === 'sim' && ehFaturamento) {
      return {
        status: 'fora_do_prazo_falta_foto_autorizacao', hangarId: hangar.id, grupoId: msg.grupoId,
        ticket: pendente.ticket, valor: pendente.valor,
        mensagemWhatsapp: `Para eu liberar o ticket ${pendente.ticket} e seguir com o faturamento, preciso de uma FOTO confirmando a autorização — é o registro de quem autorizou a cobrança. Pode mandar a foto aqui no grupo?`,
        notificarAdmin: false, responder: true, etapa: 'resposta',
      };
    }

    if (msg.resposta !== 'sim') {
      // Texto que não é sim nem não, com pergunta em aberto: reforça sem
      // adivinhar. Tratar "ok" ou um emoji como autorização gastaria cota do
      // hangar e ocuparia vaga sem o cliente ter dito claramente que queria.
      return {
        status: 'resposta_nao_entendida', hangarId: hangar.id, grupoId: msg.grupoId,
        ticket: pendente.ticket,
        mensagemWhatsapp: ehFaturamento
          ? `Não entendi. Para eu liberar o ticket ${pendente.ticket} e seguir com o faturamento, responda SIM. Para deixar pra lá, responda NÃO.`
          : ehCotaMensal
            ? `Não entendi. Para validar o ticket ${pendente.ticket} usando uma das validações do mês, responda SIM. Para deixar pra lá, responda NÃO.`
            : `Não entendi. Para validar o ticket ${pendente.ticket} usando uma das validações fora do prazo, responda SIM. Para deixar pra lá, responda NÃO.`,
        notificarAdmin: false, responder: true, etapa: 'resposta',
      };
    }

    // SIM: consome a pendência sob trava (duas mensagens quase simultâneas do
    // mesmo cliente não podem validar o mesmo ticket duas vezes) e valida.
    const pedido = pendencias.consumir(msg.grupoId, msg.remetenteId);
    if (!pedido) {
      return { status: 'ignorado', motivo: 'pendência já consumida por outra mensagem', grupoId: msg.grupoId, responder: false };
    }

    // SIM na cota mensal NÃO é `usarCota` — aquele parâmetro libera a validação
    // fora do prazo, que é outra coisa e cobra do hangar. Aqui o cliente só
    // autorizou gastar uma das validações do mês.
    if (ehCotaMensal) {
      // Num hangar que exige foto do veículo, autorizar a cota é o primeiro
      // passo, não o último: ainda falta a comprovação de que o carro está no
      // pátio. Hoje nenhum hangar tem cota E foto, mas deixar o caminho certo
      // custa três linhas e evita que a combinação futura valide sem conferir.
      if (hangar.exigeFotoVeiculoNoLocal) {
        pendencias.registrar(msg.grupoId, msg.remetenteId, { ...pedido, tipo: 'foto_local' });
        return {
          status: 'aguardando_foto_veiculo', hangarId: hangar.id, grupoId: msg.grupoId, ticket: pedido.ticket,
          mensagemWhatsapp: 'Combinado. Agora mande uma foto do veículo estacionado no hangar, '
            + 'com a placa visível e um pouco do entorno aparecendo.\n\n'
            + `⏱️ Tenho esse pedido aberto por ${pendencias.VALIDADE_MS / 60000} minutos.`,
          notificarAdmin: false, responder: true, etapa: 'pedido_foto_veiculo',
        };
      }
      return validar(hangar, msg, pedido, false);
    }

    return validar(hangar, msg, pedido, true);
  }

  // ---- foto chegando com pedido de foto do veículo = é a comprovação ----
  // Fluxo de dois passos dos hangares antifraude: a primeira foto traz o
  // ticket, esta traz o carro no pátio. Uma foto só não serve para as duas
  // coisas — o OCR precisa de close para ler 12 dígitos e a conferência precisa
  // de enquadramento aberto para ver piso, parede e fundo. Tentar as duas numa
  // só garante que uma sai ruim (confirmado no primeiro teste real do AIBM 2,
  // que voltou "indeterminado" por ser um close do ticket).
  const pedidoFoto = pendencias.buscar(msg.grupoId, msg.remetenteId);
  if (pedidoFoto && pedidoFoto.tipo === 'foto_local') {
    const pedido = pendencias.consumir(msg.grupoId, msg.remetenteId);
    if (!pedido) {
      return { status: 'ignorado', motivo: 'pendência já consumida por outra mensagem', grupoId: msg.grupoId, responder: false };
    }
    if (aoReceber) {
      try { await aoReceber(msg.grupoId, '🔎 Recebi a foto do veículo, conferindo o local...'); } catch (e) { /* aviso é conforto */ }
    }

    const imagemVeiculo = await baixarImagemBase64(msg.messageId);

    // Foto já usada em outra validação: recusa ANTES de conferir o local.
    //
    // A conferência de local jamais pegaria isto — ela pergunta "o carro está
    // neste pátio?", e numa foto reaproveitada do próprio pátio a resposta é
    // sim. A pergunta que faltava é "esta foto é de agora?". Apareceu no AIBM 2,
    // com fotos repetidas validadas (relatado em 16/09/2026).
    //
    // Antes do modelo de propósito: reenvio não merece uma chamada paga, e a
    // resposta é a mesma de qualquer jeito.
    const reuso = fotosUsadas.jaUsada(imagemVeiculo.base64);
    if (reuso) {
      pendencias.registrar(msg.grupoId, msg.remetenteId, pedido);
      return {
        status: 'foto_reutilizada',
        hangarId: hangar.id,
        grupoId: msg.grupoId,
        ticket: pedido.ticket,
        fotoUsadaEm: reuso.em,
        fotoUsadaNoTicket: reuso.ticket,
        fotoUsadaNoHangar: reuso.hangarId,
        mensagem: `Foto já usada no ticket ${reuso.ticket} (${reuso.hangarId}) em ${reuso.em}.`,
        mensagemWhatsapp: fotosUsadas.mensagemRecusa(reuso, pedido.ticket),
        // Reenviar foto é sinal de fraude, não descuido de enquadramento:
        // a administração precisa saber, como no local incompatível.
        notificarAdmin: true,
        responder: true,
        etapa: 'conferencia_local',
      };
    }

    // Esta foto NÃO passa pelo OCR: não há ticket nela, e o número já veio da
    // primeira. Só o local é conferido.
    const r = await lerLocal({ base64: imagemVeiculo.base64, mediaType: imagemVeiculo.mediaType, hangar });
    const local = avaliarLocal(hangar, r.local, r.localMotivo);
    const infoLocal = { local: local.local, localMotivo: local.motivo || null, cenario: r.cenario || null };

    // Placa, em ordem de confiança: a lida na foto do veículo (é o próprio
    // carro, a fonte mais direta), depois a que o cliente escreveu na legenda
    // do ticket, e por fim a genérica do hangar.
    const placaFinal = r.placa || pedido.placa || hangar.placaGenerica || 'AAA0000';
    pedido.placa = placaFinal;
    pedido.placaEhGenerica = !r.placa && !pedido.placa;
    if (r.placa) infoLocal.placaLidaDaFoto = r.placa;

    // SÓ `compativel` valida.
    //
    // Antes o `indeterminado` passava, para não acusar cliente honesto por causa
    // do enquadramento. Mas isso esvaziava o controle: se a foto não confirma
    // que o carro está no local, validar é o mesmo que não ter conferência
    // nenhuma — e num hangar com histórico de fraude é justamente o contrário
    // do que se quer. Decisão do usuário em 16/09/2026.
    //
    // A pendência é REGRAVADA nos dois casos de recusa: o cliente reenvia só a
    // foto do carro, sem precisar mandar o ticket de novo. Ela vence em 5 min.
    if (local.local !== 'compativel') {
      pendencias.registrar(msg.grupoId, msg.remetenteId, pedido);
      const incompativel = local.local === 'incompativel';
      return {
        ...infoLocal,
        status: incompativel ? 'local_incompativel' : 'local_indeterminado',
        hangarId: hangar.id, grupoId: msg.grupoId, ticket: pedido.ticket,
        mensagemWhatsapp: incompativel
          ? local.mensagemWhatsapp
          : 'Não consegui confirmar pela foto que o veículo está no hangar — '
            + `${local.motivo ? `${local.motivo} ` : ''}`
            + 'Mande outra foto um pouco mais afastada, mostrando o carro e o entorno (piso, parede ou o que aparece ao fundo). '
            + `O ticket ${pedido.ticket} continua aguardando por ${pendencias.VALIDADE_MS / 60000} minutos.`,
        // Local que CONTRADIZ a referência é sinal de fraude e precisa de gente.
        // Enquadramento ruim é só enquadramento ruim — não vale acionar ninguém.
        notificarAdmin: incompativel,
        responder: true,
        etapa: 'conferencia_local',
      };
    }

    const resultado = { ...infoLocal, ...validar(hangar, msg, pedido, false) };

    // Queima a foto SÓ quando validou. Registrar antes faria o cliente perder
    // uma foto boa por causa de um erro nosso — pátio cheio, site fora do ar —
    // e na tentativa seguinte ele seria acusado de reusar a própria foto.
    if (resultado.status === 'validado') {
      try {
        fotosUsadas.registrarPar({
          hashes: [pedido.hashTicket, fotosUsadas.impressaoDigital(imagemVeiculo.base64)],
          hangarId: hangar.id,
          ticket: pedido.ticket,
          grupoId: msg.grupoId,
          remetente: msg.remetente,
          placa: placaFinal,
        });
      } catch (e) {
        // O ticket já foi validado; falhar aqui não pode desfazer isso. Perde-se
        // a proteção para ESTA foto, e só.
        resultado.fotoNaoRegistrada = e.message;
      }
    }
    return resultado;
  }

  // ---- foto chegando com faturamento pendente = é a autorização ----
  // Foto de autorização do faturamento de ticket VENCIDO. Não emite nada aqui:
  // cria o pedido e manda para o admin. O boleto só sai no aval dele.
  const ofertaFat = pendencias.buscar(msg.grupoId, msg.remetenteId);
  if (ofertaFat && ofertaFat.tipo === 'faturar_fora_prazo') {
    const pedido = pendencias.consumir(msg.grupoId, msg.remetenteId);
    if (!pedido) {
      return { status: 'ignorado', motivo: 'pendência já consumida por outra mensagem', grupoId: msg.grupoId, responder: false };
    }
    filaFaturamentos.enfileirar({
      ticket: pedido.ticket,
      hangarId: hangar.id,
      grupoId: msg.grupoId,
      valor: pedido.valor,
      horasDecorridas: pedido.horasDecorridas,
      fotoMsgId: msg.messageId,
      solicitadoPor: msg.remetente,
    });
    return {
      status: 'faturamento_aguardando_admin',
      hangarId: hangar.id,
      grupoId: msg.grupoId,
      ticket: pedido.ticket,
      valor: pedido.valor,
      // Vai ao ADMIN (notificarAdmin) com o que ele precisa para decidir.
      mensagem: `FATURAMENTO pedido — ticket ${pedido.ticket}, ${hangar.hangar || hangar.id}, R$ ${formatarReais(pedido.valor)}, `
        + `cliente ${msg.remetente || '?'}, foto de autorização recebida.\n`
        + `Responda aqui *SIM* para EMITIR O BOLETO e liberar, ou *NÃO* para recusar.`,
      mensagemWhatsapp: `Recebi sua autorização do ticket ${pedido.ticket}. `
        + 'Encaminhei à administração; assim que for aprovado, o boleto é emitido e o ticket liberado. Aviso aqui.',
      notificarAdmin: true,
      responder: true,
      etapa: 'faturamento_aguardando_admin',
    };
  }

  // O bot acabou de pedir uma foto confirmando a autorização, então uma foto
  // desta pessoa agora é essa confirmação, não um ticket novo. Mandá-la ao
  // OCR seria errado duas vezes: não há ticket nela para ler, e o pedido
  // original (ticket, placa, data) já está guardado na pendência.
  const faturamentoPendente = pendencias.buscar(msg.grupoId, msg.remetenteId);
  if (faturamentoPendente && faturamentoPendente.tipo === 'autorizar_faturamento') {
    const pedido = pendencias.consumir(msg.grupoId, msg.remetenteId);
    if (!pedido) {
      return { status: 'ignorado', motivo: 'pendência já consumida por outra mensagem', grupoId: msg.grupoId, responder: false };
    }
    if (aoReceber) {
      try {
        await aoReceber(msg.grupoId, '🔎 Recebi a autorização, estou liberando o ticket e gerando a cobrança...');
      } catch (erro) { /* aviso é conforto, não pode travar o fluxo */ }
    }
    // A referência da foto guardada na auditoria é o id da mensagem no
    // WhatsApp: é o que permite reencontrar quem autorizou, e quando.
    return validar(hangar, msg, pedido, false, {
      autorizar: true,
      fotoAutorizacao: msg.messageId,
    });
  }

  // Daqui para baixo tudo é lento. Avisa que recebeu antes de começar.
  if (aoReceber) {
    try {
      await aoReceber(msg.grupoId, '🔎 Recebi seu ticket, já estou verificando...');
    } catch (erro) {
      // Falhar no aviso não pode impedir a validação: o aviso é conforto, o
      // resultado é o que importa.
    }
  }

  const imagem = await baixarImagemBase64(msg.messageId);

  // Foto de ticket já usada numa validação: recusa antes do OCR.
  //
  // O par ticket+veículo é gasto junto (ver lib/fotos-usadas.js). Aceitar de
  // volta a foto do ticket deixaria metade do par livre para reabrir um pedido
  // — e o pedido é justamente o que autoriza a foto do veículo a valer.
  const ticketReusado = fotosUsadas.jaUsada(imagem.base64);
  if (ticketReusado) {
    return {
      status: 'foto_reutilizada',
      hangarId: hangar.id,
      grupoId: msg.grupoId,
      ticket: ticketReusado.ticket,
      mensagem: `Foto de ticket já usada na validação do ticket ${ticketReusado.ticket} (${ticketReusado.hangarId}) em ${ticketReusado.em}.`,
      mensagemWhatsapp: fotosUsadas.mensagemRecusa(ticketReusado, ticketReusado.ticket || 'novo'),
      notificarAdmin: true,
      responder: true,
      etapa: 'leitura_ticket',
    };
  }

  // O hangar vai junto: nos que exigem foto do veículo no local (AIBM 1 e 2),
  // a conferência do cenário é feita na mesma chamada que lê o ticket.
  const ocr = await lerTicket({ base64: imagem.base64, mediaType: imagem.mediaType, hangar });

  if (ocr.status !== 'ocr_ok') {
    return {
      status: ocr.status,
      hangarId: hangar.id,
      grupoId: msg.grupoId,
      mensagemWhatsapp: ocr.mensagemWhatsapp,
      notificarAdmin: ocr.notificarAdmin === true,
      responder: true,
      ocr,
    };
  }

  // Ticket travado por tentativa em pátio cheio. Vem cedo: um ticket que
  // depende de decisão humana não deve consumir OCR, navegador nem foto do
  // cliente — e muito menos validar em outro pátio enquanto espera.
  const travado = bloqueados.estaBloqueado(ocr.ticket);
  if (travado) {
    // Registra ESTA tentativa antes de montar o aviso: é ela que interessa a
    // quem decide — o ticket travou num pátio e está sendo pedido em outro.
    const comAtual = bloqueados.bloquear(ocr.ticket, {
      hangarId: hangar.id,
      hangarNome: hangar.hangar || hangar.id,
      grupoId: msg.grupoId,
      remetente: msg.remetente,
    }) || travado;

    return {
      status: 'ticket_bloqueado',
      hangarId: hangar.id,
      grupoId: msg.grupoId,
      ticket: ocr.ticket,
      bloqueadoEm: travado.bloqueadoEm,
      bloqueadoNoHangar: travado.hangarNome || travado.hangarId,
      tentativas: (comAtual.tentativas || []).length,
      mensagem: `Ticket travado por falta de vaga, pedido de novo agora.\n`
        + bloqueados.trilha(comAtual, { quandoLegivel })
        + `\n\nResponda SIM para liberar ou NÃO para manter bloqueado.`,
      mensagemWhatsapp: bloqueados.mensagemParaCliente(ocr.ticket),
      notificarAdmin: true,
      responder: true,
      etapa: 'ticket_bloqueado',
    };
  }

  // Ticket que JÁ FOI VALIDADO por nós, em qualquer pátio.
  //
  // Cada hangar tem seu login no ValidPark, e cada login enxerga só o próprio
  // pátio. O número do ticket, porém, é global — quem gera é o servidor central
  // do aeroporto. Então o mesmo papel vale em qualquer pátio, e nenhum dos
  // sites tem como perceber. Em 16/09/2026 o ticket 011609161628 foi validado
  // no Alljet às 19:25 e no Hangar 1 às 19:36; o carro não estava nos dois.
  //
  // Esta é a ÚNICA barreira contra isso: é o nosso histórico que sabe o que
  // aconteceu nos outros pátios. Vale antes da conferência antifraude porque o
  // problema atinge todos os hangares, inclusive os que não pedem foto — foram
  // justamente esses dois.
  const validadoAntes = registro.jaValidado(ocr.ticket);
  if (validadoAntes) {
    const outroPatio = validadoAntes.hangarId && validadoAntes.hangarId !== hangar.id;
    const quando = new Date(validadoAntes.em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    return {
      status: 'ticket_ja_validado',
      hangarId: hangar.id,
      grupoId: msg.grupoId,
      ticket: ocr.ticket,
      validadoEm: validadoAntes.em,
      validadoNoHangar: validadoAntes.hangarId,
      mensagem: `Ticket ${ocr.ticket} já validado em ${validadoAntes.hangarId} às ${quando}`
        + `${outroPatio ? ' — PÁTIO DIFERENTE deste pedido.' : ' (mesmo pátio).'}`,
      mensagemWhatsapp: outroPatio
        ? `Esse ticket já foi validado em outro pátio, em ${quando}. `
          + 'Um ticket vale para um pátio só. Nossa equipe foi avisada — se houver engano, ela resolve.'
        : `Esse ticket já foi validado em ${quando}. Não é preciso validar de novo. `
          + 'Se precisar estender o prazo, fale com a administração.',
      // Avisa nos DOIS casos (escolha do usuário em 16/09/2026). A ideia
      // anterior era poupar o administrador da repetição no mesmo pátio, por
      // ser quase sempre reenvio por engano — mas quem decide o que é engano é
      // quem conhece o pátio, e ticket validado duas vezes é dinheiro em jogo
      // nas duas formas. O texto do `mensagem` diz qual dos dois casos é, então
      // dá para distinguir num relance sem precisar de dois tratamentos.
      notificarAdmin: true,
      responder: true,
      etapa: 'conferencia_duplicidade',
    };
  }

  // Ticket fora do prazo (>2h): oferece a cota, se o hangar tiver.
  //
  // Vem depois de "já validado" (não faz sentido gastar cota num ticket que já
  // foi usado) e antes do resto. A validação de vencido roda no COLETOR, sob o
  // pátio #1PARK — o ValidPark recusa vencido. Aqui o bot só DECIDE: havendo
  // cota, pergunta ao cliente; ele aceitando, a validação é enfileirada e a
  // cota descontada. Sem cota, o caminho é o faturamento (a montar) — por ora,
  // escala para a administração.
  const prazo = dentroDoPrazo(hangar, ocr.dataEmissaoIso);
  if (prazo.ok === false) {
    const restanteForaPrazo = cotaForaPrazo.obterRestante(hangar);
    if (restanteForaPrazo > 0) {
      pendencias.registrar(msg.grupoId, msg.remetenteId, {
        ticket: ocr.ticket,
        hangarId: hangar.id,
        horasDecorridas: prazo.horasDecorridas,
        tipo: 'usar_cota_fora_prazo',
      });
      return {
        status: 'fora_do_prazo_requer_decisao',
        hangarId: hangar.id,
        grupoId: msg.grupoId,
        ticket: ocr.ticket,
        cotaRestante: restanteForaPrazo,
        mensagemWhatsapp: `⚠️ O ticket ${ocr.ticket} está fora do prazo de ${hangar.prazoValidacaoHoras}h `
          + `(emitido há ${prazo.horasDecorridas.toFixed(1)}h).\n\n`
          + `Este pátio tem *${restanteForaPrazo}* validação(ões) fora do prazo neste mês. `
          + 'Quer usar *1* para validar mesmo assim? Responda *SIM* ou *NÃO*.',
        notificarAdmin: false,
        responder: true,
        etapa: 'decisao_cota_fora_prazo',
      };
    }
    // Sem cota: oferece FATURAR. O boleto é real (Asaas produção) e só sai depois
    // do aval do admin — mas isso é lá na frente. Aqui o bot informa o valor e
    // pede a FOTO de autorização, que é o registro de quem mandou cobrar.
    const valorFaturar = calcularValorPermanencia(prazo.horasDecorridas);
    pendencias.registrar(msg.grupoId, msg.remetenteId, {
      ticket: ocr.ticket,
      hangarId: hangar.id,
      horasDecorridas: prazo.horasDecorridas,
      valor: valorFaturar,
      tipo: 'faturar_fora_prazo',
    });
    return {
      status: 'fora_do_prazo_requer_autorizacao_faturamento',
      hangarId: hangar.id,
      grupoId: msg.grupoId,
      ticket: ocr.ticket,
      valor: valorFaturar,
      mensagem: `Ticket há ${prazo.horasDecorridas.toFixed(1)}h, sem cota fora do prazo. Faturamento oferecido: R$ ${formatarReais(valorFaturar)}.`,
      mensagemWhatsapp: `⚠️ O ticket ${ocr.ticket} está fora do prazo de ${hangar.prazoValidacaoHoras}h e este pátio não tem cota disponível.\n\n`
        + `Dá para *faturar e liberar*: R$ ${formatarReais(valorFaturar)}, boleto para o hangar.\n\n`
        + 'Para autorizar, mande uma *FOTO* confirmando (registro de quem autorizou a cobrança). '
        + 'Ou responda *NÃO* para deixar pra lá.',
      notificarAdmin: false,
      responder: true,
      etapa: 'oferta_faturamento',
    };
  }

  // Teto mensal de validações, para hangares com cota contratada (hoje só o
  // VOASP, com 20 por mês). Vale antes de qualquer trabalho caro: não faz
  // sentido pedir foto do veículo e abrir navegador para um ticket que a cota
  // já não permite validar.
  //
  // A renovação é automática porque a contagem é por mês de calendário — não
  // existe contador a zerar, o mês simplesmente vira. Em horário de São Paulo,
  // não no do servidor: ver a nota de fuso em lib/cota-mensal.js.
  const cota = cotaMensal.situacao(hangar);
  if (cota.esgotada) {
    return {
      status: 'cota_mensal_esgotada',
      hangarId: hangar.id,
      grupoId: msg.grupoId,
      ticket: ocr.ticket,
      cotaLimite: cota.limite,
      cotaUsadas: cota.usadas,
      mensagem: `Cota mensal esgotada: ${cota.usadas} de ${cota.limite} validações em ${cota.mes}.`,
      mensagemWhatsapp: cotaMensal.mensagemEsgotada(hangar, cota),
      // Precisa de gente: a cota é regra comercial, e só a administração pode
      // decidir se libera uma exceção ou se o mês acabou mesmo.
      notificarAdmin: true,
      responder: true,
      etapa: 'cota_mensal',
    };
  }

  // Cota mensal disponível: PERGUNTA antes de gastar.
  //
  // Pedido do usuário em 16/09/2026. A cota é do hangar, não do bot: cada
  // validação consome uma das 20 do mês, e quem manda o ticket pode não ser
  // quem decide se aquele carro merece gastar uma. Validar direto tiraria essa
  // escolha de quem paga a conta.
  //
  // Mesma mecânica da cota fora do prazo, para o cliente encontrar o
  // comportamento que já conhece: pergunta, guarda o pedido, e só age no SIM.
  // "Quer identificar este ticket?" — nome do cliente, carro ou placa.
  //
  // A identificação é do HANGAR, não do ValidPark: o site só aceita placa no
  // formato dele, então um nome ou um modelo de carro não teriam onde caber
  // lá. Ela fica no nosso histórico, que é onde alguém vai procurar depois
  // para saber de quem era aquele ticket.
  //
  // É pergunta de sim/não antes do texto livre porque a maior parte das
  // validações não precisa disso, e obrigar todo mundo a digitar algo para
  // validar um ticket seria pedágio.
  // Quem já mandou a placa na legenda da foto NÃO é perguntado: o ticket já
  // está identificado, e a placa vira a identificação. Perguntar de novo seria
  // pedir o que a pessoa acabou de dar — e é o fluxo que o grupo do Solojet já
  // usava antes da pergunta existir (foto + "FLI8888" na legenda).
  if (hangar.perguntarIdentificacao && !msg.placa) {
    pendencias.registrar(msg.grupoId, msg.remetenteId, {
      ticket: ocr.ticket,
      placa: msg.placa || null,
      placaEhGenerica: !msg.placa,
      dataEmissaoIso: ocr.dataEmissaoIso,
      hangarId: hangar.id,
      tipo: 'quer_identificar',
      hashTicket: fotosUsadas.impressaoDigital(imagem.base64),
    });
    return {
      status: 'requer_decisao_identificacao',
      hangarId: hangar.id,
      grupoId: msg.grupoId,
      ticket: ocr.ticket,
      mensagemWhatsapp: `Recebi o ticket ${ocr.ticket}.\n\n`
        + 'Você quer identificar esse ticket com nome de cliente, carro ou placa? Responda *SIM* ou *NÃO*.',
      notificarAdmin: false,
      responder: true,
      etapa: 'decisao_identificacao',
    };
  }

  const comCota = perguntarCotaSePreciso(hangar, msg, {
    ticket: ocr.ticket,
    // Placa da legenda também identifica o ticket, nos pátios que perguntam.
    // Sem isto, o atalho de mandar tudo numa mensagem só deixaria o histórico
    // sem identificação — justamente quem foi mais explícito ficaria de fora.
    identificacao: (hangar.perguntarIdentificacao && msg.placa) ? msg.placa : null,
    // A placa genérica precisa ser resolvida AQUI, não lá na frente. Era o bug
    // do primeiro teste do VOASP (17/09/2026): a pendência guardava null, o SIM
    // validava com null, e o ValidPark devolvia "Digite a placa do veiculo
    // corretamente". O caminho sem cota sempre aplicou essa mesma cadeia — foi
    // a pergunta da cota que passou por fora dela.
    placa: msg.placa || hangar.placaGenerica || 'AAA0000',
    placaEhGenerica: !msg.placa,
    dataEmissaoIso: ocr.dataEmissaoIso,
    hangarId: hangar.id,
    hashTicket: fotosUsadas.impressaoDigital(imagem.base64),
  });
  if (comCota) return comCota;

  // Hangar antifraude: CONSULTA primeiro, pede a foto depois.
  //
  // A ordem importa. Pedir a foto do carro antes de saber se o ticket serve
  // faria o cliente ir até o veículo, fotografar e voltar — para só então
  // ouvir que o ticket já tinha sido usado ou está fora do prazo. Conferir
  // antes custa uma consulta barata e evita esse trabalho perdido.
  if (hangar.exigeFotoVeiculoNoLocal) {
    const previa = rodarScript('consultar-ticket.js', [hangar.id, ocr.ticket]);

    // Aproveita a consulta que acabou de acontecer para resolver a divergência
    // entre número e data impressa, quando houver.
    const suspeito = suspeitaDeNumeroTrocado(hangar, msg, ocr, previa);
    if (suspeito) return suspeito;

    const naoServe = previa.status !== 'consulta_ok' || previa.jaValidado === true;
    if (naoServe) {
      return {
        status: previa.status,
        hangarId: hangar.id,
        grupoId: msg.grupoId,
        ticket: ocr.ticket,
        // O motivo TÉCNICO da falha vem junto. Sem ele, um erro na consulta
        // chegava ao log do n8n e ao administrador como "não conseguimos
        // consultar" e nada mais — sem timeout, sem seletor, sem nome de
        // exceção. Aconteceu em 16/09/2026 no AIBM 1: para descobrir a causa
        // foi preciso rodar o script à mão, e aí já não reproduzia.
        mensagem: previa.mensagem || null,
        mensagemWhatsapp: previa.mensagemWhatsapp,
        notificarAdmin: previa.notificarAdmin === true,
        responder: true,
        etapa: 'consulta',
      };
    }

    pendencias.registrar(msg.grupoId, msg.remetenteId, {
      ticket: ocr.ticket,
      placa: msg.placa || null,       // da legenda, se veio; senão a foto do carro decide
      placaEhGenerica: !msg.placa,
      dataEmissaoIso: ocr.dataEmissaoIso,
      hangarId: hangar.id,
      tipo: 'foto_local',
      // A impressão digital da foto do ticket viaja com o pedido para ser
      // gasta JUNTO com a do veículo quando a validação sair. É isto que
      // agrupa as duas: uma validação, um par, nenhuma das duas reaproveitável.
      hashTicket: fotosUsadas.impressaoDigital(imagem.base64),
    });
    return {
      status: 'aguardando_foto_veiculo',
      hangarId: hangar.id,
      grupoId: msg.grupoId,
      ticket: ocr.ticket,
      // O prazo vai na mensagem: sem ele a expiração chega como surpresa, e a
      // pessoa descobre que perdeu a vez só quando manda a foto.
      mensagemWhatsapp: `Recebi seu ticket ${ocr.ticket} e verifiquei que ele pode ser validado. `
        + 'Agora mande uma foto do veículo estacionado no hangar, com a placa visível e um pouco do entorno aparecendo. '
        + 'Vou usar a placa da foto para preencher a validação.\n\n'
        + `⏱️ Tenho esse pedido aberto por ${pendencias.VALIDADE_MS / 60000} minutos. `
        + 'Passando disso, é só mandar a foto do ticket de novo.',
      notificarAdmin: false,
      responder: true,
      etapa: 'pedido_foto_veiculo',
    };
  }

  // Conferência de local, antes de qualquer coisa que tenha efeito. Só vale
  // para hangares com exigeFotoVeiculoNoLocal (AIBM 1 e 2): é o requisito
  // antifraude do pátio com histórico de problema.
  //
  // Até 15/09/2026 o módulo conferir-local.js existia, testado, e não era
  // chamado por lugar nenhum — o config dizia que a checagem era obrigatória e
  // o código validava sem fazê-la, em silêncio.
  //
  // Só `incompativel` bloqueia. `indeterminado` passa com aviso: num close do
  // carro aparece apenas um pedaço de asfalto ou de parede branca, que existe
  // no aeroporto inteiro, e travar por isso acusaria de fraude cliente
  // honesto por causa do enquadramento da foto.
  const local = avaliarLocal(hangar, ocr.local, ocr.localMotivo);

  // O veredito viaja junto do resultado mesmo quando NÃO bloqueia. Antes ele só
  // aparecia no caminho de bloqueio, e um "indeterminado" ficava invisível —
  // indistinguível de "a conferência não rodou". Para um controle antifraude
  // isso é grave: quem olha depois não sabe se houve checagem.
  const infoLocal = local.aplicavel
    ? { local: local.local, localMotivo: local.motivo || null, cenario: ocr.cenario || null }
    : {};

  if (local.bloqueia) {
    return {
      status: 'local_incompativel',
      hangarId: hangar.id,
      grupoId: msg.grupoId,
      ticket: ocr.ticket,
      local: local.local,
      localMotivo: local.motivo,
      cenario: ocr.cenario || null,
      mensagemWhatsapp: local.mensagemWhatsapp,
      notificarAdmin: local.notificarAdmin === true,
      responder: true,
      etapa: 'conferencia_local',
    };
  }

  // Consulta primeiro, sempre. Além de ser barata e sem efeito colateral, ela
  // evita tentar validar um ticket que já foi usado — o que gastaria uma
  // abertura de navegador e, fora do prazo, uma validação da cota do hangar.
  //
  // Na CONTINGÊNCIA essa consulta ao vivo não roda: ela também é no ValidPark,
  // que é justamente o que caiu. O já-validado que conhecemos (nosso histórico)
  // já foi conferido acima; perde-se só a checagem contra uma validação feita
  // direto no balcão. Reenfileirar um ticket já validado no coletor apenas
  // re-estende a tolerância no mesmo pátio — não cobra de novo —, então o risco
  // é aceitável durante uma queda. A validação segue para validarPorContingencia.
  const consulta = contingenciaLigada()
    ? { status: 'consulta_ok', jaValidado: false }
    : rodarScript('consultar-ticket.js', [hangar.id, ocr.ticket]);

  const suspeito = suspeitaDeNumeroTrocado(hangar, msg, ocr, consulta);
  if (suspeito) return suspeito;

  const jaResolvido =
    consulta.status !== 'consulta_ok' || consulta.jaValidado === true;

  if (jaResolvido) {
    return {
      ...infoLocal,
      status: consulta.status,
      hangarId: hangar.id,
      grupoId: msg.grupoId,
      ticket: ocr.ticket,
      mensagemWhatsapp: consulta.mensagemWhatsapp,
      notificarAdmin: consulta.notificarAdmin === true,
      responder: true,
      etapa: 'consulta',
    };
  }

  // Placa: vem da legenda da foto; sem ela, a genérica do hangar. Decisão do
  // usuário em 15/09/2026 — o cliente é avisado quando a genérica for usada,
  // para poder corrigir com a administração.
  const placa = msg.placa || hangar.placaGenerica || 'AAA0000';

  return {
    ...infoLocal,
    ...validar(hangar, msg, {
      ticket: ocr.ticket,
      placa,
      placaEhGenerica: !msg.placa,
      // Mesma regra do caminho com cota: a placa da legenda identifica o
      // ticket nos pátios que perguntam.
      identificacao: (hangar.perguntarIdentificacao && msg.placa) ? msg.placa : null,
      dataEmissaoIso: ocr.dataEmissaoIso,
    }, false),
  };
}

/**
 * Resposta da administração, em conversa privada, sobre ticket bloqueado.
 *
 * Existe porque o aviso de bloqueio chega no privado de quem decide, e mandar
 * essa pessoa abrir o painel para digitar um "sim" é atrito no pior momento —
 * tem cliente parado no pátio esperando.
 *
 * QUEM PODE: só um número cadastrado como `grupoAdministracao` de algum
 * hangar. Qualquer outro privado é ignorado em silêncio, sem resposta: o
 * número do bot é público dentro dos grupos, e responder a estranhos
 * confirmaria que existe algo ali para ser explorado.
 */
// Fonte reconhecida como administração: o destino de aviso de algum hangar
// (grupoAdministracao), OU uma entrada na lista global adminsWhatsapp — que
// aceita tanto um NÚMERO (…@s.whatsapp.net) quanto um GRUPO (…@g.us), para dar
// poder de comando a um segundo telefone ou a um grupo só da administração.
function ehFonteAdmin(config, jid) {
  const id = (jid || '').trim();
  if (!id) return false;
  if ((config.adminsWhatsapp || []).map((n) => String(n).trim()).includes(id)) return true;
  return config.hangares.some((h) => (h.grupoAdministracao || '').trim() === id);
}

/**
 * Acha o hangar citado num texto livre ("pátio do solojet", "credenciados aibm
 * 2"). Casa por nome, id e bolsão, e prefere o MAIS LONGO: "aibm 2" ganha de
 * "aibm", "solojet shares" ganha de "solojet". Sem citação clara, devolve null
 * — melhor perguntar qual pátio do que consultar o errado.
 */
function acharHangarNoTexto(config, texto) {
  const t = normalizar(texto || '');
  if (!t) return null;
  let melhor = null;
  for (const h of config.hangares) {
    const chaves = [h.hangar, h.id, String(h.id || '').replace(/-/g, ' '), h.bolsaoTechparking]
      .filter(Boolean).map((x) => normalizar(x));
    for (const chave of chaves) {
      if (chave.length >= 3 && t.includes(chave) && (!melhor || chave.length > melhor.len)) {
        melhor = { hangar: h, len: chave.length };
      }
    }
  }
  return melhor ? melhor.hangar : null;
}

/**
 * O assunto de pátio num texto, SEM exigir verbo — "credenciados do solojet",
 * "vagas do alljet". No grupo do hangar o parser pede verbo (para frase solta
 * não virar comando), mas no hub da administração nomear o hangar já é a
 * intenção clara, então aqui basta o assunto. Devolve 'credenciados', 'tickets',
 * 'status' ou null.
 */
function assuntoPatioNoHub(texto) {
  const t = normalizar(texto || '');
  if (/\b(credenciad[oa]s?|mensalistas?)\b/.test(t)) return 'credenciados';
  if (/\btickets?\b/.test(t)) return 'tickets';
  if (/\b(patio|vagas?|estacionamento)\b/.test(t)) return 'status';
  return null;
}

/**
 * Mensagens vindas de um grupo (ou número) de administração. Além dos comandos
 * de decisão (contingência, faturamento, ticket travado, em
 * responderAutorizacaoPrivada), aqui dá para CONSULTAR qualquer pátio — coisa
 * que no grupo de um hangar sai sozinha (o grupo já é o pátio), mas no hub da
 * administração precisa do nome do hangar junto.
 */
async function responderNoGrupoAdmin(msg, aoReceber) {
  const config = carregarConfig();
  const hangar = msg.tipo === 'texto' ? acharHangarNoTexto(config, msg.texto) : null;
  // Pedido de pátio: o do parser normal (com verbo) OU, se um hangar foi
  // nomeado, o assunto solto. Nomear o hangar é o que separa consulta de
  // conversa — sem nome, uma palavra solta ("vagas") não vira consulta.
  const pedido = (msg.tipo === 'texto' && (msg.pedidoPatio || (hangar ? assuntoPatioNoHub(msg.texto) : null))) || null;

  if (pedido) {
    if (!hangar) {
      const nomes = config.hangares
        .filter((h) => (h.grupoWhatsappId || '').trim())
        .map((h) => h.hangar || h.id);
      const exemplo = pedido === 'credenciados' ? 'credenciados do Solojet'
        : pedido === 'tickets' ? 'tickets validados do Alljet' : 'como está o pátio do Solojet';
      return {
        status: 'admin_patio_sem_hangar', grupoId: msg.grupoId,
        mensagemWhatsapp: `De qual pátio? Diga o nome do hangar junto — ex.: *${exemplo}*.\n\n`
          + `Pátios: ${nomes.join(', ')}.`,
        notificarAdmin: false, responder: true, etapa: 'admin_patio',
      };
    }
    if (aoReceber) {
      try { await aoReceber(msg.grupoId, `🔎 Consultando o pátio ${hangar.hangar || hangar.id}...`); } catch (e) { /* aviso é conforto */ }
    }
    // Sem menu no hub: o genérico ("status") traz tudo de uma vez, que é o que
    // quem administra quer ao olhar um pátio de fora.
    const formato = pedido === 'credenciados' ? 'credenciados'
      : pedido === 'tickets' ? 'tickets' : 'ambos';
    const patio = await consultarPatio(hangar.id, { formato });
    return {
      status: patio.status, hangarId: hangar.id, grupoId: msg.grupoId,
      mensagemWhatsapp: patio.mensagemWhatsapp,
      notificarAdmin: patio.notificarAdmin === true, responder: true, etapa: `admin_patio_${formato}`,
      vagasDisponiveis: patio.disponiveis ?? null, totalVagas: patio.total ?? null,
    };
  }

  return await responderAutorizacaoPrivada(msg);
}

async function responderAutorizacaoPrivada(msg) {
  const config = carregarConfig();
  const ehAdmin = ehFonteAdmin(config, msg.grupoId);

  // Comando de contingência: ligar/desligar o contorno do ValidPark pelo
  // WhatsApp, para quando a queda pega longe do painel. Vem ANTES da porta do
  // admin porque tem autorização PRÓPRIA, mais larga: a administração pode
  // sempre, e também os números em contingenciaValidPark.autorizados — que
  // comandam SÓ a contingência, não aprovam faturamento nem ticket travado.
  const comandoCont = interpretarComandoContingencia(msg.texto);
  if (comandoCont !== null) {
    const atual = config.contingenciaValidPark || {};
    const autorizados = (atual.autorizados || []).map((n) => String(n).trim());
    if (!ehAdmin && !autorizados.includes((msg.grupoId || '').trim())) {
      return { status: 'ignorado', motivo: 'contingência de número não autorizado', grupoId: msg.grupoId, responder: false };
    }
    if ((atual.ativo === true) === comandoCont) {
      return {
        status: 'contingencia_sem_mudanca', grupoId: msg.grupoId,
        mensagemWhatsapp: `A contingência do ValidPark já está *${comandoCont ? 'LIGADA' : 'desligada'}*.`,
        notificarAdmin: false, responder: true, etapa: 'comando_contingencia',
      };
    }
    const quemCont = msg.remetente || msg.grupoId;
    // Espalha o atual para PRESERVAR 'autorizados' (e o que mais houver) — só
    // ativo/desde/por mudam aqui.
    config.contingenciaValidPark = {
      ...atual,
      ativo: comandoCont,
      desde: comandoCont ? new Date().toISOString() : null,
      por: comandoCont ? quemCont : null,
    };
    try {
      salvarEComitar(config, `Contingência ValidPark ${comandoCont ? 'LIGADA' : 'desligada'} por ${quemCont} (WhatsApp)`, 'Bot do WhatsApp');
    } catch (erro) {
      return {
        status: 'erro', grupoId: msg.grupoId, mensagem: erro.message,
        mensagemWhatsapp: '⚠️ Não consegui salvar a mudança da contingência. Nossa equipe foi avisada.',
        notificarAdmin: true, responder: true, etapa: 'comando_contingencia',
      };
    }
    return {
      status: comandoCont ? 'contingencia_ligada' : 'contingencia_desligada', grupoId: msg.grupoId,
      mensagem: `Contingência ${comandoCont ? 'LIGADA' : 'desligada'} por ${quemCont} via WhatsApp.`,
      mensagemWhatsapp: comandoCont
        ? '🔴 Contingência do ValidPark *LIGADA*.\n\nA validação dentro do prazo passa a ser feita pelo sistema do aeroporto (coletor), no pátio de cada hangar. A confirmação ao cliente chega em segundos.\n\n*Desligue assim que o ValidPark voltar* — mande "desligar contingência".'
        : '✅ Contingência do ValidPark *desligada*.\n\nA validação volta a ser feita pelo ValidPark, na hora.',
      notificarAdmin: false, responder: true, etapa: 'comando_contingencia',
    };
  }

  // Daqui para baixo é decisão de admin de verdade (faturamento, ticket
  // travado). Número fora da administração não passa.
  if (!ehAdmin) {
    return { status: 'ignorado', motivo: 'privado de número que não é administração', grupoId: msg.grupoId, responder: false };
  }

  // O admin decide sobre DUAS coisas pelo privado: ticket bloqueado (pátio
  // cheio) e faturamento de ticket vencido. O número do ticket desempata; sem
  // ele, se só um tipo espera, age nele; se os dois esperam, pede o número.
  const fatCitado = msg.ticketCitado ? filaFaturamentos.aguardandoPorTicket(msg.ticketCitado) : null;
  const bloqCitado = msg.ticketCitado ? bloqueados.estaBloqueado(msg.ticketCitado) : null;
  const fats = filaFaturamentos.listar().filter((f) => f.estado === 'aguardando_admin');
  const blocks = bloqueados.listar({ apenasAtivos: true });

  if (msg.resposta !== 'sim' && msg.resposta !== 'nao') {
    const total = fats.length + blocks.length;
    if (!total) {
      return { status: 'ignorado', motivo: 'privado sem decisão e sem nada aguardando', grupoId: msg.grupoId, responder: false };
    }
    const linhasFat = fats.slice(0, 5).map((f) => `• 💰 ${f.ticket} — ${f.hangarId}, faturar R$ ${formatarReais(f.valor)}`);
    const linhasBloq = blocks.slice(0, 5).map((b) => `• 🚫 ${b.ticket} — ${b.hangarNome || b.hangarId}, pátio cheio`);
    return {
      status: 'autorizacao_nao_entendida', grupoId: msg.grupoId,
      mensagemWhatsapp: `Há ${total} pedido(s) aguardando sua decisão:\n\n`
        + linhasFat.concat(linhasBloq).join('\n')
        + '\n\nResponda *SIM* para autorizar ou *NÃO* para recusar.'
        + (total > 1 ? '\nCom mais de um, diga o número: _SIM 011809140000_' : ''),
      notificarAdmin: false, responder: true, etapa: 'autorizacao_privada',
    };
  }

  // Escolhe o alvo. Faturamento tem prioridade quando o número casa com um.
  let tipo = null;
  let alvoFat = null;
  let alvoBloq = null;
  if (msg.ticketCitado) {
    if (fatCitado) { tipo = 'faturamento'; alvoFat = fatCitado; }
    else if (bloqCitado) { tipo = 'bloqueio'; alvoBloq = bloqCitado; }
  } else if (fats.length + blocks.length === 1) {
    if (fats.length === 1) { tipo = 'faturamento'; alvoFat = fats[0]; }
    else { tipo = 'bloqueio'; alvoBloq = blocks[0]; }
  } else if (fats.length + blocks.length > 1) {
    return {
      status: 'autorizacao_ambigua', grupoId: msg.grupoId,
      mensagemWhatsapp: 'Há mais de um pedido aguardando. Diga o número do ticket: _SIM 011809140000_.',
      notificarAdmin: false, responder: true, etapa: 'autorizacao_privada',
    };
  }

  if (!tipo) {
    return {
      status: 'autorizacao_sem_alvo', grupoId: msg.grupoId,
      mensagemWhatsapp: msg.ticketCitado
        ? `O ticket ${msg.ticketCitado} não está aguardando decisão — pode já ter sido resolvido.`
        : 'Não há nada aguardando sua decisão no momento.',
      notificarAdmin: false, responder: true, etapa: 'autorizacao_privada',
    };
  }

  const quem = msg.remetente || msg.grupoId;

  if (tipo === 'faturamento') {
    return aprovarOuRecusarFaturamento(alvoFat, msg.resposta === 'sim', quem, config, msg.grupoId);
  }

  // --- ticket bloqueado (pátio cheio) ---
  try {
    if (msg.resposta === 'sim') {
      bloqueados.autorizar(alvoBloq.ticket, quem);
      // Autorizar o bloqueio VALIDA o ticket: enfileira para o coletor.
      filaValidacoes.enfileirar({ ticket: alvoBloq.ticket, grupoId: alvoBloq.grupoId, hangarId: alvoBloq.hangarId, motivo: 'bloqueio_liberado', autorizadoPor: quem });
      return {
        status: 'bloqueio_autorizado', grupoId: msg.grupoId, ticket: alvoBloq.ticket,
        grupoDeOrigem: alvoBloq.grupoId,
        mensagemWhatsapp: `✅ Ticket *${alvoBloq.ticket}* liberado (${alvoBloq.hangarNome || alvoBloq.hangarId}). Vou validá-lo e avisei o grupo.`,
        avisarGrupoDeOrigem: `✅ O ticket ${alvoBloq.ticket} foi *autorizado* pela administração. Estou validando.`,
        notificarAdmin: false, responder: true, etapa: 'autorizacao_privada',
      };
    }
    bloqueados.manterBloqueado(alvoBloq.ticket, quem);
    return {
      status: 'bloqueio_mantido', grupoId: msg.grupoId, ticket: alvoBloq.ticket,
      grupoDeOrigem: alvoBloq.grupoId,
      mensagemWhatsapp: `🚫 Ticket *${alvoBloq.ticket}* segue bloqueado (${alvoBloq.hangarNome || alvoBloq.hangarId}). Avisei o grupo.`,
      avisarGrupoDeOrigem: `🚫 O ticket ${alvoBloq.ticket} *não foi autorizado* pela administração. Para pagar, use o totem de autopagamento no terminal do aeroporto.`,
      notificarAdmin: false, responder: true, etapa: 'autorizacao_privada',
    };
  } catch (erro) {
    return {
      status: 'erro', grupoId: msg.grupoId, mensagem: erro.message,
      mensagemWhatsapp: `⚠️ Não consegui registrar a decisão: ${erro.message}`,
      notificarAdmin: false, responder: true, etapa: 'autorizacao_privada',
    };
  }
}

/**
 * O aval do admin sobre um faturamento. SIM emite o boleto (Asaas) e libera a
 * validação; NÃO recusa. O boleto real é o ÚLTIMO passo — nunca antes daqui.
 *
 * FATURAMENTO_SIMULAR=true pula a chamada ao Asaas e finge o boleto, para
 * testar o fluxo inteiro sem cobrar. Com a chave de PRODUÇÃO no servidor, é
 * assim que se testa sem emitir dinheiro real.
 */
async function aprovarOuRecusarFaturamento(fat, aprovado, quem, config, adminGrupoId) {
  const hangar = config.hangares.find((h) => h.id === fat.hangarId) || { id: fat.hangarId };

  if (!aprovado) {
    filaFaturamentos.decidir(fat.id, { aprovado: false, quem });
    return {
      status: 'faturamento_recusado', grupoId: adminGrupoId, ticket: fat.ticket,
      grupoDeOrigem: fat.grupoId,
      mensagemWhatsapp: `🚫 Faturamento do ticket *${fat.ticket}* recusado. Avisei o grupo.`,
      avisarGrupoDeOrigem: `🚫 O faturamento do ticket ${fat.ticket} não foi autorizado. Para pagar, use o totem de autopagamento no terminal do aeroporto.`,
      notificarAdmin: false, responder: true, etapa: 'autorizacao_privada',
    };
  }

  const simular = String(process.env.FATURAMENTO_SIMULAR || '').toLowerCase() === 'true';
  let boleto;
  try {
    if (simular) {
      boleto = { simulado: true, id: `sim_${fat.id.slice(0, 8)}`, value: fat.valor, bankSlipUrl: null };
    } else {
      boleto = await asaas.criarCobrancaBoleto({
        hangar,
        valor: fat.valor,
        descricao: `Estacionamento SBJD — ticket ${fat.ticket} (fora do prazo)`,
        dataVencimento: new Date(Date.now() + 3 * 24 * 3600 * 1000).toISOString().slice(0, 10),
      });
    }
  } catch (erro) {
    // Falhou emitir: NÃO marca como faturado, para você poder tentar de novo.
    // Não valida nem avisa o grupo — nada aconteceu.
    return {
      status: 'faturamento_erro', grupoId: adminGrupoId, ticket: fat.ticket,
      mensagem: `Falha ao emitir boleto do ticket ${fat.ticket}: ${erro.message}`,
      mensagemWhatsapp: `⚠️ Não consegui emitir o boleto do ticket ${fat.ticket}: ${erro.message}\n\n`
        + 'O pedido continua aguardando — dá para tentar de novo. '
        + (/cadastro|CNPJ/i.test(erro.message) ? 'Falta o cadastro do hangar no Asaas.' : ''),
      notificarAdmin: false, responder: true, etapa: 'autorizacao_privada',
    };
  }

  filaFaturamentos.decidir(fat.id, { aprovado: true, quem, resultado: { id: boleto.id, valor: boleto.value, url: boleto.bankSlipUrl || null, simulado: boleto.simulado === true } });
  // Boleto emitido: agora sim libera a validação no coletor.
  filaValidacoes.enfileirar({ ticket: fat.ticket, grupoId: fat.grupoId, hangarId: fat.hangarId, motivo: 'faturamento', autorizadoPor: quem });

  return {
    status: 'faturamento_autorizado', grupoId: adminGrupoId, ticket: fat.ticket,
    grupoDeOrigem: fat.grupoId,
    mensagemWhatsapp: `✅ Boleto do ticket *${fat.ticket}* ${boleto.simulado ? '(SIMULADO) ' : ''}emitido — R$ ${formatarReais(fat.valor)}. `
      + 'Estou validando o ticket e avisei o grupo.',
    avisarGrupoDeOrigem: `✅ O ticket ${fat.ticket} foi autorizado e faturado pela administração. Estou validando — aviso aqui quando ficar pronto.`,
    notificarAdmin: false, responder: true, etapa: 'autorizacao_privada',
  };
}

function suspeitaDeNumeroTrocado(hangar, msg, ocr, consulta) {
  if (!ocr.conferencia || ocr.conferencia.ok !== false) return null;

  const naoEncontrado = consulta.status !== 'consulta_ok';
  const entradaDivergente = conferirEntradaComPapel(consulta.entrada, ocr.dataEmissaoIso);
  // Ticket já utilizado é resposta legítima do site e assunto de outro ramo do
  // fluxo — aqui só interessa se o número EXISTE e bate com o papel.
  if (!naoEncontrado && !entradaDivergente) return null;

  return {
    status: 'ocr_numero_suspeito',
    hangarId: hangar.id,
    grupoId: msg.grupoId,
    ticket: ocr.ticket,
    mensagem: `Número e data impressa não conferem entre si (${ocr.conferencia.motivo}), `
      + `e no site ${naoEncontrado ? `o ticket não foi encontrado (${consulta.status})` : `a entrada é ${consulta.entrada}`}. `
      + 'Provável dígito trocado na leitura.',
    mensagemWhatsapp: `⚠️ Não consegui confirmar o número do ticket ${ocr.ticket}. `
      + 'Pode reenviar a foto, mais de perto e com o papel bem iluminado?',
    notificarAdmin: true,
    responder: true,
    etapa: 'conferencia_numero',
  };
}

/**
 * A entrada que o ValidPark mostra bate com a data impressa no papel?
 *
 * Devolve true quando DIVERGEM — é o caso que interessa. Sem entrada no site
 * não há o que comparar, e aí não se acusa: ausência de informação não é
 * prova de erro.
 *
 * Tolerância de 2 minutos: papel e sistema são o mesmo evento, mas o site
 * mostra segundos e o arredondamento entre os dois não é garantido.
 */
function conferirEntradaComPapel(entradaDoSite, dataEmissaoIso) {
  if (!entradaDoSite || !dataEmissaoIso) return false;
  const m = String(entradaDoSite).match(/(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return false;
  const doSite = new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}-03:00`).getTime();
  const doPapel = new Date(dataEmissaoIso).getTime();
  if (!Number.isFinite(doSite) || !Number.isFinite(doPapel)) return false;
  return Math.abs(doSite - doPapel) > 2 * 60 * 1000;
}

/** Data e hora em horário de São Paulo, para ler no WhatsApp. */
/** Data e hora em horário de São Paulo, para ler no WhatsApp. */
function quandoLegivel(iso) {
  try {
    return new Date(iso).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', dateStyle: 'short', timeStyle: 'short' });
  } catch (e) {
    return iso;
  }
}

/**
 * O que fazer depois de resolver a identificação: a cota, se houver, e então
 * a validação. A placa genérica é aplicada AQUI, porque quem respondeu "não"
 * nunca informou placa nenhuma e o ValidPark não aceita campo vazio.
 */
function seguirAposIdentificar(hangar, msg, pedido) {
  if (!pedido.placa) {
    pedido.placa = hangar.placaGenerica || 'AAA0000';
    pedido.placaEhGenerica = true;
  }
  const comCota = perguntarCotaSePreciso(hangar, msg, pedido);
  if (comCota) return comCota;
  return validar(hangar, msg, pedido, false);
}

/**
 * Se o hangar tem cota mensal, guarda o pedido e devolve a pergunta. Devolve
 * null quando não há cota — e aí quem chamou segue o fluxo normal.
 *
 * Extraída para servir aos DOIS caminhos que chegam aqui: o ticket recém-lido,
 * e o ticket que estava esperando a placa. Deixar a pergunta só no primeiro
 * fazia um hangar com placa obrigatória E cota validar sem perguntar nada.
 */
function perguntarCotaSePreciso(hangar, msg, pedido) {
  const cota = cotaMensal.situacao(hangar);
  if (!cota.temCota) return null;

  pendencias.registrar(msg.grupoId, msg.remetenteId, { ...pedido, tipo: 'usar_cota_mensal' });
  return {
    status: 'requer_decisao_cota_mensal',
    hangarId: hangar.id,
    grupoId: msg.grupoId,
    ticket: pedido.ticket,
    placa: pedido.placa,
    cotaLimite: cota.limite,
    cotaRestantes: cota.restantes,
    mensagemWhatsapp: `Recebi o ticket ${pedido.ticket}`
      + `${pedido.placa ? `, placa ${pedido.placa}` : ''}. `
      + `Validar vai usar *1 das ${cota.limite} validações do mês* deste pátio — restam ${cota.restantes}.`
      + '\n\nPosso validar? Responda *SIM* ou *NÃO*.',
    notificarAdmin: false,
    responder: true,
    etapa: 'decisao_cota_mensal',
  };
}

/**
 * O que devolver quando `processar` estoura.
 *
 * Um erro aqui costuma ser bug nosso, e até 16/09/2026 o cliente não recebia
 * NADA: mandava o ticket e o grupo ficava mudo. Silêncio no WhatsApp é lido
 * como "ainda processando", então a pessoa espera em vez de procurar a
 * administração — foi exatamente o que aconteceu no AIBM 1, com um bug que só
 * disparava quando a consulta prévia dizia que o ticket não servia.
 *
 * Responder exige saber PARA ONDE. Só respondemos em grupo de hangar
 * CADASTRADO: sem essa condição, um erro numa mensagem qualquer viraria
 * mensagem do bot em conversa que não é nossa.
 */
function resultadoDeErro(erro, payloadBase64) {
  const resultado = {
    status: 'erro',
    mensagem: erro.message,
    mensagemWhatsapp: '⚠️ Não conseguimos processar sua mensagem no momento. Nossa equipe foi avisada.',
    notificarAdmin: true,
    responder: false,
  };
  try {
    const body = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf-8'));
    const grupoId = body && body.data && body.data.key && body.data.key.remoteJid;
    if (grupoId && String(grupoId).endsWith('@g.us')) {
      buscarHangarPorGrupo(carregarConfig(), grupoId); // lança se não for nosso
      resultado.grupoId = grupoId;
      resultado.responder = true;
    }
  } catch (e) {
    // Payload ilegível ou grupo não cadastrado: segue mudo, que para esses
    // casos é o comportamento certo.
  }
  return resultado;
}

async function main() {
  const [payloadBase64, ...flags] = process.argv.slice(2);
  const enviar = flags.includes('--enviar');

  if (!payloadBase64) {
    console.log(JSON.stringify({
      status: 'parametros_invalidos',
      mensagem: 'Uso: node scripts/processar-mensagem.js <payloadBase64> [--enviar]',
      responder: false,
      notificarAdmin: true,
    }));
    return;
  }

  let resultado;
  try {
    const body = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf-8'));
    // O aviso só existe quando estamos de fato conversando com o WhatsApp.
    resultado = await processar(body, {
      aoReceber: enviar ? (grupoId, texto) => enviarTexto(grupoId, texto) : null,
      aoNotificarAdmin: enviar ? (destino, texto) => enviarTexto(destino, texto) : null,
    });
  } catch (erro) {
    resultado = resultadoDeErro(erro, payloadBase64);
  }

  if (enviar && resultado.responder && resultado.grupoId && resultado.mensagemWhatsapp) {
    try {
      await enviarTexto(resultado.grupoId, resultado.mensagemWhatsapp);
      resultado.enviado = true;
    } catch (erro) {
      // Falhar no envio não pode derrubar o resultado: o ticket pode já ter
      // sido validado, e essa informação precisa aparecer no log do n8n.
      resultado.enviado = false;
      resultado.erroEnvio = erro.message;
      resultado.notificarAdmin = true;
    }
  }

  console.log(JSON.stringify(resultado));
}

if (require.main === module) {
  main();
}

module.exports = { processar, avisarAdmin, escalar, resultadoDeErro, STATUS_QUE_ESCALAM };
