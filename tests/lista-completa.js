#!/usr/bin/env node
/**
 * As listas do "status do pátio" vão INTEIRAS, até o limite do WhatsApp.
 *
 * Antes havia um teto fixo — 10 tickets, 20 credenciados — e um "e mais N" no
 * fim. Isso confundia: o "Ver mais" do WhatsApp expande o que foi ENVIADO, e
 * os itens cortados nunca saíram do bot. Quem tocava nele não via nada de
 * novo, e a lista completa era inalcançável.
 *
 * Agora o único corte é o da mensagem do WhatsApp, 4096 caracteres. O que este
 * teste protege é a fronteira: passar do limite trava a resposta inteira, e
 * cortar cedo demais volta ao problema de origem.
 */

const path = require('path');
const { montarMensagem, montarMensagemCredenciados } = require(path.join(__dirname, '..', 'scripts', 'consultar-patio.js'));

const LIMITE_WHATSAPP = 4096;

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  if (ok) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

const tickets = (n) => Array.from({ length: n }, (_, i) => ({
  ticket: `0118091${String(i).padStart(5, '0')}`, placa: `ABC${1000 + i}`, tolerancia: '29/09/2026 18:00',
}));
const mensagemCom = (n) => montarMensagem({ hangar: 'Teste' },
  { total: 2000, disponiveis: 100, utilizadas: n, tickets: n, credenciados: 0, validados: tickets(n), doCache: false });

const contar = (m) => (m.match(/^•/gm) || []).length;

console.log('Listas que cabem vão inteiras');
for (const n of [1, 10, 21, 60]) {
  const m = mensagemCom(n);
  conferir(`${n} tickets -> mostra os ${n}`, contar(m) === n, `mostrou ${contar(m)}`);
  conferir(`${n} tickets -> não anuncia corte`, !/não couberam/.test(m));
}

console.log('\nAcima do que cabe, corta e DIZ quantos ficaram');
const grande = mensagemCom(200);
conferir('respeita o limite do WhatsApp', grande.length <= LIMITE_WHATSAPP, `${grande.length} caracteres`);
conferir('mostra bem mais que o teto antigo de 10', contar(grande) > 50, `mostrou ${contar(grande)}`);
conferir('avisa quantos faltaram', /mais \d+ não couberam/.test(grande), grande.split('\n').pop());
const faltando = Number((grande.match(/mais (\d+) não couberam/) || [])[1]);
conferir('a conta fecha', contar(grande) + faltando === 200, `${contar(grande)} + ${faltando}`);

console.log('\nO mesmo vale para a lista de credenciados');
const fs = require('fs');
const ARQ = path.join(__dirname, '..', 'data', 'techparking-snapshot.json');
const guardado = fs.existsSync(ARQ) ? fs.readFileSync(ARQ, 'utf-8') : null;
process.on('exit', () => {
  if (guardado === null) { try { fs.unlinkSync(ARQ); } catch (e) { /* já não existe */ } }
  else fs.writeFileSync(ARQ, guardado);
});
fs.writeFileSync(ARQ, JSON.stringify({
  recebidoEm: new Date().toISOString(),
  patios: [], avulsos: [],
  credenciados: Array.from({ length: 45 }, (_, i) => ({
    CARTAO: String(i), USUARIO: `CREDENCIADO NUMERO ${i}`, DATAHORA: '2026-09-29T08:00:00', PLACA: '', BOLSAO: 'TESTE',
  })),
}));
const cred = montarMensagemCredenciados({ hangar: 'Teste', bolsaoTechparking: 'TESTE' },
  { credenciados: 45, utilizadas: 45, tickets: 0, doCache: false });
conferir('45 credenciados aparecem todos', contar(cred) === 45, `mostrou ${contar(cred)}`);
conferir('dentro do limite', cred.length <= LIMITE_WHATSAPP, `${cred.length} caracteres`);

console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
process.exit(falhas ? 1 : 0);
