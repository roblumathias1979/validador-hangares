/**
 * whatsapp-fechamento.js — traduz o evento `messages.upsert` da Evolution API
 * para o que processar-fechamento.js usa.
 *
 * Duas mensagens são aceitas: FOTO do relatório (`tipo: 'imagem'`) e TEXTO
 * puro complementando valores escritos à mão (`tipo: 'texto'`, ex: "Envelope
 * R$214,00") — confirmado em uso real (30/09/2026, Vila Mariana), mandado
 * como mensagem separada logo após a foto. Texto sem nenhum valor em reais
 * reconhecível (conversa qualquer no grupo) ainda é ignorado — ver o filtro
 * em processar-fechamento.js, que só tenta interpretar texto com
 * `R$`/dígitos.
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
  if (textoLivre && PARECE_TER_VALOR_EM_REAIS.test(textoLivre)) {
    // Gatilho barato (regex local) antes de gastar uma chamada à Anthropic:
    // só tenta interpretar como complemento de fechamento quando o texto
    // parece mesmo trazer um valor em reais — "oi", "chegou?" etc. continuam
    // ignorados em silêncio, sem custo de API nenhum.
    return { ...base, tipo: 'texto', texto: textoLivre };
  }

  return { ...base, ignorar: true, motivo: 'mensagem sem imagem nem valor em reais reconhecível' };
}

// "R$37,00", "R$ 200", "214,00", "37.50" — texto que parece trazer um valor
// em dinheiro. Não precisa ser perfeito: é só o filtro que evita gastar uma
// chamada de API em toda mensagem de conversa do grupo.
const PARECE_TER_VALOR_EM_REAIS = /r\$\s?\d|\d+[.,]\d{2}\b/i;

module.exports = { interpretarEvento, ehGrupo };
