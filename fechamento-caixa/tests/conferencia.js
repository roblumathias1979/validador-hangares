#!/usr/bin/env node
/**
 * Fixtures com os números de TRÊS fotos reais de relatórios de fechamento
 * (Hotel Nacional Inn Poços de Caldas, Hotel Ibis Styles, Argentina Mall —
 * 25/09/2026), não dados inventados. Servem para travar o comportamento
 * observado nelas: a matemática interna dessas três fecha (mesmo com uma
 * linha ilegível no Ibis Styles), e a comparação com a maquininha diverge
 * no relatório PARCIAL do Argentina Mall — de propósito, porque o período do
 * resumo da maquininha (dia inteiro) não corresponde ao período do caixa
 * ainda aberto. É por isso que o veredito geral nunca fecha em
 * "inconsistente" — só "a_conferir" para uma pessoa decidir.
 *
 * O caso do Hotel Nacional é o mais importante dos três: o TOTAL sozinho
 * parecia normal (diferença de 3,25%, dentro da tolerância), mas a quebra
 * por forma de pagamento revela que isso era coincidência — tinha R$60 de
 * cartão a mais E R$160 de Pix a menos, e as duas diferenças quase se
 * cancelavam no agregado. Sem abrir por forma, essa divergência de Pix
 * passaria batida.
 */

const path = require('path');
const { conferirFechamentoInterno, conferirMaquininha, classificarForma, classificarOperadoraTag } = require(path.join(__dirname, '..', 'scripts', 'lib', 'conferencia'));

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  if (ok) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

console.log('classificarForma reconhece os rótulos vistos nas fotos reais');
{
  conferir('MAQ. CARTAO -> cartao', classificarForma('MAQ. CARTAO') === 'cartao');
  conferir('MASTER Credito -> cartao', classificarForma('MASTER Credito') === 'cartao');
  conferir('VISA Credito -> cartao', classificarForma('VISA Credito') === 'cartao');
  conferir('DINHEIRO -> dinheiro', classificarForma('DINHEIRO') === 'dinheiro');
  conferir('SEMPARAR -> tag (operadora de pedágio/estacionamento, não "outra")', classificarForma('SEMPARAR') === 'tag');
  conferir('A Faturar -> outra', classificarForma('A Faturar') === 'outra');
  conferir('QR CODE/Pix -> pix', classificarForma('QR CODE - Pix') === 'pix');
}

console.log('\nclassificarOperadoraTag discrimina qual operadora é (Sem Parar, Veloe, ConectCar)');
{
  conferir('SEMPARAR -> sem_parar', (classificarOperadoraTag('SEMPARAR') || {}).id === 'sem_parar');
  conferir('Veloe -> veloe', (classificarOperadoraTag('Veloe') || {}).id === 'veloe');
  conferir('ConectCar -> conectcar', (classificarOperadoraTag('ConectCar') || {}).id === 'conectcar');
  conferir('MAQ. CARTAO -> não é operadora de tag', classificarOperadoraTag('MAQ. CARTAO') === null);
}

