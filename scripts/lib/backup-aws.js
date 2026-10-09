/**
 * backup-aws.js — quando foi o ÚLTIMO snapshot do disco (o backup diário do
 * Data Lifecycle Manager). Para o "status do sistema" mostrar se o backup
 * realmente está sendo feito: uma política que parou em silêncio é pior que
 * nenhuma, porque dá a sensação de proteção.
 *
 * Consulta a AWS com a `aws` CLI usando o PERFIL DA INSTÂNCIA (IAM role), sem
 * chave guardada no servidor. A role só precisa de `ec2:DescribeSnapshots`
 * (leitura) — ver infra/README.md. Sem a CLI ou sem a permissão, devolve
 * `indisponivel` e o status diz isso em vez de inventar.
 */

const REGIAO = process.env.AWS_REGION || 'us-east-2';
const H = 3600 * 1000;

/** Consulta o snapshot mais recente. `rodar` = auto-conserto.rodar. */
function ultimoSnapshot(rodar) {
  const r = rodar('aws', [
    'ec2', 'describe-snapshots', '--owner-ids', 'self', '--region', REGIAO,
    '--query', 'sort_by(Snapshots,&StartTime)[-1].[StartTime,State]', '--output', 'json',
  ], 20000);
  if (!r.ok) return { indisponivel: true, motivo: /not found|ENOENT/i.test(r.erro) ? 'a CLI da AWS não está instalada no servidor' : 'sem permissão de leitura na AWS' };
  try {
    const v = JSON.parse(r.saida);
    if (!Array.isArray(v) || !v[0]) return { nenhum: true };
    return { em: v[0], estado: v[1] };
  } catch (e) { return { indisponivel: true, motivo: 'resposta ilegível da AWS' }; }
}

/** {cor, texto, problema}: a linha de backup do status. Pura. */
function avaliar(s, agora = Date.now()) {
  if (!s || s.indisponivel) return { cor: '⚪', texto: `Backup: não consegui consultar (${(s && s.motivo) || 'sem dados'})`, problema: false };
  if (s.nenhum) return { cor: '🔴', texto: 'Backup: nenhum snapshot encontrado', problema: true };
  const idadeH = (agora - new Date(s.em).getTime()) / H;
  const quando = new Date(s.em).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
  const ha = idadeH < 1 ? 'há minutos' : idadeH < 48 ? `há ${Math.round(idadeH)} h` : `há ${Math.floor(idadeH / 24)} dias`;
  const andamento = s.estado === 'pending' ? ' (em andamento)' : '';
  // Backup diário: até ~30 h é normal; passou de 2 dias, a política parou.
  const cor = idadeH <= 30 ? '🟢' : idadeH <= 50 ? '🟡' : '🔴';
  return { cor, texto: `Último backup: ${quando} (${ha})${andamento}`, problema: cor === '🔴' };
}

module.exports = { ultimoSnapshot, avaliar };
