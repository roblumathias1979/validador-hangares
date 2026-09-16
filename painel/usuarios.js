/**
 * usuarios.js — contas de acesso ao painel.
 *
 * Substitui a senha única compartilhada. A diferença prática: dá para tirar o
 * acesso de uma pessoa sem trocar a senha de todo mundo, e o log mostra QUEM
 * fez cada coisa em vez de "alguém com a senha".
 *
 * ONDE FICA: data/usuarios.json, que está no .gitignore — é dado operacional
 * com hash de senha, não configuração. Nunca vai para o repositório.
 *
 * COMO A SENHA É GUARDADA: scrypt com sal aleatório por usuário, do módulo
 * crypto do próprio Node — sem dependência nova. A senha em texto puro nunca é
 * gravada nem registrada em log. Quem esquecer, troca; não há como recuperar.
 *
 * PERFIL: além de administrador, existe "somente leitura". O painel edita cota
 * e prazo, que têm efeito financeiro — nem todo mundo que precisa consultar o
 * histórico precisa poder mexer nisso.
 */

const crypto = require('crypto');
const path = require('path');
const { comTrava, salvarAtomico, lerJson } = require('../scripts/lib/trava-arquivo');

const ARQUIVO = path.join(__dirname, '..', 'data', 'usuarios.json');

const MIN_SENHA = 10;
// Bloqueio por tentativas. Em memória de propósito: reinício do serviço limpa,
// e isso é aceitável — o objetivo é frear ataque automatizado, não manter
// histórico. Persistir exigiria escrita a cada tentativa errada, o que por sua
// vez vira um jeito de encher o disco de fora.
const MAX_TENTATIVAS = 5;
const BLOQUEIO_MS = 15 * 60 * 1000;
const tentativas = new Map();

function gerarHash(senha, sal = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(senha, sal, 64).toString('hex');
  return { sal, hash };
}

function conferirHash(senha, registro) {
  if (!registro || !registro.sal || !registro.hash) return false;
  const a = Buffer.from(crypto.scryptSync(senha, registro.sal, 64).toString('hex'));
  const b = Buffer.from(registro.hash);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function ler() {
  const d = lerJson(ARQUIVO, { usuarios: [] });
  return Array.isArray(d.usuarios) ? d : { usuarios: [] };
}

function validarEmail(email) {
  const e = String(email || '').trim().toLowerCase();
  if (e === '') return '';
  // Validação deliberadamente simples: o que prova o endereço é o e-mail
  // chegar, não o formato casar com um regex elaborado.
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(e)) throw new Error('E-mail inválido.');
  return e;
}

function listar() {
  // Nunca devolve sal nem hash: esta lista vai para a tela.
  return ler().usuarios.map((u) => ({
    nome: u.nome,
    email: u.email || '',
    somenteLeitura: u.somenteLeitura === true,
    criadoEm: u.criadoEm,
    ultimoAcesso: u.ultimoAcesso || null,
  }));
}

function existeAlgum() {
  return ler().usuarios.length > 0;
}

function validarNome(nome) {
  const n = String(nome || '').trim().toLowerCase();
  if (!/^[a-z0-9._-]{3,32}$/.test(n)) {
    throw new Error('Nome de usuário: 3 a 32 caracteres, apenas letras, números, ponto, hífen e sublinhado.');
  }
  return n;
}

function validarSenha(senha) {
  const s = String(senha || '');
  if (s.length < MIN_SENHA) throw new Error(`Senha precisa de pelo menos ${MIN_SENHA} caracteres.`);
  return s;
}

function criar({ nome, senha, email = '', somenteLeitura = false }) {
  const n = validarNome(nome);
  const s = validarSenha(senha);
  const e = validarEmail(email);
  return comTrava(ARQUIVO, () => {
    const d = ler();
    if (d.usuarios.some((u) => u.nome === n)) throw new Error(`Usuário "${n}" já existe.`);
    d.usuarios.push({ nome: n, email: e, ...gerarHash(s), somenteLeitura: somenteLeitura === true, criadoEm: new Date().toISOString() });
    salvarAtomico(ARQUIVO, d);
    return { nome: n, email: e, somenteLeitura: somenteLeitura === true };
  });
}

