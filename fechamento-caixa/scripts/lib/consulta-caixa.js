/**
 * consulta-caixa.js — interpreta perguntas em texto livre que o ADMIN manda
 * no PRIVADO (não em nenhum grupo de unidade) sobre o caixa: saldo atual de
 * uma unidade/cofre, ou quanto foi recebido em dinheiro num período. Pedido
 * do usuário (30/09/2026): "quanto faturou de dinheiro Nacional Inn de
 * período X a X" e "quanto tem de dinheiro no cofre ou unidade".
 *
 * A unidade ou cofre ALVO é resolvido de forma DETERMINÍSTICA (mesmo
 * buscarPorTexto usado para o nome impresso no relatório — ver unidades.js):
 * só o TIPO da pergunta (saldo vs período) e as DATAS livres (tipo "mês
 * passado") passam pelo Claude, porque isso sim varia demais em português
 * livre para valer a pena um regex.
 */

const https = require('https');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), override: true });
const { normalizar, buscarPorTexto } = require('./unidades');

const MODELO = 'claude-sonnet-5';

function hojeEmSaoPaulo() {
  // Fixo UTC-3 (Brasil não tem mais horário de verão desde 2019) — mesmo
  // raciocínio de scripts/auditar-dia-anterior.js::dataDeOntemEmSaoPaulo.
  const spMs = Date.now() - 3 * 60 * 60 * 1000;
  return new Date(spMs).toISOString().slice(0, 10);
}

const PROMPT_BASE = `Você recebe uma pergunta em português sobre o caixa (dinheiro) de unidades de estacionamento. Hoje é DATA_HOJE (data em São Paulo, Brasil não tem mais horário de verão).

Identifique o TIPO da pergunta:
- "saldo": quanto TEM de dinheiro agora (saldo atual do caixa, cofre ou unidade) — não depende de período.
- "faturamento": quanto foi RECEBIDO em dinheiro num período (ex: "de ontem a hoje", "essa semana", "do dia 1 ao dia 15", "mês passado").

Para "faturamento", converta o período para datas absolutas AAAA-MM-DD (desde/ate, inclusive). Se a pergunta não disser um período e for do tipo faturamento, desde/ate ficam null e confianca vira baixa.

Pergunta recebida:
"""
PERGUNTA_AQUI
"""

Responda APENAS com um JSON (sem markdown, sem texto antes ou depois) neste formato exato:
{
  "tipo": "saldo" | "faturamento",
  "desde": "AAAA-MM-DD" | null,
  "ate": "AAAA-MM-DD" | null,
  "confianca": "alta" | "baixa",
  "motivo": "<se confianca=baixa, explique por quê; se alta, string vazia>"
}

Não invente datas — período não mencionado ou ambíguo vira confianca baixa.`;

function chamarClaude(texto) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      reject(new Error('ANTHROPIC_API_KEY não configurada em .env.'));
      return;
    }

    const corpo = JSON.stringify({
      model: MODELO,
      max_tokens: 500,
      messages: [
        { role: 'user', content: PROMPT_BASE.replace('DATA_HOJE', hojeEmSaoPaulo()).replace('PERGUNTA_AQUI', texto) },
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

/**
 * Resolve a unidade/cofre alvo diretamente do texto da pergunta (mesma
 * lógica de buscarPorTexto — apelidos cadastrados, ver unidades.js), sem
 * depender do modelo. "todas as unidades"/"em geral"/"no total" soma tudo.
 * Devolve null quando não achou nada reconhecível (nunca adivinha).
 */
function resolverAlvo(config, texto) {
  const alvo = normalizar(texto);

  if (/\btodas as unidades\b|\bem geral\b|\bno total\b|\btodas unidades\b/.test(alvo)) {
    return { tipo: 'todas', unidadeIds: config.unidades.map((u) => u.id), label: 'todas as unidades' };
  }

  const unidade = buscarPorTexto(config, texto);
  if (unidade) return { tipo: 'unidade', unidadeIds: [unidade.id], label: unidade.nome };

  const cofres = [...new Set(config.unidades.map((u) => u.cofre).filter(Boolean))];
  const cofre = cofres.find((c) => alvo.includes(normalizar(c)));
  if (cofre) {
    const unidadeIds = config.unidades.filter((u) => u.cofre === cofre).map((u) => u.id);
    return { tipo: 'cofre', unidadeIds, label: `cofre ${cofre}` };
  }

  return null;
}

async function interpretarConsulta(texto) {
  if (!texto || !texto.trim()) throw new Error('interpretarConsulta precisa de um texto não vazio.');

  const resposta = await chamarClaude(texto);
  const textoResposta = (resposta.content || []).map((b) => b.text || '').join('');

  let extraido;
  try {
    extraido = extrairJson(textoResposta);
  } catch (erro) {
    return { status: 'falhou', mensagem: `Não consegui interpretar a resposta do modelo (${textoResposta.length} caracteres).` };
  }

  if (extraido.confianca !== 'alta') {
    return { status: 'confianca_baixa', mensagem: extraido.motivo || 'Confiança baixa na leitura da pergunta.' };
  }

  if (extraido.tipo !== 'saldo' && extraido.tipo !== 'faturamento') {
    return { status: 'confianca_baixa', mensagem: `Tipo de pergunta não reconhecido: "${extraido.tipo}".` };
  }

  return {
    status: 'ok',
    tipo: extraido.tipo,
    desde: extraido.tipo === 'faturamento' ? extraido.desde : null,
    ate: extraido.tipo === 'faturamento' ? extraido.ate : null,
  };
}

module.exports = { interpretarConsulta, resolverAlvo, hojeEmSaoPaulo };
