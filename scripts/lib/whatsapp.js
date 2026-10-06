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
// Os padrões são comparados contra o texto NORMALIZADO (sem acento, em
// minúsculas), e por isso são escritos sem acento.
//
// Isso não é estilo: o `\b` do JavaScript trata letra acentuada como
// separador, então `\best[áa]\b` NÃO casa com "está" seguido de espaço — o "á"
// já é um não-caractere-de-palavra e o limite depois dele nunca fecha. Foi
// assim que "como está meu pátio?" deixou de ser reconhecido enquanto "como
// esta meu patio" funcionava (29/09/2026). Normalizar antes resolve a classe
// inteira do problema em vez de um caso por vez.
const VERBOS = '(status|situacao|como\\s+esta|quant[ao]s?|tem|quais|qual|liste?|lista|'
  + 'me\\s+(fale|diga|informe|mostre?|de)|informe|mostrar?|mostre|ver|saber)';
const ASSUNTO_PATIO = '(patio|vagas?|estacionamento)';
const ASSUNTO_CREDENCIADOS = '(credenciad[oa]s?|mensalistas?)';
const ASSUNTO_TICKETS = '(tickets?\\s+validad[oa]s?|validad[oa]s?)';

const REGEX_PATIO = new RegExp(`\\b${VERBOS}\\b[^?!.]{0,50}\\b${ASSUNTO_PATIO}\\b`, 'i');
const REGEX_CREDENCIADOS = new RegExp(`\\b${VERBOS}\\b[^?!.]{0,50}\\b${ASSUNTO_CREDENCIADOS}\\b`, 'i');
const REGEX_TICKETS = new RegExp(`\\b${VERBOS}\\b[^?!.]{0,50}\\b${ASSUNTO_TICKETS}\\b`, 'i');

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

// Comando de configuração pelo grupo: liga e desliga a pergunta de
// identificação. Exige o verbo E o assunto — "ativar" sozinho não mexe em
// nada, e "a identificação está errada" é reclamação, não comando.
const REGEX_LIGAR = /\b(ativar?|ative|ligar?|ligue|habilitar?|habilite)\b/i;
const REGEX_DESLIGAR = /\b(desativar?|desative|desligar?|desligue|desabilitar?|desabilite|tirar?|tire|remover?|remova)\b/i;
const REGEX_ASSUNTO_IDENT = /\b(identifica[çc][ãa]o|identificar)\b/i;
const REGEX_ASSUNTO_CONTINGENCIA = /\b(conting[eê]ncia|valid\s?park)\b/i;

/**
 * Devolve true, false ou null (não é comando).
 *
 * Só comando curto: uma frase longa que por acaso contenha "desativar" e
 * "identificação" é conversa sobre o assunto, não ordem para mexer nele.
 */
function interpretarComandoIdentificacao(texto) {
  const t = (texto || '').trim();
  if (!t || t.length > 80) return null;
  if (!REGEX_ASSUNTO_IDENT.test(t)) return null;
  if (REGEX_DESLIGAR.test(t)) return false;
  if (REGEX_LIGAR.test(t)) return true;
  return null;
}

/**
 * Pedido de movimentação (entrada e saída) dos credenciados. Devolve true/false.
 * Separado da consulta de pátio (vagas) e do diagnóstico.
 */
function interpretarPedidoMovimentacao(texto) {
  const t = normalizar(texto || '');
  if (!t || t.length > 120) return false;
  if (/\b(movimenta[çc][aã]o|movimento)\b/.test(t)) return true;
  if (/\bentrada[s]?\b[^.?!]{0,15}\bsaida[s]?\b/.test(t)) return true; // "entrada e saída"
  if (/\bquem\b[^.?!]{0,20}\b(entrou|saiu|entrou e saiu)\b/.test(t)) return true;
  if (/\b(entrou|saiu|entraram|sairam)\b[^.?!]{0,20}\b(credenciad|funcionari|hoje)/.test(t)) return true;
  return false;
}

/**
 * Pergunta de diagnóstico do SISTEMA ("por que não está funcionando?", "status
 * do validador", "diagnóstico", "o que houve"). Diferente da consulta de pátio
 * (que é sobre vagas de um hangar). Devolve true/false.
 */
function interpretarPedidoDiagnostico(texto) {
  const t = normalizar(texto || '');
  if (!t || t.length > 120) return false;
  if (/\bdiagnostic/.test(t)) return true;
  if (/\b(status|situacao|como (esta|anda))\b/.test(t) && /\b(sistema|validador|bot|tudo|geral|servico|validacao)\b/.test(t)) return true;
  if (/\bnao\b[^.?!]{0,30}\b(funciona|funcionando|valida|validando|responde|respondendo)\b/.test(t)) return true;
  if (/\bpor que\b[^.?!]{0,30}\b(nao|parou|caiu|funciona)\b/.test(t)) return true;
  if (/\bparou de (funcionar|validar|responder)\b/.test(t)) return true;
  if (/\b(o que|oque)\b[^.?!]{0,20}\b(houve|aconteceu|acontecendo)\b/.test(t)) return true;
  if (/\b(deu|ha|tem|qual o)\b[^.?!]{0,20}\bproblema\b/.test(t)) return true;
  if (/\b(validador|sistema|o bot)\b[^.?!]{0,20}\b(caiu|fora|parado|travado|lento)\b/.test(t)) return true;
  return false;
}

