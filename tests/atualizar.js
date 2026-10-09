#!/usr/bin/env node
/**
 * Comando "atualizar servidor" (09/10/2026): menu 1) procurar (só lê) 2) instalar
 * (com SIM). Protege: o parser; a leitura do `apt list` (com a saída REAL do
 * servidor de 09/10); a diferença entre "tem versão nova" e "será instalado
 * agora" (liberação gradual); e o fluxo — procurar nunca instala, instalar só
 * depois do SIM, falha do sudo avisa em vez de fingir.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const ADMGRUPO = '120363432317888806@g.us';
const PESSOA = '5511999999999@s.whatsapp.net';
const PEDIDO = path.join(RAIZ, 'data', 'atualizacao-pedido.json');

require('./cenario').montar({});

const { interpretarPedidoAtualizar, interpretarPedidoReiniciar, interpretarPedidoConserto } = require(path.join(RAIZ, 'scripts', 'lib', 'whatsapp.js'));
const autoConserto = require(path.join(RAIZ, 'scripts', 'lib', 'auto-conserto.js'));
const atualizacoes = require(path.join(RAIZ, 'scripts', 'lib', 'atualizacoes.js'));

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

console.log('1) Parser');
for (const t of ['atualizar servidor', 'atualiza o sistema', 'atualizar os pacotes', 'tem atualização pendente no servidor?', 'Atualizar Servidor!']) {
  conferir(`"${t}"`, interpretarPedidoAtualizar(t) === true);
}
for (const t of ['atualizar', 'recarregar sistema', 'reiniciar sistema', 'consertar', 'status do sistema', 'atualizar o cadastro do João', 'bom dia']) {
  conferir(`"${t}" NÃO é atualizar`, interpretarPedidoAtualizar(t) === false);
}
conferir('"atualizar servidor" não é reiniciar nem conserto', !interpretarPedidoReiniciar('atualizar servidor') && !interpretarPedidoConserto('atualizar servidor'));

console.log('\n2) Leitura do apt (saída real do servidor, 09/10/2026)');
const LISTA = `Listing...
caddy/any-version 2.11.7 amd64 [upgradable from: 2.11.4]
docker-ce/resolute 5:29.8.2-1~ubuntu.26.04~resolute amd64 [upgradable from: 5:29.8.1-1~ubuntu.26.04~resolute]
nodejs/nodistro 22.23.3-1nodesource1 amd64 [upgradable from: 22.23.2-1nodesource1]
openssh-server/resolute-updates 1:10.2p1-2ubuntu3.7 amd64 [upgradable from: 1:10.2p1-2ubuntu3.6]
openssl/resolute-updates,resolute-security 3.5.5-1 amd64 [upgradable from: 3.5.4-1]
apparmor/resolute-updates 5.0.2-0ubuntu1~26.04.1 amd64 [upgradable from: 5.0.0~beta1-0ubuntu7]
`;
const SIM = `Reading package lists...
Inst caddy [2.11.4] (2.11.7 any-version [amd64])
Inst docker-ce [5:29.8.1] (5:29.8.2 resolute [amd64])
Inst nodejs [22.23.2] (22.23.3 nodistro [amd64])
Inst openssl [3.5.4-1] (3.5.5-1 resolute-updates,resolute-security [amd64])
Conf caddy (2.11.7 any-version [amd64])
`;
const lista = atualizacoes.parseListaAtualizaveis(LISTA);
conferir('lê 6 pacotes (ignora "Listing...")', lista.length === 6, String(lista.length));
conferir('lê versão antiga e nova', lista[0].nome === 'caddy' && lista[0].antiga === '2.11.4' && lista[0].nova === '2.11.7');
conferir('marca segurança pela origem', lista.find((p) => p.nome === 'openssl').seguranca === true && lista.find((p) => p.nome === 'caddy').seguranca === false);
const inst = atualizacoes.parseSimulacao(SIM);
conferir('simulação: só as linhas "Inst"', inst.join() === 'caddy,docker-ce,nodejs,openssl', inst.join());
const r = atualizacoes.resumir(lista, inst, false);
conferir('instaláveis = 4 (o resto está em liberação gradual)', r.instalaveis === 4 && r.seguradas.join() === 'openssh-server,apparmor', `${r.instalaveis} / ${r.seguradas}`);
conferir('1 de segurança', r.seguranca === 1);
conferir('avisa Docker, Node e Caddy', ['Docker', 'Node', 'Caddy'].every((n) => r.sensiveis.some((s) => s.rotulo.startsWith(n))));
const txt = atualizacoes.relatorio(r);
conferir('relatório cita liberação gradual', /liberação gradual/.test(txt) && /openssh-server/.test(txt));
conferir('relatório sem nada a instalar', /Nada para instalar/.test(atualizacoes.relatorio(atualizacoes.resumir([], [], false))));

console.log('\n3) Fluxo no grupo admin');
(async () => {
  const agendados = [];
  let sudoOk = true;
  let resumo = r;
  autoConserto.agendarReinicio = (tipo) => { agendados.push(tipo); return sudoOk ? { ok: true, detalhe: 'agendado' } : { ok: false, detalhe: 'sudo: a password is required' }; };
  atualizacoes.verificar = () => resumo;

  const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));
  const pendencias = require(path.join(RAIZ, 'scripts', 'lib', 'pendencias.js'));
  const enviar = async (texto) => processar({ data: { key: { remoteJid: ADMGRUPO, fromMe: false, id: `A${Math.random()}`, participant: PESSOA }, pushName: 'Admin', message: { conversation: texto } } }, {});
  const limpar = () => { pendencias.consumir(ADMGRUPO, PESSOA); try { fs.unlinkSync(PEDIDO); } catch (e) { /* ok */ } };
  limpar();

  let m = await enviar('atualizar servidor');
  conferir('abre o menu', m.status === 'atualizar_menu', m.status);
  conferir('menu sozinho não instala', agendados.length === 0);

  m = await enviar('1');
  conferir('opção 1 mostra o relatório e oferece instalar', m.status === 'atualizar_confirmar' && /4 pacote/.test(m.mensagemWhatsapp) && /SIM/.test(m.mensagemWhatsapp), m.status);
  conferir('procurar NÃO instalou', agendados.length === 0);
  m = await enviar('não');
  conferir('NÃO depois do relatório cancela', m.status === 'atualizar_cancelado' && agendados.length === 0, m.status);

  await enviar('atualizar servidor');
  m = await enviar('2');
  conferir('opção 2 pede confirmação, sem instalar ainda', m.status === 'atualizar_confirmar' && agendados.length === 0, m.status);
  m = await enviar('talvez');
  conferir('resposta solta não instala', m.status === 'atualizar_confirma_nao_entendido' && agendados.length === 0, m.status);
  m = await enviar('sim');
  conferir('SIM agenda a atualização', m.status === 'atualizando_servidor' && agendados.join() === 'atualizar', `${m.status} / ${agendados}`);
  const ped = fs.existsSync(PEDIDO) ? JSON.parse(fs.readFileSync(PEDIDO, 'utf-8')) : null;
  conferir('grava o pedido (grupo e quantos pacotes)', ped && ped.grupoId === ADMGRUPO && ped.antes === 4, JSON.stringify(ped));
  limpar(); agendados.length = 0;

  resumo = atualizacoes.resumir([], [], false);
  await enviar('atualizar servidor');
  m = await enviar('2');
  conferir('sem nada a instalar: avisa e não pergunta', m.status === 'atualizar_nada' && agendados.length === 0, m.status);
  resumo = r;

  await enviar('atualizar servidor');
  m = await enviar('cancelar');
  conferir('CANCELAR no menu', m.status === 'atualizar_cancelado', m.status);

  await enviar('atualizar servidor');
  m = await enviar('quero o 3');
  conferir('opção inválida pede de novo', m.status === 'atualizar_nao_entendido', m.status);
  limpar();

  resumo = { erro: 'apt travado' };
  await enviar('atualizar servidor');
  m = await enviar('1');
  conferir('erro ao consultar: avisa', m.status === 'atualizar_erro' && /apt travado/.test(m.mensagemWhatsapp), m.status);
  resumo = r;
  limpar();

  sudoOk = false;
  await enviar('atualizar servidor'); await enviar('2');
  m = await enviar('sim');
  conferir('sudo negado: avisa em vez de fingir', m.status === 'atualizar_erro' && /Não consegui iniciar/.test(m.mensagemWhatsapp) && m.notificarAdmin === true, m.status);
  conferir('sudo negado: não deixa pedido pendurado', !fs.existsSync(PEDIDO));
  limpar();

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
  process.exit(falhas ? 1 : 0);
})();
