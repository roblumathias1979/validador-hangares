/**
 * conferir-local.js — confere se a foto do cliente foi tirada no hangar certo.
 *
 * Só AIBM 1 e AIBM 2 usam isto (`exigeFotoVeiculoNoLocal: true` no config).
 * Nos outros 14 hangares o cliente manda só o ticket, e nada aqui roda.
 *
 * COMO FUNCIONA
 * O cliente fotografa o ticket na mão com o carro estacionado ao fundo. O
 * modelo descreve o cenário e compara com a descrição de referência do hangar,
 * que fica em config/hangares.json (campo `localReferencia`) — texto puro, em
 * português, editável por qualquer pessoa sem mexer em código.
 *
 * POR QUE TEXTO E NÃO FOTO DE REFERÊNCIA
 * Mandar foto de referência junto em toda chamada custa mais e obriga a manter
 * arquivos de imagem no servidor, versionados e sincronizados. Aqui a diferença
 * entre os dois locais é grande e fácil de escrever: asfalto com vaga demarcada
 * em amarelo, em campo aberto, contra concreto sem demarcação encostado numa
 * parede de bloco branco. Texto resolve, e o operador consegue corrigir sozinho
 * se o pátio mudar.
 *
 * TRÊS RESULTADOS, NUNCA DOIS
 * `compativel`   — o cenário bate com a referência do hangar.
 * `incompativel` — bate com OUTRO lugar, ou contradiz a referência. Sinal de
 *                  que o carro não está onde deveria.
 * `indeterminado`— não deu para dizer. Acontece bastante: num close de carro
 *                  aparece só um pedaço de asfalto ou de parede branca, que
 *                  existe no aeroporto inteiro.
 *
 * `indeterminado` é resultado legítimo, não falha. Forçar um veredito onde não
 * há evidência é pior que admitir a dúvida: acusaria cliente honesto de fraude.
 */

// Descrições escritas a partir das fotos de referência tiradas em 15/09/2026.
// Ficam aqui só como FALLBACK e documentação — o valor que vale é o do
// config/hangares.json, para poder ser corrigido sem editar código.
const REFERENCIAS_PADRAO = {
  aibm: {
    resumo:
      'Vagas de concreto liso, SEM demarcação pintada no chão, sob cobertura de telha ' +
      'metálica apoiada em pilares azuis. A cobertura é encostada no prédio: atrás dos ' +
      'carros há uma parede de bloco de concreto pintada de branco, com janelas pequenas ' +
      'com grade e aparelhos de ar-condicionado presos na fachada. Acima da parede branca ' +
      'aparece um telhado curvo de metal azul. Os carros ficam próximos à parede, com a ' +
      'frente voltada para ela. Ao lado passa uma rua de asfalto.',
    sinaisFortes: [
      'parede de bloco branco logo atrás do carro',
      'piso de concreto sem faixa amarela',
      'ar-condicionado na parede acima dos carros',
      'telhado curvo azul acima da parede branca',
    ],
  },
  'aibm-2': {
    resumo:
      'Estacionamento a céu aberto, com piso de ASFALTO e vagas demarcadas por faixas ' +
      'AMARELAS pintadas no chão. A cobertura é isolada, apoiada em pilares azuis, e NÃO ' +
      'encosta em prédio nenhum: atrás e ao lado dos carros não há parede, e sim uma cerca ' +
      'viva alta de árvores, gramado em declive e vista aberta de morros ao longe. Em uma ' +
      'das pontas há uma lixeira preta grande com rodas. Mais adiante, na mesma área, há ' +
      'um hangar de portas azuis com aeronaves estacionadas ao lado.',
    sinaisFortes: [
      'faixa amarela demarcando a vaga',
      'piso de asfalto',
      'ausência de parede atrás do carro',
      'árvores ou gramado ao fundo',
      'aeronave ou hangar de portas azuis visível',
    ],
  },
};