function trocarSenha(nome, senha) {
  const n = validarNome(nome);
  const s = validarSenha(senha);
  return comTrava(ARQUIVO, () => {
    const d = ler();
    const u = d.usuarios.find((x) => x.nome === n);
    if (!u) throw new Error(`Usuário "${n}" não existe.`);
    Object.assign(u, gerarHash(s));
    salvarAtomico(ARQUIVO, d);
    // Trocar a senha limpa o bloqueio: quem acabou de definir uma senha nova
    // não deve ficar preso por tentativas antigas.
    tentativas.delete(n);
    return { nome: n };
  });
}

function remover(nome) {
  const n = validarNome(nome);
  return comTrava(ARQUIVO, () => {
    const d = ler();
    const antes = d.usuarios.length;
    // Remover o último usuário trancaria todo mundo para fora, e a única saída
    // seria mexer no arquivo por SSH. Melhor recusar.
    if (antes <= 1) throw new Error('Não dá para remover o último usuário — o painel ficaria inacessível.');
    d.usuarios = d.usuarios.filter((u) => u.nome !== n);
    if (d.usuarios.length === antes) throw new Error(`Usuário "${n}" não existe.`);
    salvarAtomico(ARQUIVO, d);
    return { removido: n };
  });
}

function estaBloqueado(nome) {
  const t = tentativas.get(nome);
  if (!t) return false;
  if (Date.now() - t.desde > BLOQUEIO_MS) { tentativas.delete(nome); return false; }
  return t.falhas >= MAX_TENTATIVAS;
}

function registrarFalha(nome) {
  const t = tentativas.get(nome) || { falhas: 0, desde: Date.now() };
  if (Date.now() - t.desde > BLOQUEIO_MS) { t.falhas = 0; t.desde = Date.now(); }
  t.falhas += 1;
  tentativas.set(nome, t);
}

/**
 * Autentica. Devolve o usuário (sem hash) ou null.
 *
 * O bloqueio é por nome de usuário, não por IP: atrás do Caddy todo mundo chega
 * com o mesmo endereço, então bloquear por IP travaria todos de uma vez.
 */
function autenticar(nome, senha) {
  const n = String(nome || '').trim().toLowerCase();
  if (!n || estaBloqueado(n)) return null;

  const d = ler();
  const u = d.usuarios.find((x) => x.nome === n);
  if (!u || !conferirHash(senha, u)) {
    registrarFalha(n);
    return null;
  }

  tentativas.delete(n);
  // Marca o último acesso sem travar a resposta se a escrita falhar: saber a
  // data é útil, mas não ao ponto de derrubar o login.
  try {
    comTrava(ARQUIVO, () => {
      const atual = ler();
      const alvo = atual.usuarios.find((x) => x.nome === n);
      if (alvo) { alvo.ultimoAcesso = new Date().toISOString(); salvarAtomico(ARQUIVO, atual); }
    });
  } catch (e) { /* ignora */ }

  return { nome: u.nome, somenteLeitura: u.somenteLeitura === true };
}

/** Acha por nome OU e-mail — a pessoa que esqueceu a senha pode ter esquecido
 *  também qual dos dois cadastrou. */
function buscar(identificador) {
  const i = String(identificador || '').trim().toLowerCase();
  if (!i) return null;
  const u = ler().usuarios.find((x) => x.nome === i || (x.email || '').toLowerCase() === i);
  return u ? { nome: u.nome, email: u.email || '', somenteLeitura: u.somenteLeitura === true } : null;
}

function definirEmail(nome, email) {
  const n = validarNome(nome);
  const e = validarEmail(email);
  return comTrava(ARQUIVO, () => {
    const d = ler();
    const u = d.usuarios.find((x) => x.nome === n);
    if (!u) throw new Error(`Usuário "${n}" não existe.`);
    u.email = e;
    salvarAtomico(ARQUIVO, d);
    return { nome: n, email: e };
  });
}

module.exports = {
  listar, criar, trocarSenha, remover, autenticar, existeAlgum, buscar, definirEmail,
  estaBloqueado, MIN_SENHA, MAX_TENTATIVAS, ARQUIVO,
};
