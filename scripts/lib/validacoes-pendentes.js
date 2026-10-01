/**
 * validacoes-pendentes.js — fila de validações que o COLETOR precisa executar.
 *
 * O bot (na AWS) decide e autoriza; a validação de ticket vencido, porém, só
 * roda na máquina do aeroporto, que é quem alcança a API do TECHPARKING. Então
 * o bot não valida: ele ENFILEIRA aqui, e o coletor puxa no ciclo dele, executa
 * e reporta de volta. Mesmo princípio do AnyDesk e dos snapshots — o de dentro
 * liga para fora, nada é aberto na rede do aeroporto.
 *
 * A consequência é que a validação é ASSÍNCRONA: o cliente ouve "autorizado,
 * validando..." e a confirmação chega segundos depois, quando o coletor
 * reporta. É o preço de a validação viver noutra máquina.
 *
 * ANTI-DUPLICAÇÃO: validar duas vezes é o erro que o projeto inteiro combate.
 * Por isso a entrega marca 'processando' na hora, e só um 'processando' PARADO
 * há muito tempo (resposta perdida) volta para a fila. Reexecutar nesse caso
 * apenas re-estende a tolerância no mesmo pátio — não gera cobrança nova, que a
 * cota já foi contada no lado do bot.
 */

const path = require('path');
const crypto = require('crypto');
const { comTrava, salvarAtomico, lerJson } = require('./trava-arquivo');

const ARQUIVO = path.join(__dirname, '..', '..', 'data', 'validacoes-pendentes.json');

// 'processando' parado além disso presume resposta perdida e volta à fila.
const REENTREGA_MS = 10 * 60 * 1000;
// Registros concluídos são varridos depois disso — auditoria de curto prazo,
// não arquivo eterno. O histórico de verdade é o data/validacoes.jsonl.
const RETENCAO_MS = 7 * 24 * 3600 * 1000;

function enfileirar(pedido) {
  return comTrava(ARQUIVO, () => {
    const todas = lerJson(ARQUIVO, {});

    // DEDUP POR TICKET: valida duas vezes é o erro que o projeto combate. Dois
    // webhooks da mesma foto (ou dois envios) chegam a enfileirar o MESMO
    // ticket; na contingência, sem a conferência ao vivo do ValidPark, os dois
    // passavam. Aqui, se já existe uma validação do mesmo ticket em andamento
    // (pendente/processando) ou concluída com sucesso há pouco, devolve ELA em
    // vez de criar outra — sob a mesma trava, então não há corrida. Uma que
    // FALHOU não bloqueia: aí re-tentar é o certo.
    const limiteRecente = Date.now() - REENTREGA_MS;
    const existente = Object.values(todas).find((v) =>
      String(v.ticket) === String(pedido.ticket)
      && (v.estado === 'pendente' || v.estado === 'processando'
        || (v.estado === 'feito' && v.resultado && v.resultado.ok
            && v.concluidoEm && new Date(v.concluidoEm).getTime() > limiteRecente)));
    if (existente) return { ...existente, jaExistia: true };

    const id = crypto.randomUUID();
    todas[id] = {
      id,
      ticket: pedido.ticket,
      grupoId: pedido.grupoId || null,
      hangarId: pedido.hangarId || null,
      // Parâmetros da validação. Vazios: o coletor usa o padrão dele (#1PARK,
      // 20 dias). Preenchidos: o bot manda o pátio e o prazo específicos.
      patioId: pedido.patioId ?? null,
      patioLabel: pedido.patioLabel ?? null,
      dias: pedido.dias ?? null,
      placa: pedido.placa ?? null,
      motivo: pedido.motivo || null,          // 'cota' | 'faturamento'
      autorizadoPor: pedido.autorizadoPor || null,
      // Teste do canal SEM escrever: o coletor faz tudo menos o PUT.
      simular: pedido.simular === true,
      estado: 'pendente',
      criadoEm: new Date().toISOString(),
      entregueEm: null,
      concluidoEm: null,
      resultado: null,
      // Quem já avisou o grupo do resultado. O bot pode ESPERAR o resultado
      // para responder na hora (como o ValidPark) e, se conseguir, reivindica
      // o aviso aqui; senão o servidor avisa quando o coletor reporta. Esta
      // marca garante que só UM dos dois fale com o grupo.
      avisado: false,
    };
    salvarAtomico(ARQUIVO, todas);
    return todas[id];
  });
}

