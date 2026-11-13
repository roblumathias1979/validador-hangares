#!/usr/bin/env node
/**
 * Agendar manutenção pelo grupo de administração (13/11/2026): "agendar reiniciar
 * servidor domingo 03:00". Confirma antes de guardar; avisa 10 min antes; executa no
 * horário pelo mesmo caminho dos comandos manuais; NÃO executa o que atrasou mais de
 * 15 minutos; só uma execução por agendamento, mesmo com duas rodadas ao mesmo tempo.
 *
 * Protege: a leitura das frases; o cálculo (fuso de Brasília, próximo dia, limites);
 * o armazenamento (duplicado, limite, cancelar, poda); o fluxo no WhatsApp; e o
 * executor com tempo FIXO (sem depender do relógio).
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
require('./cenario').montar({});

const EXTRA = ['data/agendamentos.json', 'data/pendencias.json', 'data/mensagens-vistas.json'];
const guardado = {};
for (const a of EXTRA) { const p = path.join(RAIZ, a); guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; fs.writeFileSync(p, '{}'); }
process.on('exit', () => { for (const a of EXTRA) { const p = path.join(RAIZ, a); if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) { /* ok */ } } else fs.writeFileSync(p, guardado[a]); } });
const zerar = () => { for (const a of EXTRA) fs.writeFileSync(path.join(RAIZ, a), '{}'); };

const w = require(path.join(RAIZ, 'scripts', 'lib', 'whatsapp.js'));
const ag = require(path.join(RAIZ, 'scripts', 'lib', 'agendamentos.js'));
const executor = require(path.join(RAIZ, 'scripts', 'executar-agendamentos.js'));
const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));

const ADM = '120363432317888806@g.us';
const ADMIN_PRIV = '5511992773041@s.whatsapp.net';
const GRUPO_HANGAR = '120363431859218622@g.us';
const PESSOA = '5511999999999@s.whatsapp.net';
const grupo = (jid, t) => ({ data: { key: { remoteJid: jid, fromMe: false, id: `G${Math.random()}`, participant: PESSOA }, pushName: 'Rodrigo', message: { conversation: t } } });
const privado = (t) => ({ data: { key: { remoteJid: ADMIN_PRIV, fromMe: false, id: `P${Math.random()}` }, pushName: 'Rodrigo', message: { conversation: t } } });
const adm = (t) => processar(grupo(ADM, t), {});

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };
const igual = (a, b) => JSON.stringify(a) === JSON.stringify(b);

