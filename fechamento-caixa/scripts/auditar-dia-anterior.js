#!/usr/bin/env node
// Uso: node scripts/auditar-dia-anterior.js [--data=AAAA-MM-DD] [--enviar]
//
// Auditoria do DIA ANTERIOR (nunca do dia atual — o extrato EDI do PagBank só
// fica pronto em D+1, ver scripts/lib/pagseguro-edi.js): para cada unidade
// com `pagseguroEstabelecimento` preenchido em config/unidades.json, busca
// as vendas reais processadas pela maquininha naquele dia e compara contra o
// que a unidade declarou no(s) fechamento(s) daquele dia. É a conferência
// "de verdade" — a conferência por FOTO (processar-fechamento.js) já
// acontece na hora, no mesmo dia; esta é o resumo final auditado do dia
// seguinte, pedido pelo usuário (30/09/2026).
//
// Pensado para rodar 1x por dia via systemd timer (ver
// infra/auditoria-diaria.timer) — mesmo padrão do validador de hangares
// (scripts/varrer-patios.js + infra/varrer-patios.timer).
//
// ⚠️ Só funciona de verdade depois que: 1) o PagBank aprovar a ativação do
// EDI e enviar USER/TOKEN (env PAGSEGURO_EDI_USER/PAGSEGURO_EDI_TOKEN), 2) o
// formato do header de autenticação for confirmado contra o material técnico
// que vem junto (ver nota em scripts/lib/pagseguro-edi.js — hoje é uma
// suposição, Basic Auth). Até lá, cada unidade aparece com
// status "erro_api" no resultado, sem travar as demais.

const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '.env'), override: true });

const { carregarConfig } = require('./lib/unidades');
const { classificarForma } = require('./lib/conferencia');
const { listarFechamentos, gravarAuditoria } = require('./lib/armazenamento');
const { buscarVendasDoDia, somarPorFormaDePagamento } = require('./lib/pagseguro-edi');
const { enviarTexto } = require('./lib/evolution');

function formatarReais(v) {
  return typeof v === 'number' ? `R$ ${v.toFixed(2).replace('.', ',')}` : '—';
}

// UTC-3 fixo — Brasil não tem mais horário de verão desde 2019, então essa
// conta simples é confiável (diferente de antes, quando precisava checar a
// data da mudança de horário).
function dataDeOntemEmSaoPaulo(agora = new Date()) {
  const sp = new Date(agora.getTime() - 3 * 60 * 60 * 1000);
  sp.setUTCDate(sp.getUTCDate() - 1);
  return sp.toISOString().slice(0, 10);
}

function cartaoDeclaradoNoDia(unidadeId, dataAlvo) {
  // Soma o cartão de TODOS os fechamentos finais daquele dia — normalmente é
  // só um, mas não custa somar caso a unidade mande mais de um no mesmo dia.
  const fechamentosDoDia = listarFechamentos({ unidadeId }).filter((f) => {
    if ((f.relatorio || {}).situacao === 'parcial') return false;
    return (f.criadoEm || '').slice(0, 10) === dataAlvo;
  });

  let soma = 0;
  let encontrouAlgum = false;
  for (const f of fechamentosDoDia) {
    const r = f.relatorio || {};
    const formas = Array.isArray(r.formasDePagamento) ? r.formasDePagamento : [];
    const cartaoFormas = formas.filter((fp) => classificarForma(fp.forma) === 'cartao' && typeof fp.valor === 'number');
    if (cartaoFormas.length) {
      soma += cartaoFormas.reduce((acc, fp) => acc + fp.valor, 0);
      encontrouAlgum = true;
    } else if (typeof r.recebidoCartao === 'number') {
      soma += r.recebidoCartao;
      encontrouAlgum = true;
    }
  }
  return encontrouAlgum ? Number(soma.toFixed(2)) : null;
}

