#!/usr/bin/env node
/**
 * Status do servidor, backup e créditos (09/10/2026).
 *
 * Protege: a leitura de memória/disco; as cores e os limites (avisar COM folga,
 * não com 1 GB livre); a idade do último backup; o crédito da AWS (dias, ritmo,
 * alerta); o comando "crédito aws"; o bloco novo no "status do sistema"; e o
 * monitor — que avisa ao entrar em alerta e não repete a cada 5 minutos.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const ADMGRUPO = '120363432317888806@g.us';
const PESSOA = '5511999999999@s.whatsapp.net';

require('./cenario').montar({});

const EXTRA = ['data/credito-aws.json', 'data/uso-anthropic.json', 'data/saude.json', 'data/techparking-snapshot.json'];
const guardado = {};
for (const a of EXTRA) { const p = path.join(RAIZ, a); guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; }
const restaurar = () => { for (const a of EXTRA) { const p = path.join(RAIZ, a); if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) { /* ok */ } } else fs.writeFileSync(p, guardado[a]); } };
process.on('exit', restaurar);
const limparAws = () => { try { fs.unlinkSync(path.join(RAIZ, 'data', 'credito-aws.json')); } catch (e) { /* ok */ } };

const si = require(path.join(RAIZ, 'scripts', 'lib', 'servidor-info.js'));
const backup = require(path.join(RAIZ, 'scripts', 'lib', 'backup-aws.js'));
const aws = require(path.join(RAIZ, 'scripts', 'lib', 'creditos-aws.js'));
const { interpretarCreditoAws } = require(path.join(RAIZ, 'scripts', 'lib', 'whatsapp.js'));
const autoConserto = require(path.join(RAIZ, 'scripts', 'lib', 'auto-conserto.js'));

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

console.log('1) Leitura da máquina');
const mem = si.parseMeminfo('MemTotal:        1990000 kB\nMemAvailable:    1005000 kB\nSwapTotal:       2097148 kB\nSwapFree:        1990000 kB\n');
conferir('lê memória e swap', Math.round(mem.memTotalMb) === 1943 && Math.round(mem.memDispMb) === 981 && Math.round(mem.swapTotalMb) === 2048);
const df = si.parseDf('Filesystem 1024-blocks Used Available Capacity Mounted on\n/dev/root 19000000 12000000 7300000 61% /\n');
conferir('lê disco em %', df.discoUsoPct === 61 && Math.abs(df.discoLivreGb - 6.96) < 0.1, JSON.stringify(df));

console.log('\n2) Cores e limites (com folga)');
const base = { ...mem, ...df, carga1: 0.2, cpus: 2, ligadoSeg: 3 * 86400, reinicioPendente: false };
let av = si.avaliar(base);
conferir('tudo normal: sem problema', av.problemas.length === 0, av.problemas.join());
conferir('mostra memória, swap, disco, carga e tempo ligado', ['Memória', 'Swap', 'Disco', 'Carga', 'Ligado há 3 dias', 'Reinício pendente: não'].every((t) => av.linhas.join('\n').includes(t)));
av = si.avaliar({ ...base, discoUsoPct: 86, discoLivreGb: 2.6 });
conferir('disco a 86% já é problema (o antigo só avisava com <1 GB)', av.problemas.includes('disco'));
av = si.avaliar({ ...base, discoUsoPct: 50, discoLivreGb: 1.5 });
conferir('menos de 2 GB livres é problema', av.problemas.includes('disco'));
av = si.avaliar({ ...base, discoUsoPct: 75, discoLivreGb: 5 });
conferir('75% é só amarelo, sem problema', !av.problemas.length && /🟡 Disco/.test(av.linhas.join('\n')));
av = si.avaliar({ ...base, memDispMb: 250 });
conferir('memória disponível <300 MB é problema', av.problemas.includes('memoria'));
av = si.avaliar({ ...base, memDispMb: 450 });
conferir('memória <500 MB é só amarelo', !av.problemas.length && /🟡 Memória/.test(av.linhas.join('\n')));
av = si.avaliar({ ...base, swapLivreMb: 500 });
conferir('swap alto sozinho NÃO é problema (só amarelo)', !av.problemas.length && /🟡 Swap/.test(av.linhas.join('\n')));
av = si.avaliar({ ...base, reinicioPendente: true });
conferir('reinício pendente aponta o comando', /reiniciar sistema/.test(av.linhas.join('\n')));
conferir('checarDisco/checarMemoria usados pelo monitor', si.checarDisco({ ...df, discoUsoPct: 90, discoLivreGb: 1 }).ok === false && si.checarMemoria(mem).ok === true);

