#!/usr/bin/env node
/**
 * Backup externo cifrado (09/10/2026). Protege: o que entra (só o que existe), a
 * CIFRA de verdade (segredo nunca aparece em claro; senha errada não abre; senha
 * certa devolve tudo), a senha (0600 e nunca sobrescrita), a rotação e o nome.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const bk = require(path.join(RAIZ, 'scripts', 'backup-externo.js'));

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teste-bkp-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ok */ } });
const SEGREDO = 'sk-ant-SEGREDO-NAO-PODE-APARECER-EM-CLARO';
const raiz = path.join(tmp, 'projeto'); const home = path.join(tmp, 'home');
fs.mkdirSync(path.join(raiz, 'data'), { recursive: true });
fs.mkdirSync(path.join(raiz, 'config'), { recursive: true });
fs.mkdirSync(path.join(home, 'evolution'), { recursive: true });
fs.writeFileSync(path.join(raiz, '.env'), `ANTHROPIC_API_KEY=${SEGREDO}\n`);
fs.writeFileSync(path.join(raiz, 'config', 'hangares.json'), '{"hangares":[]}');
fs.writeFileSync(path.join(raiz, 'data', 'validacoes.jsonl'), '{"cliente":"Maria 5511999990000"}\n');
fs.writeFileSync(path.join(raiz, 'data', 'painel.log'), 'ruido de log\n');
fs.writeFileSync(path.join(home, 'evolution', '.env'), 'AUTHENTICATION_API_KEY=chave-da-evolution\n');
const senhaArq = path.join(tmp, 'senha');
const destino = path.join(tmp, 'backups');

(async () => {
  console.log('1) Itens e nome');
  const itens = bk.itensDoBackup(raiz, home).map((i) => i.rel);
  conferir('inclui .env, config, data e os arquivos da Evolution que existem', ['.env', 'config', 'data', 'evolution/.env'].every((x) => itens.includes(x)), itens.join());
  conferir('ignora o que não existe (docker-compose da Evolution)', !itens.includes('evolution/docker-compose.yaml'));
  conferir('nome com a data de São Paulo', bk.nomeDoBackup(new Date('2026-10-09T15:00:00Z')) === 'validador-2026-10-09.bak');
  conferir('à meia-noite UTC ainda é o dia anterior em São Paulo', bk.nomeDoBackup(new Date('2026-10-10T01:00:00Z')) === 'validador-2026-10-09.bak');

  console.log('\n2) Senha');
  const s1 = bk.criarSenha(senhaArq);
  conferir('cria uma senha forte', typeof s1 === 'string' && s1.length >= 30);
  conferir('arquivo com permissão 0600', (fs.statSync(senhaArq).mode & 0o777) === 0o600, (fs.statSync(senhaArq).mode & 0o777).toString(8));
  conferir('NÃO sobrescreve (os backups antigos ficariam ilegíveis)', bk.criarSenha(senhaArq) === null && fs.readFileSync(senhaArq, 'utf-8').trim() === s1);

  console.log('\n3) Cifra de verdade');
  const r = await bk.gerarBackup({ raiz, home, destino, senhaArquivo: senhaArq, data: new Date('2026-10-09T15:00:00Z') });
  conferir('gera o arquivo', fs.existsSync(r.arquivo) && r.bytes > 0, r.arquivo);
  conferir('arquivo 0600', (fs.statSync(r.arquivo).mode & 0o777) === 0o600);
  const bruto = fs.readFileSync(r.arquivo);
  conferir('o segredo NÃO aparece em claro no arquivo', !bruto.includes(SEGREDO) && !bruto.includes('Maria') && !bruto.includes('5511999990000'));
  conferir('começa com o cabeçalho do openssl (Salted__)', bruto.slice(0, 8).toString() === 'Salted__');
  const abrir = (senha) => execFileSync('sh', ['-c', `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass pass:${senha} -in "${r.arquivo}" | tar tzf -`], { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
  const lista = abrir(s1);
  conferir('a senha certa devolve tudo', /\.env/.test(lista) && /config\/hangares\.json/.test(lista) && /data\/validacoes\.jsonl/.test(lista) && /evolution\/\.env/.test(lista), lista);
  conferir('logs ficam de fora', !/painel\.log/.test(lista));
  let abriu = true;
  try { abrir('senha-errada'); } catch (e) { abriu = false; }
  conferir('senha errada NÃO abre', abriu === false);
  const conteudo = execFileSync('sh', ['-c', `openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -pass pass:${s1} -in "${r.arquivo}" | tar xzOf - .env`], { encoding: 'utf-8' });
  conferir('o conteúdo restaurado é idêntico', conteudo.includes(SEGREDO));
  let semSenha = false;
  try { await bk.gerarBackup({ raiz, home, destino, senhaArquivo: path.join(tmp, 'nao-existe') }); } catch (e) { semSenha = /sem senha/.test(e.message); }
  conferir('sem senha criada: recusa e explica', semSenha);

  console.log('\n4) Rotação');
  for (let d = 1; d <= 10; d += 1) fs.writeFileSync(path.join(destino, `validador-2026-09-${String(d).padStart(2, '0')}.bak`), 'x');
  const removidos = bk.rotacionar(destino, 8);
  const sobraram = fs.readdirSync(destino).filter((f) => f.endsWith('.bak')).sort();
  conferir('guarda só as 8 mais recentes', sobraram.length === 8 && removidos.length === 3, `${sobraram.length} / ${removidos.length}`);
  conferir('apaga as mais antigas, não as novas', !sobraram.includes('validador-2026-09-01.bak') && sobraram.includes('validador-2026-10-09.bak'));
  fs.writeFileSync(path.join(destino, 'outro-arquivo.txt'), 'nao mexer');
  bk.rotacionar(destino, 1);
  conferir('não toca em arquivo que não é backup', fs.existsSync(path.join(destino, 'outro-arquivo.txt')));

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
  process.exit(falhas ? 1 : 0);
})();
