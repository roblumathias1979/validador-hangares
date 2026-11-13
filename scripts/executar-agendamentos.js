#!/usr/bin/env node
/**
 * executar-agendamentos.js — roda a cada minuto (infra/executar-agendamentos.timer),
 * confere os agendamentos de manutenção (lib/agendamentos.js) e:
 *   - AVISA o grupo ~10 minutos antes ("o servidor será reiniciado às 03:00");
 *   - EXECUTA o que chegou a hora, pelo mesmo caminho dos comandos manuais
 *     (lib/acoes-sistema.js), e conta o resultado ao grupo que agendou;
 *   - NÃO executa o que está atrasado mais de 15 minutos (servidor desligado no
 *     horário, por exemplo): um reinício fora de hora é pior que nenhum. Marca como
 *     perdido e avisa, para reagendar.
 *
 * Cada passo é uma TRANSIÇÃO atômica de estado (pendente -> executando -> executado),
 * então duas execuções sobrepostas nunca rodam o mesmo agendamento duas vezes.
 * Falha ao avisar pelo WhatsApp nunca impede a ação: o aviso é conforto.
 * Sai sempre com código 0.
 */

const path = require('path');

const RAIZ = path.join(__dirname, '..');

const ROTULO_AVISO = {
  servidor: 'O *servidor será reiniciado*',
  servicos: 'Os *serviços serão reiniciados*',
  atualizar: 'As *atualizações do servidor serão instaladas*',
};

/**
 * @param {object} o  { agora, enviar, acoes, verificarAtualizacoes } — tudo injetável para teste
 * @returns {object}  o que foi feito: { avisados, executados, perdidos, semNada, erros, podados }
 */
async function rodar({ agora = new Date(), enviar, acoes, verificarAtualizacoes } = {}) {
  const ag = require('./lib/agendamentos');
  enviar = enviar || require('./lib/evolution').enviarTexto;
  acoes = acoes || require('./lib/acoes-sistema');
  verificarAtualizacoes = verificarAtualizacoes || (() => require('./lib/atualizacoes').verificar(require('./lib/auto-conserto').rodar));
  const aviso = async (grupoId, texto) => { try { await enviar(grupoId, texto); } catch (e) { /* o aviso é conforto */ } };
  const hora = (j) => { const p = ag.partes(new Date(j.quandoIso)); return `${String(p.hora).padStart(2, '0')}:${String(p.minuto).padStart(2, '0')}`; };

  const feito = { avisados: [], executados: [], perdidos: [], semNada: [], erros: [], podados: 0 };
  const { avisar, executar, perdidos } = ag.classificar(agora);

  for (const j of avisar) {
    if (!ag.marcarAviso(j.id, agora)) continue;
    const min = Math.max(1, Math.round((new Date(j.quandoIso).getTime() - agora.getTime()) / 60000));
    await aviso(j.grupoId, `⏰ ${ROTULO_AVISO[j.acao]} às *${hora(j)}* (em ${min} min). O bot fica fora por alguns minutos. Para cancelar: *cancelar agendamento*.`);
    feito.avisados.push(j.id);
  }

  for (const j0 of executar) {
    const j = ag.transicao(j0.id, 'pendente', 'executando');
    if (!j) continue; // outra execução pegou
    const quem = `agendamento de ${j.criadoPor || 'alguém da administração'}`;
    const fim = (estado, resultado) => ag.transicao(j.id, 'executando', estado, { executadoEm: agora.toISOString(), resultado });
    try {
      if (j.acao === 'atualizar') {
        const v = verificarAtualizacoes();
        if (v.erro || !v.instalaveis) {
          fim('sem_nada', v.erro ? `não consegui consultar: ${v.erro}` : 'nada para instalar');
          await aviso(j.grupoId, v.erro
            ? `⚠️ Chegou a hora de instalar as atualizações (${hora(j)}), mas não consegui consultar o que há para instalar. Nada foi feito; mande *atualizar servidor* para ver.`
            : `✅ Hora do agendamento (${hora(j)}): *não há nada para instalar* agora. Nada foi alterado.`);
          feito.semNada.push(j.id);
          continue;
        }
        await aviso(j.grupoId, `🛠️ Hora do agendamento (${hora(j)}): instalando as atualizações agora. O bot pode ficar fora por 1 a 3 minutos — aviso aqui quando terminar.`);
        const r = acoes.atualizar({ grupoId: j.grupoId, quem, antes: v.instalaveis, sensiveis: v.sensiveis.map((x) => x.rotulo) });
        if (r.ok) { fim('executado', 'instalação iniciada'); feito.executados.push(j.id); } else throw new Error(r.detalhe);
      } else {
        await aviso(j.grupoId, `🔄 Hora do agendamento (${hora(j)}): ${j.acao === 'servidor' ? 'reiniciando o *servidor*' : 'reiniciando os *serviços*'} agora. Aviso aqui quando voltar.`);
        const r = acoes.reiniciar(j.acao, { grupoId: j.grupoId, quem });
        if (r.ok) { fim('executado', 'reinício iniciado'); feito.executados.push(j.id); } else throw new Error(r.detalhe);
      }
    } catch (erro) {
      fim('erro', String(erro.message || erro).slice(0, 200));
      await aviso(j.grupoId, `⚠️ Não consegui executar o agendamento das ${hora(j)}: ${String(erro.message || erro).slice(0, 150)}. O suporte técnico precisa ver (infra/README.md).`);
      feito.erros.push(j.id);
    }
  }

  for (const j0 of perdidos) {
    const j = ag.transicao(j0.id, 'pendente', 'perdido', { executadoEm: agora.toISOString(), resultado: 'atrasado demais para executar' });
    if (!j) continue;
    await aviso(j.grupoId, `⚠️ O agendamento das *${hora(j)}* (${ag.ACOES[j.acao].rotulo}) *não foi executado*: o servidor estava fora do ar ou atrasado mais de ${ag.TOLERANCIA_MIN} minutos, e uma ação de manutenção fora de hora é pior que nenhuma. Reagende se ainda quiser.`);
    feito.perdidos.push(j.id);
  }

  feito.podados = ag.podar(agora);
  return feito;
}

async function main() {
  require('dotenv').config({ path: path.join(RAIZ, '.env'), override: true });
  const r = await rodar();
  if (r.avisados.length || r.executados.length || r.perdidos.length || r.semNada.length || r.erros.length) console.log(JSON.stringify({ em: new Date().toISOString(), ...r }));
}

if (require.main === module) {
  main().catch((e) => console.log(JSON.stringify({ status: 'erro', mensagem: e.message }))).then(() => process.exit(0));
}

module.exports = { rodar };
