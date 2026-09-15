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
const pendencias = require('./lib/pendencias');
const { lerTicket } = require('./ocr-ticket');

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
        },
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

function enviarTexto(grupoId, texto) {
  return chamarEvolution(`/message/sendText/${EVOLUTION_INSTANCE}`, {
    number: grupoId,
    text: texto,
  });
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
function validar(hangar, msg, pedido, usarCota) {
  const validacao = rodarScript('validate-ticket.js', [
    hangar.id, pedido.ticket, pedido.placa, pedido.dataEmissaoIso || '',
    '0', '0', usarCota ? 'true' : '',
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

async function processar(body) {
  const msg = interpretarMensagem(body);

  if (msg.ignorar) {
    return { status: 'ignorado', motivo: msg.motivoIgnorar, grupoId: msg.grupoId, responder: false };
  }

  const hangar = buscarHangarPorGrupo(carregarConfig(), msg.grupoId);

  // ---- resposta a uma pergunta anterior ----
  if (msg.tipo === 'texto') {
    const pendente = pendencias.buscar(msg.grupoId, msg.remetenteId);

    // Sem pendência, é conversa normal do grupo: ignorar em silêncio. O bot
    // não pode responder a toda mensagem trocada entre as pessoas ali.
    if (!pendente) {
      return { status: 'ignorado', motivo: 'texto sem pendência para esta pessoa', grupoId: msg.grupoId, responder: false };
    }

    if (msg.resposta === 'nao') {
      pendencias.descartar(msg.grupoId, msg.remetenteId);
      return {
        status: 'cancelado_pelo_cliente', hangarId: hangar.id, grupoId: msg.grupoId,
        ticket: pendente.ticket,
        mensagemWhatsapp: `Tudo bem, não validei o ticket ${pendente.ticket}. Se mudar de ideia, é só mandar a foto de novo.`,
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
        mensagemWhatsapp: `Não entendi. Para validar o ticket ${pendente.ticket} usando uma das validações fora do prazo, responda SIM. Para deixar pra lá, responda NÃO.`,
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

  const imagem = await baixarImagemBase64(msg.messageId);
  const ocr = await lerTicket({ base64: imagem.base64, mediaType: imagem.mediaType });

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

  // Consulta primeiro, sempre. Além de ser barata e sem efeito colateral, ela
  // evita tentar validar um ticket que já foi usado — o que gastaria uma
  // abertura de navegador e, fora do prazo, uma validação da cota do hangar.
  const consulta = rodarScript('consultar-ticket.js', [hangar.id, ocr.ticket]);

  const jaResolvido =
    consulta.status !== 'consulta_ok' || consulta.jaValidado === true;

  if (jaResolvido) {
    return {
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

  return validar(hangar, msg, {
    ticket: ocr.ticket,
    placa,
    placaEhGenerica: !msg.placa,
    dataEmissaoIso: ocr.dataEmissaoIso,
  }, false);
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
    resultado = await processar(body);
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

module.exports = { processar };
