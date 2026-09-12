// Controla quantas validações "fora do prazo de 2h" cada hangar já usou no
// mês corrente. Regra de negócio (11/09/2026): o usuário fornece 5 dessas
// validações por mês PARA CADA HANGAR (não é uma cota única compartilhada).
// Esgotada a cota, o ticket passa a ser cobrado (ver scripts/lib/precos.js e
// scripts/lib/asaas.js) em vez de validado de graça.
//
// Estado persistido em data/cota-fora-prazo.json (fora do git — ver
// .gitignore: é dado operacional, não configuração). Formato:
// { "<hangarId>": { "<AAAA-MM>": <quantidade usada> } }
//
// Cuidado conhecido: leitura+escrita não é atômica entre processos
// concorrentes (dois "Execute Command" do n8n rodando ao mesmo tempo para o
// mesmo hangar podem perder um incremento). Aceitável por ora dado o volume
// baixo de validações fora do prazo (no máximo 5/mês por hangar); documentado
// aqui para não ser esquecido se o volume crescer.
const fs = require('fs');
const path = require('path');

const ARQUIVO_ESTADO = path.join(__dirname, '..', '..', 'data', 'cota-fora-prazo.json');
const COTA_PADRAO = 5;

function mesAtual() {
  const agora = new Date();
  const ano = agora.getFullYear();
  const mes = String(agora.getMonth() + 1).padStart(2, '0');
  return `${ano}-${mes}`;
}

function lerEstado() {
  try {
    return JSON.parse(fs.readFileSync(ARQUIVO_ESTADO, 'utf-8'));
  } catch (erro) {
    if (erro.code === 'ENOENT') return {};
    throw erro;
  }
}

function salvarEstado(estado) {
  fs.mkdirSync(path.dirname(ARQUIVO_ESTADO), { recursive: true });
  fs.writeFileSync(ARQUIVO_ESTADO, JSON.stringify(estado, null, 2));
}

function cotaMensal(hangar) {
  return Number.isFinite(hangar.cotaMensalForaPrazo) ? hangar.cotaMensalForaPrazo : COTA_PADRAO;
}

// Quantas validações fora do prazo o hangar já usou no mês corrente.
function obterUsoMensal(hangarId) {
  const estado = lerEstado();
  return (estado[hangarId] && estado[hangarId][mesAtual()]) || 0;
}

// Quantas ainda restam este mês para o hangar.
function obterRestante(hangar) {
  return Math.max(0, cotaMensal(hangar) - obterUsoMensal(hangar.id));
}

// Registra o uso de 1 validação fora do prazo neste mês. Retorna quantas
// restam depois de consumir.
function consumirUmaValidacao(hangar) {
  const estado = lerEstado();
  const mes = mesAtual();
  if (!estado[hangar.id]) estado[hangar.id] = {};
  estado[hangar.id][mes] = (estado[hangar.id][mes] || 0) + 1;
  salvarEstado(estado);
  return Math.max(0, cotaMensal(hangar) - estado[hangar.id][mes]);
}

module.exports = { mesAtual, obterUsoMensal, obterRestante, consumirUmaValidacao, COTA_PADRAO };