/** Só leitura de uma validação pelo id — o bot acompanha a sua enquanto espera. */
function consultar(id) {
  return lerJson(ARQUIVO, {})[id] || null;
}

/**
 * Reivindica o direito de avisar o grupo sobre o resultado — operação atômica
 * que resolve a corrida entre o bot (esperando para responder na hora) e o
 * servidor (avisando quando o coletor reporta). O PRIMEIRO a chamar com o
 * resultado já pronto leva; o segundo recebe `jaAvisado`.
 *
 * Devolve: `{ pronto:false }` se o resultado ainda não chegou; `{ pronto:true,
 * reivindicado:true, validacao }` para quem ganhou; `{ pronto:true,
 * reivindicado:false, jaAvisado:true, validacao }` para quem chegou depois.
 */
function reivindicarAviso(id) {
  return comTrava(ARQUIVO, () => {
    const todas = lerJson(ARQUIVO, {});
    const v = todas[id];
    if (!v) return { pronto: false, inexistente: true };
    if (!v.resultado) return { pronto: false, validacao: v };
    if (v.avisado) return { pronto: true, reivindicado: false, jaAvisado: true, validacao: v };
    v.avisado = true;
    salvarAtomico(ARQUIVO, todas);
    return { pronto: true, reivindicado: true, validacao: v };
  });
}

/**
 * O coletor puxa daqui. Devolve as pendentes e as marca 'processando' na mesma
 * trava, para duas leituras não entregarem a mesma validação duas vezes.
 */
function retirarParaProcessar() {
  return comTrava(ARQUIVO, () => {
    const todas = lerJson(ARQUIVO, {});
    const agora = Date.now();
    const lista = [];
    for (const v of Object.values(todas)) {
      if (v.estado === 'processando' && v.entregueEm
          && agora - new Date(v.entregueEm).getTime() > REENTREGA_MS) {
        v.estado = 'pendente';
      }
      if (v.estado === 'pendente') {
        v.estado = 'processando';
        v.entregueEm = new Date().toISOString();
        lista.push({ ...v });
      }
    }
    salvarAtomico(ARQUIVO, todas);
    return lista;
  });
}

function registrarResultado(id, { ok, codigo, resposta }) {
  return comTrava(ARQUIVO, () => {
    const todas = lerJson(ARQUIVO, {});
    const v = todas[id];
    if (!v) return null;
    v.estado = ok ? 'feito' : 'erro';
    v.concluidoEm = new Date().toISOString();
    v.resultado = { ok: ok === true, codigo: codigo ?? null, resposta: String(resposta || '').slice(0, 300) };
    // Varre concluídos antigos ao gravar — sem tarefa separada.
    const limite = Date.now() - RETENCAO_MS;
    for (const [k, x] of Object.entries(todas)) {
      if (x.concluidoEm && new Date(x.concluidoEm).getTime() < limite) delete todas[k];
    }
    salvarAtomico(ARQUIVO, todas);
    return v;
  });
}

/** Só leitura, para o painel mostrar o que está na fila e o que já rodou. */
function listar() {
  return Object.values(lerJson(ARQUIVO, {}))
    .sort((a, b) => String(b.criadoEm).localeCompare(String(a.criadoEm)));
}

module.exports = { enfileirar, retirarParaProcessar, registrarResultado, consultar, reivindicarAviso, listar, ARQUIVO, REENTREGA_MS };
