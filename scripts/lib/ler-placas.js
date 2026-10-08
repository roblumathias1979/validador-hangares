/**
 * ler-placas.js — acha as placas num quadro da câmera do fiscal.
 *
 * Um quadro pode ter nenhuma, uma ou várias placas (a rua tem veículos
 * enfileirados). O modelo devolve todas as que conseguiu ler COM CERTEZA; o
 * resto é descartado aqui mesmo, antes de virar consulta.
 *
 * NÃO ADIVINHAR é a regra que importa. Um caractere trocado não dá "não
 * encontrada": dá a placa de OUTRA pessoa, que pode estar irregular, e o
 * fiscal age em cima do veículo errado. Por isso o prompt pede para omitir o
 * que não estiver nítido, e o código aceita só os dois formatos brasileiros.
 * Placa meio legível aparece de novo no quadro seguinte, que é a vantagem de
 * ler continuamente em vez de por foto.
 *
 * O MODELO é configurável (config/fiscalizacao.json → modeloLeitura) porque
 * esta é a chamada mais frequente do sistema — uma a cada poucos segundos
 * durante a ronda — e o custo por hora depende inteiramente dessa escolha.
 */

const path = require('path');
require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), override: true });

const sdk = require('@anthropic-ai/sdk');
const { normalizarPlaca } = require('./fiscalizacao');

const Anthropic = sdk.default || sdk;

const PROMPT = `Esta imagem é um quadro da câmera do celular de um fiscal de estacionamento andando pela rua, no aeroporto de Jundiaí. Pode haver carros e motos estacionados.

Liste as placas de veículos brasileiros que aparecem na imagem e que você consegue ler POR INTEIRO e com certeza. Os formatos válidos são:
- antigo: 3 letras e 4 números (ex.: ABC1234)
- Mercosul: 3 letras, 1 número, 1 letra, 2 números (ex.: ABC1D23)

Regras:
- Se qualquer caractere de uma placa estiver borrado, cortado, coberto ou ambíguo, NÃO inclua essa placa. Omitir é sempre melhor que adivinhar.
- Não complete caracteres por dedução nem troque letra por número parecido.
- Ignore placas de fundo pequenas demais para ler, adesivos, letreiros e textos que não sejam placa.
- Se não houver nenhuma placa legível, devolva a lista vazia.`;

const ESQUEMA = {
  type: 'object',
  properties: {
    placas: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          placa: { type: 'string' },
          veiculo: { type: 'string', enum: ['carro', 'moto', 'outro'] },
        },
        required: ['placa', 'veiculo'],
        additionalProperties: false,
      },
    },
  },
  required: ['placas'],
  additionalProperties: false,
};

let cliente = null;
function obterCliente() {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('ANTHROPIC_API_KEY não configurada no .env.');
  if (!cliente) cliente = new Anthropic({ timeout: 30000, maxRetries: 1 });
  return cliente;
}

/**
 * @param {string} base64 imagem JPEG em base64, sem o prefixo data:
 * @param {{ modelo?: string }} opcoes
 * @returns {Promise<{ placas: {placa: string, veiculo: string}[], descartadas: string[], recusado?: boolean }>}
 */
async function lerPlacas(base64, { modelo = 'claude-opus-5-5' } = {}) {
  // O Haiku não aceita `effort` nem `fallbacks`; os demais modelos atuais sim.
  const haiku = /haiku/.test(modelo);
  const resposta = await obterCliente().beta.messages.create({
    model: modelo,
    max_tokens: 2000,
    // Se o classificador de segurança recusar um quadro de rua (falso
    // positivo), o próprio servidor da Anthropic refaz num modelo de reserva.
    ...(haiku ? {} : { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' }),
    // Tarefa curta e objetiva: esforço baixo responde mais rápido e gasta
    // menos, e a câmera manda outro quadro logo em seguida.
    output_config: { ...(haiku ? {} : { effort: 'low' }), format: { type: 'json_schema', schema: ESQUEMA } },
    messages: [{
      role: 'user',
      content: [
        { type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: base64 } },
        { type: 'text', text: PROMPT },
      ],
    }],
  });

  // Soma o custo desta leitura ao medidor de saldo (nunca derruba a ronda).
  try { require('./creditos-anthropic').registrarUso({ modelo, usage: resposta.usage }); } catch (e) { /* medir é secundário */ }

  if (resposta.stop_reason === 'refusal') return { placas: [], descartadas: [], recusado: true };

  const texto = resposta.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  let dados;
  try { dados = JSON.parse(texto); } catch (e) { return { placas: [], descartadas: [] }; }

  const vistas = new Set();
  const placas = [];
  const descartadas = [];
  for (const item of dados.placas || []) {
    const placa = normalizarPlaca(item.placa);
    if (!placa) { descartadas.push(String(item.placa)); continue; }
    if (vistas.has(placa)) continue;
    vistas.add(placa);
    placas.push({ placa, veiculo: item.veiculo || 'outro' });
  }
  return { placas, descartadas };
}

module.exports = { lerPlacas };
