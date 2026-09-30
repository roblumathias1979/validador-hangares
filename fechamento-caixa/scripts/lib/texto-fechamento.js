/**
 * texto-fechamento.js — lê uma mensagem de TEXTO PURO (sem foto) que
 * complementa o fechamento de caixa com valores escritos à mão pela
 * unidade, que não aparecem no relatório impresso do #1 Park.
 *
 * Confirmado em uso real (30/09/2026, grupo Vila Mariana), mandado como
 * mensagem separada, logo depois da foto do relatório:
 *   "Valor recebido R$37,00
 *    Fundo de caixa R$200,00
 *    Envelope R$214,00"
 *
 * "Envelope" é o saldo FÍSICO do dinheiro que vai se acumulando na unidade
 * até bater um valor-gatilho e ir para depósito — também é usado para vales
 * e compra de insumos (confirmado pelo usuário). Por isso NÃO é tratado
 * como "dinheiro que já foi depositado" (isso desconta do acumulado); é o
 * NOVO CHECKPOINT do saldo esperado — ver
 * armazenamento.js::totalDinheiroPorUnidade. A unidade sabe o saldo físico
 * real melhor do que qualquer soma que a gente calcule sem ver vales e
 * compras.
 */

const https = require('https');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), override: true });

const MODELO = 'claude-sonnet-5';

const PROMPT_BASE = `Esta é uma mensagem de texto (sem foto) que uma unidade de estacionamento mandou complementando um fechamento de caixa, com valores escritos à mão pela própria pessoa. Os rótulos variam de unidade para unidade — já vistos: "Valor recebido" (dinheiro recebido no período), "Fundo de caixa" (troco fixo mantido no caixa para dar troco), "Envelope" (saldo físico do dinheiro acumulado na unidade — sobe com o dinheiro recebido, desce com vales e compra de insumos, até bater um valor e ir para depósito bancário).

Mensagem recebida:
"""
MENSAGEM_AQUI
"""

Responda APENAS com um JSON (sem markdown, sem texto antes ou depois) neste formato exato:
{
  "valorRecebido": <número em reais com ponto decimal, ou null se não mencionado>,
  "fundoDeCaixa": <número ou null>,
  "envelope": <número ou null>,
  "outrosValores": ["<qualquer outro valor ou linha mencionado que não se encaixe acima, texto livre, um item por linha>"],
  "confianca": "alta" | "baixa",
  "motivo": "<se confianca=baixa, explique por quê (texto ambíguo, nenhum valor reconhecível, etc); se alta, string vazia>"
}

Não invente números — um valor não mencionado na mensagem vira null. Mensagem que não tem NENHUM valor em reais reconhecível tem confianca "baixa".`;

function chamarClaude(texto) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      reject(new Error('ANTHROPIC_API_KEY não configurada em .env.'));
      return;
    }

    const corpo = JSON.stringify({
      model: MODELO,
      max_tokens: 800,
      messages: [
        { role: 'user', content: PROMPT_BASE.replace('MENSAGEM_AQUI', texto) },
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

function extrairJson(texto) {
  const semCerca = texto.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  return JSON.parse(semCerca);
}

function numeroOuNull(v) {
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

async function lerComplementoTexto(texto) {
  if (!texto || !texto.trim()) throw new Error('lerComplementoTexto precisa de um texto não vazio.');

  const resposta = await chamarClaude(texto);
  const textoResposta = (resposta.content || []).map((b) => b.text || '').join('');

  let extraido;
  try {
    extraido = extrairJson(textoResposta);
  } catch (erro) {
    return {
      status: 'falhou',
      mensagem: `Não consegui interpretar a resposta do modelo (${textoResposta.length} caracteres).`,
      mensagemWhatsapp: '⚠️ Não conseguimos entender essa mensagem. Pode reenviar os valores, um por linha?',
      notificarAdmin: true,
    };
  }

  if (extraido.confianca !== 'alta') {
    return {
      status: 'confianca_baixa',
      mensagem: extraido.motivo || 'Confiança baixa na leitura do texto.',
      mensagemWhatsapp: '⚠️ Não consegui identificar valores nessa mensagem. Pode escrever cada valor em uma linha, tipo "Envelope R$214,00"?',
      notificarAdmin: false,
    };
  }

  return {
    status: 'ok',
    valorRecebido: numeroOuNull(extraido.valorRecebido),
    fundoDeCaixa: numeroOuNull(extraido.fundoDeCaixa),
    envelope: numeroOuNull(extraido.envelope),
    outrosValores: Array.isArray(extraido.outrosValores) ? extraido.outrosValores : [],
  };
}

module.exports = { lerComplementoTexto };
