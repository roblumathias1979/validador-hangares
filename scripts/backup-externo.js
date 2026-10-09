#!/usr/bin/env node
/**
 * backup-externo.js — cópia CIFRADA do que só existe no servidor, enviada para
 * FORA da AWS (o grupo de administração do WhatsApp).
 *
 * Por que existe: o código está no GitHub, mas o `.env` (chaves e senhas), a
 * pasta `data/` (histórico, cotas, pendências) e o workflow do n8n vivem só na
 * máquina. O snapshot do disco protege de um erro, mas mora na MESMA conta da
 * AWS — se a conta for suspensa (o plano gratuito acaba), ele vai junto. Esta
 * cópia é o que permite recriar o servidor.
 *
 * O que entra: .env, config/, data/, o workflow do n8n (exportado) e os arquivos
 * pequenos da Evolution (~/evolution/.env e docker-compose.yaml). O arquivo
 * sai CIFRADO (AES-256, senha em ~/.backup-passphrase): o `.env` tem chave de
 * API e senhas, e `data/` tem nome e telefone de cliente.
 *
 *   node scripts/backup-externo.js --criar-senha   gera a senha (uma vez; ela aparece SÓ aqui)
 *   node scripts/backup-externo.js                 faz o backup e envia ao grupo
 *   node scripts/backup-externo.js --sem-enviar    faz só a cópia local
 *
 * Roda todo mês (dia 1) por systemd timer (infra/backup-externo.timer). Sai com 0.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const MANTER = 8; // cópias guardadas no servidor (8 meses)
const LIMITE_ENVIO = 60 * 1024 * 1024; // acima disso o WhatsApp recusa: fica só no servidor

const CIFRA = ['enc', '-aes-256-cbc', '-pbkdf2', '-iter', '200000', '-salt'];

/** Arquivos que entram no backup: {base, rel} (para `tar -C base rel`). Só os que existem. */
function itensDoBackup(raiz, home, extras = []) {
  const candidatos = [
    { base: raiz, rel: '.env' },
    { base: raiz, rel: 'config' },
    { base: raiz, rel: 'data' },
    { base: home, rel: 'evolution/.env' },
    { base: home, rel: 'evolution/docker-compose.yaml' },
    ...extras,
  ];
  return candidatos.filter((i) => fs.existsSync(path.join(i.base, i.rel)));
}

function nomeDoBackup(data = new Date()) {
  return `validador-${data.toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' })}.bak`;
}

/** Guarda só os `manter` mais recentes. Devolve os removidos. */
function rotacionar(destino, manter = MANTER) {
  const todos = fs.readdirSync(destino).filter((f) => /^validador-\d{4}-\d{2}-\d{2}\.bak$/.test(f)).sort();
  const sobra = todos.slice(0, Math.max(0, todos.length - manter));
  for (const f of sobra) fs.unlinkSync(path.join(destino, f));
  return sobra;
}

/** Cria a senha (uma vez). Nunca sobrescreve: trocar a senha deixaria os backups antigos ilegíveis. */
function criarSenha(arquivo) {
  if (fs.existsSync(arquivo)) return null;
  const senha = crypto.randomBytes(24).toString('base64url');
  fs.writeFileSync(arquivo, `${senha}\n`, { mode: 0o600 });
  return senha;
}

/** Exporta o workflow do n8n para uma pasta temporária (sem segredo nenhum). */
function exportarN8n(raiz, tmp) {
  try {
    const saida = path.join(tmp, 'n8n-workflows.json');
    execFileSync('n8n', ['export:workflow', '--all', '--pretty', `--output=${saida}`], {
      env: { ...process.env, N8N_USER_FOLDER: path.join(raiz, 'n8n', 'data') }, timeout: 60000, stdio: 'ignore',
    });
    return fs.existsSync(saida) ? { base: tmp, rel: 'n8n-workflows.json' } : null;
  } catch (e) { return null; }
}

