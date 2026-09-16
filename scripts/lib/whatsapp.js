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

// Resposta a uma pergunta de sim/não. Deliberadamente restrito: aceita as
// formas que alguém realmente digita no WhatsApp, e devolve null para
// qualquer outra coisa. Interpretar "ok" ou um emoji como autorização seria
// arriscado — o "sim" aqui consome cota do hangar e ocupa vaga no pátio.
const AFIRMATIVAS = ['sim', 's', 'pode', 'pode sim', 'confirmo', 'confirmar', 'isso', 'quero', 'valida', 'validar'];
const NEGATIVAS = ['nao', 'não', 'n', 'nao quero', 'não quero', 'cancela', 'cancelar', 'deixa'];

function interpretarResposta(texto) {
  const t = (texto || '')
    .trim()
    .toLowerCase()
    .replace(/[!.,;]+$/, '');
  if (AFIRMATIVAS.includes(t)) return 'sim';
  if (NEGATIVAS.includes(t)) return 'nao';
  return null;
}

// Pedido de situação do pátio. Exige a palavra "pátio" ou "vagas" junto de um
// verbo de consulta, em vez de reagir a qualquer menção: num grupo as pessoas
// conversam, e "acabou a vaga aí?" entre elas não deve disparar uma consulta
// que abre navegador e loga no site.
const REGEX_STATUS_PATIO = /\b(status|situa[çc][ãa]o|como\s+est[áa]|quantas?|tem)\b[^?!.]{0,40}\b(p[áa]tio|vagas?|estacionamento)\b/i;

function ehPedidoDeStatus(texto) {
  const t = (texto || '').trim();
  if (!t || t.length > 120) return false; // frase longa raramente é comando
  return REGEX_STATUS_PATIO.test(t);
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

  // Quem falou DENTRO do grupo. Confirmado no payload real de 15/09/2026:
  //   key.participant     "272447123230847@lid"          (identificador novo)
  //   key.participantAlt  "5511913119423@s.whatsapp.net" (telefone)
  // Atenção: body.sender é o número do BOT, não o do remetente — usar aquilo
  // aqui faria todo mundo no grupo virar a mesma pessoa.
  const remetenteId = key.participant || key.participantAlt || remoteJid || null;

  const base = {
    evento: b.event || null,
    instancia: b.instance || null,
    grupoId: remoteJid,
    ehGrupo: ehGrupo(remoteJid),
    fromMe,
    messageId: key.id || null,
    remetenteId,
    remetenteTelefone: key.participantAlt || null,
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
    // Texto em grupo NÃO é descartado aqui: pode ser a resposta a uma
    // pergunta que o bot fez (ex: "SIM" para usar a cota fora do prazo). Quem
    // decide é processar-mensagem.js, consultando as pendências — se não
    // houver nenhuma para esta pessoa, aí sim a mensagem é ignorada em
    // silêncio, sem o bot responder a toda conversa do grupo.
    if (textoLivre) {
      return { ...base, tipo: 'texto', texto: textoLivre, resposta: interpretarResposta(textoLivre), pedeStatusPatio: ehPedidoDeStatus(textoLivre) };
    }
    return {
      ...base,
      tipo: 'outro',
      texto: null,
      ignorar: true,
      motivoIgnorar: 'mensagem sem imagem nem texto',
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

module.exports = { interpretarMensagem, extrairPlaca, ehGrupo, interpretarResposta, ehPedidoDeStatus };
