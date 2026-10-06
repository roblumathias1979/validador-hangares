#!/usr/bin/env node
/**
 * Faturamento de ticket vencido, para hangar SEM cota.
 *
 * Regra: sem cota -> oferta de faturar -> cliente manda FOTO -> chega ao ADMIN
 * -> admin autoriza -> só então o boleto é emitido e a validação liberada.
 *
 * O que este teste protege, e é o que mais importa: o boleto (dinheiro real) só
 * sai depois do SIM do admin — nunca no pedido do cliente. Roda com
 * FATURAMENTO_SIMULAR=true, então o Asaas não é chamado.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';
process.env.FATURAMENTO_SIMULAR = 'true'; // não emite boleto real

const RAIZ = path.join(__dirname, '..');
const GRUPO = '120363430127934870@g.us';      // AIBM 1 (cota 0)
const ADMIN = '5511913119423@s.whatsapp.net'; // grupoAdministracao do AIBM
const PESSOA = '5511999999999@s.whatsapp.net';

require('./cenario').montar({ hangares: { aibm: { cotaMensalForaPrazo: 0, grupoAdministracao: ADMIN } } });

const EXTRA = ['data/faturamentos-pendentes.json', 'data/validacoes-pendentes.json', 'data/cota-fora-prazo.json', 'data/tickets-bloqueados.json'];
const guardado = {};
for (const a of EXTRA) { const p = path.join(RAIZ, a); guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; }
process.on('exit', () => { for (const a of EXTRA) { const p = path.join(RAIZ, a); if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) {} } else fs.writeFileSync(p, guardado[a]); } });
for (const a of EXTRA) fs.writeFileSync(path.join(RAIZ, a), '{}');

const vencido = new Date(Date.now() - 30 * 3600 * 1000).toISOString();
// processar-mensagem desestrutura lerTicket ao carregar, então trocar a função
// não pega — o stub é UM, instalado antes do require, e lê desta variável.
let ticketAtual = '012809072451';
const ocr = require(path.join(RAIZ, 'scripts', 'ocr-ticket.js'));
ocr.lerTicket = async () => ({ status: 'ocr_ok', ticket: ticketAtual, dataEmissaoIso: vencido, conferencia: { ok: true } });

// Asaas NUNCA deve ser chamado (simular=true). Se for, o teste falha alto.
const asaas = require(path.join(RAIZ, 'scripts', 'lib', 'asaas.js'));
asaas.criarCobrancaBoleto = async () => { throw new Error('ASAAS FOI CHAMADO — não deveria, com simular'); };

const child = require('child_process');
child.execFileSync = (_c, args) => { throw new Error('nao deveria chamar ' + path.basename(args[0])); };

const http = require('http');
http.request = (_o, cb) => { const r = new (require('stream').PassThrough)(); r.statusCode = 200; process.nextTick(() => { cb(r); r.end(JSON.stringify({ base64: Buffer.from('f').toString('base64'), mimetype: 'image/jpeg' })); }); return { on() { return this; }, write() {}, end() {}, setTimeout() {}, destroy() {} }; };

const filaFat = require(path.join(RAIZ, 'scripts', 'lib', 'faturamentos-pendentes.js'));
const filaVal = require(path.join(RAIZ, 'scripts', 'lib', 'validacoes-pendentes.js'));
const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));

const foto = () => ({ data: { key: { remoteJid: GRUPO, fromMe: false, id: `T${Math.random()}`, participant: PESSOA }, pushName: 'Cliente', message: { imageMessage: { caption: '', mimetype: 'image/jpeg' } } } });
const textoAdmin = (t) => ({ data: { key: { remoteJid: ADMIN, fromMe: false, id: `A${Math.random()}` }, pushName: 'Rodrigo', message: { conversation: t } } });

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

async function main() {
  console.log('Sem cota: oferece faturar');
  const oferta = await processar(foto(), {});
  conferir('oferece faturamento', oferta.status === 'fora_do_prazo_requer_autorizacao_faturamento', `veio "${oferta.status}"`);
  conferir('informa um valor', typeof oferta.valor === 'number' && oferta.valor > 0, `valor=${oferta.valor}`);
  conferir('pede a foto de autorização', /FOTO/.test(oferta.mensagemWhatsapp));
  conferir('ainda não criou faturamento', filaFat.listar().length === 0);

  console.log('\nCliente manda a foto: vai para o admin, sem emitir nada');
  const comFoto = await processar(foto(), {});
  conferir('fica aguardando admin', comFoto.status === 'faturamento_aguardando_admin', `veio "${comFoto.status}"`);
  conferir('aciona a administração', comFoto.notificarAdmin === true);
  conferir('criou o faturamento aguardando', filaFat.listar().filter(f => f.estado === 'aguardando_admin').length === 1);
  conferir('NADA foi validado ainda', filaVal.listar().length === 0);

  console.log('\nAdmin autoriza no privado: aí sim emite (simulado) e libera');
  const sim = await processar(textoAdmin('sim'), {});
  conferir('faturamento autorizado', sim.status === 'faturamento_autorizado', `veio "${sim.status}"`);
  conferir('a resposta cita boleto simulado', /SIMULADO/i.test(sim.mensagemWhatsapp), sim.mensagemWhatsapp);
  conferir('avisa o grupo do cliente', sim.grupoDeOrigem === GRUPO && /faturado/i.test(sim.avisarGrupoDeOrigem || ''));
  conferir('AGORA enfileirou a validação', filaVal.listar().filter(v => v.motivo === 'faturamento').length === 1);
  conferir('o faturamento saiu de aguardando', filaFat.listar().filter(f => f.estado === 'aguardando_admin').length === 0);

  console.log('\nAdmin recusa outro: nada é emitido nem validado');
  ticketAtual = '012809081706';
  await processar(foto(), {}); await processar(foto(), {}); // oferta + foto
  const naoAntes = filaVal.listar().length;
  const nao = await processar(textoAdmin('não 012809081706'), {});
  conferir('recusa', nao.status === 'faturamento_recusado', `veio "${nao.status}"`);
  conferir('não validou nada a mais', filaVal.listar().length === naoAntes);
  conferir('orienta o cliente ao totem', /totem/i.test(nao.avisarGrupoDeOrigem || ''));

  console.log('\nPátio com faturamentoDesligado: sem cota, escala para a administração');
  const CFG = path.join(RAIZ, 'config', 'hangares.json');
  const cfg = JSON.parse(fs.readFileSync(CFG, 'utf-8'));
  cfg.hangares.find((h) => h.grupoWhatsappId === GRUPO).faturamentoDesligado = true;
  fs.writeFileSync(CFG, JSON.stringify(cfg, null, 2));
  ticketAtual = '012809091234';
  const filaAntes = filaFat.listar().length;
  const semFat = await processar(foto(), {});
  conferir('não oferece faturar', semFat.status === 'fora_do_prazo' && !/faturar/i.test(semFat.mensagemWhatsapp), `veio "${semFat.status}"`);
  conferir('avisa a administração', semFat.notificarAdmin === true);
  const depois = await processar(foto(), {});
  conferir('foto seguinte não vira autorização', depois.status !== 'faturamento_aguardando_admin' && filaFat.listar().length === filaAntes, `veio "${depois.status}"`);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main().catch((e) => { console.error('teste quebrou:', e); falhas += 1; }).finally(() => process.exit(falhas ? 1 : 0));
