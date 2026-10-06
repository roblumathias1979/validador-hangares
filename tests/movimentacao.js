#!/usr/bin/env node
/**
 * Consulta de entrada e saída (movimentação) de credenciados pelo grupo.
 *
 * A consulta roda no TECHPARKING (só o coletor alcança), então é assíncrona: o
 * bot pergunta credenciados/tudo, enfileira, espera o coletor e responde. O que
 * este teste protege (o lado do bot; o filtro em si roda no coletor, em Python):
 *
 * 1. No grupo do hangar: "entrada e saída" → menu → "1" → lista (coletor dublê).
 * 2. No grupo admin: precisa nomear o hangar; sem nome, pergunta qual.
 * 3. A resposta mostra os movimentos (entrada 🟢 / saída 🔴) com horário e nome.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';
process.env.CONTINGENCIA_ESPERA_MS = '3000';
process.env.CONTINGENCIA_POLL_MS = '20';

const RAIZ = path.join(__dirname, '..');
const GRUPO = '120363431859218622@g.us'; // Solojet
const ADMGRUPO = '120363432317888806@g.us'; // grupo admin
const PESSOA = '5511999999999@s.whatsapp.net';

require('./cenario').montar({});

const EXTRA = ['data/consultas-pendentes.json', 'data/pendencias.json', 'data/mensagens-vistas.json'];
const guardado = {};
for (const a of EXTRA) { const p = path.join(RAIZ, a); guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; }
process.on('exit', () => { for (const a of EXTRA) { const p = path.join(RAIZ, a); if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) {} } else fs.writeFileSync(p, guardado[a]); } });
for (const a of EXTRA) fs.writeFileSync(path.join(RAIZ, a), '{}');

const filaConsultas = require(path.join(RAIZ, 'scripts', 'lib', 'consultas-pendentes.js'));
const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));

// Coletor dublê: assim que o bot enfileira uma consulta, devolve movimentos.
let ultimaConsulta = null;
function simularColetor(movimentos) {
  const iv = setInterval(() => {
    for (const q of filaConsultas.retirarParaProcessar()) {
      ultimaConsulta = q;
      filaConsultas.registrarResultado(q.id, { ok: true, movimentos, total: movimentos.length });
    }
  }, 10);
  return () => clearInterval(iv);
}

const texto = (grupo, t) => ({ data: { key: { remoteJid: grupo, fromMe: false, id: `M${Math.random()}`, participant: PESSOA }, pushName: 'Alguém', message: { conversation: t } } });

const MOVS = [
  { datahora: '2026-10-06T08:15:00', evento: 'Entrada de credenciado', cartao: '111', nome: 'SOLOJET JOÃO', grupo: 'HANGAR SOLOJET' },
  { datahora: '2026-10-06T17:40:00', evento: 'Saída de credenciado', cartao: '111', nome: 'SOLOJET JOÃO', grupo: 'HANGAR SOLOJET' },
  { datahora: '2026-10-06T09:00:00', evento: 'Entrada de credenciado', cartao: '222', nome: 'SOLOJET MARIA', grupo: 'HANGAR SOLOJET' },
  { datahora: '2026-10-06T07:20:00', evento: 'Entrada de credenciado', cartao: '333', nome: 'SOLOJET LARISSA OLIVEIRA DE ALMEIDA', grupo: 'HANGAR SOLOJET' },
];

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

async function main() {
  console.log('Grupo do hangar: menu → escolha → lista');
  const menu = await processar(texto(GRUPO, 'entrada e saída'), {});
  conferir('abre o menu credenciados/tudo', menu.status === 'menu_movimentacao' && /credenciados/i.test(menu.mensagemWhatsapp) && /tudo/i.test(menu.mensagemWhatsapp), `veio "${menu.status}"`);

  const parar = simularColetor(MOVS);
  const r = await processar(texto(GRUPO, '1'), {});
  parar();
  conferir('responde a movimentação', r.status === 'movimentacao', `veio "${r.status}"`);
  conferir('mostra entrada e saída com nome', /JOÃO/.test(r.mensagemWhatsapp) && /🟢/.test(r.mensagemWhatsapp) && /🔴/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  conferir('tira o prefixo SOLOJET do nome', !/SOLOJET JOÃO/.test(r.mensagemWhatsapp));

  console.log('\nFiltro por nome: mostra só o credenciado pedido');
  await processar(texto(GRUPO, 'entrada e saída'), {});
  const parar3 = simularColetor(MOVS);
  const porNome = await processar(texto(GRUPO, 'maria'), {});
  parar3();
  conferir('responde a movimentação', porNome.status === 'movimentacao', `veio "${porNome.status}"`);
  conferir('mostra só a Maria', /MARIA/.test(porNome.mensagemWhatsapp) && !/JOÃO/.test(porNome.mensagemWhatsapp), porNome.mensagemWhatsapp);
  conferir('título cita o nome', /maria/i.test(porNome.mensagemWhatsapp));

  console.log('\nFiltro por nome sem resultado: avisa');
  await processar(texto(GRUPO, 'entrada e saída'), {});
  const parar4 = simularColetor(MOVS);
  const semNome2 = await processar(texto(GRUPO, 'fulano inexistente'), {});
  parar4();
  conferir('avisa que não achou', /Nenhuma movimenta/i.test(semNome2.mensagemWhatsapp), semNome2.mensagemWhatsapp);

  console.log('\nPedido DIRETO por nome (sem menu): "histórico da maria"');
  const parar5 = simularColetor(MOVS);
  const direto = await processar(texto(GRUPO, 'histórico da maria'), {});
  parar5();
  conferir('vai direto à movimentação (pula o menu)', direto.status === 'movimentacao', `veio "${direto.status}"`);
  conferir('mostra só a Maria', /MARIA/.test(direto.mensagemWhatsapp) && !/JOÃO/.test(direto.mensagemWhatsapp), direto.mensagemWhatsapp);

  console.log('\nNome com "de" no meio: busca sem o "de" ainda acha');
  const parar7 = simularColetor(MOVS);
  const comDe = await processar(texto(GRUPO, 'movimentação larissa oliveira de almeida'), {});
  parar7();
  conferir('acha mesmo faltando o "de" na busca', /LARISSA OLIVEIRA DE ALMEIDA/.test(comDe.mensagemWhatsapp) && !/Nenhuma/.test(comDe.mensagemWhatsapp), comDe.mensagemWhatsapp);

  console.log('\nPedido direto por nome no admin: "entrada e saída do solojet joão"');
  const parar6 = simularColetor(MOVS);
  const diretoAdm = await processar(texto(ADMGRUPO, 'entrada e saída do solojet joão'), {});
  parar6();
  conferir('admin vai direto ao nome', diretoAdm.status === 'movimentacao' && /JOÃO/.test(diretoAdm.mensagemWhatsapp), `veio "${diretoAdm.status}"`);

  console.log('\nGrupo admin sem nome do hangar: pergunta qual');
  const semNome = await processar(texto(ADMGRUPO, 'entrada e saída'), {});
  conferir('pede o nome do pátio', semNome.status === 'mov_sem_hangar', `veio "${semNome.status}"`);

  console.log('\nGrupo admin nomeando o hangar: menu → tudo → lista');
  const menuAdm = await processar(texto(ADMGRUPO, 'entrada e saída do solojet'), {});
  conferir('abre o menu (hangar nomeado)', menuAdm.status === 'menu_movimentacao', `veio "${menuAdm.status}"`);
  const parar2 = simularColetor(MOVS);
  const r2 = await processar(texto(ADMGRUPO, 'tudo'), {});
  parar2();
  conferir('responde a movimentação no admin', r2.status === 'movimentacao', `veio "${r2.status}"`);

  console.log('\nLista longa: oferece VER MAIS e depois mostra tudo');
  const MUITOS = [];
  for (let i = 0; i < 50; i += 1) {
    MUITOS.push({ datahora: `2026-10-06T${String(6 + (i % 12)).padStart(2, '0')}:${String(i % 60).padStart(2, '0')}:00`, evento: 'Entrada de credenciado', cartao: `c${i}`, nome: `SOLOJET PESSOA ${i}`, grupo: 'HANGAR SOLOJET' });
  }
  await processar(texto(GRUPO, 'entrada e saída'), {});
  const pararM = simularColetor(MUITOS);
  const longo = await processar(texto(GRUPO, '1'), {});
  pararM();
  conferir('separa em Entradas/Saídas com contagem', /Entradas/.test(longo.mensagemWhatsapp) && /entrada\(s\)/.test(longo.mensagemWhatsapp), longo.mensagemWhatsapp.slice(0, 80));
  conferir('oferece VER MAIS quando passa do limite', /VER MAIS/i.test(longo.mensagemWhatsapp));
  const verMais = await processar(texto(GRUPO, 'ver mais'), {});
  conferir('VER MAIS mostra a lista (sem novo corte)', verMais.status === 'movimentacao' && !/VER MAIS/i.test(verMais.mensagemWhatsapp), `veio "${verMais.status}"`);
  conferir('VER MAIS inclui mais itens que a 1ª', (verMais.mensagemWhatsapp.match(/PESSOA/g) || []).length > (longo.mensagemWhatsapp.match(/PESSOA/g) || []).length);

  console.log('\nPor período: "entrada e saída de ontem"');
  const hojeSP = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Sao_Paulo' });
  const ontem = (() => { const [y, m, d] = hojeSP.split('-').map(Number); const dt = new Date(Date.UTC(y, m - 1, d)); dt.setUTCDate(dt.getUTCDate() - 1); return dt.toISOString().slice(0, 10); })();
  const menuOntem = await processar(texto(GRUPO, 'entrada e saída de ontem'), {});
  conferir('menu mostra o período (ontem)', /\(ontem\)/.test(menuOntem.mensagemWhatsapp), menuOntem.mensagemWhatsapp);
  ultimaConsulta = null;
  const pararO = simularColetor(MOVS);
  const rOntem = await processar(texto(GRUPO, '1'), {});
  pararO();
  conferir('consulta usa as datas de ontem', ultimaConsulta && ultimaConsulta.dataini === `${ontem} 00:00:00` && ultimaConsulta.dataend === `${ontem} 23:59:59`, JSON.stringify(ultimaConsulta && { i: ultimaConsulta.dataini, f: ultimaConsulta.dataend }));
  conferir('título reflete o período', /de ontem/.test(rOntem.mensagemWhatsapp));

  console.log('\nPor data direto com nome: "histórico do joão ontem"');
  ultimaConsulta = null;
  const pararJ = simularColetor(MOVS);
  const rJoaoOntem = await processar(texto(GRUPO, 'histórico do joão ontem'), {});
  pararJ();
  conferir('vai direto (nome) e com período ontem', rJoaoOntem.status === 'movimentacao' && ultimaConsulta && ultimaConsulta.dataini === `${ontem} 00:00:00`, `veio "${rJoaoOntem.status}"`);
  conferir('título com nome e período', /JOÃO/.test(rJoaoOntem.mensagemWhatsapp) && /de ontem/.test(rJoaoOntem.mensagemWhatsapp));

  console.log('\nColetor mudo: avisa que não respondeu (não trava)');
  await processar(texto(GRUPO, 'movimentação'), {});
  const semResp = await processar(texto(GRUPO, 'credenciados'), {}); // sem coletor dublê
  conferir('status sem resposta', semResp.status === 'mov_sem_resposta', `veio "${semResp.status}"`);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main().catch((e) => { console.error('teste quebrou:', e); falhas += 1; }).finally(() => process.exit(falhas ? 1 : 0));
