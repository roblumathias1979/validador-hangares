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
// Concorrência (resolvido em 14/09/2026): leitura+escrita agora acontece sob
// trava exclusiva entre processos, e a gravação é atômica (grava em .tmp e
// renomeia). Antes, dois "Execute Command" do n8n rodando ao mesmo tempo para
// o mesmo hangar podiam ler o mesmo valor e perder um incremento — o hangar
// ganhava uma validação de graça que deveria ter sido cobrada. E um processo
// morto no meio do writeFileSync deixava o JSON truncado, o que derrubaria a
// contagem inteira do mês para zero.
const path = require('path');
const { comTrava, salvarAtomico, lerJson } = require('./trava-arquivo');

const ARQUIVO_ESTADO = path.join(__dirname, '..', '..', 'data', 'cota-fora-prazo.json');
// Fallback usado só quando o hangar não declara `cotaMensalForaPrazo` no
// config. Vale 2, o padrão geral: se um hangar novo for cadastrado sem a
// chave, ele cai na cota menor, não na maior. Solojet e Alljet têm 5, mas
// isso está explícito no config de cada um — nunca aqui.
const COTA_PADRAO = 2;

function mesAtual() {
  const agora = new Date();
  return `${agora.getFullYear()}-${String(agora.getMonth() + 1).padStart(2, '0')}`;
}

function lerEstado() {
  return lerJson(ARQUIVO_ESTADO, {});
}

function salvarEstado(estado) {
  salvarAtomico(ARQUIVO_ESTADO, estado);
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

// Registra o uso de 1 validação fora do prazo neste mês.
//
// Devolve `dentroDaCota: false` quando o incremento passou do limite. Isso
// acontece se outro processo consumiu a última vaga entre a checagem do
// chamador e este consumo. Não dá para desfazer a validação nesse caso, então
// o uso é registrado de verdade (o arquivo tem que refletir o que aconteceu) e
// quem chamou decide o que fazer — avisar o admin para cobrar à mão.
function consumirUmaValidacao(hangar) {
  return comTrava(ARQUIVO_ESTADO, () => {
    const estado = lerEstado();
    const mes = mesAtual();
    if (!estado[hangar.id]) estado[hangar.id] = {};
    const usoAntes = estado[hangar.id][mes] || 0;
    const usoDepois = usoAntes + 1;
    estado[hangar.id][mes] = usoDepois;
    salvarEstado(estado);

    const cota = cotaMensal(hangar);
    return {
      usoAntes,
      usoDepois,
      cota,
      restanteDepois: Math.max(0, cota - usoDepois),
      dentroDaCota: usoDepois <= cota,
    };
  });
}

// Devolve uma validação consumida que acabou não acontecendo.
//
// Necessário porque a cota é debitada ANTES do navegador abrir, e a validação
// pode falhar depois (pátio sem vaga, ticket já utilizado, ticket inexistente,
// ou o site exigindo tolerância > 0). Sem devolver, o hangar perderia uma
// validação gratuita sem ter validado nada — com cota 2, duas tentativas
// frustradas zerariam o mês.
function devolverUmaValidacao(hangar) {
  return comTrava(ARQUIVO_ESTADO, () => {
    const estado = lerEstado();
    const mes = mesAtual();
    if (!estado[hangar.id]) estado[hangar.id] = {};
    const usoAntes = estado[hangar.id][mes] || 0;
    const usoDepois = Math.max(0, usoAntes - 1);
    estado[hangar.id][mes] = usoDepois;
    salvarEstado(estado);

    const cota = cotaMensal(hangar);
    return { usoAntes, usoDepois, cota, restanteDepois: Math.max(0, cota - usoDepois) };
  });
}

module.exports = {
  mesAtual,
  obterUsoMensal,
  obterRestante,
  consumirUmaValidacao,
  devolverUmaValidacao,
  COTA_PADRAO,
};
