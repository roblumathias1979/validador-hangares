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

// Stubs ANTES do require do processar (ele desestrutura no topo): PDF (não abrir
// Chromium) e envio de documento (capturar).
const pdfLib = require(path.join(RAIZ, 'scripts', 'lib', 'pdf-movimentacao.js'));
let pdfsGerados = 0;
pdfLib.gerarPdfMovimentacao = async () => { pdfsGerados += 1; return Buffer.from('%PDF-fake').toString('base64'); };
const evo = require(path.join(RAIZ, 'scripts', 'lib', 'evolution.js'));
let documentosEnviados = [];
evo.enviarDocumento = async (grupo, base64, opts) => { documentosEnviados.push({ grupo, base64, opts }); return { ok: true }; };

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

  console.log('\n"por período" sem dizer qual: pergunta e eu escolho');
  const pedePer = await processar(texto(GRUPO, 'movimentação jumper por periodo'), {});
  conferir('pergunta qual período', pedePer.status === 'mov_pede_periodo' && /per[ií]odo/i.test(pedePer.mensagemWhatsapp), `veio "${pedePer.status}"`);
  conferir('mantém o nome na pergunta', /jumper/i.test(pedePer.mensagemWhatsapp));
  ultimaConsulta = null;
  const pararP = simularColetor(MOVS);
  const escolhido = await processar(texto(GRUPO, 'ontem'), {});
  pararP();
  conferir('aplica o período escolhido', escolhido.status === 'movimentacao' && ultimaConsulta && ultimaConsulta.dataini === `${ontem} 00:00:00`, JSON.stringify(ultimaConsulta && ultimaConsulta.dataini));

  console.log('\n"por período" sem nome: pergunta, escolho, cai no menu');
  const pedePer2 = await processar(texto(GRUPO, 'entrada e saída por período'), {});
  conferir('pergunta o período', pedePer2.status === 'mov_pede_periodo');
  const menuPos = await processar(texto(GRUPO, 'dia 05/10'), {});
  conferir('vai ao menu com o período', menuPos.status === 'menu_movimentacao' && /05\/10/.test(menuPos.mensagemWhatsapp), `veio "${menuPos.status}"`);

  console.log('\nMenu de período numerado (1,2,3,4)');
  const mp = await processar(texto(GRUPO, 'histórico do jumper por periodo'), {});
  conferir('menu numerado 1-4', /\*1\*/.test(mp.mensagemWhatsapp) && /\*4\*/.test(mp.mensagemWhatsapp) && /Hoje/i.test(mp.mensagemWhatsapp), mp.mensagemWhatsapp);
  ultimaConsulta = null;
  const pararN = simularColetor(MOVS);
  const opc2 = await processar(texto(GRUPO, '2'), {}); // ontem
  pararN();
  conferir('opção 2 = ontem', opc2.status === 'movimentacao' && ultimaConsulta && ultimaConsulta.dataini === `${ontem} 00:00:00`, JSON.stringify(ultimaConsulta && ultimaConsulta.dataini));

  console.log('\nOpção 4: pergunta data inicial e final');
  await processar(texto(GRUPO, 'entrada e saída por periodo'), {});
  const op4 = await processar(texto(GRUPO, '4'), {});
  conferir('pede data inicial', /data inicial/i.test(op4.mensagemWhatsapp), op4.mensagemWhatsapp);
  const dIni = await processar(texto(GRUPO, '01/10'), {});
  conferir('pede data final', /data final/i.test(dIni.mensagemWhatsapp), dIni.mensagemWhatsapp);
  const dFim = await processar(texto(GRUPO, '03/10'), {});
  conferir('conclui com a faixa → menu credenciados/tudo', dFim.status === 'menu_movimentacao' && /01\/10\/\d{4} a 03\/10/.test(dFim.mensagemWhatsapp), dFim.mensagemWhatsapp);

  console.log('\nPDF: oferta após a lista e geração');
  pdfsGerados = 0; documentosEnviados = [];
  await processar(texto(GRUPO, 'entrada e saída'), {});
  const pararPdf = simularColetor(MOVS);
  const lista = await processar(texto(GRUPO, '1'), {});
  pararPdf();
  conferir('pergunta se quer em PDF (sim/não)', /quer receber esse relat/i.test(lista.mensagemWhatsapp) && /SIM/.test(lista.mensagemWhatsapp), lista.mensagemWhatsapp);
  const pdf1 = await processar(texto(GRUPO, 'sim'), {});
  conferir('SIM gera o PDF e envia como documento', pdf1.status === 'movimentacao_pdf' && pdfsGerados === 1 && documentosEnviados.length === 1, `status "${pdf1.status}", pdfs ${pdfsGerados}, docs ${documentosEnviados.length}`);
  conferir('documento é .pdf com legenda', /\.pdf$/.test(documentosEnviados[0].opts.nomeArquivo) && /Solojet/i.test(documentosEnviados[0].opts.legenda));

  console.log('\nPDF: responder NÃO não gera');
  pdfsGerados = 0; documentosEnviados = [];
  await processar(texto(GRUPO, 'entrada e saída'), {});
  const pararNao = simularColetor(MOVS);
  await processar(texto(GRUPO, '1'), {});
  pararNao();
  const nao = await processar(texto(GRUPO, 'não'), {});
  conferir('NÃO não gera PDF', nao.status === 'mov_pdf_recusado' && pdfsGerados === 0 && documentosEnviados.length === 0, `status "${nao.status}"`);

  console.log('\nPDF direto no pedido: "histórico da maria em pdf"');
  pdfsGerados = 0; documentosEnviados = [];
  const pararPdf2 = simularColetor(MOVS);
  const pdfDireto = await processar(texto(GRUPO, 'histórico da maria em pdf'), {});
  pararPdf2();
  conferir('vai direto ao PDF', pdfDireto.status === 'movimentacao_pdf' && pdfsGerados === 1 && documentosEnviados.length === 1, `status "${pdfDireto.status}"`);

  console.log('\nColetor mudo: avisa que não respondeu (não trava)');
  await processar(texto(GRUPO, 'movimentação'), {});
  const semResp = await processar(texto(GRUPO, 'credenciados'), {}); // sem coletor dublê
  conferir('status sem resposta', semResp.status === 'mov_sem_resposta', `veio "${semResp.status}"`);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main().catch((e) => { console.error('teste quebrou:', e); falhas += 1; }).finally(() => process.exit(falhas ? 1 : 0));
