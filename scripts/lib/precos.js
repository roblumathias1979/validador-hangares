// Tabela de preços fornecida pelo usuário (11/09/2026), usada para calcular o
// valor a faturar quando um ticket está fora do prazo de 2h E a cota mensal
// de validações fora do prazo do hangar já acabou (ver scripts/lib/cota-fora-prazo.js).
//
// Regras confirmadas com o usuário:
// - 1ª hora: R$20 | 2ª hora: R$15 | demais horas: R$5 cada.
// - Acumulado por hora TRAVA em R$60 (valor da diária) — nunca cobra mais que
//   a diária dentro de um período de 24h (o acumulado bate R$60 exatamente
//   na 7ª hora: 20+15+5*5=60).
// - Acima de 24h: R$60 por diária completa + o restante calculado com a
//   mesma tabela/teto (ex: 30h = 1 diária de R$60 + 6h = R$55 → R$115).
// - Fração de hora arredonda para CIMA (padrão do setor).
const VALOR_PRIMEIRA_HORA = 20;
const VALOR_SEGUNDA_HORA = 15;
const VALOR_HORA_ADICIONAL = 5;
const VALOR_DIARIA = 60;
const HORAS_POR_DIARIA = 24;

// Valor de 1 até `horas` (no máximo 24) horas dentro de uma mesma diária,
// já aplicando o teto de R$60.
function valorAteUmaDiaria(horas) {
  let acumulado = 0;
  for (let h = 1; h <= horas; h += 1) {
    if (h === 1) acumulado += VALOR_PRIMEIRA_HORA;
    else if (h === 2) acumulado += VALOR_SEGUNDA_HORA;
    else acumulado += VALOR_HORA_ADICIONAL;
    if (acumulado >= VALOR_DIARIA) return VALOR_DIARIA;
  }
  return acumulado;
}

// `horasDecorridas` pode vir fracionado (ex: 2.08h) — arredonda pra cima
// antes de aplicar a tabela, então parcela em blocos de até 24h.
function calcularValorPermanencia(horasDecorridas) {
  if (!Number.isFinite(horasDecorridas) || horasDecorridas <= 0) return 0;

  let horasRestantes = Math.ceil(horasDecorridas);
  let total = 0;
  while (horasRestantes > 0) {
    const horasNestaDiaria = Math.min(horasRestantes, HORAS_POR_DIARIA);
    total += valorAteUmaDiaria(horasNestaDiaria);
    horasRestantes -= horasNestaDiaria;
  }
  return total;
}

function formatarReais(valor) {
  return valor.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

module.exports = { calcularValorPermanencia, formatarReais };
