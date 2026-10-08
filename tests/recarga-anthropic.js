#!/usr/bin/env node
/**
 * Recarga dos créditos da Anthropic pelo grupo de administração.
 *
 * Contexto (08/10/2026): os créditos acabaram e o bot ficou sem ler fotos de
 * ticket. A Anthropic não tem API para COMPRAR crédito — só o Console, no
 * navegador —, então o que o grupo de administração pode ter é um atalho: dizer
 * se o problema é mesmo esse e levar até a página certa. Protege:
 *
 * 1. o parser reconhece o pedido (inclusive "antrophic", como se digita) e NÃO
 *    dispara com conversa comum do grupo ("saldo do caixa", "créditos do João");
 * 2. sem crédito: a resposta diz isso, traz o link do Console e o passo a passo;
 * 3. com crédito: diz que está tudo bem, sem mandar recarregar à toa;
 * 4. se a verificação falhar, não afirma nada que não sabe;
 * 5. o "status do sistema" passa a mostrar a situação da leitura de fotos;
 * 6. o parser do diagnóstico não rouba o pedido (a recarga vem antes).
 *
 * Roda sem rede: Evolution e API da Anthropic não são chamadas.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const ADMGRUPO = '120363432317888806@g.us'; // grupo de administração (adminsWhatsapp)
const PESSOA = '5511999999999@s.whatsapp.net';

require('./cenario').montar({});

// O diagnóstico lê estes dois arquivos; o teste devolve ao que estavam.
const EXTRA = ['data/saude.json', 'data/techparking-snapshot.json'];
const guardado = {};
for (const a of EXTRA) { const p = path.join(RAIZ, a); guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; }
process.on('exit', () => { for (const a of EXTRA) { const p = path.join(RAIZ, a); if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) { /* já não existe */ } } else fs.writeFileSync(p, guardado[a]); } });
fs.mkdirSync(path.join(RAIZ, 'data'), { recursive: true });
fs.writeFileSync(path.join(RAIZ, 'data', 'techparking-snapshot.json'), JSON.stringify({ recebidoEm: new Date().toISOString(), patios: [], avulsos: [], credenciados: [] }));
fs.writeFileSync(path.join(RAIZ, 'data', 'saude.json'), JSON.stringify({ em: new Date().toISOString(), saudavel: true, checagens: {}, validpark: { ok: true, detalhe: 'login e leitura ok', em: new Date().toISOString() } }));

// Dublês: a API da Anthropic e a verificação geral de saúde.
const monitor = require(path.join(RAIZ, 'scripts', 'monitor-saude.js'));
let anthropic = { ok: false, detalhe: 'créditos esgotados' };
monitor.checarAnthropic = async () => anthropic;
monitor.verificar = async () => ({
  em: new Date().toISOString(), saudavel: true, problemas: [],
  checagens: {
    whatsapp: { ok: true, detalhe: 'conectada' },
    n8n: { ok: true, detalhe: 'respondendo' },
    disco: { ok: true, detalhe: '10 GB livres' },
    anthropic,
  },
});

const { interpretarPedidoRecargaAnthropic, interpretarPedidoDiagnostico } = require(path.join(RAIZ, 'scripts', 'lib', 'whatsapp.js'));
const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));

const texto = (t) => ({ data: { key: { remoteJid: ADMGRUPO, fromMe: false, id: `R${Math.random()}`, participant: PESSOA }, pushName: 'Admin', message: { conversation: t } } });

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

