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

// Pergunta sobre o pátio. Exige um ASSUNTO conhecido junto de um VERBO de
// consulta, em vez de reagir a qualquer menção: num grupo as pessoas conversam,
// e "o pátio fica lá atrás" não pode disparar uma consulta que abre navegador e
// faz login no site.
//
// A lista de verbos nasceu curta demais (16/09/2026): "me fale quais são os
// credenciados que estão no pátio" não era reconhecido, porque "quais" não
// estava nela. Ampliada com as formas que as pessoas realmente usam.
const VERBOS = '(status|situa[çc][ãa]o|como\\s+est[áa]|quant[ao]s?|tem|quais|qual|liste?|lista|'
  + 'me\\s+(fale|diga|informe|mostre?|d[êe])|informe|mostrar?|mostre|ver|saber)';
const ASSUNTO_PATIO = '(p[áa]tio|vagas?|estacionamento)';
const ASSUNTO_CREDENCIADOS = '(credenciad[oa]s?|mensalistas?)';

const REGEX_PATIO = new RegExp(`\\b${VERBOS}\\b[^?!.]{0,50}\\b${ASSUNTO_PATIO}\\b`, 'i');
const REGEX_CREDENCIADOS = new RegExp(`\\b${VERBOS}\\b[^?!.]{0,50}\\b${ASSUNTO_CREDENCIADOS}\\b`, 'i');

// Consulta ao histórico: "o ticket do João foi validado?", "a placa ABC1234 já
// foi validada?", "validaram o 011709101527?".
//
// Exige um verbo de validação E um termo de busca. Só o verbo não basta: "vou
// validar agora" é conversa, não pergunta, e responder a isso com um relatório
// seria o bot falando por cima das pessoas.
const REGEX_VALIDACAO = /\b(validad[oa]s?|validou|validaram|validei|valida[çc][ãa]o)\b/i;

// Palavras que emolduram a pergunta e não fazem parte do que se procura. Sem
// removê-las, "o ticket do João foi validado" viraria a busca pela frase
// inteira e não casaria com a identificação "João da Silva".
//
// É um CONJUNTO comparado palavra a palavra, não uma regex com \b. O \b do
// JavaScript trata letra acentuada como separador: `\bo\b` casa com o "o"
// final de "João" e devolve "Joã", e `\bjá\b` não casa com "já" nenhuma.
// Comparar palavras normalizadas evita os dois erros de uma vez.
const MOLDURA = new Set([
  'o', 'a', 'os', 'as', 'um', 'uma', 'do', 'da', 'de', 'dos', 'das', 'no', 'na', 'em',
  'para', 'pra', 'por', 'com', 'e', 'ou', 'que', 'se', 'ja',
  'ticket', 'tickets', 'placa', 'placas', 'carro', 'veiculo', 'cliente', 'nome',
  'foi', 'foram', 'esta', 'sabe', 'saber', 'diga', 'fale', 'me', 'voce', 'ai', 'gente', 'favor',
  'validado', 'validada', 'validados', 'validadas', 'validou', 'validaram', 'validei', 'validacao',
  'hoje', 'ontem', 'hangar', 'patio',
]);

/** Sem acento e em minúsculas, para comparar sem depender de como foi digitado. */
function normalizar(texto) {
  return String(texto || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

/**
 * Devolve `{ termo }` quando a mensagem pergunta se algo foi validado, e null
 * quando não é essa a pergunta. `termo` vazio significa que a pessoa perguntou
 * sem dizer de quem — quem chama decide o que fazer com isso.
 */
function interpretarConsultaValidacao(texto) {
  const t = (texto || '').trim();
  if (!t || t.length > 140) return null;
  if (!REGEX_VALIDACAO.test(t)) return null;
  // Pergunta sobre o pátio ganha do histórico: "quantos tickets validados tem
  // no pátio" é status, não busca por cliente.
  if (interpretarPedidoPatio(t)) return null;

  const termo = normalizar(t)
    .replace(/[?!.,;:]/g, ' ')
    .split(/\s+/)
    .filter((palavra) => palavra && !MOLDURA.has(palavra))
    .join(' ');

  return { termo };
}

/**
 * Devolve null, 'status' ou 'credenciados'.
 *
 * A distinção existe porque o site expõe coisas diferentes: dos tickets
 * validados há a lista completa; dos credenciados, apenas a CONTAGEM. Quem
 * pergunta "quais são os credenciados" precisa ouvir que essa lista não existe
 * ali, não receber outra coisa no lugar.
 */
function interpretarPedidoPatio(texto) {
  const t = (texto || '').trim();
  // Frase longa raramente é comando; é conversa que por acaso cita o pátio.
  if (!t || t.length > 140) return null;
  if (REGEX_CREDENCIADOS.test(t)) return 'credenciados';
  if (REGEX_PATIO.test(t)) return 'status';
  return null;
}

function ehPedidoDeStatus(texto) {
  return interpretarPedidoPatio(texto) !== null;
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
      return {
        ...base, tipo: 'texto', texto: textoLivre,
        resposta: interpretarResposta(textoLivre),
        pedidoPatio: interpretarPedidoPatio(textoLivre),
        consultaValidacao: interpretarConsultaValidacao(textoLivre),
      };
    }
    // Álbum: quando várias fotos são enviadas juntas, o WhatsApp manda primeiro
    // um `albumMessage` que é só metadado — anuncia quantas imagens vêm e não
    // carrega nenhuma. As fotos chegam logo atrás, como mensagens separadas.
    // Ignorar é o certo, mas com motivo próprio: cair em "sem imagem nem texto"
    // escondia o que estava acontecendo (16/09/2026).
    if (msg.albumMessage) {
      return {
        ...base,
        tipo: 'album',
        ignorar: true,
        motivoIgnorar: `aviso de álbum com ${msg.albumMessage.expectedImageCount ?? '?'} imagem(ns) — as fotos vêm em mensagens separadas`,
      };
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

module.exports = { interpretarMensagem, extrairPlaca, ehGrupo, interpretarResposta, ehPedidoDeStatus, interpretarPedidoPatio, interpretarConsultaValidacao, normalizar };
