/**
 * fotos-usadas.js — impede que a MESMA foto valide mais de um ticket.
 *
 * O BURACO QUE ISTO FECHA
 * O fluxo original pedia UMA foto: o ticket na mão com o carro ao fundo. Aquela
 * foto provava as duas coisas ao mesmo tempo, e não servia para outro ticket —
 * o número estava nela.
 *
 * Em 16/09/2026 o fluxo passou a ter dois passos (ticket primeiro, foto do
 * carro depois), para não fazer o cliente ir até o veículo antes de saber se o
 * ticket servia. A ordem ficou melhor, mas junto se perdeu o vínculo: a foto do
 * carro não tem nada que a ligue àquele ticket. Guardar uma foto e reenviá-la
 * todos os dias passava na conferência de local — porque o local está certo
 * mesmo. Foi o que apareceu no pátio do AIBM 2, com fotos repetidas validadas.
 *
 * A conferência de local NUNCA pegaria isso, por construção: ela responde "o
 * carro está neste pátio?", e a resposta é sim. A pergunta que faltava é outra,
 * "esta foto é de agora?", e é essa que este módulo responde.
 *
 * O QUE PEGA E O QUE NÃO PEGA
 * Pega a mesma imagem reenviada — encaminhada, reenviada da galeria, mandada em
 * outro grupo. É a fraude barata, a que não dá trabalho nenhum.
 *
 * NÃO pega foto NOVA do mesmo carro no mesmo lugar: bytes diferentes, hash
 * diferente. Para fechar isso é preciso exigir algo imprevisível na foto — o
 * próprio ticket visível, por exemplo — o que é decisão de fluxo, não de código.
 * Está registrado em ESTADO-ATUAL.md para não se perder.
 *
 * POR QUE SHA-256 DOS BYTES, E NÃO COMPARAÇÃO VISUAL
 * Comparar imagens parecidas exige decodificar JPEG, e o projeto tem duas
 * dependências (dotenv e playwright) — nenhuma faz isso. Um hash exato não tem
 * falso positivo: ou é o mesmo arquivo, ou não é. Acusar alguém de reusar foto
 * por semelhança seria bem pior do que deixar passar uma foto nova.
 */

const crypto = require('crypto');
const path = require('path');
const { comTrava, salvarAtomico, lerJson } = require('./trava-arquivo');

const ARQUIVO = path.join(__dirname, '..', '..', 'data', 'fotos-usadas.json');

// Mesma retenção do histórico de validações: o suficiente para conferir uma
// cobrança contestada do mês anterior, sem virar arquivo eterno.
const RETENCAO_DIAS = 90;

function impressaoDigital(base64) {
  return crypto.createHash('sha256').update(Buffer.from(base64, 'base64')).digest('hex');
}

/**
 * Se esta foto já validou algum ticket, devolve o registro daquela vez.
 * Devolve null quando é foto nova.
 */
function jaUsada(base64) {
  const hash = impressaoDigital(base64);
  const usadas = lerJson(ARQUIVO, {});
  const anterior = usadas[hash];
  return anterior ? { hash, ...anterior } : null;
}

/**
 * Marca a foto como gasta. Chamado DEPOIS da validação dar certo — se a
 * validação falha, a foto continua valendo, senão o cliente perderia uma foto
 * boa por causa de um erro nosso.
 */
function registrar(base64, dados) {
  return registrarPar({ ...dados, hashes: [impressaoDigital(base64)] });
}

/**
 * Registra o PAR de fotos de uma validação: a do ticket e a do veículo.
 *
 * As duas são gastas JUNTAS porque juntas é que provam alguma coisa. A foto do
 * ticket sozinha não diz onde o carro está; a do veículo sozinha não diz a que
 * ticket pertence. Gastar só uma deixaria a outra livre para ser reaproveitada
 * na próxima validação, que é exatamente o buraco que se está fechando.
 *
 * Os dois hashes apontam para o MESMO registro, então a recusa consegue dizer
 * qual ticket aquela foto validou, seja qual das duas venha de volta.
 */
function registrarPar({ hashes, hangarId, ticket, grupoId, remetente, placa }) {
  const lista = (hashes || []).filter(Boolean);
  if (!lista.length) return { registrada: false };

  return comTrava(ARQUIVO, () => {
    const usadas = lerJson(ARQUIVO, {});
    const registro = {
      hangarId: hangarId || null,
      ticket: ticket || null,
      grupoId: grupoId || null,
      remetente: remetente || null,
      placa: placa || null,
      em: new Date().toISOString(),
      par: lista,
    };
    for (const hash of lista) usadas[hash] = registro;
    expurgarEm(usadas);
    salvarAtomico(ARQUIVO, usadas);
    return { hashes: lista, registrada: true };
  });
}

/** Como `jaUsada`, mas para quem já tem o hash em mãos. */
function jaUsadaPorHash(hash) {
  const anterior = lerJson(ARQUIVO, {})[hash];
  return anterior ? { hash, ...anterior } : null;
}

function expurgarEm(usadas) {
  const limite = new Date(Date.now() - RETENCAO_DIAS * 24 * 3600 * 1000).toISOString();
  for (const [hash, dados] of Object.entries(usadas)) {
    if ((dados.em || '') < limite) delete usadas[hash];
  }
  return usadas;
}

/**
 * Mensagem para quem reenviou uma foto já usada.
 *
 * Diz QUANDO e em QUE ticket, porque o caso honesto existe: duas pessoas do
 * mesmo hangar mandando a mesma foto por engano, ou alguém reenviando sem
 * perceber. Com a informação na mão, quem errou entende sozinho; quem tentou
 * burlar sabe que o sistema viu.
 */
function mensagemRecusa(anterior, ticketAtual) {
  const quando = anterior.em
    ? new Date(anterior.em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })
    : 'antes';
  const outroPatio = anterior.hangarId ? ` (hangar ${anterior.hangarId})` : '';
  return 'Essa foto já foi usada para validar outro ticket'
    + `${anterior.ticket ? ` (${anterior.ticket}${outroPatio})` : ''}, em ${quando}.\n\n`
    + `Para validar o ticket ${ticketAtual} preciso de uma foto TIRADA AGORA do veículo estacionado no hangar, `
    + 'com a placa visível e um pouco do entorno aparecendo.';
}

module.exports = { impressaoDigital, jaUsada, jaUsadaPorHash, registrar, registrarPar, mensagemRecusa, RETENCAO_DIAS, ARQUIVO };
