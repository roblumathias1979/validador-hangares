#!/usr/bin/env node
// Uso: node scripts/processar-fechamento.js <payloadBase64> [--enviar]
//
// Recebe o corpo do webhook da Evolution API (evento messages.upsert do grupo
// de fechamento de caixa, codificado em base64), baixa a foto, lê o relatório
// por OCR, identifica a unidade, confere a matemática, grava o registro e
// (com --enviar) responde no grupo e avisa a administração se houver
// inconsistência.
//
// Um script só, chamado pelo n8n via "Execute Command" — mesmo desenho do
// validador de hangares (scripts/processar-mensagem.js): o n8n é só um cano,
// e toda a lógica fica em código versionado e testável.
//
// Sem --enviar o script só devolve o json com o resultado calculado, sem
// mandar nada ao WhatsApp — é como se testa o fluxo sem escrever numa
// conversa real.

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

const { interpretarEvento } = require('./lib/whatsapp-fechamento');
const { baixarImagemBase64, enviarTexto } = require('./lib/evolution');
const { lerFechamento } = require('./lib/ocr-fechamento');
const { carregarConfig, identificarUnidade } = require('./lib/unidades');
const { conferirFechamentoInterno, conferirMaquininha } = require('./lib/conferencia');
const { gravarFechamento } = require('./lib/armazenamento');

function formatarReais(v) {
  return typeof v === 'number' ? `R$ ${v.toFixed(2).replace('.', ',')}` : '—';
}

async function processar(payloadBase64) {
  let evento;
  try {
    evento = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf-8'));
  } catch (erro) {
    return { status: 'payload_invalido', mensagem: erro.message, notificarAdmin: true };
  }

  const msg = interpretarEvento(evento);
  if (msg.ignorar) {
    return { status: 'ignorado', motivo: msg.motivo, notificarAdmin: false };
  }

  const config = carregarConfig();

  let imagem;
  try {
    imagem = await baixarImagemBase64(msg.messageId);
  } catch (erro) {
    return {
      status: 'erro_download',
      mensagem: erro.message,
      grupoId: msg.grupoId,
      mensagemWhatsapp: '⚠️ Não consegui baixar essa foto do fechamento. Pode reenviar?',
      notificarAdmin: true,
    };
  }

  let ocr;
  try {
    ocr = await lerFechamento({ base64: imagem.base64, mediaType: imagem.mediaType });
  } catch (erro) {
    return {
      status: 'erro_ocr',
      mensagem: erro.message,
      grupoId: msg.grupoId,
      mensagemWhatsapp: '⚠️ Não conseguimos processar essa foto do fechamento agora. Nossa equipe foi avisada.',
      notificarAdmin: true,
    };
  }

  if (ocr.status !== 'ocr_ok') {
    return { ...ocr, grupoId: msg.grupoId };
  }

  // O grupo é autoritativo (um grupo por unidade, administrado por quem
  // configura o bot) — lança quando o grupo não está cadastrado em
  // config/unidades.json, que é problema de configuração, não do cliente.
  let identificacao;
  try {
    identificacao = identificarUnidade(config, {
      grupoId: msg.grupoId,
      legenda: msg.legenda,
      unidadeImpressa: ocr.unidadeImpressa,
    });
  } catch (erro) {
    return {
      status: 'unidade_nao_identificada',
      grupoId: msg.grupoId,
      mensagem: erro.message,
      mensagemWhatsapp: '⚠️ Este grupo ainda não está cadastrado para nenhuma unidade. Nossa equipe foi avisada.',
      notificarAdmin: true,
    };
  }

  const unidade = identificacao.unidade;
  const interna = conferirFechamentoInterno(ocr.relatorio);
  const maquininha = conferirMaquininha(ocr.relatorio, ocr.documentoAnexo);

  const registro = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    unidadeId: unidade.id,
    unidadeNome: unidade.nome,
    relatorio: ocr.relatorio,
    documentoAnexo: ocr.documentoAnexo,
    conferenciaInterna: interna,
    conferenciaMaquininha: maquininha,
    camposNaoReconhecidos: ocr.camposNaoReconhecidos,
    identificacao: { confianca: identificacao.confianca, sinais: identificacao.sinais },
    origem: {
      grupoId: msg.grupoId,
      remetente: msg.remetente,
      remetenteTelefone: msg.remetenteTelefone,
      legenda: msg.legenda,
    },
    criadoEm: new Date().toISOString(),
  };
  gravarFechamento(registro);

  const partes = [];
  const r = ocr.relatorio;
  const parcial = r.situacao === 'parcial';

  partes.push(parcial
    ? `📋 Fechamento *parcial* (caixa ainda aberto) de *${unidade.nome}* registrado — valor faturado até agora: ${formatarReais(r.valorFaturado)}.`
    : `✅ Fechamento de *${unidade.nome}* registrado: valor faturado ${formatarReais(r.valorFaturado)}.`);

  if (interna.status === 'inconsistente') {
    const c = interna.checagens.resumoVsFaturado.status === 'inconsistente' ? interna.checagens.resumoVsFaturado : interna.checagens.formasVsFaturado;
    partes.push(`⚠️ A matemática do próprio relatório não fecha — diferença de ${formatarReais(Math.abs(c.diferenca))}. Equipe avisada.`);
  }

  if (maquininha.status === 'a_conferir') {
    partes.push('⚠️ Divergência a conferir entre o relatório e o comprovante anexado:');

    // Só cita o TOTAL quando ele mesmo estourou a tolerância — caso real que
    // validou isto: total dentro da tolerância por COINCIDÊNCIA (cartão
    // sobrando e Pix faltando se cancelando no agregado), e a mensagem não
    // pode dizer "o total diverge" quando ele estava normal.
    if (maquininha.totalDivergente) {
      partes.push(`   • total não-dinheiro: ${formatarReais(maquininha.naoDinheiroRelatorio)} × comprovante ${formatarReais(maquininha.totalGeralMaquininha ?? maquininha.valorDeposito)} `
        + `(diferença de ${formatarReais(Math.abs(maquininha.diferenca))})`);
    }

    // Aponta ONDE está a diferença por forma de pagamento — é o que revela
    // divergências que o total sozinho esconde (ver nota acima).
    for (const item of maquininha.porFormaDePagamento) {
      if (item.direcao === 'ok') continue;
      const rotulo = item.direcao === 'sobra' ? 'sobrando' : 'faltando';
      partes.push(`   • ${item.forma}: ${rotulo} ${formatarReais(Math.abs(item.diferenca))} `
        + `(relatório ${formatarReais(item.valorRelatorio)} × comprovante ${formatarReais(item.valorComprovante)})`);
    }

    partes.push('Pode não ser erro (períodos diferentes, convênio faturado à parte), mas vale uma conferência.');
  }

  if (identificacao.alerta) {
    partes.push(`⚠️ Possível grupo errado: ${identificacao.alerta}`);
  }

  const notificarAdmin = interna.status === 'inconsistente' || maquininha.status === 'a_conferir' || Boolean(identificacao.alerta);

  return {
    status: 'fechamento_registrado',
    grupoId: msg.grupoId,
    registro,
    mensagemWhatsapp: partes.join('\n'),
    notificarAdmin,
    grupoAdministracao: unidade.grupoAdministracao || config.grupoAdministracaoPadrao || null,
  };
}

