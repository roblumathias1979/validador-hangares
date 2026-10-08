#!/usr/bin/env node
/**
 * Comando "investigar" (Jeito A, 08/10/2026): o bot NÃO corrige código — ele
 * junta o pacote de diagnóstico (problemas + versão no ar + logs de erro dos
 * serviços) e entrega para levar a uma sessão do Claude, onde a IA acha a causa
 * e abre um PR para o admin aprovar. Protege:
 * 1. o parser ("investigar"/"ver os logs" sim; "consertar"/"status" não);
 * 2. o fluxo: reúne os logs do serviço com problema e aponta a sessão do Claude;
 * 3. não promete corrigir sozinho (sem editar código por aqui).
 */

const path = require('path');

process.env.EVOLUTION_API_KEY = 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const ADMGRUPO = '120363432317888806@g.us';
const PESSOA = '5511999999999@s.whatsapp.net';

require('./cenario').montar({});

const { interpretarPedidoInvestigar } = require(path.join(RAIZ, 'scripts', 'lib', 'whatsapp.js'));
const autoConserto = require(path.join(RAIZ, 'scripts', 'lib', 'auto-conserto.js'));

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

console.log('1) Parser');
for (const t of ['investigar', 'investiga o problema', 'ver os logs', 'puxar os logs', 'o que deu errado']) {
  conferir(`"${t}"`, interpretarPedidoInvestigar(t) === true);
}
for (const t of ['consertar', 'recarregar sistema', 'status do sistema', 'bom dia']) {
  conferir(`"${t}" NÃO é investigar`, interpretarPedidoInvestigar(t) === false);
}

console.log('\n2) Fluxo: junta logs do serviço com problema e aponta a sessão');
(async () => {
  autoConserto.logsRecentes = (servico) => `linha de erro de ${servico} 1\nlinha de erro 2`;
  autoConserto.rodar = (cmd, args) => (cmd === 'git' ? { ok: true, saida: 'abc123 commit de teste' } : { ok: false, erro: 'x' });

  const monitor = require(path.join(RAIZ, 'scripts', 'monitor-saude.js'));
  monitor.verificar = async () => ({ checagens: {
    whatsapp: { ok: true, detalhe: 'conectada' },
    n8n: { ok: false, detalhe: 'não respondeu' },
    disco: { ok: true, detalhe: 'ok' },
    anthropic: { ok: false, detalhe: 'sem crédito' },
  } });

  const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));
  const msg = { data: { key: { remoteJid: ADMGRUPO, fromMe: false, id: `I${Math.random()}`, participant: PESSOA }, pushName: 'Admin', message: { conversation: 'investigar' } } };
  const r = await processar(msg, {});

  conferir('status investigacao', r.status === 'investigacao', `veio "${r.status}"`);
  conferir('lista os problemas', /n8n/.test(r.mensagemWhatsapp) && /anthropic/.test(r.mensagemWhatsapp));
  conferir('mostra a versão no ar', /abc123/.test(r.mensagemWhatsapp));
  conferir('traz os logs do n8n', /linha de erro de n8n\.service/.test(r.mensagemWhatsapp));
  conferir('aponta a sessão do Claude', /Claude Code/.test(r.mensagemWhatsapp) && /investigar o validador/.test(r.mensagemWhatsapp));
  conferir('deixa claro que roda fora da conta do bot', /não gasta o crédito do OCR/.test(r.mensagemWhatsapp));

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
  process.exit(falhas ? 1 : 0);
})();