/** tar | openssl > arquivo. Resolve com {arquivo, bytes, itens}. */
function gerarBackup({ raiz = RAIZ, home = os.homedir(), destino, senhaArquivo, extras = [], data = new Date() }) {
  return new Promise((resolve, reject) => {
    if (!fs.existsSync(senhaArquivo)) return reject(new Error('sem senha: rode "node scripts/backup-externo.js --criar-senha" uma vez'));
    fs.mkdirSync(destino, { recursive: true, mode: 0o700 });
    const itens = itensDoBackup(raiz, home, extras);
    if (!itens.length) return reject(new Error('nada para copiar'));
    const arquivo = path.join(destino, nomeDoBackup(data));

    const args = ['-czf', '-', '--exclude=*.log', '--exclude=node_modules'];
    for (const i of itens) args.push('-C', i.base, i.rel);
    const tar = spawn('tar', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const ssl = spawn('openssl', [...CIFRA, '-pass', `file:${senhaArquivo}`], { stdio: ['pipe', 'pipe', 'pipe'] });
    const saida = fs.createWriteStream(arquivo, { mode: 0o600 });
    tar.stdout.pipe(ssl.stdin);
    ssl.stdout.pipe(saida);

    let erro = '';
    tar.stderr.on('data', (d) => { erro += d; });
    ssl.stderr.on('data', (d) => { erro += d; });
    const codigos = {};
    const fim = () => {
      if (codigos.tar === undefined || codigos.ssl === undefined || !codigos.saida) return;
      if (codigos.tar !== 0 || codigos.ssl !== 0) {
        try { fs.unlinkSync(arquivo); } catch (e) { /* ok */ }
        return reject(new Error(`falhou (tar ${codigos.tar}, openssl ${codigos.ssl}): ${erro.slice(0, 200)}`));
      }
      resolve({ arquivo, bytes: fs.statSync(arquivo).size, itens: itens.map((i) => i.rel) });
    };
    tar.on('close', (c) => { codigos.tar = c; fim(); });
    ssl.on('close', (c) => { codigos.ssl = c; fim(); });
    saida.on('close', () => { codigos.saida = true; fim(); });
    tar.on('error', reject); ssl.on('error', reject);
  });
}

const mb = (b) => `${(b / 1024 / 1024).toFixed(1).replace('.', ',')} MB`;

async function main() {
  require('dotenv').config({ path: path.join(RAIZ, '.env'), override: true });
  const senhaArquivo = path.join(os.homedir(), '.backup-passphrase');
  const destino = path.join(os.homedir(), 'backups');
  const args = process.argv.slice(2);

  if (args.includes('--criar-senha')) {
    const senha = criarSenha(senhaArquivo);
    if (!senha) { console.log('Já existe uma senha (não sobrescrevo: os backups antigos ficariam ilegíveis).'); return; }
    console.log('\nSENHA DO BACKUP (guarde AGORA num gerenciador de senhas; ela não aparece de novo):\n');
    console.log(`    ${senha}\n`);
    console.log('Sem ela os backups não abrem. Se o servidor for perdido, ela só existe com você.');
    return;
  }

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bkp-'));
  let r;
  try {
    const extra = exportarN8n(RAIZ, tmp);
    r = await gerarBackup({ destino, senhaArquivo, extras: extra ? [extra] : [] });
  } catch (e) {
    console.log(JSON.stringify({ status: 'erro', mensagem: e.message }));
    await avisar(`⚠️ O backup mensal do servidor *falhou*: ${e.message}\nChame o suporte técnico.`).catch(() => {});
    return;
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  const removidos = rotacionar(destino);

  let enviadoA = 0;
  let motivo = null;
  if (args.includes('--sem-enviar')) motivo = 'envio desligado (--sem-enviar)';
  else if (r.bytes > LIMITE_ENVIO) motivo = `grande demais para o WhatsApp (${mb(r.bytes)})`;
  else {
    const { carregarConfig } = require('./lib/hangar');
    const { enviarDocumento } = require('./lib/evolution');
    const b64 = fs.readFileSync(r.arquivo).toString('base64');
    const legenda = `💾 *Backup mensal do servidor* — ${mb(r.bytes)}\n\n`
      + 'Guarde este arquivo (ele vem CIFRADO). Para abrir é preciso a *senha do backup*, que está com o dono do sistema. '
      + 'Não apague as mensagens com backup: se o servidor for perdido, é daqui que ele é recriado.';
    for (const destinoZap of (carregarConfig().adminsWhatsapp || []).map((x) => String(x || '').trim()).filter(Boolean)) {
      try { await enviarDocumento(destinoZap, b64, { nomeArquivo: path.basename(r.arquivo), mimetype: 'application/octet-stream', legenda }); enviadoA += 1; } catch (e) { motivo = `falha ao enviar: ${e.message}`; }
    }
    if (!enviadoA && !motivo) motivo = 'nenhum grupo de administração configurado';
  }
  if (motivo && !enviadoA) await avisar(`⚠️ Backup mensal feito (${mb(r.bytes)}), mas *não foi enviado*: ${motivo}.\nA cópia está só no servidor.`).catch(() => {});

  console.log(JSON.stringify({ status: 'ok', arquivo: r.arquivo, tamanho: mb(r.bytes), itens: r.itens, enviadoA, motivo, removidos }));
}

async function avisar(texto) {
  const { carregarConfig } = require('./lib/hangar');
  const { enviarTexto } = require('./lib/evolution');
  for (const d of (carregarConfig().adminsWhatsapp || []).map((x) => String(x || '').trim()).filter(Boolean)) await enviarTexto(d, texto);
}

if (require.main === module) {
  main().catch((e) => console.log(JSON.stringify({ status: 'erro', mensagem: e.message }))).then(() => process.exit(0));
}

module.exports = { itensDoBackup, nomeDoBackup, rotacionar, criarSenha, gerarBackup, CIFRA };
