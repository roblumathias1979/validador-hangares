/**
 * auto-conserto.js — o runbook que o comando "consertar" executa.
 *
 * Filosofia: só faz o que é SEGURO e REVERSÍVEL por conta própria — reiniciar
 * um serviço que caiu, compactar log que encheu o disco, ligar a contingência
 * quando o ValidPark está fora. O que depende de gente (recarregar crédito,
 * reconectar o celular, o servidor do aeroporto) ele NÃO tenta fazer de araque:
 * diz o que é, para a pessoa certa agir. Nada aqui edita código nem valida
 * ticket — é operação de infra, não decisão de negócio.
 *
 * `acoesPara` é a decisão (pura, testável); as outras funções executam.
 */

/** Roda um comando sem shell. Nunca lança: devolve {ok, saida|erro}. */
function rodar(cmd, args, timeout = 20000) {
  try {
    const out = require('child_process').execFileSync(cmd, args, { encoding: 'utf-8', timeout });
    return { ok: true, saida: String(out || '').trim() };
  } catch (e) {
    return { ok: false, erro: String((e && (e.stderr || e.message)) || e).slice(0, 200) };
  }
}

/** Reinicia um serviço systemd e confere se ficou ativo. */
function reiniciarServico(nome) {
  const r = rodar('sudo', ['systemctl', 'restart', nome]);
  if (!r.ok) return { ok: false, nome, detalhe: `não consegui reiniciar (${r.erro})` };
  const st = rodar('systemctl', ['is-active', nome]);
  const ativo = st.ok && st.saida === 'active';
  return { ok: ativo, nome, detalhe: ativo ? 'reiniciado e no ar' : `reiniciei, mas está "${st.saida || st.erro}"` };
}

/** Compacta os logs do journald, que são o que normalmente enche o disco. */
function liberarDisco() {
  const r = rodar('sudo', ['journalctl', '--vacuum-size=200M']);
  return r.ok ? { ok: true, detalhe: 'logs do sistema compactados' } : { ok: false, detalhe: `não consegui compactar logs (${r.erro})` };
}

/** Últimas linhas de aviso/erro de um serviço — para o relatório e para quem for investigar. */
function logsRecentes(servico, n = 25) {
  const r = rodar('journalctl', ['-u', servico, '-n', String(n), '--no-pager', '-p', 'warning']);
  return r.ok ? r.saida : `(sem logs de ${servico}: ${r.erro})`;
}

/**
 * Dado o conjunto de problemas detectados, decide O QUE FAZER. Puro: não
 * executa nada, só devolve o plano — por isso dá para testar sem tocar no
 * servidor. `problemas` é uma lista de chaves ('n8n','disco','validpark',
 * 'anthropic','whatsapp','coletor'); `contingenciaLigada` evita religar o que
 * já está contornado.
 */
function acoesPara(problemas, { contingenciaLigada = false } = {}) {
  const tem = (p) => problemas.includes(p);
  const automaticas = []; // {tipo, alvo, rotulo}
  const manuais = [];     // rótulos para a pessoa certa agir

  if (tem('n8n')) automaticas.push({ tipo: 'reiniciar', alvo: 'n8n.service', rotulo: 'reiniciar o fluxo (n8n)' });
  if (tem('painel')) automaticas.push({ tipo: 'reiniciar', alvo: 'painel-validador.service', rotulo: 'reiniciar o painel' });
  if (tem('disco')) automaticas.push({ tipo: 'liberar_disco', rotulo: 'liberar espaço em disco' });
  if (tem('validpark') && !contingenciaLigada) automaticas.push({ tipo: 'ligar_contingencia', rotulo: 'ligar a contingência (validar pelo aeroporto)' });

  if (tem('validpark') && contingenciaLigada) manuais.push('ℹ️ ValidPark fora, mas a *contingência já está ligada* — validações seguem pelo aeroporto. Desligue quando ele voltar.');
  if (tem('anthropic')) manuais.push('👉 Leitura de fotos parada (crédito/chave da Anthropic). Responda *recarregar sistema* — e, se recarregou, *recarreguei US$ <valor>*. (isso eu não compro sozinho)');
  if (tem('whatsapp')) manuais.push('🔧 Sessão do WhatsApp caída — precisa reconectar o celular (QR). O suporte técnico resolve. (se você recebeu esta mensagem, a sessão voltou)');
  if (tem('coletor')) manuais.push('🔧 Coletor do aeroporto sem enviar dados — é no servidor do aeroporto (AnyDesk) ou suporte técnico.');

  return { automaticas, manuais };
}

module.exports = { rodar, reiniciarServico, liberarDisco, logsRecentes, acoesPara };
