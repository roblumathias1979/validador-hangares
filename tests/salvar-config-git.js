#!/usr/bin/env node
/**
 * Salvar configuração com o GitHub andando (13/11/2026).
 *
 * O caso real: o painel/bot gravam no servidor e fazem push; enquanto isso a main
 * do GitHub recebe uma mesclagem. O push seguinte do servidor é RECUSADO, os
 * commits ficavam presos ("N alterações não enviadas") e o `git pull` falhava com
 * "divergent branches" — a mudança do AIBM nunca chegou. Aqui se usa git de
 * verdade (um "GitHub" local e dois clones), não dublê.
 *
 * Protege: push normal; GitHub andou em OUTRA chave -> reaplica por cima e envia;
 * GitHub andou na MESMA chave -> aborta sem sujar nada e diz o motivo; falha de
 * commit continua desfazendo a gravação.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const RAIZ = path.join(__dirname, '..');
const { salvarEComitar } = require(path.join(RAIZ, 'scripts', 'lib', 'salvar-config.js'));

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'teste-git-'));
process.on('exit', () => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch (e) { /* ok */ } });
const git = (cwd, ...args) => execFileSync('git', ['-c', 'user.name=Teste', '-c', 'user.email=t@t', ...args], { cwd, encoding: 'utf-8' }).trim();

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

const CONFIG_INICIAL = { hangares: [{ id: 'a', x: 1 }, { id: 'b', y: 1 }] };
const escrever = (dir, obj) => fs.writeFileSync(path.join(dir, 'config', 'hangares.json'), `${JSON.stringify(obj, null, 2)}\n`);
const ler = (dir) => JSON.parse(fs.readFileSync(path.join(dir, 'config', 'hangares.json'), 'utf-8'));

function montar(nome) {
  const base = path.join(tmp, nome);
  const remoto = path.join(base, 'github.git');
  const servidor = path.join(base, 'servidor');
  const outro = path.join(base, 'outro');
  fs.mkdirSync(base);
  execFileSync('git', ['init', '--bare', '-b', 'main', remoto], { stdio: 'ignore' });
  execFileSync('git', ['clone', '-q', remoto, servidor], { stdio: 'ignore' });
  fs.mkdirSync(path.join(servidor, 'config'));
  escrever(servidor, CONFIG_INICIAL);
  git(servidor, 'checkout', '-q', '-B', 'main');
  git(servidor, 'add', '.'); git(servidor, 'commit', '-q', '-m', 'inicial'); git(servidor, 'push', '-q', 'origin', 'main');
  execFileSync('git', ['clone', '-q', remoto, outro], { stdio: 'ignore' });
  return { remoto, servidor, outro };
}
const noRemoto = (r) => JSON.parse(execFileSync('git', ['--git-dir', r.remoto, 'show', 'main:config/hangares.json'], { encoding: 'utf-8' }));
const mexerNoGithub = (r, mudar) => { const c = ler(r.outro); mudar(c); escrever(r.outro, c); git(r.outro, 'add', '.'); git(r.outro, 'commit', '-q', '-m', 'mesclagem no GitHub'); git(r.outro, 'push', '-q', 'origin', 'main'); };

console.log('1) Push normal');
let r = montar('normal');
let c = ler(r.servidor); c.hangares[0].x = 2;
let res = salvarEComitar(c, 'a: x 1 -> 2', 'Painel do Validador', { raiz: r.servidor });
conferir('envia ao GitHub', res.push.enviado === true && !res.push.reconciliado, JSON.stringify(res.push));
conferir('o GitHub recebeu a alteração', noRemoto(r).hangares[0].x === 2);

console.log('\n2) O GitHub andou em OUTRA chave: reaplica por cima e envia');
r = montar('divergiu');
mexerNoGithub(r, (cfg) => { cfg.hangares[1].y = 99; });           // ex.: mesclagem minha na main
c = ler(r.servidor); c.hangares[0].x = 2;                          // ex.: alguém salvou no painel
res = salvarEComitar(c, 'a: x 1 -> 2', 'Painel do Validador', { raiz: r.servidor });
conferir('o push é recusado, mas se recupera e envia', res.push.enviado === true && res.push.reconciliado === true, JSON.stringify(res.push));
const remoto2 = noRemoto(r);
conferir('o GitHub tem as DUAS alterações', remoto2.hangares[0].x === 2 && remoto2.hangares[1].y === 99, JSON.stringify(remoto2));
conferir('o servidor também (o arquivo em uso já tem a mudança do GitHub)', ler(r.servidor).hangares[1].y === 99 && ler(r.servidor).hangares[0].x === 2);
conferir('o hash devolvido é o de agora', res.commit === git(r.servidor, 'rev-parse', '--short', 'HEAD'));
conferir('nada pendente de envio', git(r.servidor, 'rev-list', '--count', 'origin/main..HEAD') === '0');
conferir('sem rebase pela metade', !fs.existsSync(path.join(r.servidor, '.git', 'rebase-merge')) && git(r.servidor, 'status', '--porcelain') === '');

console.log('\n3) O GitHub andou na MESMA chave: não resolve sozinho, não suja nada');
r = montar('conflito');
mexerNoGithub(r, (cfg) => { cfg.hangares[0].x = 5; });
c = ler(r.servidor); c.hangares[0].x = 2;
res = salvarEComitar(c, 'a: x 1 -> 2', 'Painel do Validador', { raiz: r.servidor });
conferir('não envia e diz o motivo', res.push.enviado === false && /conflitam/.test(res.push.motivo), JSON.stringify(res.push));
conferir('a alteração do servidor continua valendo localmente', ler(r.servidor).hangares[0].x === 2);
conferir('o GitHub não foi tocado', noRemoto(r).hangares[0].x === 5);
conferir('o git não ficou no meio de um rebase', !fs.existsSync(path.join(r.servidor, '.git', 'rebase-merge')) && git(r.servidor, 'status', '--porcelain') === '');
conferir('segue contando 1 alteração pendente', git(r.servidor, 'rev-list', '--count', 'HEAD', '--not', 'origin/main') === '1' || git(r.servidor, 'log', '--oneline', '-1').includes('x 1 -> 2'));

console.log('\n4) Falha de commit continua desfazendo a gravação');
r = montar('falha');
fs.mkdirSync(path.join(r.servidor, '.git', 'hooks'), { recursive: true });
fs.writeFileSync(path.join(r.servidor, '.git', 'hooks', 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 });
c = ler(r.servidor); c.hangares[0].x = 7;
let erro = null;
try { salvarEComitar(c, 'a: x -> 7', 'Painel do Validador', { raiz: r.servidor }); } catch (e) { erro = e; }
conferir('lança erro explicando', erro && /alteração desfeita/.test(erro.message));
conferir('o arquivo voltou ao que era', ler(r.servidor).hangares[0].x === 1);

console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
process.exit(falhas ? 1 : 0);