console.log('\n3) Último backup');
const agora = Date.parse('2026-10-09T12:00:00Z');
const h = (n) => new Date(agora - n * 3600000).toISOString();
conferir('backup de 6 h: verde', backup.avaliar({ em: h(6), estado: 'completed' }, agora).cor === '🟢');
conferir('backup de 40 h: amarelo', backup.avaliar({ em: h(40), estado: 'completed' }, agora).cor === '🟡');
let b = backup.avaliar({ em: h(80), estado: 'completed' }, agora);
conferir('backup de 80 h: vermelho e vira problema', b.cor === '🔴' && b.problema === true && /dias/.test(b.texto), b.texto);
conferir('nenhum snapshot: vermelho', backup.avaliar({ nenhum: true }, agora).problema === true);
b = backup.avaliar({ indisponivel: true, motivo: 'sem permissão de leitura na AWS' }, agora);
conferir('sem acesso à AWS: diz que não consultou, não inventa', b.cor === '⚪' && b.problema === false && /não consegui consultar/.test(b.texto));
const consulta = backup.ultimoSnapshot((cmd) => (cmd === 'aws' ? { ok: true, saida: '["2026-10-09T06:00:11.000Z","completed"]' } : { ok: false }));
conferir('lê a resposta da CLI da AWS', consulta.em === '2026-10-09T06:00:11.000Z' && consulta.estado === 'completed');
conferir('CLI ausente: indisponível com motivo', backup.ultimoSnapshot(() => ({ ok: false, erro: 'spawnSync aws ENOENT' })).motivo === 'a CLI da AWS não está instalada no servidor');

console.log('\n4) Crédito da AWS');
const p1 = interpretarCreditoAws('crédito aws 79,52 até 03/03/2027');
conferir('lê valor e data', p1 && p1.usd === 79.52 && p1.ate === '2027-03-03', JSON.stringify(p1));
conferir('"crédito aws" só consulta', interpretarCreditoAws('crédito aws').consulta === true);
conferir('crédito da Anthropic NÃO é da AWS', interpretarCreditoAws('recarreguei US$ 50') === null && interpretarCreditoAws('saldo anthropic 20') === null);
limparAws();
conferir('sem informação: pede para informar', /não informado/.test(aws.avaliar(aws.estado()).texto));
aws.definir(79.52, '2027-03-03', Date.parse('2026-10-09T15:00:00Z'));
let e = aws.estado(Date.parse('2026-10-09T15:00:00Z'));
conferir('conta os dias até vencer', e.diasAteVencer === 145, String(e.diasAteVencer));
conferir('verde com 145 dias', aws.avaliar(e).cor === '🟢', aws.avaliar(e).texto);
e = aws.estado(Date.parse('2027-02-10T15:00:00Z'));
conferir('a 21 dias do fim: vermelho e vira problema', aws.avaliar(e).cor === '🔴' && aws.avaliar(e).problema === true, aws.avaliar(e).texto);
e = aws.estado(Date.parse('2026-12-15T15:00:00Z'));
conferir('informação com mais de 30 dias: amarelo pedindo para conferir', aws.avaliar(e).cor === '🟡' && /confira o painel/.test(aws.avaliar(e).texto), aws.avaliar(e).texto);
const hist = [{ em: '2026-10-01T00:00:00Z', saldoUsd: 100 }, { em: '2026-10-11T00:00:00Z', saldoUsd: 80 }];
conferir('ritmo de gasto: US$ 2/dia', Math.abs(aws.taxaDia(hist) - 2) < 1e-9);
conferir('ritmo ignora o que veio antes de uma recarga', Math.abs(aws.taxaDia([{ em: '2026-09-01T00:00:00Z', saldoUsd: 10 }, ...hist]) - 2) < 1e-9);
conferir('duas leituras com <3 dias: sem estimativa', aws.taxaDia([{ em: '2026-10-01T00:00:00Z', saldoUsd: 100 }, { em: '2026-10-02T00:00:00Z', saldoUsd: 99 }]) === null);
limparAws();

