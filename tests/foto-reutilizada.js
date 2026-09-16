#!/usr/bin/env node
/**
 * A mesma foto não pode validar dois tickets.
 *
 * Buraco relatado em 16/09/2026: no pátio do AIBM 2 apareceram fotos repetidas
 * validadas. A conferência de local não pega isso por construção — ela pergunta
 * "o carro está neste pátio?" e, numa foto reaproveitada do próprio pátio, a
 * resposta é sim. Medido no mesmo dia com a foto real que validou o AIBM 1:
 * "compativel" no AIBM 1 e "incompativel" no AIBM 2, ou seja, o controle de
 * local funciona e ainda assim a fraude passava.
 *
 * Roda sem rede: Evolution, OCR e scripts filhos são substituídos. Os arquivos
 * de estado são de verdade, então o teste guarda e devolve.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const GRUPO_AIBM1 = '120363430127934870@g.us';
const REMETENTE = '5511999999999@s.whatsapp.net';

// A "foto do carro" que a Evolution devolve nos testes.
const FOTO = Buffer.from('foto-do-carro-de-teste').toString('base64');

// --- guarda o estado real -------------------------------------------------
const ARQUIVOS = ['data/fotos-usadas.json', 'data/pendencias.json', 'data/validacoes.jsonl'];
const guardado = {};
for (const a of ARQUIVOS) {
  const p = path.join(RAIZ, a);
  guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
}
const restaurar = () => {
  for (const a of ARQUIVOS) {
    const p = path.join(RAIZ, a);
    if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) { /* já não existe */ } }
    else fs.writeFileSync(p, guardado[a]);
  }
};

// --- substituições --------------------------------------------------------
// processar-mensagem.js captura `execFileSync` por desestruturação ao ser
// carregado, então trocar a função depois não tem efeito nenhum. O stub é
// instalado UMA vez e lê desta variável, que os casos ajustam.
let respostaDaValidacao = { status: 'validado', mensagemWhatsapp: 'validado', vagasDisponiveis: 9, totalVagas: 12 };

const child = require('child_process');
child.execFileSync = (_cmd, args) => {
  const arquivo = path.basename(args[0]);
  if (arquivo === 'validate-ticket.js') {
    return JSON.stringify({ ...respostaDaValidacao, ticket: args[2], placa: args[3] });
  }
  // Consulta prévia do hangar antifraude: o ticket serve, siga para a foto.
  if (arquivo === 'consultar-ticket.js') {
    return JSON.stringify({ status: 'consulta_ok', jaValidado: false, ticket: args[1] });
  }
  throw new Error(`script inesperado no teste: ${arquivo}`);
};

const ocr = require(path.join(RAIZ, 'scripts', 'ocr-ticket.js'));
ocr.lerLocal = async () => ({ local: 'compativel', localMotivo: 'bate com a referência', cenario: 'concreto e parede branca', placa: 'TKM1I33' });

// O que o OCR do ticket devolve. Os casos ajustam.
let respostaDoOcr = null;
ocr.lerTicket = async () => respostaDoOcr;

// Qual imagem a Evolution devolve agora. Os casos trocam.
let fotoAtual = FOTO;

const http = require('http');
http.request = (_o, cb) => {
  const resposta = new (require('stream').PassThrough)();
  resposta.statusCode = 200;
  process.nextTick(() => { cb(resposta); resposta.end(JSON.stringify({ base64: fotoAtual, mimetype: 'image/jpeg' })); });
  return { on() { return this; }, write() {}, end() {}, setTimeout() {}, destroy() {} };
};

const fotosUsadas = require(path.join(RAIZ, 'scripts', 'lib', 'fotos-usadas.js'));
const pendencias = require(path.join(RAIZ, 'scripts', 'lib', 'pendencias.js'));
const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));

function payloadFotoCarro() {
  return {
    data: {
      key: { remoteJid: GRUPO_AIBM1, fromMe: false, id: `T${Date.now()}`, participant: REMETENTE },
      pushName: 'Teste',
      message: { imageMessage: { caption: '', mimetype: 'image/jpeg' } },
    },
  };
}

function pendenciaDeFoto(ticket) {
  pendencias.registrar(GRUPO_AIBM1, REMETENTE, {
    ticket, placa: null, placaEhGenerica: true,
    dataEmissaoIso: new Date().toISOString(), hangarId: 'aibm', tipo: 'foto_local',
  });
}

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  if (ok) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

