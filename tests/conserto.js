#!/usr/bin/env node
/**
 * Comando "consertar" (08/10/2026): o grupo de administração manda e o bot AGE
 * nos problemas que têm conserto seguro e reversível (reiniciar serviço, liberar
 * disco, ligar contingência), e DIZ o que depende de gente (crédito, celular,
 * coletor). Nada aqui edita código nem valida ticket.
 *
 * Protege:
 * 1. o parser ("consertar" sim; "recarregar sistema" e "status" NÃO);
 * 2. o planejador acoesPara (o que é automático × o que é manual);
 * 3. o fluxo: no grupo admin, "consertar" reinicia o que caiu e reporta o resto.
 */

const path = require('path');

process.env.EVOLUTION_API_KEY = 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const ADMGRUPO = '120363432317888806@g.us'; // grupo de administração (adminsWhatsapp)
const PESSOA = '5511999999999@s.whatsapp.net';

require('./cenario').montar({});

const { interpretarPedidoConserto } = require(path.join(RAIZ, 'scripts', 'lib', 'whatsapp.js'));
const autoConserto = require(path.join(RAIZ, 'scripts', 'lib', 'auto-conserto.js'));

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

console.log('1) Parser');
for (const t of ['consertar', 'conserta o validador', 'arruma isso', 'reiniciar o sistema', 'resolver o problema', 'tenta consertar o bot']) {
  conferir(`"${t}"`, interpretarPedidoConserto(t) === true);
}
for (const t of ['recarregar sistema', 'status do sistema', 'por que não está funcionando?', 'entrada e saída do Solojet', 'bom dia pessoal']) {
  conferir(`"${t}" NÃO é conserto`, interpretarPedidoConserto(t) === false);
}

console.log('\n2) Planejador acoesPara');
let p = autoConserto.acoesPara(['n8n', 'disco'], {});
conferir('n8n → reinicia o fluxo', p.automaticas.some((a) => a.tipo === 'reiniciar' && a.alvo === 'n8n.service'));
conferir('disco → libera disco', p.automaticas.some((a) => a.tipo === 'liberar_disco'));
p = autoConserto.acoesPara(['validpark'], { contingenciaLigada: false });
conferir('validpark fora → liga contingência', p.automaticas.some((a) => a.tipo === 'ligar_contingencia'));
p = autoConserto.acoesPara(['validpark'], { contingenciaLigada: true });
conferir('validpark fora mas contingência ligada → não religa', !p.automaticas.some((a) => a.tipo === 'ligar_contingencia'));
p = autoConserto.acoesPara(['anthropic', 'whatsapp', 'coletor'], {});
conferir('anthropic/whatsapp/coletor → nada automático', p.automaticas.length === 0);
conferir('e viram instruções manuais', p.manuais.length === 3);

console.log('\n3) Fluxo no grupo admin: reinicia o que caiu, reporta o resto');
(async () => {
  // Não deixa tocar no servidor de verdade: as ações são substituídas.
  const chamados = [];
  autoConserto.reiniciarServico = (nome) => { chamados.push(nome); return { ok: true, nome, detalhe: 'reiniciado e no ar' }; };
  autoConserto.liberarDisco = () => ({ ok: true, detalhe: 'logs compactados' });

  const monitor = require(path.join(RAIZ, 'scripts', 'monitor-saude.js'));
  monitor.verificar = async () => ({ checagens: {
    whatsapp: { ok: true, detalhe: 'conectada' },
    n8n: { ok: false, detalhe: 'não respondeu' },
    disco: { ok: true, detalhe: '10 GB livres' },
    anthropic: { ok: false, detalhe: 'sem crédito' },
  } });

  const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));
  const msg = { data: { key: { remoteJid: ADMGRUPO, fromMe: false, id: `C${Math.random()}`, participant: PESSOA }, pushName: 'Admin', message: { conversation: 'consertar' } } };
  const r = await processar(msg, {});

  conferir('status conserto', r.status === 'conserto', `veio "${r.status}"`);
  conferir('reiniciou o n8n', chamados.includes('n8n.service'), chamados.join(','));
  conferir('relata que reiniciou o fluxo', /reiniciar o fluxo \(n8n\)/.test(r.mensagemWhatsapp || ''));
  conferir('manda recarregar o crédito (manual)', /recarregar sistema/.test(r.mensagemWhatsapp || ''));
  conferir('não tenta consertar o crédito sozinho', /não compro sozinho/.test(r.mensagemWhatsapp || ''));

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
  process.exit(falhas ? 1 : 0);
})();