(async () => {
  console.log('1) Leitura das frases');
  const casos = [
    ['agendar reiniciar servidor 03:00', { acao: 'servidor', hora: 3, minuto: 0, dia: null }],
    ['agendar reiniciar serviços amanhã 04:30', { acao: 'servicos', hora: 4, minuto: 30, dia: 'amanha' }],
    ['programar atualizar servidor domingo 2h', { acao: 'atualizar', hora: 2, minuto: 0, dia: { dow: 0 } }],
    ['agendar reiniciar servidor às 3 da manhã', { acao: 'servidor', hora: 3, minuto: 0, dia: null }],
    ['agendar reiniciar servidor 3 da tarde', { acao: 'servidor', hora: 15, minuto: 0, dia: null }],
    ['agendar reiniciar servidor 15/11 02:30', { acao: 'servidor', hora: 2, minuto: 30, dia: { dia: 15, mes: 11, ano: null } }],
    ['agendar reiniciar servidor depois de amanhã 5h30', { acao: 'servidor', hora: 5, minuto: 30, dia: 'depois' }],
    ['agendar reiniciar servidor meia noite', { acao: 'servidor', hora: 0, minuto: 0, dia: null }],
    ['agendar reiniciar 03:00', { acao: null, hora: 3, minuto: 0, dia: null }],
    ['agendar reiniciar servidor', { acao: 'servidor', hora: null, minuto: null, dia: null }],
  ];
  for (const [t, esperado] of casos) { const r = w.interpretarComandoAgendar(t); conferir(`"${t}"`, igual(r, esperado), JSON.stringify(r)); }
  for (const t of ['reiniciar sistema', 'atualizar servidor', 'agendamentos', 'cancelar agendamento', 'bom dia', 'a reunião está marcada para as 3h']) conferir(`"${t}" NÃO é o comando de agendar`, w.interpretarComandoAgendar(t) === null);
  conferir('"agendamentos" lista', igual(w.interpretarPedidoAgendamentos('agendamentos'), { tipo: 'listar' }));
  conferir('"o que está agendado?" lista', igual(w.interpretarPedidoAgendamentos('o que está agendado?'), { tipo: 'listar' }));
  conferir('"cancelar agendamento" cancela', igual(w.interpretarPedidoAgendamentos('cancelar agendamento'), { tipo: 'cancelar' }));
  conferir('o comando de agendar não vira "lista"', w.interpretarPedidoAgendamentos('agendar reiniciar servidor 3h') === null);

  console.log('\n2) Cálculo do horário (fuso de Brasília; hoje = sexta 13/11/2026 16:00)');
  const agora = new Date('2026-11-13T19:00:00Z');
  const q = (spec) => ag.calcularQuando(spec, agora);
  conferir('03:00 sem dia, já passou hoje: amanhã', q({ hora: 3, dia: null }).quando.toISOString() === '2026-11-14T06:00:00.000Z' && q({ hora: 3, dia: null }).adiouParaAmanha === true);
  conferir('20:00 sem dia: hoje', q({ hora: 20, dia: null }).quando.toISOString() === '2026-11-13T23:00:00.000Z' && !q({ hora: 20, dia: null }).adiouParaAmanha);
  conferir('"hoje 03:00" (já passou): erro, não adivinha', q({ hora: 3, dia: 'hoje' }).erro === 'ja_passou');
  conferir('amanhã 04:30', q({ hora: 4, minuto: 30, dia: 'amanha' }).quando.toISOString() === '2026-11-14T07:30:00.000Z');
  conferir('domingo 3h', q({ hora: 3, dia: { dow: 0 } }).quando.toISOString() === '2026-11-15T06:00:00.000Z');
  conferir('sexta 3h (hoje passou): sexta que vem', q({ hora: 3, dia: { dow: 5 } }).quando.toISOString() === '2026-11-20T06:00:00.000Z');
  conferir('sexta 20h: hoje mesmo', q({ hora: 20, dia: { dow: 5 } }).quando.toISOString() === '2026-11-13T23:00:00.000Z');
  conferir('15/11 02:30', q({ hora: 2, minuto: 30, dia: { dia: 15, mes: 11, ano: null } }).quando.toISOString() === '2026-11-15T05:30:00.000Z');
  conferir('25:00 é recusado', q({ hora: 25, dia: null }).erro === 'hora_invalida');
  conferir('31/02 é recusado', q({ hora: 2, dia: { dia: 31, mes: 2, ano: null } }).erro === 'data_invalida');
  conferir('mais de 30 dias é recusado', q({ hora: 2, dia: { dia: 20, mes: 12, ano: null } }).erro === 'longe');
  conferir('data por extenso', ag.formatarQuando(q({ hora: 3, dia: { dow: 0 } }).quando, agora) === 'domingo, 15/11 às 03:00 (daqui a 2 dias)', ag.formatarQuando(q({ hora: 3, dia: { dow: 0 } }).quando, agora));
  conferir('"amanhã" aparece como amanhã', /\(amanhã\)/.test(ag.formatarQuando(q({ hora: 4, dia: 'amanha' }).quando, agora)));

  console.log('\n3) Armazenamento');
  zerar();
  const t1 = new Date('2026-11-15T06:00:00Z');
  const j1 = ag.criar({ acao: 'servidor', quando: t1, grupoId: ADM, quem: 'Rodrigo' }, agora);
  conferir('cria como pendente', j1.estado === 'pendente' && j1.quandoIso === t1.toISOString());
  let erro = null; try { ag.criar({ acao: 'servidor', quando: t1, grupoId: ADM }, agora); } catch (e) { erro = e; }
  conferir('o mesmo agendamento duas vezes é recusado', erro && erro.codigo === 'duplicado');
  conferir('a mesma hora com OUTRA ação é aceita', Boolean(ag.criar({ acao: 'servicos', quando: t1, grupoId: ADM }, agora)));
  erro = null; try { ag.criar({ acao: 'servidor', quando: new Date('2026-11-13T18:00:00Z'), grupoId: ADM }, agora); } catch (e) { erro = e; }
  conferir('horário no passado é recusado', erro && erro.codigo === 'passado');
  erro = null; try { ag.criar({ acao: 'servidor', quando: new Date('2026-12-30T06:00:00Z'), grupoId: ADM }, agora); } catch (e) { erro = e; }
  conferir('mais de 30 dias é recusado', erro && erro.codigo === 'longe');
  erro = null; try { ag.criar({ acao: 'formatar-disco', quando: t1, grupoId: ADM }, agora); } catch (e) { erro = e; }
  conferir('ação desconhecida é recusada (só as 3 seguras)', erro && erro.codigo === 'acao');
  zerar();
  for (let i = 0; i < 10; i += 1) ag.criar({ acao: 'servidor', quando: new Date(t1.getTime() + i * 3600000), grupoId: ADM }, agora);
  erro = null; try { ag.criar({ acao: 'servidor', quando: new Date(t1.getTime() + 99 * 3600000), grupoId: ADM }, agora); } catch (e) { erro = e; }
  conferir('no máximo 10 ativos', erro && erro.codigo === 'limite');
  const lista = ag.listarAtivos();
  conferir('a lista vem em ordem de horário', lista.length === 10 && lista[0].quandoIso < lista[9].quandoIso);
  conferir('cancelar um', ag.cancelar(lista[0].id).estado === 'cancelado' && ag.listarAtivos().length === 9);
  conferir('cancelar o mesmo de novo não faz nada', ag.cancelar(lista[0].id) === null);
  conferir('cancelar todos', ag.cancelarTodos() === 9 && ag.listarAtivos().length === 0);

  console.log('\n4) No WhatsApp (grupo de administração)');
  zerar();
  let r = await adm('agendar reiniciar servidor amanhã 03:00');
  conferir('pede confirmação com a data por extenso', r.status === 'agendar_confirmar' && /reiniciar o servidor/.test(r.mensagemWhatsapp) && /às 03:00 \(amanhã\)/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  conferir('avisa o impacto e o aviso de 10 min', /2 a 3 minutos/.test(r.mensagemWhatsapp) && /10 minutos antes/.test(r.mensagemWhatsapp));
  conferir('nada foi guardado antes do SIM', ag.listarAtivos().length === 0);
  r = await adm('talvez');
  conferir('resposta solta pede SIM ou NÃO', r.status === 'agendar_confirma_nao_entendido');
  r = await adm('sim');
  conferir('SIM agenda', r.status === 'agendado' && ag.listarAtivos().length === 1 && ag.listarAtivos()[0].grupoId === ADM, r.status);
  conferir('o que foi guardado é horário de Brasília em UTC (amanhã 03:00 = 06:00Z)', /T06:00:00\.000Z$/.test(ag.listarAtivos()[0].quandoIso), ag.listarAtivos()[0].quandoIso);
  conferir('a mensagem diz como listar e cancelar', /agendamentos/.test(r.mensagemWhatsapp) && /cancelar agendamento/.test(r.mensagemWhatsapp));
  r = await adm('agendar reiniciar servidor amanhã 03:00'); r = await adm('sim');
  conferir('o mesmo de novo: recusa por duplicado', r.status === 'agendar_erro' && /Já existe/.test(r.mensagemWhatsapp), r.status);
  r = await adm('agendar reiniciar servidor amanhã 05:00'); r = await adm('não');
  conferir('NÃO não agenda', r.status === 'agendar_cancelado' && ag.listarAtivos().length === 1);

  console.log('\n5) Perguntas quando falta informação');
  r = await adm('agendar reiniciar 04:00');
  conferir('sem dizer o quê: pergunta (serviços, servidor ou atualizações)', r.status === 'agendar_perguntar_acao' && /\*1\*/.test(r.mensagemWhatsapp) && /\*3\*/.test(r.mensagemWhatsapp), r.status);
  r = await adm('2');
  conferir('"2" = servidor, e como o horário já veio, vai à confirmação', r.status === 'agendar_confirmar' && /reiniciar o servidor/.test(r.mensagemWhatsapp), r.status);
  await adm('cancelar');
  r = await adm('agendar reiniciar servidor');
  conferir('sem horário: pergunta que horas', r.status === 'agendar_perguntar_horario' && /Exemplos/.test(r.mensagemWhatsapp), r.status);
  r = await adm('bananas');
  conferir('horário ilegível: pede de novo', r.status === 'agendar_horario_nao_entendido', r.status);
  r = await adm('domingo 3h');
  conferir('"domingo 3h" leva à confirmação', r.status === 'agendar_confirmar' && /domingo, \d\d\/\d\d às 03:00/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  await adm('cancelar');
  r = await adm('agendar reiniciar servidor 25:00');
  conferir('25:00: avisa que não entendeu o horário e pergunta de novo', r.status === 'agendar_perguntar_horario' && /Não entendi esse horário/.test(r.mensagemWhatsapp), r.status);
  await adm('cancelar');
  const br = ag.partes(new Date());
  if (!(br.hora === 0 && br.minuto < 3)) {
    r = await adm('agendar reiniciar servidor hoje 00:00');
    conferir('"hoje" num horário que já passou: não adivinha, pergunta', r.status === 'agendar_perguntar_horario' && /já passou/.test(r.mensagemWhatsapp), r.status);
    await adm('cancelar');
  }
  r = await adm('agendar reiniciar servidor 31/02 03:00');
  conferir('data que não existe', r.status === 'agendar_erro' && /não existe/.test(r.mensagemWhatsapp), r.status);
  r = await adm('agendar reiniciar servidor 15/01/2099 03:00');
  conferir('longe demais', r.status === 'agendar_erro' && /30 dias/.test(r.mensagemWhatsapp), r.status);

  console.log('\n6) Listar e cancelar');
  zerar();
  await adm('agendar atualizar servidor amanhã 02:00'); await adm('sim');
  await adm('agendar reiniciar serviços amanhã 04:00'); await adm('sim');
  r = await adm('agendamentos');
  conferir('lista os dois, numerados', r.status === 'agendar_lista' && /\*1\*/.test(r.mensagemWhatsapp) && /\*2\*/.test(r.mensagemWhatsapp) && /Instalar as atualizações/.test(r.mensagemWhatsapp) && /Reiniciar os serviços/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  r = await adm('cancelar agendamento');
  conferir('pergunta qual cancelar', r.status === 'agendar_cancelar_qual', r.status);
  r = await adm('1');
  conferir('cancelar o 1 (o das 02:00)', r.status === 'agendar_cancelados' && ag.listarAtivos().length === 1 && ag.listarAtivos()[0].acao === 'servicos', r.status);
  await adm('cancelar agendamento'); r = await adm('todos');
  conferir('TODOS', r.status === 'agendar_cancelados' && ag.listarAtivos().length === 0);
  r = await adm('agendamentos');
  conferir('sem nada: diz que não há', r.status === 'agendar_vazio');

  console.log('\n7) Privado de admin e grupo de hangar');
  r = await processar(privado('agendar reiniciar servidor amanhã 03:00'), {});
  conferir('no privado de quem é admin funciona', r.status === 'agendar_confirmar', r.status);
  r = await processar(privado('sim'), {});
  conferir('e agenda para o PRIVADO (é para lá que o aviso vai)', r.status === 'agendado' && ag.listarAtivos()[0].grupoId === ADMIN_PRIV, r.status);
  ag.cancelarTodos();
  r = await processar(grupo(GRUPO_HANGAR, 'agendar reiniciar servidor amanhã 03:00'), {});
  conferir('no grupo de um pátio NÃO agenda nada', !/^agendar/.test(String(r.status)) && ag.listarAtivos().length === 0, r.status);
  r = await adm('ajuda');
  conferir('"ajuda" lista os comandos de agendar', /agendar reiniciar servidor 03:00/.test(r.mensagemWhatsapp) && /agendamentos/.test(r.mensagemWhatsapp));

  console.log('\n8) Executor (tempo fixo)');
  const base = new Date('2026-11-14T05:00:00Z'); // 02:00 em Brasília
  const hora3 = new Date('2026-11-14T06:00:00Z'); // 03:00
  const cena = () => {
    zerar();
    const msgs = []; const feitos = [];
    return {
      msgs, feitos,
      enviar: async (g, t) => { msgs.push([g, t]); },
      acoes: {
        reiniciar: (tipo, o) => { feitos.push(['reiniciar', tipo, o.grupoId]); return { ok: true }; },
        atualizar: (o) => { feitos.push(['atualizar', o.antes]); return { ok: true }; },
      },
    };
  };
  let c = cena();
  ag.criar({ acao: 'servidor', quando: hora3, grupoId: ADM, quem: 'Rodrigo' }, base);
  let f = await executor.rodar({ agora: new Date('2026-11-14T05:40:00Z'), ...c });
  conferir('20 min antes: não faz nada', !f.avisados.length && !f.executados.length && c.msgs.length === 0);
  f = await executor.rodar({ agora: new Date('2026-11-14T05:52:00Z'), ...c });
  conferir('8 min antes: avisa o grupo', f.avisados.length === 1 && /será reiniciado/.test(c.msgs[0][1]) && /03:00/.test(c.msgs[0][1]) && c.msgs[0][0] === ADM, JSON.stringify(c.msgs));
  f = await executor.rodar({ agora: new Date('2026-11-14T05:55:00Z'), ...c });
  conferir('o aviso sai UMA vez só', c.msgs.length === 1 && !f.avisados.length);
  f = await executor.rodar({ agora: new Date('2026-11-14T06:00:10Z'), ...c });
  conferir('na hora: avisa e executa o reinício do servidor, para o grupo certo', f.executados.length === 1 && igual(c.feitos, [['reiniciar', 'servidor', ADM]]) && /Hora do agendamento/.test(c.msgs[1][1]), JSON.stringify(c.feitos));
  f = await executor.rodar({ agora: new Date('2026-11-14T06:01:10Z'), ...c });
  conferir('não executa de novo no minuto seguinte', c.feitos.length === 1 && !f.executados.length);
  conferir('o estado ficou "executado"', Object.values(JSON.parse(fs.readFileSync(ag.ARQUIVO, 'utf-8')))[0].estado === 'executado');

  c = cena();
  ag.criar({ acao: 'servidor', quando: hora3, grupoId: ADM }, base);
  f = await executor.rodar({ agora: new Date('2026-11-14T06:14:00Z'), ...c });
  conferir('14 min atrasado ainda executa (tolerância de 15)', f.executados.length === 1);
  c = cena();
  ag.criar({ acao: 'servidor', quando: hora3, grupoId: ADM }, base);
  f = await executor.rodar({ agora: new Date('2026-11-14T06:20:00Z'), ...c });
  conferir('20 min atrasado: NÃO executa, marca perdido e avisa', f.perdidos.length === 1 && c.feitos.length === 0 && /não foi executado/.test(c.msgs[0][1]), JSON.stringify({ f, m: c.msgs }));
  f = await executor.rodar({ agora: new Date('2026-11-14T06:21:00Z'), ...c });
  conferir('o perdido não é tentado nem avisado de novo', !f.perdidos.length && c.feitos.length === 0 && c.msgs.length === 1);

  c = cena();
  ag.criar({ acao: 'atualizar', quando: hora3, grupoId: ADM, quem: 'Rodrigo' }, base);
  f = await executor.rodar({ agora: new Date('2026-11-14T06:00:05Z'), ...c, verificarAtualizacoes: () => ({ instalaveis: 0, sensiveis: [] }) });
  conferir('atualizar sem nada a instalar: não dispara a instalação e conta', f.semNada.length === 1 && c.feitos.length === 0 && /não há nada para instalar/.test(c.msgs[0][1]));
  c = cena();
  ag.criar({ acao: 'atualizar', quando: hora3, grupoId: ADM, quem: 'Rodrigo' }, base);
  f = await executor.rodar({ agora: new Date('2026-11-14T06:00:05Z'), ...c, verificarAtualizacoes: () => ({ instalaveis: 7, sensiveis: [{ rotulo: 'Docker' }] }) });
  conferir('atualizar com 7 pacotes: dispara a instalação levando a contagem', igual(c.feitos, [['atualizar', 7]]), JSON.stringify(c.feitos));

  c = cena();
  c.acoes.reiniciar = () => ({ ok: false, detalhe: 'sudo: a password is required' });
  ag.criar({ acao: 'servicos', quando: hora3, grupoId: ADM }, base);
  f = await executor.rodar({ agora: new Date('2026-11-14T06:00:05Z'), ...c });
  conferir('se a ação falha: marca erro e avisa o grupo', f.erros.length === 1 && /Não consegui executar/.test(c.msgs.at(-1)[1]) && /password/.test(c.msgs.at(-1)[1]));

  c = cena();
  c.enviar = async () => { throw new Error('WhatsApp fora'); };
  ag.criar({ acao: 'servidor', quando: hora3, grupoId: ADM }, base);
  f = await executor.rodar({ agora: new Date('2026-11-14T06:00:05Z'), ...c });
  conferir('WhatsApp fora do ar NÃO impede o reinício', f.executados.length === 1 && c.feitos.length === 1);

  c = cena();
  ag.criar({ acao: 'servidor', quando: hora3, grupoId: ADM }, base);
  await Promise.all([executor.rodar({ agora: new Date('2026-11-14T06:00:05Z'), ...c }), executor.rodar({ agora: new Date('2026-11-14T06:00:05Z'), ...c })]);
  conferir('duas rodadas ao mesmo tempo: executa UMA vez só', c.feitos.length === 1, String(c.feitos.length));

  c = cena();
  ag.criar({ acao: 'servidor', quando: hora3, grupoId: ADM }, base);
  await executor.rodar({ agora: new Date('2026-11-14T06:00:05Z'), ...c });
  f = await executor.rodar({ agora: new Date('2026-12-20T06:00:00Z'), ...c });
  conferir('o histórico antigo (mais de 30 dias) é podado', f.podados === 1 && Object.keys(JSON.parse(fs.readFileSync(ag.ARQUIVO, 'utf-8'))).length === 0);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
  process.exit(falhas ? 1 : 0);
})().catch((e) => { console.error('teste quebrou:', e); process.exit(1); });
