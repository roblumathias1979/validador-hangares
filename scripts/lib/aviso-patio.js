/**
 * aviso-patio.js — alerta quando o pátio está ficando cheio.
 *
 * POR QUE ISSO IMPORTA
 * Validar um ticket ocupa uma vaga até o veículo sair. Quando as vagas acabam,
 * o bot recusa validar e manda o cliente ao totem — o que é correto, mas chega
 * como surpresa: ninguém viu o pátio encher. Avisar antes dá tempo de agir.
 *
 * ONDE O NÚMERO VEM
 * Da contagem que o ValidPark já mostra e que o sistema JÁ LÊ em duas
 * situações: antes de cada validação (é a proteção de pátio cheio) e no comando
 * "status do pátio". Nenhuma consulta extra é feita — abrir um Chromium por
 * hangar de tempos em tempos custaria caro numa máquina de 2 GB e não traria
 * nada que esses dois momentos já não tragam.
 *
 * QUANDO AVISA
 * Na TRAVESSIA do limite, não a cada leitura. Um pátio que fica horas com 3
 * vagas geraria uma enxurrada de mensagens idênticas, e a pessoa pararia de
 * ler. Reavisa a cada 6h enquanto continuar baixo, e avisa quando normaliza —
 * senão fica sem saber se ainda precisa agir.
 */

const path = require('path');
const { comTrava, salvarAtomico, lerJson } = require('./trava-arquivo');

const ARQUIVO = path.join(__dirname, '..', '..', 'data', 'aviso-patio.json');
// A cada 3 horas enquanto o pátio continuar no limite (definido pelo usuário em
// 16/09/2026; antes eram 6h). Com a varredura de 15 minutos, é isso que separa
// "lembrete" de "enxurrada": quem recebe a mesma mensagem de hora em hora para
// de ler, e aí o aviso deixa de funcionar justamente quando importa.
const REAVISO_MS = 3 * 3600 * 1000;

// Avisa a partir de 5 vagas livres — regra única para todos os hangares,
// definida pelo usuário em 16/09/2026.
//
// Substitui a regra anterior, de 10% do total com piso de 3, que tentava ser
// proporcional ao tamanho do pátio. Na prática o que importa não é a proporção
// e sim quantos carros ainda cabem: cinco vagas livres é pouco tempo de folga
// tanto no Solojet, de 90 vagas, quanto no AIBM 1, de 12.
const LIMITE_PADRAO = 5;

/**
 * Limite de vagas livres a partir do qual se avisa.
 *
 * `avisarVagasAbaixoDe` continua valendo por hangar, pelo painel, para quem
 * precisar de um número diferente do padrão. Nenhum hangar usa isso hoje.
 */
function limiteDe(hangar) {
  if (Number.isFinite(hangar.avisarVagasAbaixoDe)) return hangar.avisarVagasAbaixoDe;
  return LIMITE_PADRAO;
}

/**
 * Decide se há aviso a dar. Devolve null quando não há.
 *
 * `disponiveis` vem da leitura que já foi feita; se vier null (o site mudou o
 * texto, por exemplo), não inventa nada — sem número não há aviso.
 */
/**
 * `persistir: false` avalia SEM gravar — para simulações.
 *
 * Avaliar tem efeito colateral por natureza: marca que o hangar já foi avisado,
 * e é isso que impede a enxurrada de mensagens repetidas. Uma simulação que
 * grave esse marcador CONSOME o alerta — a varredura real seguinte acha que já
 * avisou e fica calada. Aconteceu em 16/09/2026: rodei `--simular` no Alljet
 * lotado, o timer entrou 90 segundos depois e o grupo não recebeu nada.
 */