async function main() {
  console.log('O parser reconhece o pedido:');
  for (const t of ['recarregar sistema', 'Recarregar o sistema', 'recarregar anthropic', 'Recarga antrophic', 'recarregar a antropic', 'saldo da anthropic',
    'comprar créditos da anthropic', 'recarregar créditos', 'recarregar os créditos do claude', 'adicionar crédito na api']) {
    conferir(`"${t}"`, interpretarPedidoRecargaAnthropic(t) === true);
  }

  console.log('\nE não dispara com conversa comum do grupo:');
  for (const t of ['saldo do caixa do Solojet', 'os créditos do João acabaram', 'como está o pátio do Solojet', 'recarregar o celular',
    'status do sistema', 'o sistema está lento', 'por que não está funcionando?', 'ligar contingência', 'entrada e saída do Alljet']) {
    conferir(`"${t}"`, interpretarPedidoRecargaAnthropic(t) === false);
  }

  console.log('\nO diagnóstico não rouba o pedido (a recarga vem antes):');
  const colisao = 'o bot não funciona, recarregar sistema';
  conferir('o diagnóstico também casaria com a frase', interpretarPedidoDiagnostico(colisao) === true);
  const rc = await processar(texto(colisao), {});
  conferir('mas quem responde é a recarga', rc.status === 'recarga_anthropic', `veio "${rc.status}"`);

  console.log('\nSem crédito:');
  anthropic = { ok: false, detalhe: 'créditos esgotados' };
  const r = await processar(texto('recarregar sistema'), {});
  conferir('status recarga_anthropic', r.status === 'recarga_anthropic', `veio "${r.status}"`);
  conferir('responde no grupo de administração', r.responder === true && r.grupoId === ADMGRUPO);
  conferir('diz que os créditos acabaram', /créditos da Anthropic acabaram/.test(r.mensagemWhatsapp || ''));
  conferir('traz o link do Console', /https:\/\/console\.anthropic\.com\/settings\/billing/.test(r.mensagemWhatsapp || ''));
  conferir('manda comprar créditos e conferir depois', /Comprar créditos/.test(r.mensagemWhatsapp) && /status do sistema/.test(r.mensagemWhatsapp));
  conferir('é honesto: não dá para pagar pelo bot', /não dá para pagar por aqui/.test(r.mensagemWhatsapp));
  conferir('não acusa a administração de nada', r.notificarAdmin === false);

  console.log('\nCom crédito:');
  anthropic = { ok: true, detalhe: 'API respondendo' };
  const ok = await processar(texto('saldo da anthropic'), {});
  conferir('diz que está lendo normalmente', /está respondendo e tem crédito/.test(ok.mensagemWhatsapp || ''), ok.mensagemWhatsapp);
  conferir('NÃO manda recarregar', !/acabaram/.test(ok.mensagemWhatsapp) && !/Comprar créditos\*\./.test(ok.mensagemWhatsapp));
  conferir('ainda oferece o link (recarga automática)', /settings\/billing/.test(ok.mensagemWhatsapp));

  console.log('\nVerificação impossível: não afirma o que não sabe:');
  monitor.checarAnthropic = async () => { throw new Error('rede caiu'); };
  const incerto = await processar(texto('recarregar anthropic'), {});
  conferir('responde mesmo assim', incerto.responder === true && incerto.status === 'recarga_anthropic');
  conferir('diz que não conseguiu verificar', /não consegui verificar/.test(incerto.mensagemWhatsapp || ''));
  conferir('não afirma que os créditos acabaram', !/acabaram/.test(incerto.mensagemWhatsapp || ''));
  monitor.checarAnthropic = async () => anthropic;

  console.log('\nStatus do sistema mostra a leitura de fotos:');
  anthropic = { ok: false, detalhe: 'créditos esgotados' };
  const s1 = await processar(texto('status do sistema'), {});
  conferir('linha da Anthropic em vermelho', /🔴 Leitura de fotos \(Anthropic\)/.test(s1.mensagemWhatsapp || ''), s1.mensagemWhatsapp);
  conferir('aponta o comando para recarregar', /recarregar sistema/.test(s1.mensagemWhatsapp || ''));
  anthropic = { ok: true, detalhe: 'API respondendo' };
  const s2 = await processar(texto('status do sistema'), {});
  conferir('linha da Anthropic em verde', /🟢 Leitura de fotos \(Anthropic\)/.test(s2.mensagemWhatsapp || ''));
  conferir('com tudo no ar, não manda recarregar', !/recarregar sistema/.test(s2.mensagemWhatsapp || ''));

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main().catch((e) => { console.error('teste quebrou:', e); falhas += 1; }).finally(() => process.exit(falhas ? 1 : 0));
