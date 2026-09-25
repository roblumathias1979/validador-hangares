/**
 * ocr-fechamento.js — lê a foto do relatório de fechamento de caixa (sistema
 * "#1 Park") usando a API da Anthropic (Claude) com visão.
 *
 * Esquema CONFIRMADO contra três fotos reais (25/09/2026: Hotel Nacional Inn
 * Poços de Caldas, Hotel Ibis Styles, Argentina Mall) — diferente da primeira
 * versão deste arquivo, que supunha campos fixos (dinheiro/débito/crédito/pix)
 * sem nunca ter visto uma foto real. O formato de verdade é:
 *
 *   - Cabeçalho: nome da unidade impresso (varia por unidade) + CNPJ.
 *     NÃO usar o CNPJ para identificar a unidade — confirmado pelo usuário
 *     que máquinas de unidades DIFERENTES compartilham o mesmo CNPJ.
 *   - Um bloco de resumo: Valor Faturado, Dinheiro Caixa, Recebido em
 *     Cartão/Dinheiro/Outra Forma, Valor Total a Faturar, Valor Total
 *     Recebido.
 *   - Uma tabela "Formas de Pagamento" de tamanho e rótulos VARIÁVEIS (MAQ.
 *     CARTAO, MASTER Crédito, MASTER Débito, SEMPARAR, VISA Crédito,
 *     DINHEIRO, A Faturar, ...) — por isso vem como lista livre
 *     {forma, valor}, não como campos fixos.
 *   - Às vezes um relatório PARCIAL ("Caixa Em Aberto desde...") em vez de um
 *     fechamento final — situação que muda o que fazer com o resultado (ver
 *     processar-fechamento.js).
 *   - Às vezes uma REIMPRESSÃO do mesmo relatório.
 *   - Frequentemente uma segunda nota grampeada e fotografada junto: o
 *     resumo da maquininha de cartão (ex: "pagvendas"/PagBank, com Débito
 *     Total / Crédito à Vista Total / QR Code-Pix Total) ou um envelope de
 *     depósito bancário em dinheiro. É esse anexo que serve de conferência
 *     externa — sem precisar de API de banco/maquininha.
 *
 * Não inventa números: campo ilegível ou ausente vira null, nunca um
 * palpite — um valor errado aqui é dinheiro que não bate para alguém.
 */

const https = require('https');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), override: true });

const MODELO = 'claude-sonnet-5';

