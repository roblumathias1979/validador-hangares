/**
 * recuperacao.js — "esqueci minha senha" do painel.
 *
 * As senhas são guardadas com scrypt e não há como recuperá-las — por desenho.
 * O que este módulo faz é provar que a pessoa controla o e-mail cadastrado e,
 * com isso, deixar que ela defina uma senha nova.
 *
 * DECISÕES DE SEGURANÇA, E O PORQUÊ DE CADA UMA
 *
 * 1. A resposta é SEMPRE a mesma, exista ou não a conta. Se dissesse "usuário
 *    não encontrado", qualquer um poderia descobrir quem tem acesso ao painel
 *    testando nomes — e o painel está na internet aberta.
 *
 * 2. O token é guardado como HASH, não em texto. Quem conseguir ler o arquivo
 *    de tokens não consegue usá-los. É a mesma razão de não guardar senha.
 *
 * 3. Uso único e prazo curto (30 min). Um link de redefinição que continua
 *    valendo é uma senha paralela — e ele viaja por e-mail, que fica em caixa
 *    de entrada, backup e log de servidor.
 *
 * 4. Limite de pedidos por conta. Sem isso, o endereço público vira um jeito
 *    de encher a caixa de e-mail de alguém, usando o nosso servidor.
 */

const crypto = require('crypto');
const path = require('path');
const { comTrava, salvarAtomico, lerJson } = require('../scripts/lib/trava-arquivo');

const ARQUIVO = path.join(__dirname, '..', 'data', 'recuperacoes.json');

const VALIDADE_MS = 30 * 60 * 1000;
// No máximo 3 pedidos por conta a cada 30 minutos.
const MAX_PEDIDOS = 3;

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function ler() {
  const d = lerJson(ARQUIVO, { pedidos: [] });
  return Array.isArray(d.pedidos) ? d : { pedidos: [] };
}

function vigentes(pedidos, agora = Date.now()) {
  return pedidos.filter((p) => !p.usadoEm && new Date(p.expiraEm).getTime() > agora);
}

/**
 * Cria um pedido e devolve o token em texto — a ÚNICA vez que ele existe em
 * claro. Quem chama manda por e-mail e descarta; nada o registra.
 * Devolve null se a conta estourou o limite de pedidos.
 */
function criar(nomeUsuario) {
  return comTrava(ARQUIVO, () => {
    const agora = Date.now();
    const d = ler();
    // Aproveita para descartar o que venceu: sem isto o arquivo cresceria para
    // sempre com tokens mortos.
    d.pedidos = d.pedidos.filter((p) => new Date(p.expiraEm).getTime() > agora - VALIDADE_MS);

    const recentes = d.pedidos.filter(
      (p) => p.usuario === nomeUsuario && new Date(p.criadoEm).getTime() > agora - VALIDADE_MS
    );
    if (recentes.length >= MAX_PEDIDOS) return null;

    const token = crypto.randomBytes(32).toString('hex');
    d.pedidos.push({
      usuario: nomeUsuario,
      tokenHash: hashToken(token),
      criadoEm: new Date(agora).toISOString(),
      expiraEm: new Date(agora + VALIDADE_MS).toISOString(),
      usadoEm: null,
    });
    salvarAtomico(ARQUIVO, d);
    return token;
  });
}

/**
 * Consome o token: valida e marca como usado na MESMA trava. Separar as duas
 * coisas permitiria usar o mesmo link duas vezes em chamadas simultâneas.
 * Devolve o nome do usuário ou null.
 */
function consumir(token) {
  if (!token || typeof token !== 'string') return null;
  return comTrava(ARQUIVO, () => {
    const agora = Date.now();
    const d = ler();
    const alvo = vigentes(d.pedidos, agora).find((p) => p.tokenHash === hashToken(token));
    if (!alvo) return null;
    alvo.usadoEm = new Date(agora).toISOString();
    salvarAtomico(ARQUIVO, d);
    return alvo.usuario;
  });
}

function pendentes() {
  return vigentes(ler().pedidos).length;
}

module.exports = { criar, consumir, pendentes, VALIDADE_MS, MAX_PEDIDOS };
