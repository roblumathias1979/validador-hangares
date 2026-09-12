// Integração com a API do Asaas para emitir o boleto quando um ticket fica
// fora do prazo de 2h E a cota mensal de validações fora do prazo do hangar
// já acabou (ver scripts/lib/cota-fora-prazo.js e scripts/lib/precos.js).
//
// Escopo desta primeira versão (confirmado com o usuário em 11/09/2026):
// SÓ boleto — nota fiscal (NF-e) fica para uma etapa seguinte, porque exige
// configuração municipal extra no Asaas (serviço, alíquota) que ainda não
// temos.
//
// Credenciais em .env: ASAAS_API_KEY (chave da conta) e ASAAS_AMBIENTE
// ("sandbox" ou "producao" — sandbox por padrão, decidido com o usuário para
// testar sem gerar cobrança real).
const https = require('https');

// CONFIRMADO testando de verdade (11/09/2026): os dois ambientes usam
// caminho BASE diferente, não só host diferente — produção NÃO tem o
// prefixo "/api" (é "/v3/..."), sandbox tem ("/api/v3/..."). Usar o mesmo
// caminho pros dois ambientes faz produção retornar 404 (a chave até
// funciona — confirmado com /v3/customers — mas a rota com /api não existe
// lá, só no CloudFront/nginx da Amazon na frente, que devolve um 404 vazio,
// sem corpo JSON, bem diferente de um 401 de autenticação).
const AMBIENTES = {
  sandbox: { host: 'sandbox.asaas.com', prefixoCaminho: '/api/v3' },
  producao: { host: 'api.asaas.com', prefixoCaminho: '/v3' },
};

function resolverAmbiente() {
  const ambiente = (process.env.ASAAS_AMBIENTE || 'sandbox').trim();
  const config = AMBIENTES[ambiente];
  if (!config) {
    throw new Error(`ASAAS_AMBIENTE="${ambiente}" inválido — use "sandbox" ou "producao".`);
  }
  return config;
}

function requisitar(metodo, caminho, corpo) {
  return new Promise((resolve, reject) => {
    const apiKey = process.env.ASAAS_API_KEY;
    if (!apiKey) {
      reject(new Error('ASAAS_API_KEY não configurada em .env — preencha antes de tentar faturar.'));
      return;
    }

    const dados = corpo ? JSON.stringify(corpo) : null;
    const { host, prefixoCaminho } = resolverAmbiente();
    const req = https.request(
      {
        hostname: host,
        path: `${prefixoCaminho}${caminho}`,
        method: metodo,
        headers: {
          'Content-Type': 'application/json',
          access_token: apiKey,
          ...(dados ? { 'Content-Length': Buffer.byteLength(dados) } : {}),
        },
      },
      (res) => {
        let corpoResposta = '';
        res.on('data', (chunk) => { corpoResposta += chunk; });
        res.on('end', () => {
          let json;
          try {
            json = corpoResposta ? JSON.parse(corpoResposta) : {};
          } catch (erro) {
            reject(new Error(`Resposta inesperada do Asaas (status ${res.statusCode}): ${corpoResposta.slice(0, 300)}`));
            return;
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(json);
          } else {
            const mensagemErro = (json.errors || []).map((e) => e.description).join('; ') || JSON.stringify(json);
            reject(new Error(`Asaas retornou erro (status ${res.statusCode}): ${mensagemErro}`));
          }
        });
      }
    );
    req.on('error', reject);
    if (dados) req.write(dados);
    req.end();
  });
}

// Dados cadastrais mínimos pra criar um cliente no Asaas: CNPJ + razão
// social (email é opcional). `override` é o que o CLIENTE informou na hora
// (ver validate-ticket.js) — tem prioridade sobre o que já estiver em
// config/hangares.json, mas normalmente só um dos dois existe.
function dadosCadastrais(hangar, override = {}) {
  const asaas = hangar.asaas || {};
  return {
    cnpj: override.cnpj || asaas.cnpj || '',
    razaoSocial: override.razaoSocial || asaas.razaoSocial || '',
    email: override.email || asaas.email || '',
  };
}

// Muitos hangares nunca precisaram faturar antes (11/09/2026, confirmado com
// o usuário) e por isso não têm cliente cadastrado no Asaas nem dados pra
// criar um. Esta função deixa `validate-ticket.js` checar ANTES de tentar
// faturar, pra pedir os dados ao cliente em vez de só falhar.
function temDadosParaCriarCliente(hangar, override = {}) {
  if (hangar.asaas && hangar.asaas.customerId) return true;
  const dados = dadosCadastrais(hangar, override);
  return Boolean(dados.cnpj && dados.razaoSocial);
}

// Garante um customer id do Asaas para o hangar: usa o já cadastrado em
// config/hangares.json (campo `asaas.customerId`) se existir, ou cria um
// novo a partir dos dados cadastrais (de `override` ou de
// `asaas.cnpj`/`razaoSocial`/`email` em config/hangares.json). Se não tiver
// nem um nem outro, falha com uma mensagem clara — não adivinha dados
// cadastrais. Retorna `{ customerId, criadoAgora }` — `criadoAgora` diz pra
// quem chamou se precisa persistir esse id em config/hangares.json (ver
// scripts/lib/hangar.js#salvarAsaasCustomerId).
async function garantirCliente(hangar, override = {}) {
  if (hangar.asaas && hangar.asaas.customerId) {
    return { customerId: hangar.asaas.customerId, criadoAgora: false };
  }

  const dados = dadosCadastrais(hangar, override);
  if (!dados.cnpj || !dados.razaoSocial) {
    throw new Error(
      `Hangar "${hangar.id}" não tem cliente Asaas cadastrado (asaas.customerId) nem dados cadastrais ` +
      `suficientes (CNPJ/razão social) para criar um automaticamente.`
    );
  }

  const cliente = await requisitar('POST', '/customers', {
    name: dados.razaoSocial,
    cpfCnpj: dados.cnpj,
    email: dados.email || undefined,
  });
  return { customerId: cliente.id, criadoAgora: true };
}

// Cria a cobrança (boleto) no Asaas para o hangar. Retorna o registro criado
// (inclui `id`, `bankSlipUrl`/`invoiceUrl` com o link do boleto) mais
// `customerId`/`clienteCriadoAgora`, pra quem chamou decidir se persiste o
// customerId novo em config/hangares.json.
async function criarCobrancaBoleto({ hangar, valor, descricao, dataVencimento, dadosCadastraisNovoCliente }) {
  const { customerId, criadoAgora } = await garantirCliente(hangar, dadosCadastraisNovoCliente);
  const pagamento = await requisitar('POST', '/payments', {
    customer: customerId,
    billingType: 'BOLETO',
    value: valor,
    dueDate: dataVencimento,
    description: descricao,
  });
  return { ...pagamento, customerId, clienteCriadoAgora: criadoAgora };
}

module.exports = { criarCobrancaBoleto, garantirCliente, temDadosParaCriarCliente };