console.log('\n5) Monitor: avisa ao entrar em alerta, sem repetir a cada 5 min');
const monitor = require(path.join(RAIZ, 'scripts', 'monitor-saude.js'));
(async () => {
  const enviados = [];
  const enviar = async (t) => { enviados.push(t); return { avisado: true }; };
  const em = (iso) => ({ em: iso });
  const diasAtras = (n) => new Date(Date.now() - n * 86400000).toISOString();
  const ate = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

  limparAws();
  let atual = em(new Date().toISOString());
  await monitor.acompanharCreditoAws(null, atual, enviar);
  conferir('sem crédito informado: lembra a administração', enviados.length === 1 && /não informado/.test(enviados[0]), enviados[0]);
  const ant1 = { creditoAws: atual.creditoAws };
  atual = em(new Date().toISOString());
  await monitor.acompanharCreditoAws(ant1, atual, enviar);
  conferir('não repete o lembrete na rodada seguinte', enviados.length === 1);

  enviados.length = 0;
  aws.definir(79.52, ate(145));
  atual = em(new Date().toISOString());
  await monitor.acompanharCreditoAws(null, atual, enviar);
  conferir('crédito saudável: silêncio', enviados.length === 0);

  aws.definir(8, ate(100));
  atual = em(new Date().toISOString());
  await monitor.acompanharCreditoAws({ creditoAws: { alerta: false } }, atual, enviar);
  conferir('saldo ≤ US$ 10: avisa ao entrar em alerta', enviados.length === 1 && /acabando/.test(enviados[0]) && /Billing/.test(enviados[0]), enviados[0]);
  conferir('o aviso fica registrado', atual.creditoAws.alerta === true && !!atual.creditoAws.ultimoAvisoEm);
  const antAlerta = { creditoAws: atual.creditoAws };
  atual = em(new Date().toISOString());
  await monitor.acompanharCreditoAws(antAlerta, atual, enviar);
  conferir('5 minutos depois: NÃO repete', enviados.length === 1);
  const antVelho = { creditoAws: { ...antAlerta.creditoAws, ultimoAvisoEm: diasAtras(1.1) } };
  atual = em(new Date().toISOString());
  await monitor.acompanharCreditoAws(antVelho, atual, enviar);
  conferir('um dia depois, ainda em alerta: avisa de novo', enviados.length === 2);

  enviados.length = 0;
  const semAviso = async () => ({ avisado: false });
  atual = em(new Date().toISOString());
  await monitor.acompanharCreditoAws({ creditoAws: { alerta: false } }, atual, semAviso);
  conferir('se o WhatsApp estiver fora, não marca como avisado (tenta de novo)', !atual.creditoAws.ultimoAvisoEm);

  console.log('\n6) Comando e status no grupo admin');
  const stub = { checagens: { whatsapp: { ok: true, detalhe: 'conectada' }, n8n: { ok: true, detalhe: 'respondendo' }, disco: { ok: true, detalhe: 'ok' }, memoria: { ok: true, detalhe: 'ok' } } };
  monitor.verificar = async () => stub;
  autoConserto.rodar = () => ({ ok: false, erro: 'spawnSync aws ENOENT' });
  limparAws();
  fs.writeFileSync(path.join(RAIZ, 'data', 'techparking-snapshot.json'), JSON.stringify({ recebidoEm: new Date().toISOString(), patios: [], avulsos: [], credenciados: [] }));

  const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));
  const enviarMsg = async (t) => processar({ data: { key: { remoteJid: ADMGRUPO, fromMe: false, id: `S${Math.random()}`, participant: PESSOA }, pushName: 'Admin', message: { conversation: t } } }, {});

  let r = await enviarMsg('crédito aws 79,52 até 03/03/2027');
  conferir('anota o crédito pelo WhatsApp', r.status === 'credito_aws_anotado' && /79,52/.test(r.mensagemWhatsapp) && /03\/03\/2027/.test(r.mensagemWhatsapp), r.status);
  conferir('o valor ficou guardado', aws.estado() && aws.estado().saldoUsd === 79.52);
  r = await enviarMsg('crédito aws');
  conferir('"crédito aws" mostra o que está anotado', r.status === 'credito_aws_consulta' && /79,52/.test(r.mensagemWhatsapp));

  r = await enviarMsg('status do sistema');
  const t = r.mensagemWhatsapp || '';
  conferir('status traz o bloco do servidor', r.status === 'diagnostico' && /Servidor/.test(t) && /Memória/.test(t) && /Disco/.test(t));
  conferir('status traz o backup (sem acesso: diz que não consultou)', /Backup: não consegui consultar/.test(t), t);
  conferir('status traz os créditos (Anthropic e AWS)', /Créditos/.test(t) && /Anthropic/.test(t) && /Crédito AWS: US\$ 79,52/.test(t), t);
  conferir('não aparece "não consegui ler" (erro interno escondido)', !/não consegui ler/.test(t), t);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
  process.exit(falhas ? 1 : 0);
})();
