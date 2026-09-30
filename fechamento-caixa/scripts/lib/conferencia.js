/**
 * conferencia.js — as checagens de inconsistência do fechamento de caixa,
 * reescritas (25/09/2026) contra o formato REAL do relatório #1 Park (ver
 * ocr-fechamento.js) depois de três fotos reais. A tabela "Formas de
 * Pagamento" tem rótulos livres (MAQ. CARTAO, MASTER Credito, SEMPARAR...),
 * por isso a classificação por palavra-chave em vez de campos fixos.
 *
 * Duas frentes, como pedido:
 *  1) conferirFechamentoInterno: a matemática do PRÓPRIO relatório fecha?
 *     Não depende de nada externo — é exata, dá para exigir tolerância de
 *     1 centavo.
 *  2) conferirMaquininha: o total do relatório bate com o resumo da
 *     maquininha/depósito ANEXADO NA MESMA FOTO? Ao contrário do que se
 *     pensava inicialmente, isso NÃO precisa de API de banco/maquininha —
 *     a unidade já grampeia o comprovante físico. MAS os períodos impressos
 *     no relatório #1 Park e no resumo da maquininha nem sempre coincidem
 *     (medido nas fotos reais: diferença de dezenas de reais mesmo sem nada
 *     de errado), e "Recebido Outra Forma" costuma ser convênio faturado —
 *     dinheiro que nunca passou pela maquininha. Por isso o veredito GERAL
 *     nunca é "inconsistente" ("inconsistente" fica só para a matemática
 *     exata do item 1) — é sempre "a_conferir" ou "dentro_do_esperado", para
 *     uma pessoa decidir se a divergência é normal ou não.
 *
 *     Além do total, `porFormaDePagamento` abre cartão/pix separadamente
 *     (pedido do usuário, 25/09/2026), com direção de sobra/falta — é o que
 *     revelou, numa das fotos reais, que R$160 em Pix processados pela
 *     maquininha não apareciam em NENHUMA linha do relatório #1 Park, coisa
 *     que o total sozinho escondia (o total ficava "dentro do esperado" só
 *     porque o excesso de cartão por acaso compensava a falta de Pix).
 */

const TOLERANCIA_CENTAVOS = 0.01;

// Diferença aceitável por padrão na comparação com a maquininha, dado o
// desalinhamento de período observado nas fotos reais. Ajustável por quem
// chama — é uma escolha de negócio, não uma verdade técnica.
const TOLERANCIA_MAQUININHA_PADRAO = 0.05; // 5%

function round2(v) {
  return Math.round((v + Number.EPSILON) * 100) / 100;
}

