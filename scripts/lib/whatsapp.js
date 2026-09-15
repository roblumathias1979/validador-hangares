/**
 * whatsapp.js — traduz o que a Evolution API entrega para o que os scripts usam.
 *
 * A Evolution manda um evento `messages.upsert` com estrutura própria, que não
 * se parece em nada com o formato (`grupoId`, `ticket`, `opcao`) que o workflow
 * usava nos testes manuais. Este módulo é a ponte.
 *
 * O formato abaixo foi confirmado com mensagens REAIS capturadas em 15/09/2026
 * (execuções 35, 36 e 37 do n8n), não deduzido da documentação:
 *
 *   body.event                      "messages.upsert"
 *   body.data.key.remoteJid         "120363431859218622@g.us"   (grupo)
 *                                   "5511913119423@s.whatsapp.net" (conversa privada)
 *   body.data.key.fromMe            false
 *   body.data.key.id                id da mensagem, usado para baixar a mídia
 *   body.data.pushName              nome de quem mandou
 *   body.data.message.imageMessage  { caption, mimetype, url, directPath, ... }
 *
 * Duas armadilhas confirmadas nesses payloads reais:
 *
 * 1. A mensagem de grupo veio com `senderKeyDistributionMessage` ao lado do
 *    `imageMessage` — metadado de criptografia. Procurar a imagem entre as
 *    chaves, nunca assumir que `message` tem uma chave só.
 * 2. A foto NÃO vem em base64, mesmo com `webhookBase64: true` habilitado: o
 *    payload traz `url`/`directPath`/`mediaKey`, e o arquivo está criptografado
 *    nos servidores do WhatsApp. Baixar exige chamar
 *    `/chat/getBase64FromMediaMessage` da Evolution com o id da mensagem.
 */

// Placa brasileira em dois formatos:
//   antigo   AAA1234
//   Mercosul AAA1A23  (4ª posição dígito, 5ª letra, 6ª e 7ª dígitos)
// Aceita hífen ou espaço no meio, e minúsculas.
const REGEX_PLACA_ANTIGA = /\b([A-Z]{3})[\s-]?(\d{4})\b/;
const REGEX_PLACA_MERCOSUL = /\b([A-Z]{3})[\s-]?(\d)([A-Z])(\d{2})\b/;

/**
 * Procura uma placa válida num texto livre — a legenda que o cliente escreve
 * ao mandar a foto. Devolve normalizada (maiúscula, sem separador) ou null.
 *
 * Deliberadamente NÃO tenta "consertar" letra/dígito trocados (O↔0, I↔1). Uma
 * correção por posição transformaria uma placa legítima em outra placa
 * legítima e errada, sem aviso — o cliente ficaria registrado com a placa de
 * outra pessoa. Se não casar com um dos dois formatos, tratamos como ausente e
 * caímos na placa genérica, que é um erro visível e auditável.
 */
function extrairPlaca(texto) {
  const t = (texto || '').toUpperCase();
  // Mercosul primeiro: "ABC1D23" também casaria parcialmente com o formato
  // antigo se testado ao contrário, devolvendo algo truncado.
  const m = t.match(REGEX_PLACA_MERCOSUL);
  if (m) return `${m[1]}${m[2]}${m[3]}${m[4]}`;
  const a = t.match(REGEX_PLACA_ANTIGA);
  if (a) return `${a[1]}${a[2]}`;
  return null;
}

function ehGrupo(remoteJid) {
  return typeof remoteJid === 'string' && remoteJid.endsWith('@g.us');
}

/**
 * Normaliza o evento da Evolution. Nunca lança: devolve sempre um objeto com
 * `ignorar` dizendo se o workflow deve parar ali, e `motivoIgnorar` explicando.
 * Quem chama é um nó do n8n, e exceção lá vira execução com erro sem resposta
 * ao cliente.
 */
function interpretarMensagem(body) {
  const b = body || {};
  const data = b.data || {};
  const key = data.key || {};
  const msg = data.message || {};

  const remoteJid = key.remoteJid || null;
  const fromMe = key.fromMe === true;

  const base = {
    evento: b.event || null,
    instancia: b.instance || null,
    grupoId: remoteJid,
    ehGrupo: ehGrupo(remoteJid),
    fromMe,
    messageId: key.id || null,
    remetente: data.pushName || null,
    ignorar: false,
    motivoIgnorar: null,
  };

  // Passo 8 do ESTADO-ATUAL: sem isto o bot responde às próprias mensagens e
  // entra em laço — cada resposta dele dispara um novo webhook.
  if (fromMe) {
    return { ...base, ignorar: true, motivoIgnorar: 'mensagem enviada pelo próprio bot' };
  }

  if (b.event && b.event !== 'messages.upsert') {
    return { ...base, ignorar: true, motivoIgnorar: `evento "${b.event}" não é mensagem` };
  }

  // Conversa privada não identifica hangar: o roteamento é por grupo. Confirmado
  // na prática — as duas primeiras mensagens de teste vieram em privado e não
  // tinham como ser roteadas.
  if (!base.ehGrupo) {
    return {
      ...base,
      ignorar: true,
      motivoIgnorar: 'mensagem fora de grupo (conversa privada não identifica hangar)',
    };
  }

  // A imagem pode vir acompanhada de outras chaves (ex:
  // senderKeyDistributionMessage), então procuramos em vez de assumir.
  const imagem = msg.imageMessage || null;
  const textoLivre =
    msg.conversation ||
    (msg.extendedTextMessage && msg.extendedTextMessage.text) ||
    null;

  if (!imagem) {
    return {
      ...base,
      tipo: textoLivre ? 'texto' : 'outro',
      texto: textoLivre,
      ignorar: true,
      motivoIgnorar: textoLivre
        ? 'mensagem de texto (o fluxo espera a foto do ticket)'
        : 'mensagem sem imagem nem texto',
    };
  }

  const legenda = imagem.caption || null;

  return {
    ...base,
    tipo: 'imagem',
    legenda,
    mimetype: imagem.mimetype || null,
    // null aqui significa "cliente não informou": quem chama decide usar a
    // placaGenerica do hangar. Manter a distinção entre "não informou" e
    // "informou algo inválido" seria útil, mas na prática o tratamento é o
    // mesmo e o cliente é avisado nos dois casos.
    placa: extrairPlaca(legenda),
  };
}

module.exports = { interpretarMensagem, extrairPlaca, ehGrupo };