/**
 * Comando da administração para DISPARAR uma mensagem aos grupos ("mandar
 * mensagem para grupos", "avisar os grupos", "comunicado"). Devolve true/false.
 *
 * Exige o assunto (mensagem/aviso/comunicado/broadcast) perto do verbo, ou
 * "avisar/comunicar" + alvo (grupos/hangares) — para "mandar o ticket pro
 * grupo" não abrir um disparo sem querer. Só frase curta.
 */
function interpretarComandoBroadcast(texto) {
  const t = (texto || '').trim();
  if (!t || t.length > 80) return false;
  if (/\b(broadcast|comunicado)\b/i.test(t)) return true;
  if (/\b(mandar|enviar|disparar|avisar|comunicar)\b[^?!.]{0,30}\b(mensagem|aviso|recado)\b/i.test(t)) return true;
  if (/\b(avisar|comunicar)\b[^?!.]{0,20}\b(grupos?|hangares?|todos)\b/i.test(t)) return true;
  return false;
}

/**
 * Comando da administração para ligar/desligar a contingência do ValidPark.
 * Devolve true (ligar), false (desligar) ou null (não é comando).
 *
 * Mesma cautela da identificação: só frase curta, para "o validpark caiu de
 * novo" não ser lido como ordem. Precisa do verbo (ligar/desligar) E do
 * assunto (contingência/validpark) juntos.
 */
function interpretarComandoContingencia(texto) {
  const t = (texto || '').trim();
  if (!t || t.length > 80) return null;
  if (!REGEX_ASSUNTO_CONTINGENCIA.test(t)) return null;
  if (REGEX_DESLIGAR.test(t)) return false;
  if (REGEX_LIGAR.test(t)) return true;
  return null;
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
  const t = normalizar(String(texto || '').trim());
  // Frase longa raramente é comando; é conversa que por acaso cita o pátio.
  if (!t || t.length > 140) return null;
  // Quem já disse O QUE quer recebe direto. 'status' é a pergunta genérica —
  // "como está meu pátio" —, e essa ganha o menu em vez de um despejo de tudo.
  if (REGEX_CREDENCIADOS.test(t)) return 'credenciados';
  if (REGEX_TICKETS.test(t)) return 'tickets';
  if (REGEX_PATIO.test(t)) return 'status';
  return null;
}

/**
 * A escolha do menu do pátio: 1/2/3 ou a palavra.
 *
 * Aceita número porque é o que a pessoa faz depois de ver uma lista numerada,
 * e palavra porque é o que ela faz quando não olhou os números.
 */
function interpretarEscolhaPatio(texto) {
  const t = normalizar(texto).replace(/[^a-z0-9\s]/g, ' ').trim();
  if (!t || t.length > 40) return null;
  if (/^1\b/.test(t) || /\bcredenciad|\bmensalista/.test(t)) return 'credenciados';
  if (/^2\b/.test(t) || /\bticket|\bvalidad/.test(t)) return 'tickets';
  if (/^3\b/.test(t) || /\bambos|\bos dois|\btudo|\btodos/.test(t)) return 'ambos';
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

  // Conversa privada não identifica hangar: o roteamento é por grupo.
  //
  // TEXTO no privado passa a ser entregue desde 18/09/2026, porque a
  // administração responde por ali a autorização de ticket bloqueado. Quem
  // decide se aquele número TEM esse direito é processar-mensagem.js, olhando
  // o grupoAdministracao dos hangares — aqui não há como saber.
  //
  // FOTO no privado continua ignorada: validar exige saber de qual pátio é o
  // ticket, e o privado não diz. Foi o que aconteceu nas duas primeiras
  // mensagens de teste do projeto, que vieram em privado e não tinham como ser
  // roteadas.
  if (!base.ehGrupo) {
    const textoPrivado =
      (msg.conversation || (msg.extendedTextMessage && msg.extendedTextMessage.text) || '').trim();
    if (!textoPrivado) {
      return { ...base, ignorar: true, motivoIgnorar: 'mensagem fora de grupo sem texto (privado não identifica hangar)' };
    }
    const ticketCitado = (textoPrivado.match(/\b(\d{12})\b/) || [])[1] || null;
    return {
      ...base,
      tipo: 'texto_privado',
      texto: textoPrivado,
      // O número sai antes de interpretar o sim/não: "SIM 011809140000" é uma
      // resposta com destinatário, e `interpretarResposta` é estrito de
      // propósito — ele devolveria null para a frase inteira.
      resposta: interpretarResposta(ticketCitado ? textoPrivado.replace(ticketCitado, ' ').trim() : textoPrivado),
      ticketCitado,
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
        comandoIdentificacao: interpretarComandoIdentificacao(textoLivre),
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

module.exports = { interpretarMensagem, extrairPlaca, ehGrupo, interpretarResposta, ehPedidoDeStatus, interpretarPedidoPatio, interpretarEscolhaPatio, interpretarConsultaValidacao, interpretarComandoIdentificacao, interpretarComandoContingencia, interpretarComandoBroadcast, interpretarPedidoDiagnostico, interpretarPedidoMovimentacao, normalizar };
