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

const { interpretarEvento, PARECE_TER_VALOR_EM_REAIS } = require('./lib/whatsapp-fechamento');
const { baixarImagemBase64, enviarTexto } = require('./lib/evolution');
const { lerFechamento } = require('./lib/ocr-fechamento');
const { lerComplementoTexto } = require('./lib/texto-fechamento');
const { carregarConfig, identificarUnidade, buscarUnidadePorGrupo } = require('./lib/unidades');
const { conferirFechamentoInterno, conferirMaquininha } = require('./lib/conferencia');
const { gravarFechamento, gravarComplemento, totalDinheiroPorUnidade } = require('./lib/armazenamento');
const {
  abrirPendencia, buscarPendencia, atualizarPendencia, encerrarPendencia,
  salvarComprovante, interpretarSimNao,
} = require('./lib/retiradas');

function formatarReais(v) {
  return typeof v === 'number' ? `R$ ${v.toFixed(2).replace('.', ',')}` : '—';
}

// Diferença mínima para considerar "retirada" e abrir a pergunta — abaixo
// disso é só arredondamento de centavos, não vale interromper a conversa.
const TOLERANCIA_RETIRADA = 1;

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

  // O grupo já diz a unidade (autoritativo) — precisamos saber isso ANTES
  // de decidir se a mensagem é uma NOVA foto/texto ou a resposta a uma
  // pergunta pendente daquela unidade (motivo/comprovante de retirada).
  let unidadeDoGrupo;
  try {
    unidadeDoGrupo = buscarUnidadePorGrupo(config, msg.grupoId);
  } catch (erro) {
    return {
      status: 'unidade_nao_identificada',
      grupoId: msg.grupoId,
      mensagem: erro.message,
      mensagemWhatsapp: '⚠️ Este grupo ainda não está cadastrado para nenhuma unidade. Nossa equipe foi avisada.',
      notificarAdmin: true,
    };
  }

  const pendencia = buscarPendencia(unidadeDoGrupo.id);
  if (pendencia) {
    return processarRespostaPendencia(msg, unidadeDoGrupo, pendencia);
  }

  if (msg.tipo === 'texto') {
    if (!PARECE_TER_VALOR_EM_REAIS.test(msg.texto)) {
      // Sem pendência aberta e sem cara de valor em reais: conversa comum
      // do grupo — ignorado em silêncio, sem gastar chamada de API.
      return { status: 'ignorado', motivo: 'texto sem valor em reais reconhecível e sem pergunta pendente', notificarAdmin: false };
    }
    return processarTexto(msg, unidadeDoGrupo);
  }

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

  // Status final por forma de pagamento — SEMPRE aparece (pedido do
  // usuário, 30/09/2026), não só quando há algo fora da tolerância. Cada
  // forma diz se bate, sobra, falta, ou não tem comprovante pra conferir.
  const ROTULO_FORMA = { dinheiro: 'Dinheiro', cartao: 'Cartão', pix: 'Pix' };
  partes.push('📊 Status do caixa:');
  for (const item of maquininha.porFormaDePagamento) {
    const nome = ROTULO_FORMA[item.forma] || item.forma;
    if (item.direcao === 'sobra' || item.direcao === 'falta') {
      const rotulo = item.direcao === 'sobra' ? 'sobrando' : 'faltando';
      partes.push(`   • ${nome}: ⚠️ ${rotulo} ${formatarReais(Math.abs(item.diferenca))} `
        + `(relatório ${formatarReais(item.valorRelatorio)} × comprovante ${formatarReais(item.valorComprovante)})`);
    } else if (item.direcao === 'ok') {
      partes.push(`   • ${nome}: ✅ bate (${formatarReais(item.valorRelatorio)})`);
    } else if (item.direcao === 'sem_comprovante') {
      partes.push(`   • ${nome}: ${formatarReais(item.valorRelatorio)} (sem comprovante anexado para conferir)`);
    } else {
      partes.push(`   • ${nome}: não informado no relatório`);
    }
  }

  // Só cita o TOTAL quando ele mesmo estourou a tolerância — caso real que
  // validou isto: total dentro da tolerância por COINCIDÊNCIA (cartão
  // sobrando e Pix faltando se cancelando no agregado), e a mensagem não
  // pode dizer "o total diverge" quando ele estava normal.
  if (maquininha.totalDivergente) {
    partes.push(`   • Total não-dinheiro: ${formatarReais(maquininha.naoDinheiroRelatorio)} × comprovante ${formatarReais(maquininha.totalGeralMaquininha ?? maquininha.valorDeposito)} `
      + `(diferença de ${formatarReais(Math.abs(maquininha.diferenca))})`);
  }

  if (maquininha.status === 'a_conferir') {
    partes.push('Pode não ser erro (períodos diferentes, convênio faturado à parte), mas vale uma conferência.');
  }

  if (identificacao.alerta) {
    partes.push(`⚠️ Possível grupo errado: ${identificacao.alerta}`);
  }

  // "notificarAdmin" não dispara uma SEGUNDA mensagem — decisão do usuário
  // (25/09/2026): como cada unidade já tem grupo próprio, o aviso já vai
  // dentro da própria resposta (as linhas com ⚠️ acima), no mesmo grupo.
  // O campo continua servindo para o painel destacar/filtrar os
  // fechamentos que precisam de atenção.
  const notificarAdmin = interna.status === 'inconsistente' || maquininha.status === 'a_conferir' || Boolean(identificacao.alerta);

  return {
    status: 'fechamento_registrado',
    grupoId: msg.grupoId,
    registro,
    mensagemWhatsapp: partes.join('\n'),
    notificarAdmin,
  };
}