function avaliar(hangar, disponiveis, total = null, { persistir = true } = {}) {
  if (!Number.isFinite(disponiveis)) return null;

  // Pátio com o aviso desligado não recebe nada — nem "quase cheio" nem
  // "lotado". Existe para os pátios PEQUENOS: com 2 ou 6 vagas no total,
  // qualquer limite deixa o alerta ligado quase sempre, e um aviso que toca
  // todo dia deixa de ser aviso (Aerie e EPEAC, 17/09/2026).
  //
  // O cliente continua sendo avisado quando o pátio lota DE VERDADE: a recusa
  // por falta de vaga vive em validate-ticket.js e não passa por aqui. O que se
  // desliga é o alerta preventivo ao grupo, não a informação que impede alguém
  // de esperar por uma validação que não vai sair.
  if (hangar.avisarPatioCheio === false) return null;

  const limite = limiteDe({ ...hangar, totalVagas: total ?? hangar.totalVagas });
  const baixo = disponiveis <= limite;

  return comTrava(ARQUIVO, () => {
    const estado = lerJson(ARQUIVO, {});
    const anterior = estado[hangar.id] || { baixo: false, avisadoEm: null };
    const agora = Date.now();

    const gravidade = disponiveis <= 0 ? 'lotado' : 'quase_cheio';

    let acao = null;
    if (baixo) {
      const primeiraVez = !anterior.baixo;
      const faz6h = anterior.avisadoEm && (agora - new Date(anterior.avisadoEm).getTime()) > REAVISO_MS;
      // Piorou de "quase cheio" para LOTADO: avisa mesmo já tendo avisado. É
      // uma mudança de situação, não repetição — a partir daí o bot passa a
      // recusar validações, e quem administra precisa saber na hora.
      const piorou = anterior.baixo && anterior.gravidade !== 'lotado' && gravidade === 'lotado';
      if (primeiraVez || piorou || faz6h) acao = gravidade;
    } else if (anterior.baixo) {
      acao = 'normalizou';
    }

    estado[hangar.id] = {
      baixo,
      gravidade: baixo ? gravidade : null,
      disponiveis,
      total: total ?? null,
      limite,
      // Só marca como avisado quando de fato houve aviso, para o reaviso de 6h
      // contar a partir da última mensagem e não da última leitura.
      avisadoEm: acao && acao !== 'normalizou' ? new Date(agora).toISOString() : (baixo ? anterior.avisadoEm : null),
      em: new Date(agora).toISOString(),
    };
    if (persistir) salvarAtomico(ARQUIVO, estado);

    if (!acao) return null;
    return { acao, disponiveis, total, limite, hangarId: hangar.id, hangarNome: hangar.hangar || hangar.id };
  });
}

/**
 * Mensagem do alerta. Vai para o GRUPO dos clientes (escolha do usuário em
 * 16/09/2026): quem está lá é quem chega com o carro, e saber que o pátio está
 * no limite muda o que a pessoa faz. O nome da função ficou de quando o destino
 * era o privado da administração.
 */
function mensagemAdmin(aviso) {
  if (aviso.acao === 'normalizou') {
    return `🟢 *${aviso.hangarNome}* — pátio normalizado: ${aviso.disponiveis} vagas livres.`;
  }
  if (aviso.acao === 'lotado') {
    return `🔴 *${aviso.hangarNome}* — PÁTIO LOTADO, sem vagas.\n`
      + 'O bot vai recusar novas validações e orientar os clientes ao totem de autopagamento.';
  }
  return `🟠 *${aviso.hangarNome}* — pátio quase cheio: restam *${aviso.disponiveis}*`
    + `${aviso.total ? ` de ${aviso.total}` : ''} vagas (aviso a partir de ${aviso.limite}).`;
}

/**
 * Frase acrescentada à resposta do cliente. Só quando está baixo e ainda há
 * vaga — se lotou, a mensagem de recusa já explica tudo e repetir confundiria.
 */
function notaParaCliente(disponiveis, limite, hangar = null) {
  if (hangar && hangar.avisarPatioCheio === false) return '';
  if (!Number.isFinite(disponiveis) || disponiveis > limite || disponiveis <= 0) return '';
  return `\n\n⚠️ Atenção: restam apenas ${disponiveis} vaga(s) no pátio.`;
}

module.exports = { avaliar, mensagemAdmin, notaParaCliente, limiteDe, REAVISO_MS, LIMITE_PADRAO };
