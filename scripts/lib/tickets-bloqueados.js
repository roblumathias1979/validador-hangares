/**
 * tickets-bloqueados.js — ticket tentado em pátio CHEIO fica travado até alguém
 * da administração liberar.
 *
 * POR QUE
 * Pátio cheio significa que não há vaga — e se não há vaga, o carro daquele
 * ticket provavelmente não está ali. A tentativa pode ser honesta (a pessoa
 * chegou e não achou lugar), mas é também o formato exato de uma fraude:
 * validar um ticket de um veículo que não está no hangar, ou tentar num pátio e
 * depois em outro até achar um com espaço.
 *
 * O sistema não sabe distinguir os dois casos, e não deveria fingir que sabe.
 * Ele para e chama gente. Caso real que motivou isto: uma tentativa no Hangar
 * Aristek com o pátio cheio, em 18/09/2026.
 *
 * O BLOQUEIO É GLOBAL, não do pátio onde aconteceu. Travar só ali deixaria
 * aberto justamente o movimento suspeito — tentar no pátio seguinte.
 *
 * NÃO EXPIRA sozinho. Um bloqueio que vence sozinho é um bloqueio que o
 * paciente vence esperando, e a decisão aqui é de gente: ou a administração
 * libera, ou o ticket segue travado.
 */

const path = require('path');
const { comTrava, salvarAtomico, lerJson } = require('./trava-arquivo');

const ARQUIVO = path.join(__dirname, '..', '..', 'data', 'tickets-bloqueados.json');

/**
 * Trava o ticket. Se já estiver travado, mantém o registro ORIGINAL e apenas
 * soma a tentativa — quem investiga precisa saber quantas vezes tentaram e
 * onde, e sobrescrever apagaria justamente o padrão que denuncia.
 */
function bloquear(ticket, { hangarId, hangarNome, grupoId, remetente, vagasDisponiveis } = {}) {
  if (!ticket) return null;
  return comTrava(ARQUIVO, () => {
    const todos = lerJson(ARQUIVO, {});
    const agora = new Date().toISOString();
    const anterior = todos[ticket];

    const registro = anterior && !anterior.autorizadoEm
      ? { ...anterior, tentativas: [...(anterior.tentativas || []), { em: agora, hangarId, hangarNome, remetente, vagasDisponiveis }] }
      : {
        ticket,
        bloqueadoEm: agora,
        motivo: 'tentativa em pátio cheio',
        hangarId, hangarNome, grupoId,
        autorizadoEm: null, autorizadoPor: null,
        tentativas: [{ em: agora, hangarId, hangarNome, remetente, vagasDisponiveis }],
      };

    todos[ticket] = registro;
    salvarAtomico(ARQUIVO, todos);
    return registro;
  });
}

/** Devolve o registro se o ticket estiver travado AGORA, ou null. */
function estaBloqueado(ticket) {
  if (!ticket) return null;
  const r = lerJson(ARQUIVO, {})[ticket];
  return r && !r.autorizadoEm ? r : null;
}

/**
 * Libera o ticket. O registro NÃO é apagado — fica com quem autorizou e
 * quando. Apagar seria perder a única prova de que o caso existiu, justamente
 * nos que alguém decidiu liberar.
 */
function autorizar(ticket, quem) {
  return comTrava(ARQUIVO, () => {
    const todos = lerJson(ARQUIVO, {});
    const r = todos[ticket];
    if (!r) throw new Error(`Ticket ${ticket} não está na lista de bloqueados.`);
    if (r.autorizadoEm) throw new Error(`Ticket ${ticket} já foi autorizado em ${r.autorizadoEm}.`);
    r.autorizadoEm = new Date().toISOString();
    r.autorizadoPor = quem || 'desconhecido';
    salvarAtomico(ARQUIVO, todos);
    return r;
  });
}

/**
 * Nega a liberação. O ticket segue travado, mas com a decisão registrada —
 * diferente de simplesmente não responder, que deixa o caso em aberto para
 * sempre sem ninguém saber se foi analisado.
 */
function manterBloqueado(ticket, quem) {
  return comTrava(ARQUIVO, () => {
    const todos = lerJson(ARQUIVO, {});
    const r = todos[ticket];
    if (!r) throw new Error(`Ticket ${ticket} não está na lista de bloqueados.`);
    if (r.autorizadoEm) throw new Error(`Ticket ${ticket} já foi autorizado em ${r.autorizadoEm}.`);
    r.negadoEm = new Date().toISOString();
    r.negadoPor = quem || 'desconhecido';
    salvarAtomico(ARQUIVO, todos);
    return r;
  });
}

/**
 * O bloqueio mais recente que ainda espera decisão.
 *
 * Serve à resposta sem número: quem recebeu o aviso agora e responde "sim"
 * está falando do caso que acabou de chegar. A confirmação sempre diz QUAL
 * ticket foi afetado, para um engano aparecer na hora.
 */
function maisRecenteAguardando() {
  return listar({ apenasAtivos: true })[0] || null;
}

/** `apenasAtivos` traz só os que ainda esperam decisão. */
function listar({ apenasAtivos = false } = {}) {
  const todos = Object.values(lerJson(ARQUIVO, {}));
  const lista = apenasAtivos ? todos.filter((r) => !r.autorizadoEm) : todos;
  return lista.sort((a, b) => String(b.bloqueadoEm).localeCompare(String(a.bloqueadoEm)));
}

function mensagemParaCliente(ticket) {
  return `⚠️ O ticket ${ticket} foi tentado em um pátio *sem vagas disponíveis*.\n\n`
    + 'Por segurança ele ficou *bloqueado* e o caso foi passado para o administrador. '
    + 'A validação só sai depois da autorização dele.';
}

module.exports = { bloquear, estaBloqueado, autorizar, manterBloqueado, maisRecenteAguardando, listar, mensagemParaCliente, ARQUIVO };