/**
 * Mensagem de TEXTO puro complementando valores escritos à mão (ex:
 * "Envelope R$214,00") — ver scripts/lib/texto-fechamento.js. Não baixa
 * foto nem faz OCR: é uma chamada de texto só, bem mais barata e rápida.
 * `unidade` já vem resolvida pelo grupo (ver processar()).
 */
async function processarTexto(msg, unidade) {
  let lido;
  try {
    lido = await lerComplementoTexto(msg.texto);
  } catch (erro) {
    return {
      status: 'erro_texto',
      mensagem: erro.message,
      grupoId: msg.grupoId,
      mensagemWhatsapp: '⚠️ Não conseguimos processar essa mensagem agora. Nossa equipe foi avisada.',
      notificarAdmin: true,
    };
  }

  if (lido.status !== 'ok') {
    return { ...lido, grupoId: msg.grupoId };
  }

  // Saldo ANTES deste complemento — só para dar contexto na resposta (não
  // é um erro se divergir do Envelope informado: vale e compra de insumo
  // explicam a diferença, e é justamente por isso que o texto vira o novo
  // checkpoint em vez de a gente insistir na própria soma).
  const antes = totalDinheiroPorUnidade().find((u) => u.unidadeId === unidade.id);
  const saldoAnterior = antes ? antes.saldoEmCaixa : 0;

  const registro = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    unidadeId: unidade.id,
    unidadeNome: unidade.nome,
    valorRecebido: lido.valorRecebido,
    fundoDeCaixa: lido.fundoDeCaixa,
    envelope: lido.envelope,
    outrosValores: lido.outrosValores,
    origem: { grupoId: msg.grupoId, remetente: msg.remetente, remetenteTelefone: msg.remetenteTelefone, texto: msg.texto },
    criadoEm: new Date().toISOString(),
  };
  gravarComplemento(registro);

  const partes = [`📝 Valores registrados para *${unidade.nome}*:`];
  if (lido.valorRecebido !== null) partes.push(`   • Valor recebido: ${formatarReais(lido.valorRecebido)}`);
  if (lido.fundoDeCaixa !== null) partes.push(`   • Fundo de caixa: ${formatarReais(lido.fundoDeCaixa)}`);

  let abriuPendenciaRetirada = false;
  if (lido.envelope !== null) {
    partes.push(`   • Envelope: ${formatarReais(lido.envelope)} (novo saldo de controle desta unidade)`);
    const diferenca = Number((lido.envelope - saldoAnterior).toFixed(2));

    if (diferenca < -TOLERANCIA_RETIRADA) {
      // Envelope veio MENOR do que a soma esperava — dinheiro saiu do caixa
      // além de qualquer depósito já registrado. Pedido do usuário
      // (30/09/2026): perguntar motivo e comprovante, não só anotar.
      abrirPendencia(unidade.id, {
        valorRetirada: Math.abs(diferenca), complementoId: registro.id,
        unidadeNome: unidade.nome, grupoId: msg.grupoId,
      });
      abriuPendenciaRetirada = true;
      partes.push(`   • 💸 Isso indica uma retirada de ${formatarReais(Math.abs(diferenca))} do caixa desde o último controle. Qual foi o motivo (vale, insumo, outro)?`);
    } else if (Math.abs(diferenca) > 0.01) {
      partes.push(`   • (${diferenca > 0 ? '+' : '-'}${formatarReais(Math.abs(diferenca))} de diferença em relação ao esperado só pela soma anterior)`);
    }
  }

  return {
    status: 'complemento_registrado',
    grupoId: msg.grupoId,
    registro,
    mensagemWhatsapp: partes.join('\n'),
    notificarAdmin: false,
    aguardandoMotivoRetirada: abriuPendenciaRetirada,
  };
}

