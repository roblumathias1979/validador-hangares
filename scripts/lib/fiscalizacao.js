/**
 * fiscalizacao.js — a placa lida na rua está regular?
 *
 * A REGRA (definida pelo usuário em 28/09/2026)
 * A rua em volta dos hangares é concessão da 1Park. Credenciado de hangar e
 * ticket validado por hangar valem DENTRO do hangar; na rua, só é regular o
 * veículo de um pátio MENSALISTA (hoje Solojet e Alljet), que paga vagas na rua
 * à 1Park. Essas vagas já foram somadas às vagas do pátio no TECHPARKING, então
 * a pergunta vira: o pátio do veículo é mensalista e está dentro da lotação?
 *
 * A regularidade é POR PÁTIO, não por veículo. Se o Solojet tem 90 vagas e
 * está com 95, não há como saber quais são os 5 "a mais": o resultado é
 * "excedido", e a conversa é com o hangar.
 *
 * DE ONDE VEM O VÍNCULO PLACA → PÁTIO
 * Do TECHPARKING, a API local do aeroporto (ver coletor-aeroporto/). Cada
 * vínculo guarda a FONTE da placa, porque a confiança varia muito:
 *   - digitada: placa informada na validação do ticket. Metade é AAA0000 (a
 *     genérica do nosso bot) ou inventada ("JULI123").
 *   - cadastro: campo PLACA do credenciado. Hoje vem vazio em todos.
 *   - nome: placa escrita dentro do nome do credenciado ("PLANE ONIX GCG9175").
 *     Quebra-galho, mas é o que existe.
 *   - lpr: câmera da cancela. Ainda não instalada; quando entrar, é só mais uma
 *     fonte, e a mais confiável.
 *
 * Funções puras: recebem o snapshot e as regras, não leem disco. O servidor
 * cuida de guardar e carregar.
 */

const { extrairPlaca } = require('./whatsapp');

const FONTES = {
  lpr: 'lida na cancela',
  cadastro: 'cadastro do credenciado',
  digitada: 'digitada na validação',
  nome: 'tirada do nome do credenciado',
};

const REGEX_PLACA = /^[A-Z]{3}(\d{4}|\d[A-Z]\d{2})$/;

