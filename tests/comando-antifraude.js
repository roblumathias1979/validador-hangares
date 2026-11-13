#!/usr/bin/env node
/**
 * Ligar/desligar o antifraude (foto do veículo + conferência de local) pelo
 * WhatsApp da administração: "ativar antifraude" / "desativar antifraude".
 *
 * Protege: o parser (exige a palavra E um verbo); o passo a passo — lista de
 * pátios com o estado, escolha (números ou TODOS), confirmação SIM/NÃO, e só o
 * SIM grava `exigeFotoVeiculoNoLocal`; que DESLIGAR avisa o que se perde; que só
 * entram pátios com o local cadastrado; e que grupo de hangar não comanda.
 * Config real: o cenário guarda e devolve. O git é no-op.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const ADMGRUPO = '120363432317888806@g.us';
const ADMIN = '5511992773041@s.whatsapp.net';
const GRUPO_AIBM = '120363430127934870@g.us';
const PESSOA = '5511999999999@s.whatsapp.net';

require('./cenario').montar({ hangares: { aibm: { exigeFotoVeiculoNoLocal: true }, 'aibm-2': { exigeFotoVeiculoNoLocal: true } } });

const EXTRA = ['data/mensagens-vistas.json', 'data/pendencias.json'];
const guardado = {};
for (const a of EXTRA) { const p = path.join(RAIZ, a); guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; }
process.on('exit', () => { for (const a of EXTRA) { const p = path.join(RAIZ, a); if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) { /* ok */ } } else fs.writeFileSync(p, guardado[a]); } });
for (const a of EXTRA) fs.writeFileSync(path.join(RAIZ, a), '{}');

const child = require('child_process');
const gitReal = child.execFileSync;
const commits = [];
child.execFileSync = (cmd, args, opcoes) => {
  if (cmd === 'git') {
    if (args.includes('commit')) { commits.push(args[args.indexOf('-m') + 1]); return ''; }
    if (args.some((a) => ['add', 'push'].includes(a))) return '';
    if (args.includes('rev-parse')) return 'commit-de-teste';
    return gitReal(cmd, args, opcoes);
  }
  throw new Error('script inesperado: ' + path.basename((args && args[0]) || String(cmd)));
};

const { interpretarComandoAntifraude } = require(path.join(RAIZ, 'scripts', 'lib', 'whatsapp.js'));
const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));
const CONFIG = path.join(RAIZ, 'config', 'hangares.json');
const foto = (id) => JSON.parse(fs.readFileSync(CONFIG, 'utf-8')).hangares.find((h) => h.id === id).exigeFotoVeiculoNoLocal === true;
const noAdm = (t) => ({ data: { key: { remoteJid: ADMGRUPO, fromMe: false, id: `G${Math.random()}`, participant: PESSOA }, pushName: 'Rodrigo', message: { conversation: t } } });
const noPrivado = (t) => ({ data: { key: { remoteJid: ADMIN, fromMe: false, id: `P${Math.random()}` }, pushName: 'Rodrigo', message: { conversation: t } } });
const noGrupoAibm = (t) => ({ data: { key: { remoteJid: GRUPO_AIBM, fromMe: false, id: `H${Math.random()}`, participant: PESSOA }, pushName: 'Cliente', message: { conversation: t } } });

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

