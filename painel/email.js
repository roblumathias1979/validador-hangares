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

const nodemailer = require('nodemailer');

function configurado() {
  return Boolean(process.env.SMTP_HOST && process.env.SMTP_USUARIO && process.env.SMTP_SENHA);
}

function transporte() {
  const porta = Number(process.env.SMTP_PORTA) || 587;
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: porta,
    // secure=false + requireTLS: conecta em claro e SOBE para TLS com STARTTLS,
    // que é como a porta 587 funciona. `secure: true` seria para a 465, que
    // está bloqueada aqui.
    secure: false,
    requireTLS: true,
    auth: { user: process.env.SMTP_USUARIO, pass: process.env.SMTP_SENHA },
    connectionTimeout: 15000,
    greetingTimeout: 15000,
  });
}

async function enviar({ para, assunto, texto }) {
  if (!configurado()) throw new Error('SMTP não configurado no .env (SMTP_HOST, SMTP_USUARIO, SMTP_SENHA).');
  const remetente = process.env.SMTP_REMETENTE || process.env.SMTP_USUARIO;
  const info = await transporte().sendMail({ from: remetente, to: para, subject: assunto, text: texto });
  return { id: info.messageId, aceito: info.accepted };
}

/**
 * Verifica a configuração sem mandar mensagem — usado pelo painel para dizer
 * se a recuperação de senha está funcional, em vez de descobrir só quando
 * alguém precisar dela.
 */
async function testar() {
  if (!configurado()) return { ok: false, erro: 'SMTP não configurado no .env.' };
  try {
    await transporte().verify();
    return { ok: true };
  } catch (e) {
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

module.exports = { enviar, testar, configurado, textoRecuperacao };