async function main() {
  const [payloadBase64, flagEnviar] = process.argv.slice(2);

  if (!payloadBase64) {
    console.log(JSON.stringify({
      status: 'parametros_invalidos',
      mensagem: 'Uso: node scripts/processar-fechamento.js <payloadBase64> [--enviar]',
      notificarAdmin: true,
    }));
    return;
  }

  let resultado;
  try {
    resultado = await processar(payloadBase64);
  } catch (erro) {
    resultado = {
      status: 'erro',
      mensagem: erro.message,
      mensagemWhatsapp: '⚠️ Não conseguimos processar esse fechamento agora. Nossa equipe foi avisada.',
      notificarAdmin: true,
    };
  }

  if (flagEnviar === '--enviar') {
    if (resultado.grupoId && resultado.mensagemWhatsapp) {
      try {
        await enviarTexto(resultado.grupoId, resultado.mensagemWhatsapp);
      } catch (erro) {
        resultado.erroEnvio = erro.message;
      }
    }
    if (resultado.notificarAdmin && resultado.grupoAdministracao) {
      try {
        await enviarTexto(resultado.grupoAdministracao, `[fechamento-caixa] ${resultado.mensagemWhatsapp}`);
      } catch (erro) {
        resultado.erroEnvioAdmin = erro.message;
      }
    }
  }

  // Sai com 0 sempre, mesmo em falha: quem decide o que fazer é o nó seguinte
  // do n8n, lendo o campo `status` — código != 0 faz o "Execute Command"
  // engolir a saída antes de qualquer resposta chegar ao cliente.
  console.log(JSON.stringify(resultado));
}

if (require.main === module) {
  main();
}

module.exports = { processar };
