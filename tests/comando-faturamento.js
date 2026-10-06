#!/usr/bin/env node
/**
 * Ligar/desligar o faturamento por pátio pelo WhatsApp da administração.
 *
 * O que este teste protege:
 *
 * 1. No grupo "Adm Bot": "desligar faturamento" mostra a lista de pátios com o
 *    estado de cada um; a escolha (números ou TODOS) pede confirmação; só o SIM
 *    grava `faturamentoDesligado`. NÃO e CANCELAR não mudam nada.
 * 2. Pátio citado no próprio comando pula a lista e vai direto à confirmação.
 * 3. Ligar apaga a chave (ausência = ligado, o padrão).
 * 4. Grupo de hangar e número que não é admin não comandam.
 *
 * Config é real: o cenário guarda e devolve.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const ADMGRUPO = '120363432317888806@g.us';        // grupo "Adm Bot 1Park SBJD" (adminsWhatsapp)
const ADMIN = '5511992773041@s.whatsapp.net';      // admin (adminsWhatsapp), pelo privado
const SOLOJET = '120363431859218622@g.us';
const PESSOA = '5511999999999@s.whatsapp.net';

require('./cenario').montar({ hangares: { solojet: { faturamentoDesligado: undefined }, voasp: { faturamentoDesligado: true } } });

const EXTRA = ['data/mensagens-vistas.json'];
const guardado = {};
for (const a of EXTRA) { const p = path.join(RAIZ, a); guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; }
process.on('exit', () => { for (const a of EXTRA) { const p = path.join(RAIZ, a); if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) {} } else fs.writeFileSync(p, guardado[a]); } });
for (const a of EXTRA) fs.writeFileSync(path.join(RAIZ, a), '{}');

// O comando commita o config: git vira no-op para não sujar o repositório.
const child = require('child_process');
const gitReal = child.execFileSync;
child.execFileSync = (cmd, args, opcoes) => {
  if (cmd === 'git') {
    if (args.some((a) => ['add', 'commit', 'push'].includes(a))) return '';
    if (args.includes('rev-parse')) return 'commit-de-teste';
    return gitReal(cmd, args, opcoes);
  }
  throw new Error('script inesperado: ' + path.basename((args && args[0]) || String(cmd)));
};

const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));
const CONFIG = path.join(RAIZ, 'config', 'hangares.json');
const desligado = (id) => JSON.parse(fs.readFileSync(CONFIG, 'utf-8')).hangares.find((h) => h.id === id).faturamentoDesligado === true;
const temChave = (id) => 'faturamentoDesligado' in JSON.parse(fs.readFileSync(CONFIG, 'utf-8')).hangares.find((h) => h.id === id);

const noAdmGrupo = (t) => ({ data: { key: { remoteJid: ADMGRUPO, fromMe: false, id: `G${Math.random()}`, participant: PESSOA }, pushName: 'Rodrigo', message: { conversation: t } } });
const noPrivado = (de, t) => ({ data: { key: { remoteJid: de, fromMe: false, id: `P${Math.random()}` }, pushName: 'Rodrigo', message: { conversation: t } } });
const noGrupoHangar = (t) => ({ data: { key: { remoteJid: SOLOJET, fromMe: false, id: `H${Math.random()}`, participant: PESSOA }, pushName: 'Cliente', message: { conversation: t } } });

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

async function main() {
  const lista = JSON.parse(fs.readFileSync(CONFIG, 'utf-8')).hangares.filter((h) => (h.grupoWhatsappId || '').trim());
  const nSolojet = lista.findIndex((h) => h.id === 'solojet') + 1;

  console.log('Grupo Adm Bot: desligar → lista → escolha → SIM');
  const menu = await processar(noAdmGrupo('desligar faturamento'), {});
  conferir('mostra a lista de pátios', menu.status === 'faturamento_escolher_patios', `veio "${menu.status}"`);
  conferir('lista traz o estado de cada um', /VOASP — ⛔ desligado/.test(menu.mensagemWhatsapp) && /💰 ligado/.test(menu.mensagemWhatsapp), menu.mensagemWhatsapp);
  const conf = await processar(noAdmGrupo(String(nSolojet)), {});
  conferir('pede confirmação', conf.status === 'faturamento_confirmar' && /Solojet/i.test(conf.mensagemWhatsapp), `veio "${conf.status}"`);
  conferir('nada mudou antes do SIM', !desligado('solojet'));
  const sim = await processar(noAdmGrupo('sim'), {});
  conferir('desligou', sim.status === 'faturamento_desligado' && desligado('solojet'), `veio "${sim.status}"`);

  console.log('\nNÃO e CANCELAR não mudam nada');
  await processar(noAdmGrupo('ligar faturamento'), {});
  await processar(noAdmGrupo('todos'), {});
  const nao = await processar(noAdmGrupo('não'), {});
  conferir('NÃO cancela', nao.status === 'faturamento_cancelado' && desligado('solojet') && desligado('voasp'), `veio "${nao.status}"`);
  await processar(noAdmGrupo('ligar faturamento'), {});
  const canc = await processar(noAdmGrupo('cancelar'), {});
  conferir('CANCELAR cancela', canc.status === 'faturamento_cancelado' && desligado('solojet'), `veio "${canc.status}"`);

  console.log('\nPátio citado no comando vai direto à confirmação; ligar apaga a chave');
  const direto = await processar(noAdmGrupo('ligar faturamento do Solojet'), {});
  conferir('pula a lista', direto.status === 'faturamento_confirmar' && /Solojet/i.test(direto.mensagemWhatsapp) && !/VOASP/.test(direto.mensagemWhatsapp), direto.mensagemWhatsapp);
  const ligou = await processar(noAdmGrupo('sim'), {});
  conferir('ligou e apagou a chave', ligou.status === 'faturamento_ligado' && !temChave('solojet'), `veio "${ligou.status}"`);

  console.log('\nTODOS já no estado pedido: avisa que não há mudança');
  await processar(noAdmGrupo('ligar faturamento de todos'), {});
  await processar(noAdmGrupo('sim'), {});
  const igual = await processar(noAdmGrupo('ligar faturamento de todos'), {});
  conferir('sem mudança', igual.status === 'faturamento_sem_mudanca', `veio "${igual.status}"`);
  conferir('VOASP ficou ligado pelo TODOS', !desligado('voasp'));

  console.log('\nPrivado de admin também comanda');
  await processar(noPrivado(ADMIN, 'desativar faturamento do VOASP'), {});
  const pv = await processar(noPrivado(ADMIN, 'sim'), {});
  conferir('desligou pelo privado', pv.status === 'faturamento_desligado' && desligado('voasp'), `veio "${pv.status}"`);

  console.log('\nQuem não é admin não comanda');
  const estranho = await processar(noPrivado('5511900000000@s.whatsapp.net', 'ligar faturamento do VOASP'), {});
  conferir('número estranho ignorado', estranho.status === 'ignorado' && desligado('voasp'), `veio "${estranho.status}"`);
  const doHangar = await processar(noGrupoHangar('ligar faturamento'), {});
  conferir('grupo de hangar não vira comando', !String(doHangar.status || '').startsWith('faturamento_') && desligado('voasp'), `veio "${doHangar.status}"`);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main().catch((e) => { console.error('teste quebrou:', e); falhas += 1; }).finally(() => process.exit(falhas ? 1 : 0));
