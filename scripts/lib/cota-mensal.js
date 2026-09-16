/**
 * cota-mensal.js — teto de validações por mês, para hangares com cota contratada.
 *
 * Diferente de `cota-fora-prazo.js`, que limita só as validações FORA DO PRAZO
 * (as que custam dinheiro por serem exceção). Aqui o teto é sobre TODAS as
 * validações do mês: é uma regra comercial do pátio, não uma exceção.
 *
 * Criado em 16/09/2026 para o VOASP, que pode validar 20 tickets por mês.
 *
 * DE ONDE VEM A CONTAGEM
 * Do próprio histórico (`data/validacoes.jsonl`), não de um contador à parte.
 *
 * Um contador separado seria mais rápido de ler, e é o que cota-fora-prazo.js
 * faz — mas seria uma SEGUNDA fonte para um número que o histórico já tem, e
 * este projeto já pagou caro por duplicar fonte de verdade (a tabela de grupos
 * no n8n, que ficou fora de sincronia e deixou produção quebrada por semanas).
 * Contador que diverge do histórico é pior que contador lento: ninguém sabe
 * qual dos dois está certo, e a discussão cai no colo de quem recebe a conta.
 *
 * FUSO
 * O mês é calculado em horário de São Paulo, não no do servidor (que roda em
 * UTC). Sem isso, das 21h do último dia do mês em diante o contador já teria
 * virado — e o hangar ganharia três horas de cota nova antes da hora.
 */

const registro = require('./registro');

const FUSO = 'America/Sao_Paulo';

/**
 * Competência atual no formato AAAA-MM, em horário de São Paulo.
 */
function mesAtual(quando = new Date()) {
  // 'en-CA' devolve AAAA-MM-DD, que é o formato ordenável que interessa aqui.
  return new Date(quando).toLocaleDateString('en-CA', { timeZone: FUSO }).slice(0, 7);
}

/**
 * Teto do hangar, ou null quando não há teto. A ausência do campo significa
 * SEM LIMITE de propósito: quinze dos dezesseis hangares não têm cota
 * contratada, e um padrão numérico aqui limitaria todos eles em silêncio.
 */
function limiteDe(hangar) {
  return Number.isFinite(hangar && hangar.cotaMensalValidacoes)
    ? hangar.cotaMensalValidacoes
    : null;
}

/**
 * Quantas validações o hangar já fez no mês corrente.
 * Conta só `validado`: tentativa recusada não consome cota de ninguém.
 */
function usoNoMes(hangarId, quando = new Date()) {
  const mes = mesAtual(quando);
  return registro
    .ultimos(Infinity, { hangarId, apenasValidados: true })
    .filter((l) => l.em && mesAtual(l.em) === mes)
    .length;
}

/**
 * Situação da cota. `limite: null` significa sem teto, e aí `esgotada` é sempre
 * falso — nunca se recusa por cota um hangar que não tem cota.
 */
function situacao(hangar, quando = new Date()) {
  const limite = limiteDe(hangar);
  if (limite === null) {
    return { temCota: false, limite: null, usadas: null, restantes: null, esgotada: false, mes: mesAtual(quando) };
  }
  const usadas = usoNoMes(hangar.id, quando);
  return {
    temCota: true,
    limite,
    usadas,
    restantes: Math.max(0, limite - usadas),
    esgotada: usadas >= limite,
    mes: mesAtual(quando),
  };
}

function mensagemEsgotada(hangar, s) {
  return `Este pátio já usou as *${s.limite} validações* do mês (${s.mes}).\n\n`
    + 'Não consigo validar mais tickets até o próximo mês. Para pagar, use o totem de '
    + 'autopagamento no terminal do aeroporto. Nossa equipe foi avisada.';
}

/**
 * Nota curta na confirmação, para o cliente acompanhar o consumo.
 *
 * Só aparece perto do fim. No começo do mês, "restam 18 de 20" é ruído numa
 * mensagem que a pessoa lê de passagem esperando só saber se validou.
 */
function notaParaCliente(s, avisarAPartirDe = 5) {
  if (!s.temCota || s.restantes === null || s.restantes > avisarAPartirDe) return '';
  if (s.restantes === 0) return `\n\n⚠️ Essa foi a última das ${s.limite} validações do mês.`;
  return `\n\n⚠️ Restam ${s.restantes} de ${s.limite} validações neste mês.`;
}

module.exports = { mesAtual, limiteDe, usoNoMes, situacao, mensagemEsgotada, notaParaCliente, FUSO };