const PROMPT = `Esta foto mostra um relatório impresso de FECHAMENTO DE CAIXA do sistema "#1 Park", de uma unidade de estacionamento. Às vezes há uma SEGUNDA nota grampeada e fotografada junto — o resumo de uma maquininha de cartão (ex: marca "pagvendas"/PagBank, com Débito Total / Crédito à Vista Total / QR Code (Pix) Total) ou um envelope de depósito bancário em dinheiro.

O relatório do #1 Park normalmente traz, nesta ordem:
- Cabeçalho: nome da unidade (ex: "Hotel Ibis Styles", "Argentina Mall - Poços de Caldas") e CNPJ.
- "Número" do relatório, e se está marcado como reimpressão.
- Período: "De" / "Até" (fechamento final) OU "Parcial, Caixa Em Aberto desde" (ainda não fechou).
- Quantidade de veículos (total, avulsos, mensalistas, credenciados).
- Um resumo: Valor Faturado, Dinheiro Caixa, Recebido em Cartão, Recebido em Dinheiro, Recebido Outra Forma, Valor Total a Faturar, Valor Total Recebido, Valor Descontos (nem todo relatório tem todos esses campos).
- Uma tabela "Formas de Pagamento" com uma linha por forma (rótulos variam: MAQ. CARTAO, MASTER Credito, MASTER Debito, VISA Credito, SEMPARAR, DINHEIRO, A Faturar, Outros Cartões, etc.) e o valor de cada uma.
- Veículos Cancelados / na Tolerância / sem Saída, e o nome do Operador.

Responda APENAS com um JSON (sem markdown, sem texto antes ou depois) neste formato exato:
{
  "unidadeImpressa": "<nome da unidade como aparece no cabeçalho, ou null se não houver/não estiver legível>",
  "relatorio": {
    "numero": "<número do relatório, como string, ou null>",
    "situacao": "fechado" | "parcial",
    "reimpressao": true | false,
    "periodoDe": "<data/hora inicial como impressa, ou null>",
    "periodoAte": "<data/hora final como impressa, ou null — null também quando situacao=parcial>",
    "quantidadeVeiculos": <número ou null>,
    "valorFaturado": <número em reais com ponto decimal, ou null>,
    "dinheiroCaixa": <número ou null>,
    "recebidoCartao": <número ou null>,
    "recebidoDinheiro": <número ou null>,
    "recebidoOutraForma": <número ou null>,
    "valorTotalAFaturar": <número ou null>,
    "valorTotalRecebido": <número ou null>,
    "valorDescontos": <número ou null>,
    "formasDePagamento": [ { "forma": "<rótulo exatamente como impresso>", "valor": <número ou null se ilegível> } ],
    "veiculosCancelados": <número ou null>,
    "veiculosTolerancia": <número ou null>,
    "veiculosSemSaida": <número ou null>,
    "operador": "<nome do operador, ou null>"
  },
  "documentoAnexo": {
    "tipo": "maquininha" | "deposito_bancario" | "nenhum",
    "maquininha": {
      "provedor": "<nome/marca impressa, ex: pagvendas, PagBank, Stone, ou null>",
      "periodoDe": "<data inicial do resumo, ou null>",
      "periodoAte": "<data final do resumo, ou null>",
      "totalGeral": <número ou null>,
      "debitoTotal": <número ou null>,
      "creditoTotal": <número ou null>,
      "pixTotal": <número ou null>
    },
    "deposito": {
      "banco": "<nome do banco impresso no envelope/comprovante, ou null>",
      "valor": <número, só se estiver escrito/impresso no envelope — normalmente NÃO está, então use null>
    }
  },
  "camposNaoReconhecidos": ["<qualquer linha visível (em qualquer um dos documentos da foto) que não se encaixe nos campos acima, texto livre>"],
  "confianca": "alta" | "baixa",
  "motivo": "<se confianca=baixa, explique por quê (borrado, cortado, valor ilegível, não parece um relatório de fechamento de caixa); se alta, string vazia>"
}

Preencha "maquininha" só quando documentoAnexo.tipo="maquininha", e "deposito" só quando tipo="deposito_bancario"; caso contrário deixe esses objetos com todos os campos null. Não invente números — se um valor não estiver legível ou não existir no documento, use null. Um valor ilegível é motivo para confianca "baixa", EXCETO quando a linha simplesmente não existe naquele relatório (relatórios têm campos diferentes entre si).`;

function chamarClaude({ mediaType, dados }) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      reject(new Error('ANTHROPIC_API_KEY não configurada em .env.'));
      return;
    }

    const corpo = JSON.stringify({
      model: MODELO,
      // Dois relatórios (unidade + anexo) numa resposta só pode ficar longo,
      // principalmente com formasDePagamento e camposNaoReconhecidos.
      max_tokens: 1800,
      messages: [
        {
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: mediaType, data: dados } },
            { type: 'text', text: PROMPT },
          ],
        },
      ],
    });

    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'Content-Length': Buffer.byteLength(corpo),
        },
      },
      (res) => {
        let corpoResposta = '';
        res.on('data', (chunk) => { corpoResposta += chunk; });
        res.on('end', () => {
          let json;
          try {
            json = JSON.parse(corpoResposta);
          } catch (erro) {
            reject(new Error(`Resposta inesperada da Anthropic (status ${res.statusCode}): ${corpoResposta.slice(0, 300)}`));
            return;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            reject(new Error(`Anthropic retornou erro (status ${res.statusCode}): ${(json.error && json.error.message) || JSON.stringify(json)}`));
          }
        });
      }
    );
    req.on('error', reject);
    req.write(corpo);
    req.end();
  });
}

// A resposta às vezes vem cercada de ```json ... ``` mesmo quando instruída a
// não fazer isso.
function extrairJson(texto) {
  const semCerca = texto.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(semCerca);
}

function numeroOuNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

