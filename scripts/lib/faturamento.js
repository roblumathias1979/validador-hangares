// Registro de auditoria dos faturamentos emitidos (ticket fora do prazo e
// sem cota mensal disponível — ver scripts/lib/cota-fora-prazo.js). Guarda
// quem autorizou (referência da foto anexada, exigida na autorização) e o
// resultado da cobrança no Asaas, para consulta posterior.
//
// Persistido em data/faturamentos.json (fora do git, como data/cota-fora-prazo.json).
const fs = require('fs');
const path = require('path');

const ARQUIVO_ESTADO = path.join(__dirname, '..', '..', 'data', 'faturamentos.json');

function lerRegistros() {
  try {
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf-8'));
  } catch (erro) {
    if (erro.code === 'ENOENT') return [];
    throw erro;
  }
}

function registrarFaturamento({ hangarId, ticket, horasDecorridas, valor, fotoAutorizacao, asaasPaymentId, boletoUrl }) {
  const registros = lerRegistros();
  registros.push({
    ts: new Date().toISOString(),
    hangarId,
    ticket,
    horasDecorridas,
    valor,
    fotoAutorizacao,
    asaasPaymentId,
    boletoUrl,
  });
  fs.mkdirSync(path.dirname(ARQUIVO_ESTADO), { recursive: true });
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(registros, null, 2));
}

module.exports = { registrarFaturamento, lerRegistros };
