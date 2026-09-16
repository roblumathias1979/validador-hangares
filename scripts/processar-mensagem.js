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

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const { carregarConfig, buscarHangarPorGrupo } = require('./lib/hangar');
const { interpretarMensagem } = require('./lib/whatsapp');
const { avaliarLocal } = require('./lib/conferir-local');
const pendencias = require('./lib/pendencias');
const registro = require('./lib/registro');
const avisoPatio = require('./lib/aviso-patio');
const { lerTicket, lerLocal } = require('./ocr-ticket');
const { consultarPatio } = require('./consultar-patio');

const EVOLUTION_URL = process.env.EVOLUTION_URL || 'http://127.0.0.1:8080';
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE || 'validador-hangares';

function chamarEvolution(caminho, corpo) {
  return new Promise((resolve, reject) => {
    const chave = process.env.EVOLUTION_API_KEY;
    if (!chave) {
      reject(new Error('EVOLUTION_API_KEY não configurada no .env.'));
      return;
    }
    const url = new URL(caminho, EVOLUTION_URL);
    const dados = JSON.stringify(corpo);
    const req = http.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          apikey: chave,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(dados),
          // Sem keep-alive de propósito. Entre o aviso "recebi seu ticket" e a
          // resposta final passam ~11s de OCR e navegador; nesse intervalo a
          // Evolution fecha a conexão ociosa, e o agente padrão do Node
          // reaproveitava o socket morto — o envio final falhava com
          // "socket hang up" e o cliente ficava sem resposta (15/09/2026).
          Connection: 'close',
        },
        agent: false,
        timeout: 60000,
      },
      (res) => {
        let corpoResposta = '';
        res.on('data', (c) => (corpoResposta += c));
        res.on('end', () => {
          try {
            resolve(JSON.parse(corpoResposta));
          } catch (e) {
            reject(new Error(`Evolution devolveu resposta não-json (HTTP ${res.statusCode}): ${corpoResposta.slice(0, 200)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('Evolution não respondeu em 60s.')));
    req.write(dados);
    req.end();
  });
}

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

async function enviarTexto(grupoId, texto) {
  // Uma tentativa extra: a resposta ao cliente é a parte visível do sistema,
  // e perdê-la por uma falha momentânea de rede é o pior desfecho possível —
  // o ticket pode já ter sido validado e o cliente não fica sabendo.
  let ultimoErro = null;
  for (let tentativa = 1; tentativa <= 2; tentativa += 1) {
    try {
      return await chamarEvolution(`/message/sendText/${EVOLUTION_INSTANCE}`, {
        number: grupoId,
        text: texto,
      });
    } catch (erro) {
      ultimoErro = erro;
      if (tentativa < 2) await new Promise((r) => setTimeout(r, 1000));
    }
  }
  throw ultimoErro;
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

// Roda validate-ticket.js e monta a resposta. `usarCota` vem true quando o
// cliente respondeu SIM à pergunta sobre gastar uma validação fora do prazo.
function validar(hangar, msg, pedido, usarCota, faturamento = {}) {
  const validacao = rodarScript('validate-ticket.js', [
    hangar.id, pedido.ticket, pedido.placa, pedido.dataEmissaoIso || '',
    '0', '0', usarCota ? 'true' : '',
    faturamento.autorizar ? 'true' : '',
    faturamento.fotoAutorizacao || '',
  ]);

  let mensagem = validacao.mensagemWhatsapp;
  if (validacao.status === 'validado' && pedido.placaEhGenerica) {
    mensagem += ` (validei com a placa padrão ${pedido.placa} porque não veio placa na legenda da foto — se precisar corrigir, fale com a administração. Da próxima vez, escreva a placa junto ao enviar a foto.)`;
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
  'sem_vagas',              // pátio cheio
  'prazo_excedido_no_site', // ValidPark recusa por idade do ticket
  'erro_validacao',         // recusa que não soubemos classificar
  'valor_invalido',         // horas/dias acima do limite do slider
  'indeterminado',          // clicou em validar e o site não confirmou nada
  'erro',                   // exceção no meio do caminho
]);

/**
 * Para os casos acima: avisa o cliente de que a administração foi acionada e
 * marca o resultado para notificação. A explicação específica é mantida — o
 * cliente saber POR QUE parou evita que ele reenvie a foto várias vezes.
 */
function escalar(resultado, remetente) {
  if (!STATUS_QUE_ESCALAM.has(resultado.status)) return resultado;

  const base = resultado.mensagemWhatsapp
    || '⚠️ Não consegui concluir a validação deste ticket.';
  resultado.mensagemWhatsapp = `${base}\n\nJá estou encaminhando para o administrador resolver.`;
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
  const resultado = await conduzir(body, opcoes);

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
          resultado.vagasDisponiveis, avisoPatio.limiteDe({ ...hangarAviso, totalVagas: resultado.totalVagas })
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

async function conduzir(body, { aoReceber } = {}) {
  const msg = interpretarMensagem(body);

  if (msg.ignorar) {
    return { status: 'ignorado', motivo: msg.motivoIgnorar, grupoId: msg.grupoId, responder: false };
  }

  const hangar = buscarHangarPorGrupo(carregarConfig(), msg.grupoId);

  // ---- pedido de situação do pátio ----
  // Vem ANTES das pendências: quem tem um ticket em aberto também pode querer
  // saber das vagas, e responder "ainda preciso da foto" a uma pergunta sobre
  // o pátio seria ignorar o que foi perguntado.
  if (msg.tipo === 'texto' && msg.pedidoPatio) {
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

    if (msg.resposta === 'nao') {
      pendencias.descartar(msg.grupoId, msg.remetenteId);
      return {
        status: 'cancelado_pelo_cliente', hangarId: hangar.id, grupoId: msg.grupoId,
        ticket: pendente.ticket,
        mensagemWhatsapp: ehFaturamento
          ? `Tudo bem, não vou faturar nem validar o ticket ${pendente.ticket}. Se mudar de ideia, é só mandar a foto de novo.`
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
    // Esta foto NÃO passa pelo OCR: não há ticket nela, e o número já veio da
    // primeira. Só o local é conferido.
    const r = await lerLocal({ base64: imagemVeiculo.base64, mediaType: imagemVeiculo.mediaType, hangar });
    const local = avaliarLocal(hangar, r.local, r.localMotivo);
    const infoLocal = { local: local.local, localMotivo: local.motivo || null, cenario: r.cenario || null };

    if (local.bloqueia) {
      return {
        ...infoLocal,
        status: 'local_incompativel', hangarId: hangar.id, grupoId: msg.grupoId, ticket: pedido.ticket,
        mensagemWhatsapp: local.mensagemWhatsapp,
        notificarAdmin: local.notificarAdmin === true, responder: true, etapa: 'conferencia_local',
      };
    }

    return { ...infoLocal, ...validar(hangar, msg, pedido, false) };
  }

  // ---- foto chegando com faturamento pendente = é a autorização ----
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

  // Hangar antifraude: em vez de validar agora, pede a foto do veículo. O
  // ticket já está lido e fica guardado na pendência — a segunda foto só
  // precisa mostrar o carro no pátio.
  if (hangar.exigeFotoVeiculoNoLocal) {
    const placaPrimeiraFoto = msg.placa || hangar.placaGenerica || 'AAA0000';
    pendencias.registrar(msg.grupoId, msg.remetenteId, {
      ticket: ocr.ticket,
      placa: placaPrimeiraFoto,
      placaEhGenerica: !msg.placa,
      dataEmissaoIso: ocr.dataEmissaoIso,
      hangarId: hangar.id,
      tipo: 'foto_local',
    });
    return {
      status: 'aguardando_foto_veiculo',
      hangarId: hangar.id,
      grupoId: msg.grupoId,
      ticket: ocr.ticket,
      mensagemWhatsapp: `Li o ticket ${ocr.ticket}. Agora mande uma foto do veículo estacionado no hangar, mostrando um pouco do entorno (piso, parede ou o que aparece ao fundo) — é o que confirma que o carro está no local. Depois dela eu valido.`,
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
  const consulta = rodarScript('consultar-ticket.js', [hangar.id, ocr.ticket]);

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
      dataEmissaoIso: ocr.dataEmissaoIso,
    }, false),
  };
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
    resultado = {
      status: 'erro',
      mensagem: erro.message,
      mensagemWhatsapp: '⚠️ Não conseguimos processar sua mensagem no momento. Nossa equipe foi avisada.',
      notificarAdmin: true,
      responder: false, // sem grupoId confiável, não há para onde responder
    };
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

module.exports = { processar, avisarAdmin, escalar, STATUS_QUE_ESCALAM };