async function auditarUnidade(unidade, dataAlvo) {
  if (!unidade.pagseguroEstabelecimento) {
    return { status: 'sem_estabelecimento_configurado', unidadeId: unidade.id, unidadeNome: unidade.nome };
  }

  let vendas;
  try {
    vendas = await buscarVendasDoDia(dataAlvo, { estabelecimento: unidade.pagseguroEstabelecimento });
  } catch (erro) {
    return { status: 'erro_api', unidadeId: unidade.id, unidadeNome: unidade.nome, mensagem: erro.message };
  }

  const somaEdi = somarPorFormaDePagamento(vendas.transacoes);
  const cartaoDeclarado = cartaoDeclaradoNoDia(unidade.id, dataAlvo);

  // Só compara contra o que é CONFIRMADO (crédito, código "8") — o resto
  // (débito, Pix) fica em "nao_classificado" até o PagBank publicar a
  // tabela completa de códigos; comparar contra um número parcial seria
  // inventar uma conferência que não existe de verdade.
  const diferenca = cartaoDeclarado !== null ? Number((cartaoDeclarado - somaEdi.credito).toFixed(2)) : null;

  const registro = {
    unidadeId: unidade.id,
    unidadeNome: unidade.nome,
    dataAuditada: dataAlvo,
    cartaoDeclarado,
    creditoConfirmadoEdi: somaEdi.credito,
    valorNaoClassificadoEdi: somaEdi.nao_classificado,
    totalTransacoesEdi: vendas.transacoes.length,
    diferenca,
    status: cartaoDeclarado === null ? 'sem_fechamento_no_dia'
      : diferenca === null ? 'sem_dados_suficientes'
      : Math.abs(diferenca) <= 1 ? 'auditado_ok' : 'auditado_divergente',
    criadoEm: new Date().toISOString(),
  };
  gravarAuditoria(registro);
  return registro;
}

async function main() {
  const args = process.argv.slice(2);
  const enviar = args.includes('--enviar');
  const argData = args.find((a) => a.startsWith('--data='));
  const dataAlvo = argData ? argData.split('=')[1] : dataDeOntemEmSaoPaulo();

  const config = carregarConfig();
  const resultados = [];

  for (const unidade of config.unidades) {
    const resultado = await auditarUnidade(unidade, dataAlvo);
    resultados.push(resultado);

    if (resultado.status === 'sem_estabelecimento_configurado' || resultado.status === 'sem_fechamento_no_dia') {
      continue; // nada a avisar — unidade sem PagSeguro cadastrado, ou sem fechamento naquele dia
    }

    if (enviar && unidade.grupoWhatsappId) {
      const partes = [`🔎 Auditoria de *${unidade.nome}* — ${dataAlvo} (contra a API do PagBank):`];
      if (resultado.status === 'erro_api') {
        partes.push(`⚠️ Não consegui consultar a API do PagBank: ${resultado.mensagem}`);
      } else {
        partes.push(`   • Cartão declarado no fechamento: ${formatarReais(resultado.cartaoDeclarado)}`);
        partes.push(`   • Crédito confirmado na maquininha: ${formatarReais(resultado.creditoConfirmadoEdi)}`);
        if (resultado.valorNaoClassificadoEdi) {
          partes.push(`   • Outros valores na maquininha (débito/Pix, ainda não classificados automaticamente): ${formatarReais(resultado.valorNaoClassificadoEdi)}`);
        }
        partes.push(resultado.status === 'auditado_ok'
          ? '✅ Auditado: bate dentro do esperado.'
          : `⚠️ Auditado: diferença de ${formatarReais(Math.abs(resultado.diferenca))} — vale conferir.`);
      }
      try {
        await enviarTexto(unidade.grupoWhatsappId, partes.join('\n'));
      } catch (erro) {
        resultado.erroEnvio = erro.message;
      }
    }
  }

  console.log(JSON.stringify({ dataAuditada: dataAlvo, resultados }));
}

if (require.main === module) {
  main();
}

module.exports = { auditarUnidade, dataDeOntemEmSaoPaulo, cartaoDeclaradoNoDia };
