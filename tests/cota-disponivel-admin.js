#!/usr/bin/env node
/**
 * "Quantas validações disponíveis no VOA?" no grupo da administração.
 *
 * O que este teste protege:
 *
 * 1. A resposta traz as DUAS travas — cota do bot (conta o histórico do mês) e
 *    vagas do pátio no aeroporto (foto do TechParking) — e diz o menor.
 * 2. Só validação deste mês gasta cota: a do mês anterior e a recusada não contam.
 * 3. "voa" basta para achar o VOASP; pátio sem cota diz "sem limite".
 * 4. Sem pátio no texto, pergunta qual. Grupo de hangar não usa o comando.
 * 5. Foto do TechParking velha é avisada, não escondida.
 *
 * Config, histórico e foto do TechParking são reais: o teste guarda e devolve.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const ADMGRUPO = '120363432317888806@g.us';
const SOLOJET = '120363431859218622@g.us';
const PESSOA = '5511999999999@s.whatsapp.net';

require('./cenario').montar({ hangares: { voasp: { cotaMensalValidacoes: 20, bolsaoTechparking: 'PATIO VOA BOT' }, solojet: { cotaMensalValidacoes: undefined } } });

const EXTRA = ['data/mensagens-vistas.json', 'data/techparking-snapshot.json'];
const guardado = {};
for (const a of EXTRA) { const p = path.join(RAIZ, a); guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; }
process.on('exit', () => { for (const a of EXTRA) { const p = path.join(RAIZ, a); if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) { /* já não existe */ } } else fs.writeFileSync(p, guardado[a]); } });
fs.writeFileSync(path.join(RAIZ, 'data/mensagens-vistas.json'), '{}');

const escreverFoto = (recebidoEm) => fs.writeFileSync(path.join(RAIZ, 'data/techparking-snapshot.json'), JSON.stringify({
  recebidoEm,
  patios: [{ IDPATIO: 39, PATIO: 'PATIO VOA BOT', VAGAS: 20 }],
  credenciados: [1, 2, 3].map((n) => ({ BOLSAO: 'PATIO VOA BOT', USUARIO: `Credenciado ${n}`, PLACA: '' })),
}));
escreverFoto(new Date().toISOString());

const agora = new Date();
const mesPassado = new Date(agora.getFullYear(), agora.getMonth() - 1, 15, 12).toISOString();
const linha = (em, status, hangarId = 'voasp') => JSON.stringify({ em, hangarId, status, etapa: 'validacao', ticket: '0', placa: 'AAA0000', grupoId: 'g', remetente: 'x' });
fs.writeFileSync(path.join(RAIZ, 'data/validacoes.jsonl'), [
  ...[1, 2, 3, 4].map(() => linha(agora.toISOString(), 'validado')),
  linha(mesPassado, 'validado'), linha(mesPassado, 'validado'),
  linha(agora.toISOString(), 'sem_vagas'), linha(agora.toISOString(), 'cota_mensal_esgotada'),
].join('\n') + '\n');

const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));
const msg = (de, t) => ({ data: { key: { remoteJid: de, fromMe: false, id: `M${Math.random()}`, participant: PESSOA }, pushName: 'Rodrigo', message: { conversation: t } } });
const noAdm = (t) => processar(msg(ADMGRUPO, t), {});

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

async function main() {
  console.log('VOASP: as duas travas');
  let r = await noAdm('quantas validações disponíveis no voa');
  conferir('status certo', r.status === 'admin_cota_disponivel', `veio "${r.status}"`);
  conferir('cota: 16 de 20 (só as 4 deste mês contam)', /16 de 20/.test(r.mensagemWhatsapp) && /4 usadas/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  conferir('aeroporto: 17 vagas livres (3 de 20)', /17 vagas livres/.test(r.mensagemWhatsapp) && /3 de 20/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  conferir('diz o menor: 16', /validar \*16\* agora/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  conferir('responde sem abrir o ValidPark', r.responder === true && r.notificarAdmin === false);

  r = await noAdm('liberações restantes do VOASP');
  conferir('outra forma de perguntar', r.status === 'admin_cota_disponivel' && /16 de 20/.test(r.mensagemWhatsapp), r.status);

  console.log('\nOutros casos');
  r = await noAdm('cota do solojet');
  conferir('pátio sem cota diz "sem limite"', r.status === 'admin_cota_disponivel' && /sem limite/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  r = await noAdm('quantas validações restam?');
  conferir('sem pátio no texto, pergunta qual', r.status === 'admin_cota_sem_hangar', `veio "${r.status}"`);

  escreverFoto('2020-01-01T00:00:00.000Z');
  r = await noAdm('validações disponíveis do voasp');
  conferir('foto velha é avisada', /desatualizada/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);

  console.log('\nGrupo de hangar não usa');
  r = await processar(msg(SOLOJET, 'quantas validações disponíveis no voa'), {});
  conferir('não vira consulta da administração', r.status !== 'admin_cota_disponivel', `veio "${r.status}"`);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main().catch((e) => { console.error('teste quebrou:', e); falhas += 1; }).finally(() => process.exit(falhas ? 1 : 0));