function referenciaDe(hangar) {
  if (hangar && hangar.localReferencia && hangar.localReferencia.resumo) {
    return hangar.localReferencia;
  }
  return REFERENCIAS_PADRAO[hangar && hangar.id] || null;
}

/**
 * Trecho a ser acrescentado ao prompt do OCR quando o hangar exige a foto com
 * o veículo. Fica na MESMA chamada que lê o ticket: uma foto, uma chamada, um
 * custo. Separar em duas chamadas dobraria preço e tempo sem ganho nenhum.
 */
function blocoPromptLocal(hangar, temFotosReferencia = false) {
  const ref = referenciaDe(hangar);
  if (!ref) return '';

  // Quando há fotos do pátio, elas viram a evidência principal e o texto passa
  // a dizer O QUE olhar nelas. Sem fotos, o texto é tudo o que existe.
  const sobreFotos = temFotosReferencia
    ? '\n\nVocê recebeu também FOTOS DE REFERÊNCIA deste pátio. Compare o cenário ao redor do veículo com elas: piso, demarcação, parede ou ausência dela, cobertura e o que aparece ao fundo. As fotos valem mais que a descrição abaixo, que serve para dizer o que observar.'
    : '';

  const sinais = (ref.sinaisFortes || []).map((s) => `- ${s}`).join('\n');

  return `

${sobreFotos}

Nesta foto o cliente também deve aparecer com o VEÍCULO estacionado no hangar. Além do ticket, faça o seguinte.

1) Descreva em "cenario" o que se vê ao redor do veículo, em uma ou duas frases: tipo de piso, se há demarcação pintada, se há parede atrás do carro e de que material, o que aparece ao fundo. Descreva o que você REALMENTE vê, sem tentar encaixar na referência abaixo.

2) Depois compare com a referência do hangar "${hangar.hangar || hangar.id}":

${ref.resumo}

Sinais característicos deste local:
${sinais}

3) Preencha "local" com um destes três valores:
- "compativel": o cenário bate com a referência acima.
- "incompativel": o cenário CONTRADIZ a referência de forma clara (por exemplo, a referência diz piso de concreto encostado numa parede branca e a foto mostra asfalto com faixa amarela em campo aberto, ou vice-versa).
- "indeterminado": não dá para decidir. Use este valor sempre que a foto for um close que mostre apenas um pedaço de chão, de parede ou do próprio carro, sem contexto suficiente. Um pedaço de asfalto ou de parede branca, sozinho, existe em vários pontos do aeroporto e NÃO serve para confirmar nem para negar.

Explique o motivo em "localMotivo", citando o que você viu que sustenta a escolha.

IMPORTANTE: "indeterminado" é uma resposta correta e esperada em boa parte dos casos. Não escolha "compativel" só porque nada contradiz, e não escolha "incompativel" por falta de evidência — nesses dois casos a resposta é "indeterminado". Dizer "incompativel" sem base acusaria de fraude um cliente honesto.`;
}

/**
 * Traduz o veredito do modelo em decisão operacional.
 *
 * `bloqueia` só vale para incompativel. Indeterminado deixa passar com aviso:
 * a foto ruim é culpa do enquadramento, não do cliente, e travar por isso
 * geraria mais atrito do que fraude evitada.
 */