(async () => {
  console.log('1) Parser');
  for (const [t, esperado] of [['ativar antifraude', true], ['Ativar o anti-fraude', true], ['ligar antifraude', true], ['desativar antifraude', false], ['desligar o anti fraude', false], ['tirar antifraude', false],
    ['antifraude', null], ['ativar faturamento', null], ['teve fraude no pátio hoje, precisamos ativar algo?', null], ['ativar', null]]) {
    conferir(`"${t}" → ${esperado}`, interpretarComandoAntifraude(t) === esperado);
  }

  console.log('\n2) Desligar em um pátio: lista → escolha → confirmação → SIM');
  let r = await processar(noAdm('desativar antifraude'), {});
  conferir('mostra a lista com o estado de cada pátio', r.status === 'antifraude_escolher_patios' && /AIBM 1 — 🛡️ ligado/.test(r.mensagemWhatsapp) && /AIBM 2 — 🛡️ ligado/.test(r.mensagemWhatsapp), r.status);
  conferir('só entram pátios com o local cadastrado (2)', (r.mensagemWhatsapp.match(/\*\d\*/g) || []).length === 2, r.mensagemWhatsapp);
  r = await processar(noAdm('1'), {});
  conferir('pede confirmação e avisa o que se perde', r.status === 'antifraude_confirmar' && /AIBM 1/.test(r.mensagemWhatsapp) && /não pede a foto do veículo/.test(r.mensagemWhatsapp), r.status);
  conferir('nada mudou antes do SIM', foto('aibm') && foto('aibm-2'));
  r = await processar(noAdm('sim'), {});
  conferir('desligou SÓ o escolhido', r.status === 'antifraude_desligado' && !foto('aibm') && foto('aibm-2'), r.status);
  conferir('o commit diz quem e o quê', commits.length === 1 && /Antifraude \(foto do veículo\) DESLIGADO em AIBM 1 por/.test(commits[0]), commits[0]);

  console.log('\n3) Ligar todos: só o que muda entra na confirmação');
  r = await processar(noAdm('ativar antifraude todos'), {});
  conferir('vai direto à confirmação, só com o AIBM (o AIBM 2 já está ligado)', r.status === 'antifraude_confirmar' && /\*1 pátio\(s\)\*/.test(r.mensagemWhatsapp) && /• AIBM 1/.test(r.mensagemWhatsapp) && !/• AIBM 2/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  r = await processar(noAdm('sim'), {});
  conferir('religou', r.status === 'antifraude_ligado' && foto('aibm') && foto('aibm-2'), r.status);
  r = await processar(noAdm('ativar antifraude todos'), {});
  conferir('já está ligado: diz que não há o que mudar', r.status === 'antifraude_sem_mudanca', r.status);

  console.log('\n4) NÃO, CANCELAR e respostas soltas não mudam nada');
  r = await processar(noAdm('desativar antifraude ambos'), {});
  conferir('"ambos" vai direto à confirmação dos dois', r.status === 'antifraude_confirmar' && /todos os 2 pátios/.test(r.mensagemWhatsapp), r.status);
  r = await processar(noAdm('talvez'), {});
  conferir('resposta solta pede SIM ou NÃO', r.status === 'antifraude_confirma_nao_entendido' && foto('aibm') && foto('aibm-2'), r.status);
  r = await processar(noAdm('não'), {});
  conferir('NÃO cancela', r.status === 'antifraude_cancelado' && foto('aibm') && foto('aibm-2'), r.status);
  await processar(noAdm('desativar antifraude'), {});
  r = await processar(noAdm('cancelar'), {});
  conferir('CANCELAR na escolha', r.status === 'antifraude_cancelado' && foto('aibm') && foto('aibm-2'), r.status);
  await processar(noAdm('desativar antifraude'), {});
  r = await processar(noAdm('banana'), {});
  conferir('pátio não reconhecido pede de novo', r.status === 'antifraude_patios_nao_entendido', r.status);
  await processar(noAdm('cancelar'), {});

  console.log('\n5) Pelo nome do pátio e pelo privado do admin');
  await processar(noAdm('desligar antifraude'), {});
  r = await processar(noAdm('aibm 2'), {});
  conferir('escolha pelo nome', r.status === 'antifraude_confirmar', r.status);
  await processar(noAdm('não'), {});
  r = await processar(noPrivado('ativar antifraude todos'), {});
  conferir('funciona no privado de quem é admin (já ligado: sem mudança)', r.status === 'antifraude_sem_mudanca', r.status);

  console.log('\n6) Grupo de hangar NÃO comanda o antifraude');
  const antes = [foto('aibm'), foto('aibm-2')].join();
  r = await processar(noGrupoAibm('desativar antifraude'), {});
  conferir('não vira comando e nada mudou', !/^antifraude_/.test(String(r.status)) && [foto('aibm'), foto('aibm-2')].join() === antes, r.status);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
  process.exit(falhas ? 1 : 0);
})();
