/**
 * registro.js — histórico do que o bot fez com cada ticket.
 *
 * Até 16/09/2026 isso não existia. A contagem de cota sabia QUANTAS validações
 * fora do prazo foram usadas, e o faturamento sabia o que foi cobrado, mas
 * nada guardava "o ticket X do hangar Y foi validado às Z com a placa W". Para
 * conferir qualquer coisa era preciso abrir as execuções do n8n — que são
 * expurgadas em 7 dias e não dá para consultar por hangar.
 *
 * FORMATO: JSONL (uma linha json por evento), não um array json.
 *
 * Um array exigiria ler o arquivo inteiro, alterar e reescrever a cada
 * validação — com dois processos concorrentes, perde evento. Acrescentar uma
 * linha é uma escrita só, e o sistema operacional garante atomicidade para
 * escritas pequenas em modo append. Também sobrevive melhor a uma queda no meio:
 * perde-se no máximo a última linha, não o arquivo todo.
 *
 * PRIVACIDADE: o registro guarda nome de quem enviou, placa e número do ticket.
 * É dado de cliente, então tem prazo de validade — as linhas antigas somem, na
 * mesma linha do expurgo de execuções do n8n configurado no systemd.
 */

const fs = require('fs');
const path = require('path');
const { comTrava } = require('./trava-arquivo');
const { normalizar } = require('./whatsapp');

const ARQUIVO = path.join(__dirname, '..', '..', 'data', 'validacoes.jsonl');

// 90 dias: longo o bastante para conferir uma cobrança contestada do mês
// anterior, curto o bastante para não virar um arquivo de dados de clientes
// acumulando para sempre.
const RETENCAO_DIAS = 90;
// Teto independente da idade, para o caso de um volume inesperado.
const MAX_LINHAS = 20000;

/**
 * Situações que valem registro. Ficam de fora as mensagens ignoradas — conversa
 * do grupo, mensagem do próprio bot, foto em conversa privada — que são a
 * maioria do tráfego e encheriam o histórico de ruído sem informação.
 */
function valeRegistrar(resultado) {
  if (!resultado || !resultado.status) return false;
  return resultado.status !== 'ignorado';
}

function registrar(resultado) {
  if (!valeRegistrar(resultado)) return null;

  const linha = {
    em: new Date().toISOString(),
    hangarId: resultado.hangarId || null,
    status: resultado.status,
    etapa: resultado.etapa || null,
    ticket: resultado.ticket || null,
    placa: resultado.placa || null,
    placaEhGenerica: resultado.placaEhGenerica === true,
    // Nome do cliente, carro ou placa, como o grupo quis identificar. É a única
    // informação aqui que o ValidPark não tem — o site só aceita placa no
    // formato dele, então é neste arquivo que ela existe.
    identificacao: resultado.identificacao || null,
    remetente: resultado.remetente || null,
    grupoId: resultado.grupoId || null,
    valor: resultado.valor ?? null,
    escalado: resultado.escalado === true,
    // Guardado para diferenciar "validou de graça" de "gastou cota do hangar",
    // que é a informação que falta quando alguém contesta a conta no fim do mês.
    usouCota: resultado.etapa === 'validacao_com_cota',
    // Conferência de local (só nos hangares que a exigem). Guardado mesmo
    // quando não bloqueia: "indeterminado" precisa ser auditável, senão não dá
    // para saber se a checagem antifraude está funcionando ou só passando tudo.
    local: resultado.local || null,
    localMotivo: resultado.localMotivo || null,
  };

  try {
    fs.mkdirSync(path.dirname(ARQUIVO), { recursive: true });
    fs.appendFileSync(ARQUIVO, `${JSON.stringify(linha)}\n`);
  } catch (erro) {
    // Falhar o registro NUNCA pode derrubar o fluxo: o ticket já foi validado,
    // e o cliente precisa da resposta mais do que nós do histórico.
    return { erro: erro.message };
  }
  return linha;
}

function lerLinhas() {
  try {
    return fs.readFileSync(ARQUIVO, 'utf-8')
      .split('\n')
      .filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch (e) { return null; } })
      .filter(Boolean);
  } catch (e) {
    return [];
  }
}

/**
 * Últimos eventos, do mais recente para o mais antigo.
 * `filtro.hangarId` limita a um hangar; `filtro.apenasValidados` às validações
 * que de fato aconteceram.
 */
