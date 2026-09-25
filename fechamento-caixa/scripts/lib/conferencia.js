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

// Rótulos vistos até agora: MAQ. CARTAO, MASTER Credito, MASTER Debito, VISA
// Credito, Outros Cartões (-> cartao); DINHEIRO (-> dinheiro); PIX/QR CODE
// (-> pix, não visto ainda no #1 Park mas existe na maquininha); SEMPARAR,
// A Faturar, convênios (-> outra, nem cartão nem dinheiro nem pix).
function classificarForma(forma) {
  const f = normalizar(forma);
  if (/dinheiro/.test(f)) return 'dinheiro';
  if (/\bpix\b|qr\s*code/.test(f)) return 'pix';
  if (/cart|visa|master|maestro|\belo\b|amex|hiper/.test(f)) return 'cartao';
  return 'outra';
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
 */
function montarItem(forma, valorRelatorio, valorComprovante, toleranciaPercentual) {
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
 * `porFormaDePagamento` sempre traz um item por forma comparável (cartão e
 * pix, quando a maquininha os informa), cada um com `direcao`
 * ('sobra'/'falta'/'ok') — é o detalhe que aponta ONDE está a diferença,
 * mesmo quando o total sozinho pareceria normal.
 */
function conferirMaquininha(relatorio, documentoAnexo, { toleranciaPercentual = TOLERANCIA_MAQUININHA_PADRAO } = {}) {
  const anexo = documentoAnexo || {};
  const r = relatorio || {};

  if (anexo.tipo === 'deposito_bancario') {
    const valor = (anexo.deposito || {}).valor;
    if (typeof valor !== 'number') {
      return { status: 'sem_referencia', motivo: 'envelope de depósito anexado, mas sem valor escrito/legível para comparar.', porFormaDePagamento: [] };
    }
    // Comparação de depósito de DINHEIRO é contra o dinheiro do relatório,
    // não contra o total geral (que inclui cartão/outra forma).
    const dinheiroRelatorio = r.recebidoDinheiro ?? r.dinheiroCaixa;
    if (typeof dinheiroRelatorio !== 'number') {
      return { status: 'sem_referencia', motivo: 'relatório não informa o valor em dinheiro para comparar com o depósito.', porFormaDePagamento: [] };
    }
    const item = montarItem('dinheiro', dinheiroRelatorio, valor, toleranciaPercentual);
    return {
      status: item.direcao === 'ok' ? 'dentro_do_esperado' : 'a_conferir',
      totalDivergente: item.direcao !== 'ok',
      dinheiroRelatorio, valorDeposito: valor, diferenca: item.diferenca,
      porFormaDePagamento: [item],
    };
  }

  if (anexo.tipo !== 'maquininha') {
    return { status: 'sem_referencia', motivo: 'nenhum comprovante (maquininha ou depósito) anexado nesta foto.', porFormaDePagamento: [] };
  }

  const m = anexo.maquininha || {};
  if (typeof m.totalGeral !== 'number') {
    return { status: 'sem_referencia', motivo: 'resumo da maquininha anexado, mas sem "Total Geral" legível.', porFormaDePagamento: [] };
  }

  const formas = Array.isArray(r.formasDePagamento) ? r.formasDePagamento : [];
  const formasLegiveis = formas.length > 0 && formas.every((f) => typeof f.valor === 'number');

  // Total NÃO-DINHEIRO do relatório (cartão + outra forma + pix somados),
  // preferindo a soma da tabela de formas (mais granular) e caindo nos
  // campos-resumo só quando ela não veio legível por inteiro.
  let naoDinheiroRelatorio = null;
  if (formasLegiveis) {
    const dinheiro = somarClassificados(formas, 'dinheiro') || 0;
    const totalFormas = round2(formas.reduce((acc, f) => acc + f.valor, 0));
    naoDinheiroRelatorio = round2(totalFormas - dinheiro);
  } else if ([r.valorFaturado, r.recebidoDinheiro].every((v) => typeof v === 'number')) {
    naoDinheiroRelatorio = round2(r.valorFaturado - r.recebidoDinheiro);
  }

  // Quebra por forma, só possível com a tabela legível por inteiro — sem
  // isso não dá para separar quanto é cartão e quanto é "outra forma"
  // (convênio) dentro do total.
  const porFormaDePagamento = [];
  if (formasLegiveis) {
    if (typeof m.debitoTotal === 'number' && typeof m.creditoTotal === 'number') {
      const cartaoRelatorio = somarClassificados(formas, 'cartao') || 0;
      porFormaDePagamento.push(montarItem('cartao', cartaoRelatorio, round2(m.debitoTotal + m.creditoTotal), toleranciaPercentual));
    }
    if (typeof m.pixTotal === 'number') {
      // Ausência de linha de Pix no relatório NÃO é "sem dado" — é "zero
      // declarado", e comparar contra zero é o que revela o valor faltando.
      const pixRelatorio = somarClassificados(formas, 'pix') || 0;
      porFormaDePagamento.push(montarItem('pix', pixRelatorio, m.pixTotal, toleranciaPercentual));
    }
  }

  if (naoDinheiroRelatorio === null && porFormaDePagamento.length === 0) {
    return { status: 'sem_referencia', motivo: 'faltam valores do relatório para comparar com a maquininha.', porFormaDePagamento: [] };
  }

  const itemTotal = naoDinheiroRelatorio !== null ? montarItem('total_nao_dinheiro', naoDinheiroRelatorio, m.totalGeral, toleranciaPercentual) : null;
  const totalDivergente = Boolean(itemTotal && itemTotal.direcao !== 'ok');
  const algumaDivergente = totalDivergente || porFormaDePagamento.some((i) => i.direcao !== 'ok');

  return {
    status: algumaDivergente ? 'a_conferir' : 'dentro_do_esperado',
    // Diz se foi o TOTAL que estourou a tolerância, ou só alguma forma
    // isolada (caso real: total dentro da tolerância por coincidência,
    // cartão sobrando e Pix faltando se cancelando no agregado) — sem isso
    // a mensagem para o usuário citaria "o total diverge" quando na
    // verdade ele estava normal.
    totalDivergente,
    naoDinheiroRelatorio,
    totalGeralMaquininha: m.totalGeral,
    diferenca: itemTotal ? itemTotal.diferenca : null,
    porFormaDePagamento,
  };
}

module.exports = {
  conferirFechamentoInterno,
  conferirMaquininha,
  classificarForma,
  TOLERANCIA_CENTAVOS,
  TOLERANCIA_MAQUININHA_PADRAO,
};