console.log('\nHotel Nacional Inn Poços de Caldas (fechamento nº 358)');
{
  const relatorio = {
    situacao: 'fechado',
    valorFaturado: 1220, recebidoCartao: 1130, recebidoDinheiro: 30, recebidoOutraForma: 60,
    formasDePagamento: [
      { forma: 'A Faturar', valor: 60 },
      { forma: 'MAQ. CARTAO', valor: 1130 },
      { forma: 'DINHEIRO', valor: 30 },
    ],
  };
  const documentoAnexo = { tipo: 'maquininha', maquininha: { provedor: 'pagvendas', totalGeral: 1230, debitoTotal: 410, creditoTotal: 660, pixTotal: 160 } };

  const interna = conferirFechamentoInterno(relatorio);
  conferir('resumo (cartão+dinheiro+outra) bate com valor faturado', interna.checagens.resumoVsFaturado.status === 'consistente', JSON.stringify(interna.checagens.resumoVsFaturado));
  conferir('soma das formas de pagamento bate com valor faturado', interna.checagens.formasVsFaturado.status === 'consistente');
  conferir('interna geral consistente', interna.status === 'consistente', interna.status);

  const maq = conferirMaquininha(relatorio, documentoAnexo);
  conferir('total sozinho pareceria normal (3,25%, dentro da tolerância)', maq.diferenca === -40, maq.diferenca);
  conferir(
    'MAS a quebra por forma acusa a_conferir — cartão sobrando e Pix faltando se cancelavam no total',
    maq.status === 'a_conferir',
    JSON.stringify(maq)
  );
  const cartao = maq.porFormaDePagamento.find((i) => i.forma === 'cartao');
  const pix = maq.porFormaDePagamento.find((i) => i.forma === 'pix');
  conferir('cartão do relatório (1130) sobra 60 sobre a maquininha (1070 = débito+crédito)', cartao.direcao === 'sobra' && cartao.diferenca === 60, JSON.stringify(cartao));
  conferir('Pix não aparece em NENHUMA linha do relatório, mas a maquininha processou 160 -> falta 160', pix.direcao === 'falta' && pix.diferenca === -160, JSON.stringify(pix));
}

console.log('\nHotel Ibis Styles (fechamento nº 216) — uma linha da tabela ilegível');
{
  const relatorio = {
    situacao: 'fechado',
    valorFaturado: 290, recebidoCartao: 230, recebidoDinheiro: 20, recebidoOutraForma: 40,
    formasDePagamento: [
      { forma: 'MAQ. CARTAO', valor: 80 },
      { forma: 'DINHEIRO', valor: 20 },
      { forma: 'MASTER Credito', valor: 40 },
      { forma: 'MASTER Debito', valor: 20 },
      { forma: 'SEMPARAR', valor: 90 },
      { forma: 'VISA Credito', valor: null }, // valor cortado/ilegível na foto
    ],
  };
  const documentoAnexo = { tipo: 'deposito_bancario', deposito: { banco: 'Santander', valor: null } };

  const interna = conferirFechamentoInterno(relatorio);
  conferir('resumo bate com valor faturado', interna.checagens.resumoVsFaturado.status === 'consistente');
  conferir('soma das formas fica indeterminada (linha ilegível não vira falso positivo)', interna.checagens.formasVsFaturado.status === 'indeterminada', interna.checagens.formasVsFaturado.motivo);
  conferir('interna geral consistente (o que deu para conferir bateu)', interna.status === 'consistente', interna.status);

  const maq = conferirMaquininha(relatorio, documentoAnexo);
  conferir('depósito sem valor escrito -> sem_referencia, não bloqueia', maq.status === 'sem_referencia', maq.motivo);
  conferir(
    'SEMPARAR (90) discriminado em porOperadoraTag, não escondido em "outra"',
    maq.porOperadoraTag.length === 1 && maq.porOperadoraTag[0].operadora === 'sem_parar' && maq.porOperadoraTag[0].valor === 90,
    JSON.stringify(maq.porOperadoraTag)
  );
}

