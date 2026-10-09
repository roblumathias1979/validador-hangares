#!/usr/bin/env node
/**
 * Comando "reiniciar sistema" (09/10/2026): o grupo de administração recebe um
 * menu — 1) só serviços, 2) servidor inteiro (com SIM) — e o reinício é
 * AGENDADO, nunca executado no meio da resposta.
 *
 * Protege: o parser; o menu; opção 1 direto; opção 2 só depois do SIM; NÃO e
 * CANCELAR não reiniciam; resposta solta não reinicia; falha do sudo avisa em
 * vez de dizer que reiniciou; e "consertar" não responde por "reiniciar".
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const ADMGRUPO = '120363432317888806@g.us';
const PESSOA = '5511999999999@s.whatsapp.net';
const PEDIDO = path.join(RAIZ, 'data', 'reinicio-pedido.json');

require('./cenario').montar({});

const { interpretarPedidoReiniciar, interpretarPedidoConserto } = require(path.join(RAIZ, 'scripts', 'lib', 'whatsapp.js'));
const autoConserto = require(path.join(RAIZ, 'scripts', 'lib', 'auto-conserto.js'));

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

console.log('1) Parser');
for (const t of ['reiniciar sistema', 'reiniciar o sistema', 'reinicia o servidor', 'reiniciar', 'reboot', 'reiniciar o bot', 'Reiniciar Sistema!']) {
  conferir(`"${t}"`, interpretarPedidoReiniciar(t) === true);
}
for (const t of ['recarregar sistema', 'consertar', 'status do sistema', 'bom dia', 'reiniciei o celular ontem e agora o grupo sumiu do pátio do Solojet']) {
  conferir(`"${t}" NÃO é reiniciar`, interpretarPedidoReiniciar(t) === false);
}
conferir('"consertar" segue sendo conserto', interpretarPedidoConserto('consertar') === true);
conferir('"reiniciar sistema" NÃO é mais conserto', interpretarPedidoConserto('reiniciar sistema') === false);

console.log('\n2) Fluxo no grupo admin');
(async () => {
  const agendados = [];
  let sudoOk = true;
  autoConserto.agendarReinicio = (tipo) => { agendados.push(tipo); return sudoOk ? { ok: true, detalhe: 'agendado' } : { ok: false, detalhe: 'sudo: a password is required' }; };

  const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));
  const pendencias = require(path.join(RAIZ, 'scripts', 'lib', 'pendencias.js'));
  const enviar = async (texto) => processar({ data: { key: { remoteJid: ADMGRUPO, fromMe: false, id: `R${Math.random()}`, participant: PESSOA }, pushName: 'Admin', message: { conversation: texto } } }, {});
  const limpar = () => { pendencias.consumir(ADMGRUPO, PESSOA); try { fs.unlinkSync(PEDIDO); } catch (e) { /* ok */ } };
  limpar();

  let r = await enviar('reiniciar sistema');
  conferir('abre o menu', r.status === 'reiniciar_menu', r.status);
  conferir('menu oferece 1 e 2', /\*1\*/.test(r.mensagemWhatsapp) && /\*2\*/.test(r.mensagemWhatsapp));
  conferir('menu sozinho não reinicia nada', agendados.length === 0);

  r = await enviar('1');
  conferir('opção 1 reinicia só serviços', r.status === 'reiniciando_servicos' && agendados.join() === 'servicos', `${r.status} / ${agendados}`);
  conferir('grava o pedido para o aviso "voltei"', fs.existsSync(PEDIDO) && JSON.parse(fs.readFileSync(PEDIDO, 'utf-8')).grupoId === ADMGRUPO);
  limpar(); agendados.length = 0;

  await enviar('reiniciar sistema');
  r = await enviar('2');
  conferir('opção 2 pede confirmação', r.status === 'reiniciar_confirmar', r.status);
  conferir('opção 2 ainda não reiniciou', agendados.length === 0);
  r = await enviar('talvez');
  conferir('resposta solta não reinicia', r.status === 'reiniciar_confirma_nao_entendido' && agendados.length === 0, r.status);
  r = await enviar('sim');
  conferir('SIM reinicia o servidor', r.status === 'reiniciando_servidor' && agendados.join() === 'servidor', `${r.status} / ${agendados}`);
  limpar(); agendados.length = 0;

  await enviar('reiniciar sistema'); await enviar('2');
  r = await enviar('não');
  conferir('NÃO cancela', r.status === 'reiniciar_cancelado' && agendados.length === 0, r.status);

  await enviar('reiniciar sistema');
  r = await enviar('cancelar');
  conferir('CANCELAR no menu', r.status === 'reiniciar_cancelado' && agendados.length === 0, r.status);

  await enviar('reiniciar sistema');
  r = await enviar('quero o 3');
  conferir('opção inválida pede de novo', r.status === 'reiniciar_nao_entendido' && agendados.length === 0, r.status);
  limpar();

  sudoOk = false;
  await enviar('reiniciar sistema');
  r = await enviar('1');
  conferir('sudo negado: avisa em vez de dizer que reiniciou', r.status === 'reiniciar_erro' && /Não consegui reiniciar/.test(r.mensagemWhatsapp) && r.notificarAdmin === true, r.status);
  conferir('sudo negado: não deixa pedido pendurado', !fs.existsSync(PEDIDO));
  limpar();

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
  process.exit(falhas ? 1 : 0);
})();
