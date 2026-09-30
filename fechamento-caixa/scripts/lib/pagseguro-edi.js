/**
 * pagseguro-edi.js — cliente da API de Conciliação (Extrato EDI) do PagBank,
 * pesquisada de verdade em 30/09/2026 na documentação oficial
 * (developer.pagbank.com.br) antes de escrever qualquer linha — não é
 * adivinhação de endpoint.
 *
 * CONFIRMADO na documentação pública:
 *   - Endpoint: https://edi.api.pagbank.com.br/movement/v3.00/{tipo}/{AAAA-MM-DD}
 *     com {tipo} em transactional|financial|cashouts, e ?pageNumber=&pageSize=
 *     (limite 1000 por página, sem filtro por intervalo de datas — só uma
 *     data por chamada).
 *   - Credenciais: USER (número do estabelecimento) + TOKEN (chave EDI),
 *     obtidas por um chamado de ativação próprio junto ao PagBank (SLA de
 *     2 dias úteis) — NÃO é autoatendimento no painel de developer comum.
 *   - Dado só fica pronto em D+1 (dia seguinte ao da venda) — por isso a
 *     auditoria roda no dia seguinte (scripts/auditar-dia-anterior.js),
 *     nunca no mesmo dia.
 *   - Campos reais de cada transação: valor_total_transacao,
 *     valor_liquido_transacao, meio_pagamento (código numérico),
 *     instituicao_financeira, data_venda_ajuste/hora_venda_ajuste, etc.
 *
 * NÃO CONFIRMADO (documentação pública não mostra) — só vai ficar claro
 * quando o PagBank aprovar a ativação e mandar o material técnico completo:
 *   - O HEADER exato de autenticação (Basic USER:TOKEN? header próprio?).
 *     Implementado abaixo como Basic Auth por ser o padrão mais comum para
 *     esse estilo de API EDI — PRECISA SER CONFIRMADO/AJUSTADO contra o
 *     material que vier com o token real, antes de confiar no resultado.
 *   - A tabela COMPLETA de códigos de `meio_pagamento` — o apêndice oficial
 *     (api-de-conciliacao-apendice) está "Em breve" no site do PagBank em
 *     30/09/2026. Só o código "8" = crédito apareceu confirmado num exemplo
 *     real da própria documentação. Por isso classificarMeioPagamento()
 *     devolve 'nao_classificado' para qualquer código que não seja "8", em
 *     vez de adivinhar — ver esse mesmo princípio em
 *     scripts/lib/conferencia.js (nunca inventar número).
 */

const https = require('https');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), override: true });

const BASE_URL = 'edi.api.pagbank.com.br';
const EDI_VERSION = 'v3.00';

function chamarEdi({ tipoMovimento, data, estabelecimento, pageNumber = 1, pageSize = 1000 }) {
  return new Promise((resolve, reject) => {
    const user = process.env.PAGSEGURO_EDI_USER;
    const token = process.env.PAGSEGURO_EDI_TOKEN;
    if (!user || !token) {
      reject(new Error('PAGSEGURO_EDI_USER/PAGSEGURO_EDI_TOKEN não configurados em .env.'));
      return;
    }

    const caminho = `/movement/${EDI_VERSION}/${tipoMovimento}/${data}?pageNumber=${pageNumber}&pageSize=${pageSize}`;
    // ⚠️ Basic Auth com USER:TOKEN é a SUPOSIÇÃO — não confirmada na
    // documentação pública (ver nota no topo do arquivo). Primeira chamada
    // real precisa validar isso contra o material técnico do PagBank.
    const autorizacao = Buffer.from(`${user}:${token}`).toString('base64');

    const req = https.request(
      {
        hostname: BASE_URL,
        path: caminho,
        method: 'GET',
        headers: {
          Authorization: `Basic ${autorizacao}`,
          Accept: 'application/json',
        },
        timeout: 30000,
      },
      (res) => {
        let corpo = '';
        res.on('data', (c) => { corpo += c; });
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(corpo);
          } catch (erro) {
            reject(new Error(`EDI PagBank devolveu resposta não-json (HTTP ${res.statusCode}): ${corpo.slice(0, 300)}`));
            return;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ ...json, _validado: res.headers.validado ?? res.headers.VALIDADO ?? null });
          } else {
            reject(new Error(`EDI PagBank retornou erro (HTTP ${res.statusCode}, estabelecimento ${estabelecimento}): ${corpo.slice(0, 300)}`));
          }
        });
      }
    );
    req.on('error', (e) => reject(new Error(`Não consegui falar com o EDI do PagBank: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error('EDI do PagBank não respondeu em 30s.')); });
    req.end();
  });
}

/**
 * Movimentação TRANSACIONAL (vendas) de uma data — o que interessa para
 * auditar um fechamento de caixa contra a maquininha.
 */
async function buscarVendasDoDia(data, { estabelecimento } = {}) {
  const resposta = await chamarEdi({ tipoMovimento: 'transactional', data, estabelecimento });
  const detalhes = Array.isArray(resposta.detalhes) ? resposta.detalhes
    : Array.isArray(resposta.details) ? resposta.details
    : Array.isArray(resposta) ? resposta : [];
  return { transacoes: detalhes, paginacao: resposta.pagination || resposta.paginacao || null, validado: resposta._validado };
}

// Único código CONFIRMADO na documentação pública até 30/09/2026 (exemplo
// real mostrando meio_pagamento "8" = crédito). Tudo o mais fica
// 'nao_classificado' de propósito — ver nota no topo do arquivo.
const CODIGOS_MEIO_PAGAMENTO_CONFIRMADOS = { 8: 'credito' };

function classificarMeioPagamento(codigo) {
  return CODIGOS_MEIO_PAGAMENTO_CONFIRMADOS[Number(codigo)] || 'nao_classificado';
}

/** Soma as transações do dia por classificação, sem inventar o que não sabe. */
function somarPorFormaDePagamento(transacoes) {
  const somas = { credito: 0, nao_classificado: 0 };
  for (const t of transacoes) {
    const classe = classificarMeioPagamento(t.meio_pagamento);
    const valor = Number(t.valor_total_transacao) || 0;
    somas[classe] = (somas[classe] || 0) + valor;
  }
  somas.total = Object.values(somas).reduce((a, b) => a + b, 0);
  return somas;
}

module.exports = { buscarVendasDoDia, classificarMeioPagamento, somarPorFormaDePagamento };