/** Maiúscula, sem hífen ou espaço. Null se não for placa brasileira válida. */
function normalizarPlaca(texto) {
  const p = String(texto || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  return REGEX_PLACA.test(p) ? p : null;
}

/**
 * Chave de comparação que iguala a placa antiga à sua versão Mercosul.
 *
 * Na conversão oficial, o 2º dígito vira letra (0→A, 1→B … 9→J): ABC1234 passa
 * a ser ABC1C34. O veículo emplacado de novo carrega a Mercosul, mas quem
 * validou pode ter digitado a antiga, ou o contrário. Isto NÃO é "consertar"
 * leitura (O↔0), que o extrairPlaca recusa de propósito: é uma equivalência
 * exata e documentada, sem chance de trocar a placa de uma pessoa pela de outra.
 */
function chavePlaca(placa) {
  const p = normalizarPlaca(placa);
  if (!p) return null;
  const quinta = p[4];
  return /[A-J]/.test(quinta) ? p.slice(0, 4) + (quinta.charCodeAt(0) - 65) + p.slice(5) : p;
}

/**
 * Nome de pátio comparável. O TECHPARKING escreve o mesmo pátio de jeitos
 * diferentes em cada rota: "HANGAR SOLOJET " (com espaço no fim) no pátio,
 * "Hangar-1" no credenciado contra "HANGAR-1" na lista de pátios.
 */
function chavePatio(nome) {
  return String(nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/**
 * Datas do TECHPARKING chegam sem fuso ("2026-09-28T14:53:30") e são hora de
 * Jundiaí. O servidor roda em UTC, então interpretar sem fuso erraria 3 horas
 * e marcaria como vencido um ticket válido. Brasília não tem horário de verão
 * desde 2019, então -03:00 fixo é exato.
 */
function lerData(texto) {
  if (!texto) return null;
  const s = String(texto).trim();
  const d = new Date(/[zZ]|[+-]\d{2}:?\d{2}$/.test(s) ? s : `${s}-03:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * Monta o índice placa → vínculos e a lotação de cada pátio, a partir do
 * snapshot que o coletor manda. Feito uma vez por snapshot, não por consulta:
 * a câmera consulta várias vezes por minuto.
 */
function montarIndice(snapshot, regras) {
  const genericas = new Set((regras.placasGenericas || []).map(normalizarPlaca).filter(Boolean));
  const vinculos = new Map();
  const lotacao = new Map();
  const estatisticas = { tickets: 0, ticketsFantasma: 0, ticketsComPlaca: 0, ticketsPlacaGenerica: 0, ticketsPlacaInvalida: 0, credenciados: 0, credenciadosComPlaca: 0 };
  const patioPorId = new Map((snapshot.patios || []).map((p) => [String(p.IDPATIO), String(p.PATIO || '').trim()]));

  // TICKET FANTASMA: o TECHPARKING não registra a saída de todo veículo (data_sai
  // vem vazio em todos). Em 29/09/2026, dos 371 tickets "no pátio", 137 tinham
  // entrado antes de setembro, e um em set/2025. Contados, eles fariam o pátio
  // parecer excedido sem estar. Tolerância vencida há mais de N dias sai da
  // lotação; o vínculo com a placa fica, e a câmera diz "ticket vencido".
  const referencia = lerData(snapshot.recebidoEm) || new Date();
  const corteFantasma = new Date(referencia.getTime() - (regras.ticketFantasmaDias ?? 7) * 86400000);

  const adicionar = (placa, vinculo) => {
    const chave = chavePlaca(placa);
    if (!vinculos.has(chave)) vinculos.set(chave, []);
    vinculos.get(chave).push({ placa, ...vinculo });
  };
  const ocupar = (patio) => {
    const chave = chavePatio(patio);
    if (!chave) return;
    const l = lotacao.get(chave) || { nome: String(patio).trim(), vagas: null, ocupadas: 0 };
    l.ocupadas += 1;
    lotacao.set(chave, l);
  };

  for (const p of snapshot.patios || []) {
    const chave = chavePatio(p.PATIO);
    if (!chave) continue;
    const l = lotacao.get(chave) || { nome: String(p.PATIO).trim(), vagas: null, ocupadas: 0 };
    // VAGAS_USADAS da mesma rota está quebrado (-30, 2383 de 90 vagas, visto
    // em 28/09/2026). Só o total de vagas é aproveitado; a ocupação é contada
    // a partir das listas.
    l.nome = String(p.PATIO).trim();
    l.vagas = Number.isFinite(Number(p.VAGAS)) ? Number(p.VAGAS) : null;
    lotacao.set(chave, l);
  }

  for (const a of snapshot.avulsos || []) {
    estatisticas.tickets += 1;
    const usuario = String(a.USUARIO || '').trim();
    // "AVULSO" é o ticket ainda sem validação: não pertence a pátio nenhum.
    const validado = usuario !== '' && chavePatio(usuario) !== 'AVULSO';
    // O código do pátio, quando vem (rota por pátio), vence o nome: o nome do
    // hangar que validou nem sempre é escrito igual ao do pátio.
    const patio = validado ? (patioPorId.get(String(a.IDPATIO)) || usuario) : null;
    const tolerancia = lerData(a.TOLERANCIA);
    if (tolerancia && tolerancia < corteFantasma) estatisticas.ticketsFantasma += 1;
    else if (patio) ocupar(patio);

    const texto = String(a.PLACA || '').trim();
    if (!texto) continue;
    const placa = normalizarPlaca(texto);
    if (!placa) { estatisticas.ticketsPlacaInvalida += 1; continue; }
    if (genericas.has(placa)) { estatisticas.ticketsPlacaGenerica += 1; continue; }
    estatisticas.ticketsComPlaca += 1;
    adicionar(placa, {
      tipo: 'ticket',
      fonte: a.PLACA_LPR ? 'lpr' : 'digitada',
      patio,
      cartao: a.CARTAO || null,
      entrada: a.DATA_ENT || null,
      tolerancia: a.TOLERANCIA || null,
    });
  }

  for (const c of snapshot.credenciados || []) {
    estatisticas.credenciados += 1;
    const patio = String(c.BOLSAO || c.GRUPO || '').trim();
    ocupar(patio);

    let placa = normalizarPlaca(c.PLACA);
    let fonte = c.PLACA_LPR ? 'lpr' : 'cadastro';
    if (!placa) {
      placa = extrairPlaca(c.USUARIO);
      fonte = 'nome';
    }
    if (!placa) continue;
    estatisticas.credenciadosComPlaca += 1;
    adicionar(placa, { tipo: 'credenciado', fonte, patio: patio || null, cartao: c.CARTAO || null, entrada: c.DATAHORA || null });
  }

  const mensalistas = new Set((regras.patiosMensalistas || []).map(chavePatio));
  return { vinculos, lotacao, mensalistas, estatisticas, coletadoEm: snapshot.coletadoEm || null, recebidoEm: snapshot.recebidoEm || null };
}

function lotacaoDe(indice, patio) {
  const l = indice.lotacao.get(chavePatio(patio));
  if (!l) return null;
  return { nome: l.nome, vagas: l.vagas, ocupadas: l.ocupadas, excedeu: l.vagas !== null && l.ocupadas > l.vagas };
}

/**
 * Situação de uma placa. Devolve:
 *   regular      — pátio mensalista dentro da lotação
 *   excedido     — pátio mensalista acima da lotação
 *   irregular    — ligado a pátio não mensalista, ticket vencido ou rotativo
 *   sem_vinculo  — não achamos a placa em lugar nenhum. Enquanto os
 *                  credenciados não tiverem placa cadastrada (ou LPR), isso
 *                  não prova irregularidade: a tela pede para conferir.
 *   placa_invalida
 */
function avaliar(placaLida, indice, regras, agora = new Date()) {
  const placa = normalizarPlaca(placaLida);
  const base = { placa, dados: idadeDados(indice, regras, agora) };
  if (!placa) return { ...base, situacao: 'placa_invalida' };

  const todos = (indice.vinculos.get(chavePlaca(placa)) || []).map((v) => {
    const tolerancia = lerData(v.tolerancia);
    const vencido = v.tipo === 'ticket' && tolerancia !== null && tolerancia < agora;
    return { ...v, fonteDescricao: FONTES[v.fonte] || v.fonte, vencido };
  });
  const ativos = todos.filter((v) => v.patio && !v.vencido);
  const ehMensalista = (v) => indice.mensalistas.has(chavePatio(v.patio));

  const mensalista = ativos.find(ehMensalista);
  if (mensalista) {
    const lotacao = lotacaoDe(indice, mensalista.patio);
    return {
      ...base,
      situacao: lotacao && lotacao.excedeu ? 'excedido' : 'regular',
      patio: mensalista.patio,
      lotacao,
      vinculos: todos,
    };
  }

  const outroPatio = ativos.find((v) => !ehMensalista(v));
  if (outroPatio) return { ...base, situacao: 'irregular', motivo: 'fora_do_hangar', patio: outroPatio.patio, vinculos: todos };

  // Só o validado "vence" no sentido que interessa; o rotativo é irregular na
  // rua com ou sem tolerância, e dizer "rotativo" explica melhor.
  const vencido = todos.find((v) => v.vencido && v.patio);
  if (vencido) return { ...base, situacao: 'irregular', motivo: 'ticket_vencido', patio: vencido.patio, vinculos: todos };

  if (todos.some((v) => v.tipo === 'ticket' && !v.patio)) {
    return { ...base, situacao: 'irregular', motivo: 'rotativo', vinculos: todos };
  }

  return { ...base, situacao: 'sem_vinculo', vinculos: todos };
}

/** Quão velho está o snapshot. A tela avisa quando o coletor para de mandar. */
function idadeDados(indice, regras, agora) {
  const recebido = indice.recebidoEm ? new Date(indice.recebidoEm) : null;
  if (!recebido || Number.isNaN(recebido.getTime())) return { recebidoEm: null, minutos: null, velho: true };
  const minutos = Math.floor((agora - recebido) / 60000);
  return { recebidoEm: indice.recebidoEm, minutos, velho: minutos > (regras.snapshotVelhoMinutos || 5) };
}

module.exports = { normalizarPlaca, chavePlaca, chavePatio, lerData, montarIndice, avaliar, lotacaoDe, FONTES };
