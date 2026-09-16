/**
 * email.js — envio de e-mail do painel.
 *
 * Usa nodemailer, a primeira dependência do projeto além de dotenv e
 * playwright. Escrever um cliente SMTP à mão seriam ~120 linhas de protocolo,
 * STARTTLS, autenticação e codificação MIME — e um erro ali significa e-mail de
 * recuperação falhando em silêncio, justamente quando alguém está trancado para
 * fora.
 *
 * Porta 587 com STARTTLS, não 465: a saída na 465 está BLOQUEADA no EC2
 * (verificado em 16/09/2026 — dá timeout). A 587 responde.
 */

const path = require('path');
const nodemailer = require('nodemailer');
const { comTrava, salvarAtomico, lerJson } = require('../scripts/lib/trava-arquivo');

// Guardado em arquivo, não no .env, por um motivo prático: editar o .env exige
// um editor num terminal com TTY, o que nem sempre está disponível. Assim a
// senha é digitada num campo de senha do navegador, sobre HTTPS — não passa
// por chat nem fica no histórico do shell.
//
// data/ está no .gitignore: a senha do e-mail nunca vai para o repositório.
const ARQUIVO = path.join(__dirname, '..', 'data', 'smtp.json');

function lerConfig() {
  const a = lerJson(ARQUIVO, {});
  // O .env continua valendo como alternativa, para quem preferir configurar
  // por lá. O arquivo tem precedência por ser o caminho do painel.
  return {
    host: a.host || process.env.SMTP_HOST || '',
    porta: Number(a.porta || process.env.SMTP_PORTA) || 587,
    usuario: a.usuario || process.env.SMTP_USUARIO || '',
    senha: a.senha || process.env.SMTP_SENHA || '',
    remetente: a.remetente || process.env.SMTP_REMETENTE || a.usuario || process.env.SMTP_USUARIO || '',
  };
}

function salvarConfig({ host, porta, usuario, senha, remetente }) {
  return comTrava(ARQUIVO, () => {
    const atual = lerJson(ARQUIVO, {});
    const novo = {
      host: String(host || '').trim(),
      porta: Number(porta) || 587,
      usuario: String(usuario || '').trim(),
      // Senha vazia significa "manter a que já existe" — assim dá para corrigir
      // o remetente sem precisar redigitar a senha.
      senha: senha ? String(senha) : (atual.senha || ''),
      remetente: String(remetente || '').trim(),
    };
    salvarAtomico(ARQUIVO, novo);
    return true;
  });
}

/** Para a tela: tudo menos a senha, que nunca volta ao navegador. */
function configuracaoVisivel() {
  const c = lerConfig();
  return {
    host: c.host, porta: c.porta, usuario: c.usuario, remetente: c.remetente,
    temSenha: Boolean(c.senha),
  };
}

function configurado() {
  const c = lerConfig();
  return Boolean(c.host && c.usuario && c.senha);
}

function transporte() {
  const c = lerConfig();
  return nodemailer.createTransport({
    host: c.host,
    port: c.porta,
    // 465 usa TLS desde o primeiro byte; 587 conecta em claro e SOBE para TLS
    // com STARTTLS. Tratar os dois igual faz a conexão travar sem erro claro.
    //
    // ⚠️ Neste servidor a SAÍDA na 465 está BLOQUEADA (verificado em
    // 16/09/2026: email-ssl.com.br e smtp.email-ssl.com.br dão timeout na 465
    // e respondem na 587). Use 587.
    secure: c.porta === 465,
    requireTLS: c.porta !== 465,
    auth: { user: c.usuario, pass: c.senha },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
  });
}

async function enviar({ para, assunto, texto }) {
  if (!configurado()) throw new Error('E-mail não configurado — preencha servidor, usuário e senha no painel.');
  const remetente = lerConfig().remetente;
  const info = await transporte().sendMail({ from: remetente, to: para, subject: assunto, text: texto });
  return { id: info.messageId, aceito: info.accepted };
}

/**
 * Verifica a configuração sem mandar mensagem — usado pelo painel para dizer
 * se a recuperação de senha está funcional, em vez de descobrir só quando
 * alguém precisar dela.
 */
async function testar() {
  if (!configurado()) return { ok: false, erro: 'E-mail não configurado.' };
  const c = lerConfig();
  try {
    await transporte().verify();
    return { ok: true };
  } catch (e) {
    // "Greeting never received" na 465 é sempre a mesma coisa aqui, e a
    // mensagem crua não ajuda ninguém a resolver.
    if (c.porta === 465) {
      return {
        ok: false,
        erro: `${e.message} — a porta 465 está BLOQUEADA na saída deste servidor. `
          + 'Troque para 587, que é a porta de submissão e funciona (testado com este mesmo servidor de e-mail).',
      };
    }
    return { ok: false, erro: e.message };
  }
}

function textoRecuperacao({ nome, link, minutos }) {
  return [
    `Olá, ${nome}.`,
    '',
    'Recebemos um pedido para redefinir sua senha do Painel do Validador.',
    '',
    'Abra o endereço abaixo para escolher uma senha nova:',
    link,
    '',
    `O link vale por ${minutos} minutos e funciona uma única vez.`,
    '',
    'Se não foi você que pediu, ignore esta mensagem — sua senha continua a mesma.',
  ].join('\n');
}

module.exports = { enviar, testar, configurado, textoRecuperacao, lerConfig, salvarConfig, configuracaoVisivel };