async function main() {
  fs.writeFileSync(path.join(RAIZ, 'data/fotos-usadas.json'), '{}');
  fs.writeFileSync(path.join(RAIZ, 'data/pendencias.json'), '{}');

  console.log('Primeira vez: foto nova valida normalmente');
  pendenciaDeFoto('011609000001');
  const primeira = await processar(payloadFotoCarro(), {});
  conferir('valida', primeira.status === 'validado', `veio "${primeira.status}"`);
  conferir('a foto fica registrada como gasta', fotosUsadas.jaUsada(FOTO) !== null);

  console.log('\nMesma foto, outro ticket: tem que recusar');
  pendenciaDeFoto('011609000002');
  const segunda = await processar(payloadFotoCarro(), {});
  conferir('não valida', segunda.status !== 'validado', `veio "${segunda.status}"`);
  conferir('diz que é foto reutilizada', segunda.status === 'foto_reutilizada');
  conferir('aciona a administração', segunda.notificarAdmin === true);
  conferir('informa o ticket anterior', (segunda.mensagemWhatsapp || '').includes('011609000001'));
  conferir('pede foto tirada agora', /TIRADA AGORA/i.test(segunda.mensagemWhatsapp || ''));
  conferir('mantém a pendência para o cliente só reenviar a foto',
    (pendencias.buscar(GRUPO_AIBM1, REMETENTE) || {}).ticket === '011609000002');

  console.log('\nFoto diferente: passa');
  const OUTRA = Buffer.from('outra-foto-do-carro').toString('base64');
  conferir('foto nova não consta como usada', fotosUsadas.jaUsada(OUTRA) === null);

  console.log('\nValidação que falha NÃO queima a foto');
  fs.writeFileSync(path.join(RAIZ, 'data/fotos-usadas.json'), '{}');
  respostaDaValidacao = { status: 'sem_vagas', mensagemWhatsapp: 'sem vagas', vagasDisponiveis: 0, totalVagas: 12 };
  pendenciaDeFoto('011609000003');
  const semVagas = await processar(payloadFotoCarro(), {});
  conferir('não validou', semVagas.status === 'sem_vagas', `veio "${semVagas.status}"`);
  conferir('a foto continua valendo', fotosUsadas.jaUsada(FOTO) === null);

  console.log('\nAgrupamento: o par ticket+veículo é gasto junto');
  fs.writeFileSync(path.join(RAIZ, 'data/fotos-usadas.json'), '{}');
  fs.writeFileSync(path.join(RAIZ, 'data/pendencias.json'), '{}');
  respostaDaValidacao = { status: 'validado', mensagemWhatsapp: 'validado', vagasDisponiveis: 9, totalVagas: 12 };

  const FOTO_TICKET = Buffer.from('foto-do-ticket').toString('base64');
  const FOTO_CARRO = Buffer.from('foto-do-carro-par').toString('base64');

  // Passo 1: foto do ticket abre o pedido.
  respostaDoOcr = { status: 'ocr_ok', ticket: '011609000010', dataEmissaoIso: new Date().toISOString(), local: null, localMotivo: null };
  fotoAtual = FOTO_TICKET;
  const passo1 = await processar(payloadFotoCarro(), {});
  conferir('foto do ticket abre o pedido', passo1.status === 'aguardando_foto_veiculo', `veio "${passo1.status}"`);

  // Passo 2: foto do veículo fecha e valida.
  fotoAtual = FOTO_CARRO;
  const passo2 = await processar(payloadFotoCarro(), {});
  conferir('foto do veículo valida', passo2.status === 'validado', `veio "${passo2.status}"`);
  conferir('a foto do TICKET foi gasta', fotosUsadas.jaUsada(FOTO_TICKET) !== null);
  conferir('a foto do VEÍCULO foi gasta', fotosUsadas.jaUsada(FOTO_CARRO) !== null);
  const reg = fotosUsadas.jaUsada(FOTO_TICKET) || {};
  conferir('as duas apontam para a mesma validação', (reg.par || []).length === 2 && reg.ticket === '011609000010');

  console.log('\nReenviar a foto do TICKET não reabre pedido nenhum');
  fotoAtual = FOTO_TICKET;
  const reenvio = await processar(payloadFotoCarro(), {});
  conferir('recusa', reenvio.status === 'foto_reutilizada', `veio "${reenvio.status}"`);
  conferir('aciona a administração', reenvio.notificarAdmin === true);

  console.log('\nFoto fora do agrupamento: não é usada');
  fs.writeFileSync(path.join(RAIZ, 'data/pendencias.json'), '{}');
  respostaDoOcr = {
    status: 'sem_ticket_na_foto', temTicket: false,
    mensagem: 'A foto mostra apenas a traseira do veículo.',
    mensagemWhatsapp: 'Não vi nenhum ticket nessa foto. Para validar, mande primeiro a *foto do ticket* — depois que eu confirmar que ele pode ser validado, eu peço a foto do veículo.',
    notificarAdmin: false,
  };
  fotoAtual = Buffer.from('carro-solto-sem-pedido').toString('base64');
  const solta = await processar(payloadFotoCarro(), {});
  conferir('não valida', solta.status !== 'validado', `veio "${solta.status}"`);
  conferir('diz que não há ticket na foto', solta.status === 'sem_ticket_na_foto');
  conferir('explica a ordem certa', /mande primeiro/i.test(solta.mensagemWhatsapp || ''));
  conferir('não convida a reenviar mais de perto', !/mais de perto/i.test(solta.mensagemWhatsapp || ''));

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main()
  .catch((e) => { console.error('teste quebrou:', e); falhas += 1; })
  .finally(() => { restaurar(); process.exit(falhas ? 1 : 0); });
