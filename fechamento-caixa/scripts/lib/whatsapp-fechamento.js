/**
 * whatsapp-fechamento.js — traduz o evento `messages.upsert` da Evolution API
 * para o que processar-fechamento.js usa. Versão enxuta do equivalente no
 * validador de hangares: aqui não existe pergunta de menu, consulta de pátio
 * nem placa — só "chegou uma foto no grupo de fechamentos, ou não".
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
  if (!imagem) {
    if (msg.albumMessage) {
      return { ...base, ignorar: true, motivo: `aviso de álbum com ${msg.albumMessage.expectedImageCount ?? '?'} imagem(ns) — as fotos vêm em mensagens separadas` };
    }
    return { ...base, ignorar: true, motivo: 'mensagem sem imagem — fechamento de caixa chega como foto do relatório' };
  }

  return {
    ...base,
    legenda: imagem.caption || null,
    mimetype: imagem.mimetype || null,
  };
}

module.exports = { interpretarEvento, ehGrupo };
