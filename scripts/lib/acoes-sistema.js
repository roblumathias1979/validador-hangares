/**
 * acoes-sistema.js — as ações de manutenção do servidor que a administração pode
 * pedir (reiniciar serviços, reiniciar o servidor, instalar atualizações), num lugar
 * só. Quem usa: os comandos "reiniciar sistema" e "atualizar servidor" (WhatsApp) e
 * o AGENDADOR (scripts/executar-agendamentos.js) — assim o que roda no horário
 * marcado é exatamente o que roda quando alguém manda o comando na hora.
 *
 * Cada ação grava o pedido (para o aviso "voltei"/"concluída" saber a que grupo
 * responder) e dispara a unidade systemd correspondente via sudo, que espera uns
 * segundos antes de agir (ver agendarReinicio em auto-conserto.js).
 */

const fs = require('fs');
const path = require('path');
const { salvarAtomico } = require('./trava-arquivo');

const DADOS = path.join(__dirname, '..', '..', 'data');
const REINICIO_PEDIDO = path.join(DADOS, 'reinicio-pedido.json');
const ATUALIZACAO_PEDIDO = path.join(DADOS, 'atualizacao-pedido.json');

/** tipo: 'servicos' | 'servidor'. Devolve {ok, detalhe}. */
function reiniciar(tipo, { grupoId, quem = null } = {}) {
  const autoConserto = require('./auto-conserto'); // lido na hora: o teste troca agendarReinicio
  try {
    salvarAtomico(REINICIO_PEDIDO, { grupoId, tipo, quem, em: Date.now() });
  } catch (e) { /* o aviso "voltei" é conforto; o reinício não depende dele */ }
  const r = autoConserto.agendarReinicio(tipo);
  if (!r.ok) { try { fs.unlinkSync(REINICIO_PEDIDO); } catch (e) { /* já não existe */ } }
  return r;
}

/** Instala as atualizações. `antes`/`sensiveis` vêm da consulta feita antes (para o relatório final). */
function atualizar({ grupoId, quem = null, antes = 0, sensiveis = [] } = {}) {
  const autoConserto = require('./auto-conserto');
  try {
    salvarAtomico(ATUALIZACAO_PEDIDO, { grupoId, quem, em: Date.now(), antes, sensiveis });
  } catch (e) { /* o aviso final é conforto; a instalação não depende dele */ }
  const r = autoConserto.agendarReinicio('atualizar');
  if (!r.ok) { try { fs.unlinkSync(ATUALIZACAO_PEDIDO); } catch (e) { /* já não existe */ } }
  return r;
}

module.exports = { reiniciar, atualizar, REINICIO_PEDIDO, ATUALIZACAO_PEDIDO };
