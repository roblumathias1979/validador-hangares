/**
 * unidades.js — cadastro das unidades que mandam fechamento de caixa e a
 * lógica que decide de qual unidade é uma foto recebida.
 *
 * MUDANÇA DE DESENHO (25/09/2026): o usuário decidiu criar um GRUPO DE
 * WHATSAPP PRÓPRIO POR UNIDADE (reaproveitando o mesmo número/instância da
 * Evolution API do validador de hangares) — mesmo padrão daquele projeto
 * (config/hangares.json + buscarHangarPorGrupo). O grupo passa a ser o sinal
 * AUTORITATIVO: é administrado por quem configura o bot, não digitado por
 * quem manda a foto, então não sofre do problema que telefone/legenda/nome
 * impresso têm (todos são "confiar no que a pessoa escreveu/mandou").
 *
 * Ainda assim cruzamos o grupo com o NOME IMPRESSO no relatório (ou a
 * legenda da foto, quando o nome não veio) — não para decidir a unidade, mas
 * para PEGAR O CASO DE ALGUÉM POSTAR NO GRUPO ERRADO (ex: fechamento do Ibis
 * Styles fotografado e mandado sem querer no grupo do Argentina Mall). Isso
 * vira um alerta, não um bloqueio: o grupo continua sendo a fonte da
 * verdade, porque é o canal real por onde a mensagem chegou.
 *
 * NÃO usa CNPJ como sinal: o usuário confirmou que existem máquinas de
 * cartão em unidades diferentes compartilhando o mesmo CNPJ.
 */

const fs = require('fs');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), override: true });

const CONFIG_PATH = path.join(__dirname, '..', '..', 'config', 'unidades.json');

function carregarConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    throw new Error(`Arquivo de configuração não encontrado: ${CONFIG_PATH}.`);
  }
  return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
}

/** Sem acento e em minúsculas, para comparar sem depender de como foi digitado. */
function normalizar(texto) {
  return String(texto || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
}

/**
 * Acha a unidade dona de um grupo de WhatsApp. Lança quando o grupo não está
 * cadastrado em NENHUMA unidade, ou quando está cadastrado em MAIS DE UMA —
 * os dois são erro de configuração, não algo que o cliente resolve, e quem
 * chama (processar-fechamento.js) decide o que fazer (mesmo padrão de
 * buscarHangarPorGrupo no validador de hangares).
 */
function buscarUnidadePorGrupo(config, grupoId) {
  const id = (grupoId || '').trim();
  if (!id) {
    throw new Error('ID do grupo de WhatsApp não informado — sem ele não há como saber de qual unidade é o fechamento.');
  }

  // Unidade com grupoWhatsappId vazio ainda não foi cadastrada, e precisa
  // ficar fora da busca: senão um grupoId vazio casaria com ela por engano.
  const cadastradas = config.unidades.filter((u) => (u.grupoWhatsappId || '').trim());
  const achadas = cadastradas.filter((u) => u.grupoWhatsappId.trim() === id);

  if (achadas.length > 1) {
    throw new Error(`Grupo "${id}" está cadastrado em mais de uma unidade (${achadas.map((u) => u.id).join(', ')}) em config/unidades.json — cada grupo tem que pertencer a uma única unidade.`);
  }
  if (achadas.length === 0) {
    const conhecidas = cadastradas.length
      ? cadastradas.map((u) => `${u.id}=${u.grupoWhatsappId}`).join(', ')
      : 'nenhuma unidade tem grupoWhatsappId preenchido ainda';
    throw new Error(`Grupo "${id}" não está cadastrado em config/unidades.json (grupos conhecidos: ${conhecidas}).`);
  }
  return achadas[0];
}

/**
 * Casa um texto livre (legenda da foto, ou nome lido pelo OCR no relatório)
 * contra nome/apelidos das unidades. Devolve null tanto quando NENHUMA
 * unidade casa quanto quando MAIS DE UMA casa — texto ambíguo não deve
 * apontar uma unidade específica.
 */
function buscarPorTexto(config, texto) {
  const alvo = normalizar(texto);
  if (!alvo) return null;
  const achados = config.unidades.filter((u) => {
    const nomes = [u.nome, ...(u.apelidos || [])].map(normalizar).filter(Boolean);
    return nomes.some((n) => n && alvo.includes(n));
  });
  return achados.length === 1 ? achados[0] : null;
}

/**
 * Identifica a unidade PELO GRUPO (autoritativo — lança se o grupo não
 * estiver cadastrado, quem chama decide o que fazer) e cruza com o nome
 * impresso no relatório/legenda só para alertar divergência, nunca para
 * decidir a unidade no lugar do grupo.
 */
function identificarUnidade(config, { grupoId, legenda, unidadeImpressa } = {}) {
  const unidade = buscarUnidadePorGrupo(config, grupoId); // lança se não cadastrado

  const porTexto = buscarPorTexto(config, unidadeImpressa) || buscarPorTexto(config, legenda);
  const divergente = Boolean(porTexto && porTexto.id !== unidade.id);

  return {
    status: 'identificada',
    unidade,
    confianca: divergente ? 'baixa' : 'alta',
    sinais: ['grupo'],
    alerta: divergente
      ? `o nome impresso no relatório (ou a legenda) parece ser da unidade "${porTexto.nome}", mas a foto chegou no grupo de "${unidade.nome}" — confira se não foi mandada no grupo errado.`
      : null,
  };
}

module.exports = { carregarConfig, normalizar, buscarUnidadePorGrupo, buscarPorTexto, identificarUnidade, CONFIG_PATH };