function normalizarFormasDePagamento(lista) {
  if (!Array.isArray(lista)) return [];
  return lista
    .map((f) => ({ forma: String((f || {}).forma || '').trim(), valor: numeroOuNull((f || {}).valor) }))
    .filter((f) => f.forma);
}

async function lerFechamento({ base64, mediaType }) {
  if (!base64) throw new Error('lerFechamento precisa da imagem em base64.');

  const resposta = await chamarClaude({ mediaType: mediaType || 'image/jpeg', dados: base64 });
  const textoResposta = (resposta.content || []).map((b) => b.text || '').join('');

  let extraido;
  try {
    extraido = extrairJson(textoResposta);
  } catch (erro) {
    return {
      status: 'ocr_falhou',
      mensagem: `Não consegui interpretar a resposta do modelo (${textoResposta.length} caracteres). `
        + `Início: ${textoResposta.slice(0, 120)} ... Fim: ${textoResposta.slice(-120)}`,
      mensagemWhatsapp: '⚠️ Não conseguimos ler essa foto do fechamento. Pode reenviar, tentando deixar os valores bem visíveis?',
      notificarAdmin: true,
    };
  }

  const confiancaAlta = extraido.confianca === 'alta';
  if (!confiancaAlta) {
    return {
      status: 'ocr_confianca_baixa',
      mensagem: extraido.motivo || 'Confiança baixa na leitura do relatório.',
      mensagemWhatsapp: '⚠️ Não consegui ler esse relatório com certeza. Pode reenviar a foto mais de perto, com os valores bem visíveis?',
      notificarAdmin: false,
    };
  }

  const r = extraido.relatorio || {};
  const anexo = extraido.documentoAnexo || {};
  const maquininha = anexo.maquininha || {};
  const deposito = anexo.deposito || {};

  return {
    status: 'ocr_ok',
    unidadeImpressa: extraido.unidadeImpressa || null,
    relatorio: {
      numero: r.numero || null,
      situacao: r.situacao === 'parcial' ? 'parcial' : 'fechado',
      reimpressao: r.reimpressao === true,
      periodoDe: r.periodoDe || null,
      periodoAte: r.periodoAte || null,
      quantidadeVeiculos: numeroOuNull(r.quantidadeVeiculos),
      valorFaturado: numeroOuNull(r.valorFaturado),
      dinheiroCaixa: numeroOuNull(r.dinheiroCaixa),
      recebidoCartao: numeroOuNull(r.recebidoCartao),
      recebidoDinheiro: numeroOuNull(r.recebidoDinheiro),
      recebidoOutraForma: numeroOuNull(r.recebidoOutraForma),
      valorTotalAFaturar: numeroOuNull(r.valorTotalAFaturar),
      valorTotalRecebido: numeroOuNull(r.valorTotalRecebido),
      valorDescontos: numeroOuNull(r.valorDescontos),
      formasDePagamento: normalizarFormasDePagamento(r.formasDePagamento),
      veiculosCancelados: numeroOuNull(r.veiculosCancelados),
      veiculosTolerancia: numeroOuNull(r.veiculosTolerancia),
      veiculosSemSaida: numeroOuNull(r.veiculosSemSaida),
      operador: r.operador || null,
    },
    documentoAnexo: {
      tipo: ['maquininha', 'deposito_bancario'].includes(anexo.tipo) ? anexo.tipo : 'nenhum',
      maquininha: {
        provedor: maquininha.provedor || null,
        periodoDe: maquininha.periodoDe || null,
        periodoAte: maquininha.periodoAte || null,
        totalGeral: numeroOuNull(maquininha.totalGeral),
        debitoTotal: numeroOuNull(maquininha.debitoTotal),
        creditoTotal: numeroOuNull(maquininha.creditoTotal),
        pixTotal: numeroOuNull(maquininha.pixTotal),
      },
      deposito: {
        banco: deposito.banco || null,
        valor: numeroOuNull(deposito.valor),
      },
    },
    camposNaoReconhecidos: Array.isArray(extraido.camposNaoReconhecidos) ? extraido.camposNaoReconhecidos : [],
  };
}

module.exports = { lerFechamento, extrairJson };