function ultimos(limite = 50, filtro = {}) {
  let linhas = lerLinhas();
  if (filtro.hangarId) linhas = linhas.filter((l) => l.hangarId === filtro.hangarId);
  if (filtro.apenasValidados) linhas = linhas.filter((l) => l.status === 'validado');
  return linhas.slice(-limite).reverse();
}

/**
 * Este ticket já foi validado por nós? Devolve o registro da primeira vez.
 *
 * POR QUE ISTO EXISTE
 * Cada hangar tem seu próprio login no ValidPark, e cada login enxerga SÓ as
 * validações do próprio pátio — medido em 15/09/2026, sobreposição zero entre
 * as listas. Mas o número do ticket é global: quem gera é o servidor central do
 * aeroporto, e o mesmo papel serve em qualquer pátio.
 *
 * O resultado apareceu em 16/09/2026: o ticket 011609161628 foi validado no
 * Alljet às 19:25 e de novo no Hangar 1 às 19:36. Nenhum dos dois sites tinha
 * como saber do outro, e o carro não pode estar nos dois lugares.
 *
 * Também pega repetição no MESMO pátio — o ValidPark aceita revalidar e só
 * estende a tolerância, sem reclamar. Aconteceu com o 011609151252 no AIBM 2,
 * validado duas vezes com 15 minutos de diferença.
 *
 * LIMITE HONESTO: só enxerga o que ESTE sistema validou, a partir do dia em que
 * o histórico passou a existir. Validação feita à mão no site, ou anterior a
 * isso, é invisível daqui.
 */
function jaValidado(ticket) {
  if (!ticket) return null;
  for (const l of lerLinhas()) {
    if (l.status === 'validado' && l.ticket === ticket) return l;
  }
  return null;
}

/**
 * Procura no histórico daquele hangar por ticket, placa ou identificação.
 *
 * Só o hangar de quem perguntou, sempre. Quem está no grupo do Solojet não
 * pode descobrir a placa de um cliente do AIBM porque digitou o nome certo —
 * é a mesma regra do status do pátio, e aqui pesa mais, porque estes dados
 * trazem nome de pessoa.
 *
 * Busca por trecho, sem acento e sem diferenciar maiúsculas: quem digita
 * "joao" precisa encontrar "João da Silva". Devolve do mais recente para o
 * mais antigo, que é a ordem em que a resposta interessa.
 */
function procurar(hangarId, termo, limite = 5) {
  const alvo = normalizar(termo);
  if (!hangarId || !alvo) return [];
  return lerLinhas()
    .filter((l) => l.hangarId === hangarId)
    .filter((l) => [l.ticket, l.placa, l.identificacao].some((campo) => normalizar(campo).includes(alvo)))
    .slice(-limite)
    .reverse();
}

function resumoPorHangar() {
  const resumo = {};
  for (const l of lerLinhas()) {
    if (!l.hangarId) continue;
    const r = resumo[l.hangarId] || (resumo[l.hangarId] = { total: 0, validados: 0, comCota: 0, ultimo: null });
    r.total += 1;
    if (l.status === 'validado') r.validados += 1;
    if (l.usouCota) r.comCota += 1;
    if (!r.ultimo || l.em > r.ultimo) r.ultimo = l.em;
  }
  return resumo;
}

/**
 * Descarta o que passou da retenção. Roda sob trava porque reescreve o arquivo
 * inteiro — diferente do append, aqui a concorrência importa.
 */
function expurgar() {
  return comTrava(ARQUIVO, () => {
    const limite = new Date(Date.now() - RETENCAO_DIAS * 24 * 3600 * 1000).toISOString();
    const antes = lerLinhas();
    let depois = antes.filter((l) => (l.em || '') >= limite);
    if (depois.length > MAX_LINHAS) depois = depois.slice(-MAX_LINHAS);
    if (depois.length === antes.length) return { removidas: 0, restantes: antes.length };
    const temporario = `${ARQUIVO}.${process.pid}.tmp`;
    fs.writeFileSync(temporario, depois.map((l) => JSON.stringify(l)).join('\n') + (depois.length ? '\n' : ''));
    fs.renameSync(temporario, ARQUIVO);
    return { removidas: antes.length - depois.length, restantes: depois.length };
  });
}

module.exports = { registrar, ultimos, jaValidado, procurar, resumoPorHangar, expurgar, valeRegistrar, ARQUIVO, RETENCAO_DIAS };
