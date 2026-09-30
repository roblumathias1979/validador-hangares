#!/usr/bin/env node
// Uso: node scripts/consultar-caixa.js <payloadBase64> [--enviar]
//
// Consulta que o ADMIN manda no PRIVADO (não em grupo) perguntando o caixa:
// "quanto tem de dinheiro no cofre de Poços de Caldas", "quanto faturou de
// dinheiro a Nacional Inn do dia 1 ao dia 15" (pedido do usuário,
// 30/09/2026). Só o número cadastrado em ADMIN_WHATSAPP_ID (.env) recebe
// resposta — qualquer outro remetente é ignorado em silêncio (dado
// financeiro, não confirma nem que o comando existe pra quem não é admin).
//
// Roteado por scripts/despachar-webhook.js, que decide por uma regra
// simples e sem custo de API (número + palavra-chave) se uma mensagem
// privada parece ser esta consulta antes de chamar este script.

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

const { carregarConfig } = require('./lib/unidades');
const { totalDinheiroPorUnidade, dinheiroRecebidoNoPeriodo } = require('./lib/armazenamento');
const { interpretarConsulta, resolverAlvo } = require('./lib/consulta-caixa');
const { enviarTexto } = require('./lib/evolution');

function formatarReais(v) {
  return typeof v === 'number' ? `R$ ${v.toFixed(2).replace('.', ',')}` : '—';
}

function formatarData(iso) {
  const [ano, mes, dia] = iso.split('-');
  return `${dia}/${mes}/${ano}`;
}

function extrairTexto(evento) {
  const msg = (evento.data || {}).message || {};
  return msg.conversation || (msg.extendedTextMessage && msg.extendedTextMessage.text) || null;
}

async function processar(payloadBase64) {
  let evento;
  try {
    evento = JSON.parse(Buffer.from(payloadBase64, 'base64').toString('utf-8'));
  } catch (erro) {
    return { status: 'payload_invalido', mensagem: erro.message, notificarAdmin: true };
  }

  const key = (evento.data || {}).key || {};
  const remoteJid = key.remoteJid || null;

  if (key.fromMe === true) {
    return { status: 'ignorado', motivo: 'mensagem enviada pelo próprio bot', notificarAdmin: false };
  }

  const adminId = (process.env.ADMIN_WHATSAPP_ID || '').trim();
  if (!adminId || remoteJid !== adminId) {
    // Defesa redundante — despachar-webhook.js já só chama este script para
    // o ADMIN_WHATSAPP_ID configurado, mas isto é dado financeiro de todas
    // as unidades: não confia só no roteamento de fora.
    return { status: 'ignorado', motivo: 'remetente não é o admin configurado', notificarAdmin: false };
  }

  const texto = extrairTexto(evento);
  if (!texto) {
    return { status: 'ignorado', motivo: 'mensagem sem texto', notificarAdmin: false };
  }

  const config = carregarConfig();
  const alvo = resolverAlvo(config, texto);
  if (!alvo) {
    return {
      status: 'alvo_nao_identificado',
      remoteJid,
      mensagemWhatsapp: '⚠️ Não identifiquei nenhuma unidade ou cofre nessa pergunta. Pode citar o nome (ex: "Nacional Inn") ou o cofre (ex: "Poços de Caldas")?',
      notificarAdmin: false,
    };
  }

  let interpretado;
  try {
    interpretado = await interpretarConsulta(texto);
  } catch (erro) {
    return {
      status: 'erro_interpretacao',
      mensagem: erro.message,
      remoteJid,
      mensagemWhatsapp: '⚠️ Não consegui processar essa pergunta agora. Tenta de novo?',
      notificarAdmin: true,
    };
  }

  if (interpretado.status !== 'ok') {
    return {
      status: interpretado.status,
      remoteJid,
      mensagemWhatsapp: `⚠️ ${interpretado.mensagem} Pode reformular a pergunta?`,
      notificarAdmin: false,
    };
  }

  if (interpretado.tipo === 'saldo') {
    const todas = totalDinheiroPorUnidade(config.unidades);
    const selecionadas = todas.filter((u) => alvo.unidadeIds.includes(u.unidadeId));
    const total = Math.round(selecionadas.reduce((acc, u) => acc + u.saldoEmCaixa, 0) * 100) / 100;

    const partes = [`💰 Saldo em caixa esperado — ${alvo.label}:`];
    if (selecionadas.length > 1) {
      for (const u of selecionadas) partes.push(`   • ${u.unidadeNome}: ${formatarReais(u.saldoEmCaixa)}`);
    }
    partes.push(`Total: ${formatarReais(total)}`);

    return { status: 'consulta_respondida', tipo: 'saldo', remoteJid, mensagemWhatsapp: partes.join('\n'), notificarAdmin: false };
  }

  // tipo 'faturamento'
  if (!interpretado.desde || !interpretado.ate) {
    return {
      status: 'periodo_nao_identificado',
      remoteJid,
      mensagemWhatsapp: '⚠️ Não entendi o período dessa pergunta. Pode dizer as datas, tipo "de 01/09 a 15/09"?',
      notificarAdmin: false,
    };
  }

  const resultado = dinheiroRecebidoNoPeriodo({ unidadeIds: alvo.unidadeIds, desde: interpretado.desde, ate: interpretado.ate });
  const partes = [`💵 Dinheiro recebido — ${alvo.label} (${formatarData(interpretado.desde)} a ${formatarData(interpretado.ate)}):`];
  if (alvo.unidadeIds.length > 1) {
    for (const id of alvo.unidadeIds) {
      const nome = (config.unidades.find((u) => u.id === id) || {}).nome || id;
      partes.push(`   • ${nome}: ${formatarReais(resultado.porUnidade[id])}`);
    }
  }
  partes.push(`Total: ${formatarReais(resultado.total)}`);

  return { status: 'consulta_respondida', tipo: 'faturamento', remoteJid, mensagemWhatsapp: partes.join('\n'), notificarAdmin: false };
}

async function main() {
  const [payloadBase64, flagEnviar] = process.argv.slice(2);

  if (!payloadBase64) {
    console.log(JSON.stringify({
      status: 'parametros_invalidos',
      mensagem: 'Uso: node scripts/consultar-caixa.js <payloadBase64> [--enviar]',
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
      mensagemWhatsapp: '⚠️ Não consegui responder essa consulta agora.',
      notificarAdmin: true,
    };
  }

  if (flagEnviar === '--enviar' && resultado.remoteJid && resultado.mensagemWhatsapp) {
    try {
      await enviarTexto(resultado.remoteJid, resultado.mensagemWhatsapp);
    } catch (erro) {
      resultado.erroEnvio = erro.message;
    }
  }

  // Sai com 0 sempre — mesmo padrão de processar-fechamento.js: quem decide
  // o que fazer é o n8n, lendo o campo `status`.
  console.log(JSON.stringify(resultado));
}

if (require.main === module) {
  main();
}

module.exports = { processar };