function normalizar(texto) {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

// Operadoras de tag de pedágio/estacionamento — pedido do usuário
// (30/09/2026): deixaram de cair genericamente em "outra" e passam a ser
// discriminadas por operadora (ver computarOperadorasTag/conferirMaquininha).
// Rótulo visto de verdade até agora: SEMPARAR. Veloe e ConectCar cadastradas
// preventivamente pelo nome oficial de cada operadora — ainda sem confirmar
// contra uma foto real (mesmo cuidado de nunca inventar dado: se o rótulo
// real vier diferente do esperado, cai em "outra" normalmente, não quebra).
const OPERADORAS_TAG = [
  { id: 'sem_parar', nome: 'Sem Parar', regex: /sem\s*parar/ },
  { id: 'veloe', nome: 'Veloe', regex: /veloe/ },
  { id: 'conectcar', nome: 'ConectCar', regex: /conect\s*car/ },
];

function classificarOperadoraTag(forma) {
  const f = normalizar(forma);
  return OPERADORAS_TAG.find((o) => o.regex.test(f)) || null;
}

// Rótulos vistos até agora: MAQ. CARTAO, MASTER Credito, MASTER Debito, VISA
// Credito, Outros Cartões (-> cartao); DINHEIRO (-> dinheiro); PIX/QR CODE
// (-> pix, não visto ainda no #1 Park mas existe na maquininha); SEMPARAR e
// demais operadoras de tag (-> tag, discriminada por operadora); A Faturar,
// convênios (-> outra, nem cartão nem dinheiro nem pix nem tag).
function classificarForma(forma) {
  const f = normalizar(forma);
  if (/dinheiro/.test(f)) return 'dinheiro';
  if (/\bpix\b|qr\s*code/.test(f)) return 'pix';
  if (classificarOperadoraTag(forma)) return 'tag';
  if (/cart|visa|master|maestro|\belo\b|amex|hiper/.test(f)) return 'cartao';
  return 'outra';
}

/**
 * Agrupa as linhas de tag por OPERADORA (Sem Parar, Veloe, ConectCar...),
 * somando quando a mesma operadora aparece em mais de uma linha. Só inclui
 * operadoras que realmente apareceram no relatório — ao contrário de
 * dinheiro/cartão/Pix (sempre mostrados), tag é uma lista aberta e varia de
 * unidade para unidade.
 *
 * Ao contrário do cartão/Pix (que exigem a tabela INTEIRA legível antes de
 * confiar na soma, porque senão caem no campo-resumo), aqui não tem
 * campo-resumo por operadora pra cair de volta — então funciona mesmo com
 * outra linha ilegível no meio (ex: "VISA Credito: null"), desde que a
 * própria linha da operadora esteja legível.
 */
function computarOperadorasTag(formas) {
  const somaPorId = new Map();
  for (const f of formas) {
    const operadora = classificarOperadoraTag(f.forma);
    if (!operadora || typeof f.valor !== 'number') continue;
    somaPorId.set(operadora.id, round2((somaPorId.get(operadora.id) || 0) + f.valor));
  }
  return OPERADORAS_TAG
    .filter((o) => somaPorId.has(o.id))
    .map((o) => ({ operadora: o.id, nome: o.nome, valor: somaPorId.get(o.id) }));
}

function somarClassificados(formas, classe) {
  const legiveis = formas.filter((f) => classificarForma(f.forma) === classe && typeof f.valor === 'number');
  if (!legiveis.length) return null;
  return round2(legiveis.reduce((acc, f) => acc + f.valor, 0));
}

/**
 * Compara um valor do relatório contra o do comprovante e diz a DIREÇÃO da
 * diferença: 'sobra' quando o relatório informa MAIS do que o comprovante
 * (ex: cartão declarado maior que o processado pela maquininha), 'falta'
 * quando informa MENOS, 'ok' quando a diferença está dentro da tolerância.
 *
 * Também aceita faltar um dos dois lados — pedido do usuário (30/09/2026):
 * o "status final" da mensagem sempre lista dinheiro/cartão/Pix, mesmo
 * quando não há como comparar (ex: dinheiro contra um resumo de maquininha,
 * que não processa dinheiro nenhum). `direcao` vira 'sem_dado' (relatório
 * não informou) ou 'sem_comprovante' (relatório informou, mas não há nada
 * para comparar) em vez de forçar sobra/falta sem base.
 */
function montarItem(forma, valorRelatorio, valorComprovante, toleranciaPercentual) {
  if (typeof valorRelatorio !== 'number') {
    return {
      forma,
      valorRelatorio: null,
      valorComprovante: typeof valorComprovante === 'number' ? valorComprovante : null,
      diferenca: null,
      direcao: 'sem_dado',
    };
  }
  if (typeof valorComprovante !== 'number') {
    return { forma, valorRelatorio, valorComprovante: null, diferenca: null, direcao: 'sem_comprovante' };
  }
  const diferenca = round2(valorRelatorio - valorComprovante);
  const base = Math.max(Math.abs(valorRelatorio), Math.abs(valorComprovante), 1);
  const dentroDaTolerancia = Math.abs(diferenca) / base <= toleranciaPercentual;
  return {
    forma,
    valorRelatorio,
    valorComprovante,
    diferenca,
    direcao: dentroDaTolerancia ? 'ok' : (diferenca > 0 ? 'sobra' : 'falta'),
  };
}

/**
 * Confere a matemática do PRÓPRIO relatório #1 Park, sem nada externo.
 * Duas checagens independentes (cada uma roda só quando os campos que ela
 * precisa existem e estão legíveis — campo ausente vira "indeterminada",
 * nunca um falso "inconsistente"):
 *
 *   a) recebidoCartao + recebidoDinheiro + recebidoOutraForma == valorFaturado
 *   b) soma da tabela "Formas de Pagamento" == valorFaturado
 */
function conferirFechamentoInterno(relatorio) {
  const r = relatorio || {};
  const checagens = {};

  const resumoCompleto = [r.recebidoCartao, r.recebidoDinheiro, r.recebidoOutraForma, r.valorFaturado]
    .every((v) => typeof v === 'number');
  if (resumoCompleto) {
    const soma = round2(r.recebidoCartao + r.recebidoDinheiro + r.recebidoOutraForma);
    const diferenca = round2(r.valorFaturado - soma);
    checagens.resumoVsFaturado = {
      status: Math.abs(diferenca) <= TOLERANCIA_CENTAVOS ? 'consistente' : 'inconsistente',
      soma, valorFaturado: r.valorFaturado, diferenca,
    };
  } else {
    checagens.resumoVsFaturado = { status: 'indeterminada', motivo: 'faltam Recebido em Cartão/Dinheiro/Outra Forma ou Valor Faturado.' };
  }

  const formas = Array.isArray(r.formasDePagamento) ? r.formasDePagamento : [];
  const todasLegiveis = formas.length > 0 && formas.every((f) => typeof f.valor === 'number');
  if (todasLegiveis && typeof r.valorFaturado === 'number') {
    const soma = round2(formas.reduce((acc, f) => acc + f.valor, 0));
    const diferenca = round2(r.valorFaturado - soma);
    checagens.formasVsFaturado = {
      status: Math.abs(diferenca) <= TOLERANCIA_CENTAVOS ? 'consistente' : 'inconsistente',
      soma, valorFaturado: r.valorFaturado, diferenca,
    };
  } else {
    checagens.formasVsFaturado = {
      status: 'indeterminada',
      motivo: formas.length === 0
        ? 'relatório não trouxe a tabela de formas de pagamento.'
        : 'algum valor da tabela de formas de pagamento não foi lido com certeza.',
    };
  }

  const valores = Object.values(checagens);
  const algumaInconsistente = valores.some((c) => c.status === 'inconsistente');
  const todasIndeterminadas = valores.every((c) => c.status === 'indeterminada');

  return {
    status: algumaInconsistente ? 'inconsistente' : todasIndeterminadas ? 'indeterminada' : 'consistente',
    checagens,
  };
}

/**
 * Compara o relatório contra o comprovante ANEXADO NA MESMA FOTO (maquininha
 * ou depósito bancário). O veredito GERAL (`status`) nunca é "inconsistente"
 * — ver nota no topo do arquivo sobre desalinhamento de período — só
 * `dentro_do_esperado` / `a_conferir` / `sem_referencia`.
 *
 * `porFormaDePagamento` SEMPRE traz um item de dinheiro, cartão e Pix
 * (pedido do usuário, 30/09/2026) — não só quando dá para comparar. Quando
 * não há como (ex: dinheiro contra um resumo de maquininha, que não
 * processa dinheiro), o item vem com `direcao: 'sem_comprovante'` em vez de
 * ficar de fora — a mensagem final sempre mostra as três formas, dizendo
 * "bate", "sobra", "falta" ou "sem comprovante para conferir" em cada uma.
 */
function conferirMaquininha(relatorio, documentoAnexo, { toleranciaPercentual = TOLERANCIA_MAQUININHA_PADRAO } = {}) {
  const anexo = documentoAnexo || {};
  const r = relatorio || {};
  const formas = Array.isArray(r.formasDePagamento) ? r.formasDePagamento : [];
  const formasLegiveis = formas.length > 0 && formas.every((f) => typeof f.valor === 'number');

  // Valor de dinheiro do relatório, pelo campo mais específico disponível —
  // igual nos dois ramos (maquininha ou depósito), então calculado uma vez.
  const dinheiroRelatorio = r.recebidoDinheiro ?? r.dinheiroCaixa ?? null;

  // Discriminado por operadora (Sem Parar, Veloe, ConectCar...) em todos os
  // ramos — nenhum comprovante hoje traz esse dado pra comparar (só a
  // maquininha de cartão/Pix), então cada operadora sempre vem
  // 'sem_comprovante' na mensagem final, mas já separada de "outra".
  const porOperadoraTag = computarOperadorasTag(formas);

  if (anexo.tipo === 'deposito_bancario') {
    const valorDeposito = (anexo.deposito || {}).valor;
    const item = montarItem('dinheiro', dinheiroRelatorio, typeof valorDeposito === 'number' ? valorDeposito : null, toleranciaPercentual);
    const status = item.direcao === 'sobra' || item.direcao === 'falta' ? 'a_conferir'
      : item.direcao === 'ok' ? 'dentro_do_esperado' : 'sem_referencia';
    return {
      status,
      totalDivergente: item.direcao === 'sobra' || item.direcao === 'falta',
      dinheiroRelatorio, valorDeposito: typeof valorDeposito === 'number' ? valorDeposito : null, diferenca: item.diferenca,
      porFormaDePagamento: [item],
      porOperadoraTag,
    };
  }

  if (anexo.tipo !== 'maquininha') {
    // Sem comprovante nenhum anexado: ainda assim lista dinheiro/cartão/Pix
    // do relatório, só que todos 'sem_comprovante' — é o que permite a
    // mensagem final mostrar "dinheiro: R$X (sem comprovante para conferir)"
    // em vez de omitir a seção inteira.
    const cartaoRelatorio = formasLegiveis ? (somarClassificados(formas, 'cartao') || 0) : (r.recebidoCartao ?? null);
    const pixRelatorio = formasLegiveis ? somarClassificados(formas, 'pix') : null;
    return {
      status: 'sem_referencia',
      motivo: 'nenhum comprovante (maquininha ou depósito) anexado nesta foto.',
      porFormaDePagamento: [
        montarItem('dinheiro', dinheiroRelatorio, null, toleranciaPercentual),
        montarItem('cartao', cartaoRelatorio, null, toleranciaPercentual),
        montarItem('pix', pixRelatorio, null, toleranciaPercentual),
      ],
      porOperadoraTag,
    };
  }

  const m = anexo.maquininha || {};

  // Total NÃO-DINHEIRO do relatório (cartão + outra forma + pix somados),
  // preferindo a soma da tabela de formas (mais granular) e caindo nos
  // campos-resumo só quando ela não veio legível por inteiro. Só usado para
  // o total agregado (compatibilidade/diagnóstico) — o "status final" da
  // mensagem usa os itens por forma abaixo, não este total.
  let naoDinheiroRelatorio = null;
  if (formasLegiveis) {
    const dinheiro = somarClassificados(formas, 'dinheiro') || 0;
    const totalFormas = round2(formas.reduce((acc, f) => acc + f.valor, 0));
    naoDinheiroRelatorio = round2(totalFormas - dinheiro);
  } else if ([r.valorFaturado, r.recebidoDinheiro].every((v) => typeof v === 'number')) {
    naoDinheiroRelatorio = round2(r.valorFaturado - r.recebidoDinheiro);
  }

  // Cartão e Pix do relatório: soma da tabela quando legível por inteiro,
  // senão cai no campo-resumo (só existe para cartão; Pix não tem campo
  // resumo próprio no #1 Park).
  const cartaoRelatorio = formasLegiveis ? (somarClassificados(formas, 'cartao') || 0) : (r.recebidoCartao ?? null);
  const pixRelatorio = formasLegiveis ? (somarClassificados(formas, 'pix') || 0) : null;
  const cartaoMaquininha = (typeof m.debitoTotal === 'number' && typeof m.creditoTotal === 'number')
    ? round2(m.debitoTotal + m.creditoTotal) : null;

  const porFormaDePagamento = [
    // Maquininha não processa dinheiro — sempre 'sem_comprovante' (ou
    // 'sem_dado' se nem o relatório informou), nunca comparado.
    montarItem('dinheiro', dinheiroRelatorio, null, toleranciaPercentual),
    montarItem('cartao', cartaoRelatorio, cartaoMaquininha, toleranciaPercentual),
    montarItem('pix', pixRelatorio, typeof m.pixTotal === 'number' ? m.pixTotal : null, toleranciaPercentual),
  ];

  const itemTotal = (naoDinheiroRelatorio !== null && typeof m.totalGeral === 'number')
    ? montarItem('total_nao_dinheiro', naoDinheiroRelatorio, m.totalGeral, toleranciaPercentual) : null;
  const totalDivergente = Boolean(itemTotal && (itemTotal.direcao === 'sobra' || itemTotal.direcao === 'falta'));
  const algumaDivergente = totalDivergente || porFormaDePagamento.some((i) => i.direcao === 'sobra' || i.direcao === 'falta');
  const algumaComparavel = (itemTotal && itemTotal.direcao === 'ok') || porFormaDePagamento.some((i) => i.direcao === 'ok');

  return {
    status: algumaDivergente ? 'a_conferir' : algumaComparavel ? 'dentro_do_esperado' : 'sem_referencia',
    // Diz se foi o TOTAL que estourou a tolerância, ou só alguma forma
    // isolada (caso real: total dentro da tolerância por coincidência,
    // cartão sobrando e Pix faltando se cancelando no agregado) — sem isso
    // a mensagem para o usuário citaria "o total diverge" quando na
    // verdade ele estava normal.
    totalDivergente,
    naoDinheiroRelatorio,
    totalGeralMaquininha: typeof m.totalGeral === 'number' ? m.totalGeral : null,
    diferenca: itemTotal ? itemTotal.diferenca : null,
    porFormaDePagamento,
    porOperadoraTag,
  };
}

module.exports = {
  conferirFechamentoInterno,
  conferirMaquininha,
  classificarForma,
  classificarOperadoraTag,
  OPERADORAS_TAG,
  TOLERANCIA_CENTAVOS,
  TOLERANCIA_MAQUININHA_PADRAO,
};
