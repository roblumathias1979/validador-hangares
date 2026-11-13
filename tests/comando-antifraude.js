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

const { interpretarComandoAntifraude, interpretarConsultaAntifraude } = require(path.join(RAIZ, 'scripts', 'lib', 'whatsapp.js'));
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

  console.log('\n1b) Parser da consulta');
  for (const [t, esperado] of [['quais pátios estão com antifraude', true], ['status do antifraude', true], ['antifraude', true], ['Antifraude?', true], ['consultar antifraude', true],
    ['ativar antifraude', false], ['desativar antifraude', false], ['teve fraude no pátio', false], ['quais pátios estão com faturamento', false]]) {
    conferir(`consulta "${t}" → ${esperado}`, interpretarConsultaAntifraude(t) === esperado);
  }

  console.log('\n2) Desligar em um pátio: lista → escolha → confirmação → SIM');
  let r = await processar(noAdm('desativar antifraude'), {});
  conferir('mostra a lista com o estado de cada pátio', r.status === 'antifraude_escolher_patios' && /AIBM 1 — 🛡️ ligado/.test(r.mensagemWhatsapp) && /AIBM 2 — 🛡️ ligado/.test(r.mensagemWhatsapp), r.status);
  conferir('a lista traz TODOS os pátios, não só os dois', (r.mensagemWhatsapp.match(/\*\d+\* /g) || []).length >= 16, String((r.mensagemWhatsapp.match(/\*\d+\* /g) || []).length));
  conferir('pátio sem local cadastrado vem marcado', /Solojet — ⛔ desligado ⚠️ sem local/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  const nAibm1 = (r.mensagemWhatsapp.match(/\*(\d+)\* AIBM 1 /) || [])[1];
  r = await processar(noAdm(nAibm1), {});
  conferir('pede confirmação e avisa o que se perde', r.status === 'antifraude_confirmar' && /AIBM 1/.test(r.mensagemWhatsapp) && /não pede a foto do veículo/.test(r.mensagemWhatsapp), r.status);
  conferir('nada mudou antes do SIM', foto('aibm') && foto('aibm-2'));
  r = await processar(noAdm('sim'), {});
  conferir('desligou SÓ o escolhido', r.status === 'antifraude_desligado' && !foto('aibm') && foto('aibm-2'), r.status);
  conferir('o commit diz quem e o quê', commits.length === 1 && /Antifraude \(foto do veículo\) DESLIGADO em AIBM 1 por/.test(commits[0]), commits[0]);

  console.log('\n3) Ligar todos: só o que muda entra na confirmação');
  r = await processar(noAdm('ativar antifraude todos'), {});
  conferir('vai direto à confirmação, só com o AIBM 1 (o AIBM 2 já está ligado; os sem local ficam de fora e são avisados)', r.status === 'antifraude_confirmar' && /\*1 pátio\(s\)\*/.test(r.mensagemWhatsapp) && /• AIBM 1/.test(r.mensagemWhatsapp) && !/• AIBM 2/.test(r.mensagemWhatsapp) && /Não vou ligar/.test(r.mensagemWhatsapp) && /Solojet/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  r = await processar(noAdm('sim'), {});
  conferir('religou', r.status === 'antifraude_ligado' && foto('aibm') && foto('aibm-2'), r.status);
  r = await processar(noAdm('ativar antifraude todos'), {});
  conferir('já ligado onde dá: só avisa dos pátios sem local (nada a ligar)', r.status === 'antifraude_sem_local' && /Solojet/.test(r.mensagemWhatsapp), r.status);

  console.log('\n4) NÃO, CANCELAR e respostas soltas não mudam nada');
  r = await processar(noAdm('desativar antifraude ambos'), {});
  conferir('"ambos" vai direto à confirmação (só os 2 que estão ligados mudam)', r.status === 'antifraude_confirmar' && /\*2 pátio\(s\)\*/.test(r.mensagemWhatsapp) && /• AIBM 1/.test(r.mensagemWhatsapp) && /• AIBM 2/.test(r.mensagemWhatsapp), r.status);
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
  conferir('funciona no privado de quem é admin (já ligado onde dá)', r.status === 'antifraude_sem_local', r.status);

  console.log('\n5b) Trava: não se liga onde não há local cadastrado');
  await processar(noAdm('ativar antifraude'), {});
  const nSolojet = (/\*(\d+)\* Solojet — /.exec((await processar(noAdm('ativar antifraude'), {})).mensagemWhatsapp) || [])[1];
  r = await processar(noAdm(nSolojet), {});
  conferir('escolher só o Solojet para ligar: recusa e explica', r.status === 'antifraude_sem_local' && /nenhum validaria/.test(r.mensagemWhatsapp), r.status);
  conferir('nada mudou no Solojet', !foto('solojet'));
  r = await processar(noAdm('desativar antifraude'), {});
  r = await processar(noAdm(nSolojet), {});
  conferir('DESLIGAR vale em qualquer pátio (já está desligado: sem mudança)', r.status === 'antifraude_sem_mudanca', r.status);

  console.log('\n5c) Consulta: quais pátios estão com antifraude');
  r = await processar(noAdm('quais pátios estão com antifraude'), {});
  conferir('lista os ligados', r.status === 'antifraude_consulta' && /Ligado em 2:.*AIBM 1.*AIBM 2/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  conferir('separa os desligados sem local (não dá para ligar)', /sem local cadastrado/.test(r.mensagemWhatsapp) && /Solojet/.test(r.mensagemWhatsapp));
  conferir('aponta como mudar', /ativar antifraude/.test(r.mensagemWhatsapp));
  r = await processar(noAdm('antifraude'), {});
  conferir('"antifraude" sozinho também consulta', r.status === 'antifraude_consulta', r.status);
  await processar(noAdm('desativar antifraude'), {});
  r = await processar(noAdm('status do antifraude'), {});
  conferir('a consulta não atrapalha um comando em andamento (a escolha continua valendo)', r.status === 'antifraude_consulta', r.status);
  r = await processar(noAdm('cancelar'), {});
  conferir('...e o CANCELAR ainda funciona', r.status === 'antifraude_cancelado', r.status);

  console.log('\n6) Grupo de hangar NÃO comanda o antifraude');
  const antes = [foto('aibm'), foto('aibm-2')].join();
  r = await processar(noGrupoAibm('desativar antifraude'), {});
  conferir('não vira comando e nada mudou', !/^antifraude_/.test(String(r.status)) && [foto('aibm'), foto('aibm-2')].join() === antes, r.status);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
  process.exit(falhas ? 1 : 0);
})();
