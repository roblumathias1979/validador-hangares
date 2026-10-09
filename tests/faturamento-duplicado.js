#!/usr/bin/env node
/**
 * Faturamento: um pedido por ticket (09/10/2026).
 *
 * O admin recebeu "010610125049 — voasp, faturar R$ 55,00" DUAS vezes, e o "NÃO"
 * sem número não recusou nenhum (com mais de um pedido o bot exige o número).
 * Protege: o mesmo ticket não vira dois pedidos; pedidos duplicados HERDADOS
 * contam como um na lista do admin; uma decisão fecha os irmãos (um SIM = um
 * boleto, nunca dois); e ticket com boleto real já emitido não é cobrado de novo.
 * Roda com FATURAMENTO_SIMULAR=true: o Asaas não é chamado.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';
process.env.FATURAMENTO_SIMULAR = 'true';

const RAIZ = path.join(__dirname, '..');
const ADMIN = '5511913119423@s.whatsapp.net';

require('./cenario').montar({ hangares: { aibm: { cotaMensalForaPrazo: 0, grupoAdministracao: ADMIN } } });

const EXTRA = ['data/faturamentos-pendentes.json', 'data/validacoes-pendentes.json', 'data/tickets-bloqueados.json', 'data/mensagens-vistas.json'];
const guardado = {};
for (const a of EXTRA) { const p = path.join(RAIZ, a); guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; }
process.on('exit', () => { for (const a of EXTRA) { const p = path.join(RAIZ, a); if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) { /* ok */ } } else fs.writeFileSync(p, guardado[a]); } });
const zerar = () => { for (const a of EXTRA) fs.writeFileSync(path.join(RAIZ, a), '{}'); };
zerar();

const asaas = require(path.join(RAIZ, 'scripts', 'lib', 'asaas.js'));
let boletosReais = 0;
asaas.criarCobrancaBoleto = async () => { boletosReais += 1; return { id: `pay_${boletosReais}`, value: 55, bankSlipUrl: null }; };

const fila = require(path.join(RAIZ, 'scripts', 'lib', 'faturamentos-pendentes.js'));
const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));
const admin = (t) => ({ data: { key: { remoteJid: ADMIN, fromMe: false, id: `A${Math.random()}` }, pushName: 'Rodrigo', message: { conversation: t } } });
const pedido = (ticket) => ({ ticket, hangarId: 'aibm', grupoId: 'g@g.us', valor: 55, motivo: 'fora_do_prazo' });
const estados = () => fila.listar().map((f) => f.estado).sort().join(',');

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

(async () => {
  console.log('1) O mesmo ticket não vira dois pedidos');
  const a = fila.enfileirar(pedido('010610125049'));
  const b = fila.enfileirar(pedido('010610125049'));
  conferir('o segundo pedido devolve o MESMO registro', b.id === a.id && b.jaExistia === true);
  conferir('a fila tem um só', fila.listar().length === 1);
  conferir('ticket diferente é outro pedido', fila.enfileirar(pedido('010610125050')).id !== a.id && fila.listar().length === 2);

  console.log('\n2) Duplicados herdados contam como um para o admin');
  zerar();
  const dados = {};
  for (const id of ['a', 'b']) dados[id] = { id, ticket: '010610125049', hangarId: 'aibm', grupoId: 'g@g.us', valor: 55, estado: 'aguardando_admin', criadoEm: new Date(Date.now() - (id === 'a' ? 2000 : 1000)).toISOString() };
  fs.writeFileSync(fila.ARQUIVO, JSON.stringify(dados));
  conferir('a lista do admin mostra 1', fila.aguardandoUnicos().length === 1);
  let r = await processar(admin('não'), {});
  conferir('um "NÃO" sem número age (não pede o número)', r.status === 'faturamento_recusado', r.status);
  conferir('o irmão foi fechado junto: nada mais aguardando', fila.aguardandoUnicos().length === 0, estados());
  r = await processar(admin('não'), {});
  conferir('depois disso: "nada aguardando"', r.status === 'autorizacao_sem_alvo', r.status);

  console.log('\n3) Um SIM = um boleto');
  zerar();
  fs.writeFileSync(fila.ARQUIVO, JSON.stringify(dados));
  r = await processar(admin('sim'), {});
  conferir('SIM emite', r.status === 'faturamento_autorizado', r.status);
  conferir('o irmão virou "duplicado", não ficou aguardando', estados() === 'duplicado,faturado', estados());
  r = await processar(admin('sim'), {});
  conferir('um segundo SIM não acha nada para cobrar', r.status === 'autorizacao_sem_alvo' && boletosReais === 0, `${r.status} boletos=${boletosReais}`);

  console.log('\n4) Ticket com boleto REAL já emitido não é cobrado de novo');
  zerar();
  process.env.FATURAMENTO_SIMULAR = 'false';
  fs.writeFileSync(fila.ARQUIVO, JSON.stringify({ x: { id: 'x', ticket: '010610125049', hangarId: 'aibm', grupoId: 'g@g.us', valor: 55, estado: 'faturado', criadoEm: new Date().toISOString(), decididoEm: new Date().toISOString(), resultado: { id: 'pay_antigo', valor: 55, simulado: false } } }));
  const novo = fila.enfileirar(pedido('010610125049'));
  r = await processar(admin('sim'), {});
  conferir('SIM num ticket já faturado: avisa e NÃO emite', r.status === 'faturamento_ja_emitido' && boletosReais === 0, `${r.status} boletos=${boletosReais}`);
  conferir('o pedido novo foi fechado', fila.aguardandoUnicos().length === 0 && fila.listar().find((f) => f.id === novo.id).estado === 'recusado');
  conferir('boleto SIMULADO antigo não bloqueia um real', (() => { zerar(); fs.writeFileSync(fila.ARQUIVO, JSON.stringify({ y: { id: 'y', ticket: '77', estado: 'faturado', resultado: { simulado: true } } })); return fila.jaFaturado('77') === null; })());

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
  process.exit(falhas ? 1 : 0);
})();