/**
 * Responde a uma pergunta pendente de retirada (ver scripts/lib/retiradas.js):
 * motivo -> tem comprovante? (sim/não ou foto direto) -> foto, se disse sim.
 */
async function processarRespostaPendencia(msg, unidade, pendencia) {
  if (pendencia.estado === 'aguardando_motivo') {
    if (msg.tipo !== 'texto') {
      return {
        status: 'pendencia_motivo_invalido',
        grupoId: msg.grupoId,
        mensagemWhatsapp: '⚠️ Antes da foto, preciso saber o motivo da retirada. Pode escrever?',
        notificarAdmin: false,
      };
    }
    atualizarPendencia(unidade.id, { estado: 'aguardando_comprovante', motivo: msg.texto });
    return {
      status: 'pendencia_motivo_registrado',
      grupoId: msg.grupoId,
      mensagemWhatsapp: `Motivo registrado: "${msg.texto}". Tem comprovante (nota/recibo)? Responda *sim* ou *não* — se tiver, já pode mandar a foto direto.`,
      notificarAdmin: false,
    };
  }

  if (pendencia.estado === 'aguardando_comprovante') {
    if (msg.tipo === 'imagem') {
      return finalizarRetiradaComComprovante(msg, unidade, pendencia);
    }
    const resposta = msg.tipo === 'texto' ? interpretarSimNao(msg.texto) : null;
    if (resposta === 'nao') {
      const registro = encerrarPendencia(unidade.id, { comprovante: null });
      return {
        status: 'retirada_registrada',
        grupoId: msg.grupoId,
        registro,
        mensagemWhatsapp: `✅ Retirada de ${formatarReais(pendencia.valorRetirada)} registrada — motivo: "${pendencia.motivo}", sem comprovante.`,
        notificarAdmin: false,
      };
    }
    if (resposta === 'sim') {
      atualizarPendencia(unidade.id, { estado: 'aguardando_foto' });
      return {
        status: 'pendencia_aguardando_foto',
        grupoId: msg.grupoId,
        mensagemWhatsapp: '📎 Pode mandar a foto do comprovante.',
        notificarAdmin: false,
      };
    }
    return {
      status: 'pendencia_resposta_nao_entendida',
      grupoId: msg.grupoId,
      mensagemWhatsapp: '⚠️ Não entendi — tem comprovante dessa retirada? Responda *sim* ou *não*.',
      notificarAdmin: false,
    };
  }

  if (pendencia.estado === 'aguardando_foto') {
    if (msg.tipo !== 'imagem') {
      return {
        status: 'pendencia_foto_invalida',
        grupoId: msg.grupoId,
        mensagemWhatsapp: '⚠️ Preciso da FOTO do comprovante — pode mandar?',
        notificarAdmin: false,
      };
    }
    return finalizarRetiradaComComprovante(msg, unidade, pendencia);
  }

  // Estado desconhecido não deveria acontecer — encerra por segurança em vez
  // de travar essa unidade numa pergunta que ninguém mais entende.
  encerrarPendencia(unidade.id, { observacao: 'estado desconhecido, encerrada por segurança' });
  return {
    status: 'erro',
    grupoId: msg.grupoId,
    mensagemWhatsapp: '⚠️ Algo deu errado com essa pergunta pendente. Nossa equipe foi avisada.',
    notificarAdmin: true,
  };
}

async function finalizarRetiradaComComprovante(msg, unidade, pendencia) {
  let imagem;
  try {
    imagem = await baixarImagemBase64(msg.messageId);
  } catch (erro) {
    return {
      status: 'erro_download',
      grupoId: msg.grupoId,
      mensagem: erro.message,
      mensagemWhatsapp: '⚠️ Não consegui baixar essa foto do comprovante. Pode reenviar?',
      notificarAdmin: true,
    };
  }
  const caminho = salvarComprovante(unidade.id, imagem);
  const registro = encerrarPendencia(unidade.id, { comprovante: caminho });
  return {
    status: 'retirada_registrada',
    grupoId: msg.grupoId,
    registro,
    mensagemWhatsapp: `✅ Retirada de ${formatarReais(pendencia.valorRetirada)} registrada — motivo: "${pendencia.motivo}", comprovante anexado.`,
    notificarAdmin: false,
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

  // Só um envio, para o mesmo grupo de onde a foto chegou — não existe
  // grupo de administração central neste projeto (decisão do usuário,
  // 25/09/2026): os alertas (⚠️) já vêm dentro de mensagemWhatsapp.
  if (flagEnviar === '--enviar' && resultado.grupoId && resultado.mensagemWhatsapp) {
    try {
      await enviarTexto(resultado.grupoId, resultado.mensagemWhatsapp);
    } catch (erro) {
      resultado.erroEnvio = erro.message;
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
