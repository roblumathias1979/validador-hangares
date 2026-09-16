#!/usr/bin/env node
// Uso: node scripts/varrer-patios.js [--simular]
//
// Olha o pátio de cada hangar ativo e avisa o grupo quando cruza o limite de
// vagas — quase cheio, lotado, ou normalizado.
//
// POR QUE ISTO EXISTE
// O aviso de pátio nasceu (16/09/2026) aproveitando a leitura que a validação
// já fazia, sem consulta extra. A economia era real, mas o efeito colateral
// também: o alerta só era AVALIADO quando alguém escrevia no grupo. Se o pátio
// enchesse entre duas mensagens, a travessia passava despercebida.
//
// Aconteceu no mesmo dia, no Alljet: o grupo recebeu "PÁTIO LOTADO" sem nunca
// ter recebido "quase cheio". Entre a última mensagem e a seguinte o pátio foi
// de folgado a zero, e o aviso que serviria para alguma coisa — o que dá tempo
// de agir — foi justamente o que se perdeu.
//
// CUSTO: um Chromium por hangar, ~6s cada, SEQUENCIAIS. Em paralelo seriam
// quatro navegadores ao mesmo tempo numa máquina de 2 GB, e economizar 20
// segundos não paga esse risco. A cada 15 minutos isso dá menos de meio minuto
// de trabalho por ciclo.
//
// A decisão de avisar continua inteira em lib/aviso-patio.js: quem avalia a
// travessia, o reaviso de 6h e a normalização é o mesmo código do fluxo do bot.
// Aqui só se escolhe QUANDO olhar.

const { carregarConfig } = require('./lib/hangar');
const { consultarPatio } = require('./consultar-patio');
const avisoPatio = require('./lib/aviso-patio');
const { enviarTexto } = require('./processar-mensagem');

// Hangar sem grupo cadastrado não tem para onde avisar.
function hangaresAtivos(config) {
  return config.hangares.filter((h) => (h.grupoWhatsappId || '').trim());
}

async function varrer({ simular = false } = {}) {
  const hangares = hangaresAtivos(carregarConfig());
  const relatorio = [];

  for (const hangar of hangares) {
    try {
      // Sem forçar `--sem-cache`: se um cliente perguntou o status há menos de
      // um minuto, aquele número serve e poupa um navegador.
      const patio = await consultarPatio(hangar.id);
      // Em simulação NÃO grava: avaliar marca o hangar como avisado, e esse
      // marcador é o que impede a repetição. Simular gravando consumiria o
      // alerta — a varredura real seguinte acharia que já avisou.
      const aviso = avisoPatio.avaliar(hangar, patio.disponiveis, patio.total, { persistir: !simular });

      const linha = {
        hangar: hangar.id,
        disponiveis: patio.disponiveis,
        total: patio.total,
        aviso: aviso ? aviso.acao : null,
        enviado: false,
      };

      if (aviso && !simular) {
        await enviarTexto(hangar.grupoWhatsappId, avisoPatio.mensagemAdmin(aviso));
        linha.enviado = true;
      }
      relatorio.push(linha);
    } catch (erro) {
      // Um hangar que falha não pode impedir a varredura dos outros: o pátio
      // que está enchendo pode ser justamente o seguinte da lista.
      relatorio.push({ hangar: hangar.id, erro: erro.message });
    }
  }

  return { em: new Date().toISOString(), simulacao: simular, patios: relatorio };
}

async function main() {
  const simular = process.argv.includes('--simular');
  try {
    console.log(JSON.stringify(await varrer({ simular })));
  } catch (erro) {
    console.log(JSON.stringify({ status: 'erro', mensagem: erro.message }));
  }
}

if (require.main === module) {
  main();
}

module.exports = { varrer, hangaresAtivos };
