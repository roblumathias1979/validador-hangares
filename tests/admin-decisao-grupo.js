#!/usr/bin/env node
/**
 * Decidir pedidos pelo GRUPO de administração (13/11/2026).
 *
 * O bug: o número do ticket na resposta ("NÃO 011011080357") só era entendido no
 * PRIVADO. No grupo "Adm Bot" a frase inteira não virava sim/não e o bot repetia
 * a lista de pendências para sempre — com dois pedidos abertos ou mais, o grupo
 * não tinha como decidir ("fica travado nessa mensagem").
 *
 * Protege: sim/não com o número decide no grupo (faturamento e ticket travado);
 * SIM sem número com mais de um pedido pede o número, sem decidir nada; mensagem
 * que o bot não entende NÃO despeja a lista (só lembra, curto); "pendências"
 * mostra a lista, com um ticket de verdade no exemplo; ticket que não está
 * aguardando é dito; e grupo de HANGAR não ganha o novo comportamento.
 * FATURAMENTO_SIMULAR=true: o Asaas não é chamado.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';
process.env.FATURAMENTO_SIMULAR = 'true';

const RAIZ = path.join(__dirname, '..');
const ADM = '120363432317888806@g.us';
const GRUPO_HANGAR = '120363431859218622@g.us';
const PESSOA = '5511999999999@s.whatsapp.net';

require('./cenario').montar({});

const EXTRA = ['data/faturamentos-pendentes.json', 'data/tickets-bloqueados.json', 'data/mensagens-vistas.json', 'data/pendencias.json', 'data/validacoes-pendentes.json'];
const guardado = {};
for (const a of EXTRA) { const p = path.join(RAIZ, a); guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; }
process.on('exit', () => { for (const a of EXTRA) { const p = path.join(RAIZ, a); if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) { /* ok */ } } else fs.writeFileSync(p, guardado[a]); } });
const zerar = () => { for (const a of EXTRA) fs.writeFileSync(path.join(RAIZ, a), '{}'); };

const child = require('child_process');
const real = child.execFileSync;
child.execFileSync = (c, a, o) => (c === 'git' ? (a.includes('rev-parse') ? 'x' : '') : real(c, a, o));

const fila = require(path.join(RAIZ, 'scripts', 'lib', 'faturamentos-pendentes.js'));
const bloq = require(path.join(RAIZ, 'scripts', 'lib', 'tickets-bloqueados.js'));
const { interpretarMensagem } = require(path.join(RAIZ, 'scripts', 'lib', 'whatsapp.js'));
const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));

const TICKET_FAT = '010611085718';
const TICKET_BLOQ = '011011080357';
const abrir = () => {
  zerar();
  fila.enfileirar({ ticket: TICKET_FAT, hangarId: 'aibm-2', grupoId: 'g@g.us', valor: 40, motivo: 'fora_do_prazo' });
  bloq.bloquear(TICKET_BLOQ, { hangarId: 'alljet', hangarNome: 'Alljet', grupoId: 'h@g.us', remetente: 'x', vagasDisponiveis: 0 });
};
const grupoAdm = (t) => ({ data: { key: { remoteJid: ADM, fromMe: false, id: `G${Math.random()}`, participant: PESSOA }, pushName: 'Rodrigo', message: { conversation: t } } });
const grupoHangar = (t) => ({ data: { key: { remoteJid: GRUPO_HANGAR, fromMe: false, id: `H${Math.random()}`, participant: PESSOA }, pushName: 'Cliente', message: { conversation: t } } });

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };
const estadoFat = () => fila.listar().find((f) => f.ticket === TICKET_FAT).estado;

(async () => {
  console.log('1) Com dois pedidos abertos, o grupo decide pelo número do ticket');
  abrir();
  let r = await processar(grupoAdm(`NÃO ${TICKET_BLOQ}`), {});
  conferir('"NÃO <ticket>" recusa o ticket travado', r.status === 'bloqueio_mantido', r.status);
  conferir('o outro pedido segue aguardando', estadoFat() === 'aguardando_admin');
  abrir();
  r = await processar(grupoAdm(`sim ${TICKET_FAT}`), {});
  conferir('"sim <ticket>" autoriza o faturamento', r.status === 'faturamento_autorizado' && estadoFat() === 'faturado', r.status);
  r = await processar(grupoAdm('sim'), {});
  conferir('com um só pedido restante, "sim" simples decide', r.status === 'bloqueio_autorizado', r.status);

  console.log('\n2) SIM sem número, com mais de um pedido, não decide nada');
  abrir();
  r = await processar(grupoAdm('sim'), {});
  conferir('pede o número do ticket', r.status === 'autorizacao_ambigua', r.status);
  conferir('nada foi decidido', estadoFat() === 'aguardando_admin' && bloq.estaBloqueado(TICKET_BLOQ));
  r = await processar(grupoAdm('sim 999999999999'), {});
  conferir('ticket que não está aguardando: avisa', r.status === 'autorizacao_sem_alvo' && /999999999999/.test(r.mensagemWhatsapp), r.status);

  console.log('\n3) Mensagem não entendida NÃO despeja a lista de novo');
  r = await processar(grupoAdm('bom dia pessoal'), {});
  conferir('responde curto, com o caminho para ver a lista', r.status === 'autorizacao_nao_entendida' && /2 pedido\(s\)/.test(r.mensagemWhatsapp) && /pendências/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  conferir('sem a lista de tickets', !r.mensagemWhatsapp.includes(TICKET_FAT) && !r.mensagemWhatsapp.includes(TICKET_BLOQ));
  r = await processar(grupoAdm('pendências'), {});
  conferir('"pendências" mostra a lista', r.status === 'autorizacao_pendencias' && r.mensagemWhatsapp.includes(TICKET_FAT) && r.mensagemWhatsapp.includes(TICKET_BLOQ), r.status);
  conferir('o exemplo usa um ticket de verdade, não um fixo', new RegExp(`SIM ${TICKET_FAT}`).test(r.mensagemWhatsapp));
  r = await processar(grupoAdm('o que está aguardando?'), {});
  conferir('também por "o que está aguardando"', r.status === 'autorizacao_pendencias', r.status);
  zerar();
  r = await processar(grupoAdm('bom dia pessoal'), {});
  conferir('sem nada aguardando, fica em silêncio', r.responder === false, JSON.stringify({ s: r.status, r: r.responder }));

  console.log('\n4) Grupo de HANGAR não ganha o comportamento novo');
  const m = interpretarMensagem({ key: { remoteJid: GRUPO_HANGAR, fromMe: false, id: 'X1', participant: PESSOA }, message: { conversation: `sim ${TICKET_FAT}` } });
  conferir('a leitura no grupo de hangar não separa o número nem vira "sim"', (m.resposta === null || m.resposta === undefined) && !m.ticketCitado, JSON.stringify({ r: m.resposta, t: m.ticketCitado }));

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
  process.exit(falhas ? 1 : 0);
})();
