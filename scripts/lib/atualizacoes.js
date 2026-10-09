/**
 * atualizacoes.js — o que há para atualizar no servidor (apt), em linguagem de
 * quem administra. Só LÊ: quem instala é a unidade systemd
 * infra/atualizar-servidor.service, disparada pelo comando "atualizar servidor".
 *
 * Duas fontes, porque nenhuma sozinha responde "o que vai ser instalado":
 *  - `apt list --upgradable`: tudo que tem versão nova (inclusive o que o Ubuntu
 *    está liberando aos poucos);
 *  - `apt-get -s upgrade` (simulação, sem root): o que o upgrade de fato
 *    instalaria agora. A diferença são os pacotes em liberação gradual, que o
 *    Ubuntu segura de propósito — não se força a instalação deles.
 *
 * Os parsers são puros (texto -> dados) para testar sem tocar no servidor.
 */

const fs = require('fs');

// Pacotes que, ao atualizar, mexem nos serviços do projeto ou exigem reinício
// para valer. Rótulo = o que o admin entende.
const SENSIVEIS = [
  { re: /^(docker-ce|docker-ce-cli|containerd\.io|docker-compose-plugin)$/, rotulo: 'Docker (a Evolution/WhatsApp pode ficar fora 1 a 2 min)' },
  { re: /^nodejs$/, rotulo: 'Node (roda o n8n e os scripts)' },
  { re: /^caddy$/, rotulo: 'Caddy (o painel pode cair por alguns segundos)' },
  { re: /^openssh-(server|client|sftp-server)$/, rotulo: 'SSH' },
  { re: /^(apparmor|libapparmor1)$/, rotulo: 'AppArmor (segurança; vale reiniciar o servidor)' },
  { re: /^(linux-image\S*|linux-aws\S*|linux-modules\S*|grub\S*)$/, rotulo: 'Kernel/boot (exige reiniciar o servidor)' },
];

/** `apt list --upgradable` -> [{nome, origem, nova, antiga, seguranca}] */
function parseListaAtualizaveis(texto) {
  const itens = [];
  for (const linha of String(texto || '').split('\n')) {
    const m = linha.match(/^([^\s/]+)\/(\S+)\s+(\S+)\s+\S+\s+\[upgradable from:\s*(\S+)\]/);
    if (m) itens.push({ nome: m[1], origem: m[2], nova: m[3], antiga: m[4], seguranca: /security/.test(m[2]) });
  }
  return itens;
}

/** `apt-get -s upgrade` -> nomes que seriam instalados agora. */
function parseSimulacao(texto) {
  const nomes = [];
  for (const linha of String(texto || '').split('\n')) {
    const m = linha.match(/^Inst\s+(\S+)/);
    if (m) nomes.push(m[1]);
  }
  return nomes;
}

function resumir(lista, instalaveis, reinicioPendente = false) {
  const aInstalar = lista.filter((p) => instalaveis.includes(p.nome));
  const seguradas = lista.filter((p) => !instalaveis.includes(p.nome));
  const sensiveis = [];
  for (const s of SENSIVEIS) {
    const nomes = aInstalar.filter((p) => s.re.test(p.nome)).map((p) => p.nome);
    if (nomes.length) sensiveis.push({ rotulo: s.rotulo, nomes });
  }
  return {
    total: lista.length,
    instalaveis: aInstalar.length,
    seguranca: aInstalar.filter((p) => p.seguranca).length,
    seguradas: seguradas.map((p) => p.nome),
    sensiveis,
    reinicioPendente,
  };
}

/** Lê o servidor (sem root) e devolve o resumo; `erro` se não deu para ler. */
function verificar(rodar) {
  const lista = rodar('apt', ['list', '--upgradable'], 60000);
  if (!lista.ok) return { erro: lista.erro };
  const sim = rodar('apt-get', ['-s', 'upgrade'], 60000);
  if (!sim.ok) return { erro: sim.erro };
  const reinicio = fs.existsSync('/var/run/reboot-required');
  return resumir(parseListaAtualizaveis(lista.saida), parseSimulacao(sim.saida), reinicio);
}

/** Texto do relatório para o WhatsApp. */
function relatorio(r) {
  if (r.erro) return `⚠️ Não consegui consultar as atualizações: ${r.erro}`;
  const linhas = ['🔎 *Atualizações do servidor*', ''];
  if (!r.instalaveis) {
    linhas.push('✅ Nada para instalar agora.');
  } else {
    linhas.push(`📦 *${r.instalaveis}* pacote(s) para instalar${r.seguranca ? `, *${r.seguranca}* de segurança` : ''}.`);
    if (r.sensiveis.length) {
      linhas.push('', '*Atenção — mexem nos serviços:*', ...r.sensiveis.map((s) => `• ${s.rotulo}`));
    }
  }
  if (r.seguradas.length) {
    linhas.push('', `⏳ ${r.seguradas.length} em liberação gradual do Ubuntu (entram sozinhos nos próximos dias): ${r.seguradas.slice(0, 6).join(', ')}${r.seguradas.length > 6 ? '…' : ''}.`);
  }
  if (r.reinicioPendente) linhas.push('', '🔁 O servidor está *esperando um reinício* para aplicar atualizações já instaladas.');
  linhas.push('', '_A lista é a do dia (o Ubuntu a atualiza sozinho uma vez por dia)._');
  return linhas.join('\n');
}

/**
 * Texto do aviso mensal — ou null quando não há nada a dizer (sem atualização
 * para instalar e sem reinício pendente): aviso que repete "tudo certo" todo
 * mês vira ruído, e ruído ensina o grupo a ignorar o aviso que importa.
 */
function mensagemAvisoMensal(r) {
  if (!r || r.erro) return null;
  if (!r.instalaveis && !r.reinicioPendente) return null;
  return `🗓️ *Aviso mensal do servidor*\n\n${relatorio(r)}\n\nPara instalar, mande *atualizar servidor* → *2*. Faça num horário calmo.`;
}

module.exports = { mensagemAvisoMensal, parseListaAtualizaveis, parseSimulacao, resumir, verificar, relatorio, SENSIVEIS };
