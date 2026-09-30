/**
 * whatsapp-fechamento.js — traduz o evento `messages.upsert` da Evolution API
 * para o que processar-fechamento.js usa.
 *
 * Duas mensagens são aceitas: FOTO do relatório (`tipo: 'imagem'`) e TEXTO
 * puro (`tipo: 'texto'`) — complementando valores escritos à mão (ex:
 * "Envelope R$214,00", confirmado em uso real em 30/09/2026) OU respondendo
 * a uma pergunta pendente do bot (motivo de retirada, "sim"/"não" sobre
 * comprovante — ver scripts/lib/retiradas.js). Por isso este módulo NÃO
 * filtra texto por conter valor em reais: quem decide se um texto sem "R$"
 * é resposta de pendência ou conversa qualquer é processar-fechamento.js,
 * que conhece o estado da conversa (este módulo não conhece).
 */

function ehGrupo(remoteJid) {
  return typeof remoteJid === 'string' && remoteJid.endsWith('@g.us');
}

function interpretarEvento(body) {
  const b = body || {};
  const data = b.data || {};
  const key = data.key || {};
  const msg = data.message || {};

  const remoteJid = key.remoteJid || null;
  const fromMe = key.fromMe === true;

  const base = {
    grupoId: remoteJid,
    ehGrupo: ehGrupo(remoteJid),
    fromMe,
    messageId: key.id || null,
    // key.participantAlt é o telefone de quem falou DENTRO do grupo — key
    // .remoteJid ali é só o grupo, e o campo de nível superior `sender` da
    // Evolution é o número do BOT, não do remetente (mesma armadilha já
    // documentada no validador de hangares).
    remetenteTelefone: key.participantAlt || null,
    remetente: data.pushName || null,
    ignorar: false,
    motivo: null,
  };

  // Sem isto o bot responde à própria confirmação e entra em laço.
  if (fromMe) return { ...base, ignorar: true, motivo: 'mensagem enviada pelo próprio bot' };

  if (b.event && b.event !== 'messages.upsert') {
    return { ...base, ignorar: true, motivo: `evento "${b.event}" não é mensagem` };
  }

  if (!base.ehGrupo) {
    return { ...base, ignorar: true, motivo: 'mensagem fora do grupo de fechamento de caixa' };
  }

  const imagem = msg.imageMessage || null;
  if (imagem) {
    return {
      ...base,
      tipo: 'imagem',
      legenda: imagem.caption || null,
      mimetype: imagem.mimetype || null,
    };
  }

  if (msg.albumMessage) {
    return { ...base, ignorar: true, motivo: `aviso de álbum com ${msg.albumMessage.expectedImageCount ?? '?'} imagem(ns) — as fotos vêm em mensagens separadas` };
  }

  const textoLivre = msg.conversation || (msg.extendedTextMessage && msg.extendedTextMessage.text) || null;
  if (textoLivre) {
    return { ...base, tipo: 'texto', texto: textoLivre };
  }

  return { ...base, ignorar: true, motivo: 'mensagem sem imagem nem texto' };
}

// "R$37,00", "R$ 200", "214,00", "37.50" — texto que parece trazer um valor
// em dinheiro. Usado por processar-fechamento.js como gatilho barato (regex
// local) antes de gastar uma chamada à Anthropic para interpretar um texto
// como complemento de fechamento — só quando NÃO há pergunta pendente em
// aberto (que aceita qualquer texto como resposta, veja retiradas.js).
const PARECE_TER_VALOR_EM_REAIS = /r\$\s?\d|\d+[.,]\d{2}\b/i;

module.exports = { interpretarEvento, ehGrupo, PARECE_TER_VALOR_EM_REAIS };