function avaliarLocal(hangar, local, localMotivo) {
  if (!hangar || !hangar.exigeFotoVeiculoNoLocal) {
    return { aplicavel: false, local: null, bloqueia: false, notificarAdmin: false };
  }

  const valor = ['compativel', 'incompativel', 'indeterminado'].includes(local)
    ? local
    : 'indeterminado';

  if (valor === 'incompativel') {
    return {
      aplicavel: true,
      local: 'incompativel',
      motivo: localMotivo || '',
      bloqueia: true,
      notificarAdmin: true,
      mensagemWhatsapp:
        '⚠️ A foto não parece ter sido tirada no hangar. Pode mandar outra, mostrando o carro estacionado na vaga, com um pouco do entorno aparecendo?',
    };
  }

  if (valor === 'indeterminado') {
    return {
      aplicavel: true,
      local: 'indeterminado',
      motivo: localMotivo || '',
      bloqueia: false,
      notificarAdmin: false,
      observacao:
        'Não foi possível confirmar o local pela foto — enquadramento fechado demais.',
    };
  }

  return {
    aplicavel: true,
    local: 'compativel',
    motivo: localMotivo || '',
    bloqueia: false,
    notificarAdmin: false,
  };
}

/**
 * Prompt para a foto do VEÍCULO, enviada num segundo passo.
 *
 * Diferente de blocoPromptLocal(), que acompanha a leitura do ticket: aqui a
 * foto não tem ticket nenhum, e a única pergunta é se o lugar bate. Separar os
 * dois passos existe porque uma foto só não serve para ambos — o OCR precisa de
 * close para ler 12 dígitos, e a conferência precisa de enquadramento aberto
 * para ver piso, parede e fundo.
 */
function promptSomenteLocal(hangar, temFotosReferencia = false) {
  const ref = referenciaDe(hangar);
  if (!ref) return '';
  const sinais = (ref.sinaisFortes || []).map((s) => `- ${s}`).join('\n');
  const sobreFotos = temFotosReferencia
    ? '\n\nVocê recebeu também FOTOS DE REFERÊNCIA deste pátio. Compare com elas: piso, demarcação, parede ou ausência dela, cobertura e o que aparece ao fundo. As fotos valem mais que a descrição abaixo, que serve para dizer o que observar.'
    : '';

  return `Esta é a foto de um VEÍCULO estacionado, enviada por um cliente para comprovar que o carro está no hangar "${hangar.hangar || hangar.id}". NÃO há ticket nesta foto — não procure por um.${sobreFotos}

Responda APENAS com um JSON (sem markdown, sem texto antes ou depois) neste formato exato:
{
  "placa": "<a placa do veículo, se estiver legível na foto; só letras e números, sem hífen. null se não der para ler com certeza>",
  "cenario": "<uma ou duas frases sobre o que se vê ao redor do veículo: tipo de piso, se há demarcação pintada, se há parede atrás e de que material, o que aparece ao fundo. Descreva o que REALMENTE vê, sem tentar encaixar na referência>",
  "local": "compativel" | "incompativel" | "indeterminado",
  "localMotivo": "<por que escolheu esse valor, citando o que viu>"
}

Sobre a PLACA: só preencha se conseguir ler os caracteres com certeza. Placa borrada, cortada ou em ângulo difícil é null — um caractere errado registra o veículo de outra pessoa no sistema, e é melhor não informar do que informar errado.

Referência deste hangar:

${ref.resumo}

Sinais característicos deste local:
${sinais}

Use "incompativel" apenas quando o cenário CONTRADIZ a referência de forma clara (por exemplo, a referência diz piso de concreto encostado numa parede branca e a foto mostra asfalto com faixa amarela em campo aberto, ou vice-versa).

Use "indeterminado" sempre que a foto não permitir decidir — close que mostre apenas um pedaço de chão, de parede ou do próprio carro, sem contexto. Um pedaço de asfalto ou de parede branca, sozinho, existe em vários pontos do aeroporto e NÃO serve para confirmar nem para negar.

IMPORTANTE: "indeterminado" é uma resposta correta e esperada. Não escolha "compativel" só porque nada contradiz, e não escolha "incompativel" por falta de evidência — nesses dois casos a resposta é "indeterminado". Dizer "incompativel" sem base acusaria de fraude um cliente honesto.`;
}

module.exports = { blocoPromptLocal, promptSomenteLocal, avaliarLocal, referenciaDe, REFERENCIAS_PADRAO };
