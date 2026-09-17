#!/usr/bin/env node
/**
 * Ticket fora do prazo NÃO valida.
 *
 * Até 17/09/2026 o bot oferecia duas saídas para um ticket vencido: gastar uma
 * das validações fora do prazo do mês, ou — esgotada a cota — faturar. As duas
 * foram retiradas a pedido do usuário.
 *
 * O motivo operacional: esses casos são resolvidos à mão, no validador
 * instalado no servidor do aeroporto, que tem permissão que a conta do bot não
 * tem. Oferecer no WhatsApp uma validação que o bot não deveria fazer criava
 * expectativa e gastava cota do hangar numa decisão que não é do cliente.
 *
 * O que este teste protege é a REGRA, não a mensagem: que nenhum caminho de
 * fora do prazo termine em validação enquanto a chave estiver desligada.
 */

const path = require('path');
const { decidirAcaoForaDoPrazo } = require(path.join(__dirname, '..', 'scripts', 'validate-ticket.js'));

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  if (ok) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

const HANGAR = { id: 'solojet', hangar: 'Solojet', prazoValidacaoHoras: 2, cotaMensalForaPrazo: 5 };
const decidir = (extra = {}, hangar = HANGAR) => decidirAcaoForaDoPrazo({
  hangar, ticket: '011609200001', horasDecorridas: 7.4,
  usarCotaForaPrazo: false, autorizarFaturamento: false, fotoAutorizacao: '', dadosCadastrais: null,
  ...extra,
});

console.log('Sem a chave ligada: recusa, aconteça o que acontecer');
conferir('caso simples recusa', decidir().acao === 'recusar', decidir().acao);
conferir('não oferece a cota do mês', decidir().acao !== 'perguntar_cota');
conferir('não oferece faturamento', decidir().acao !== 'perguntar_faturamento');

// Os dois caminhos que ANTES validavam: um "SIM" para a cota e um
// faturamento já autorizado com foto. Nenhum dos dois pode passar agora.
conferir('SIM para a cota não valida', decidir({ usarCotaForaPrazo: true }).acao === 'recusar',
  decidir({ usarCotaForaPrazo: true }).acao);
conferir('faturamento autorizado não valida',
  decidir({ autorizarFaturamento: true, fotoAutorizacao: 'foto' }).acao === 'recusar',
  decidir({ autorizarFaturamento: true, fotoAutorizacao: 'foto' }).acao);

const r = decidir();
conferir('diz há quantas horas foi emitido', /7\.4h/.test(r.mensagemWhatsapp || ''));
conferir('cita o limite do hangar', /2h/.test(r.mensagemWhatsapp || ''));
conferir('avisa que a equipe foi acionada', /equipe foi avisada/i.test(r.mensagemWhatsapp || ''));
conferir('não promete validação', !/SIM/.test(r.mensagemWhatsapp || ''));

console.log('\nCom a chave ligada, o comportamento antigo volta');
const LIBERADO = { ...HANGAR, permiteValidarForaDoPrazo: true };
conferir('volta a oferecer a cota', decidir({}, LIBERADO).acao === 'perguntar_cota',
  decidir({}, LIBERADO).acao);
conferir('SIM volta a valer', decidir({ usarCotaForaPrazo: true }, LIBERADO).acao === 'usar_cota',
  decidir({ usarCotaForaPrazo: true }, LIBERADO).acao);

console.log('\nNenhum hangar tem a chave ligada hoje');
const cfg = require(path.join(__dirname, '..', 'config', 'hangares.json'));
const ligados = cfg.hangares.filter((h) => h.permiteValidarForaDoPrazo === true).map((h) => h.id);
conferir('config limpo', ligados.length === 0, `ligados: ${ligados.join(', ')}`);

console.log('\nNo fluxo: recusa ANTES de pedir a foto do veículo');
(async () => {
  const fs = require('fs');
  process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
  process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
  process.env.EVOLUTION_INSTANCE = 'teste';

  const RAIZ = path.join(__dirname, '..');
  const ESTADO = ['data/validacoes.jsonl', 'data/pendencias.json', 'data/fotos-usadas.json'];
  const guardado = {};
  for (const a of ESTADO) {
    const f = path.join(RAIZ, a);
    guardado[a] = fs.existsSync(f) ? fs.readFileSync(f, 'utf-8') : null;
  }
  const devolver = () => {
    for (const a of ESTADO) {
      const f = path.join(RAIZ, a);
      if (guardado[a] === null) { try { fs.unlinkSync(f); } catch (e) { /* já não existe */ } }
      else fs.writeFileSync(f, guardado[a]);
    }
  };

  try {
    for (const a of ESTADO) fs.writeFileSync(path.join(RAIZ, a), a.endsWith('.jsonl') ? '' : '{}');

    // Nenhum script filho pode ser chamado: a recusa tem que vir antes deles.
    const child = require('child_process');
    const chamados = [];
    child.execFileSync = (_c, args) => { chamados.push(path.basename(args[0])); return '{}'; };

    // Ticket emitido há 7 horas — muito além das 2h do AIBM 1.
    const seteHorasAtras = new Date(Date.now() - 7 * 3600 * 1000).toISOString();
    const ocr = require(path.join(RAIZ, 'scripts', 'ocr-ticket.js'));
    ocr.lerTicket = async () => ({ status: 'ocr_ok', ticket: '011609200009', dataEmissaoIso: seteHorasAtras });

    const http = require('http');
    http.request = (_o, cb) => {
      const r = new (require('stream').PassThrough)();
      r.statusCode = 200;
      process.nextTick(() => { cb(r); r.end(JSON.stringify({ base64: 'ZmFsc28=', mimetype: 'image/jpeg' })); });
      return { on() { return this; }, write() {}, end() {}, setTimeout() {}, destroy() {} };
    };

    const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));
    const pendencias = require(path.join(RAIZ, 'scripts', 'lib', 'pendencias.js'));

    const GRUPO_AIBM1 = '120363430127934870@g.us';
    const PESSOA = '5511999999999@s.whatsapp.net';
    const r = await processar({ data: {
      key: { remoteJid: GRUPO_AIBM1, fromMe: false, id: 'T1', participant: PESSOA },
      pushName: 'Teste', message: { imageMessage: { caption: '', mimetype: 'image/jpeg' } },
    } }, {});

    conferir('recusa por prazo', r.status === 'fora_do_prazo', `veio "${r.status}"`);
    conferir('NÃO pede foto do veículo', r.status !== 'aguardando_foto_veiculo');
    conferir('não deixa pendência aberta', pendencias.buscar(GRUPO_AIBM1, PESSOA) === null);
    conferir('aciona a administração', r.notificarAdmin === true);
    conferir('não abriu navegador nem consultou o site', chamados.length === 0, `chamou: ${chamados.join(', ')}`);
  } finally {
    devolver();
  }

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
  process.exit(falhas ? 1 : 0);
})();