console.log('\nArgentina Mall (fechamento nº 4, PARCIAL — caixa ainda aberto)');
{
  const relatorio = {
    situacao: 'parcial',
    valorFaturado: 234,
    formasDePagamento: [
      { forma: 'Dinheiro', valor: 52 },
      { forma: 'MASTER Credito', valor: 50 },
      { forma: 'MASTER Debito', valor: 76 },
      { forma: 'Outros Cartões', valor: 48 },
      { forma: 'VISA Credito', valor: 8 },
    ],
  };
  const documentoAnexo = { tipo: 'maquininha', maquininha: { provedor: 'pagvendas', totalGeral: 404, debitoTotal: 132, creditoTotal: 116, pixTotal: 156 } };

  const interna = conferirFechamentoInterno(relatorio);
  conferir('sem os campos de resumo -> indeterminada (não existe nesse relatório parcial)', interna.checagens.resumoVsFaturado.status === 'indeterminada');
  conferir('soma das formas bate com valor faturado parcial', interna.checagens.formasVsFaturado.status === 'consistente', JSON.stringify(interna.checagens.formasVsFaturado));

  const maq = conferirMaquininha(relatorio, documentoAnexo);
  conferir(
    'maquininha cobre o DIA INTEIRO, caixa parcial só cobre parte -> a_conferir, não "erro"',
    maq.status === 'a_conferir',
    JSON.stringify(maq)
  );
  const cartao = maq.porFormaDePagamento.find((i) => i.forma === 'cartao');
  const pix = maq.porFormaDePagamento.find((i) => i.forma === 'pix');
  conferir('cartão do parcial (182) falta contra a maquininha do dia inteiro (248)', cartao.direcao === 'falta', JSON.stringify(cartao));
  conferir('Pix também falta (relatório parcial não tem essa linha ainda)', pix.direcao === 'falta', JSON.stringify(pix));
}

console.log('\nCaso sintético: tudo bate por forma de pagamento -> dentro do esperado, sem itens divergentes');
{
  const relatorio = {
    situacao: 'fechado',
    valorFaturado: 1300, recebidoDinheiro: 100,
    formasDePagamento: [
      { forma: 'MAQ. CARTAO', valor: 1000 },
      { forma: 'PIX', valor: 200 },
      { forma: 'DINHEIRO', valor: 100 },
    ],
  };
  const documentoAnexo = { tipo: 'maquininha', maquininha: { totalGeral: 1200, debitoTotal: 600, creditoTotal: 400, pixTotal: 200 } };
  const maq = conferirMaquininha(relatorio, documentoAnexo);
  conferir('status dentro do esperado', maq.status === 'dentro_do_esperado', JSON.stringify(maq));
  conferir(
    'nenhum item SOBRA/FALTA (dinheiro fica sem_comprovante, de propósito — maquininha não processa dinheiro)',
    maq.porFormaDePagamento.every((i) => i.direcao !== 'sobra' && i.direcao !== 'falta'),
    JSON.stringify(maq.porFormaDePagamento)
  );
  const dinheiro = maq.porFormaDePagamento.find((i) => i.forma === 'dinheiro');
  conferir('dinheiro sempre presente no status final, mesmo sem comprovante para ele', dinheiro.direcao === 'sem_comprovante', JSON.stringify(dinheiro));
}

console.log('\nCaso sintético: erro real de matemática é apontado (não é um dos exemplos reais)');
{
  const relatorio = {
    situacao: 'fechado',
    valorFaturado: 200, recebidoCartao: 100, recebidoDinheiro: 50, recebidoOutraForma: 0,
    formasDePagamento: [{ forma: 'MAQ. CARTAO', valor: 100 }, { forma: 'DINHEIRO', valor: 50 }],
  };
  const interna = conferirFechamentoInterno(relatorio);
  conferir('resumo não bate -> inconsistente', interna.checagens.resumoVsFaturado.status === 'inconsistente');
  conferir('diferença correta', interna.checagens.resumoVsFaturado.diferenca === 50, interna.checagens.resumoVsFaturado.diferenca);
  conferir('interna geral inconsistente', interna.status === 'inconsistente', interna.status);
}

console.log('\nSem documento anexado nenhum -> maquininha sem_referencia, nunca bloqueia');
{
  const maq = conferirMaquininha({ valorFaturado: 100, recebidoDinheiro: 10 }, { tipo: 'nenhum' });
  conferir('sem_referencia', maq.status === 'sem_referencia', maq.status);
  conferir(
    'ainda assim lista dinheiro/cartão/pix (todos sem_comprovante), para a mensagem final não sumir com a seção',
    maq.porFormaDePagamento.length === 3 && maq.porFormaDePagamento.every((i) => i.direcao === 'sem_comprovante' || i.direcao === 'sem_dado'),
    JSON.stringify(maq.porFormaDePagamento)
  );
}

console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
process.exit(falhas ? 1 : 0);
