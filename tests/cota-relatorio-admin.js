#!/usr/bin/env node
/**
 * Relatório das cotas usadas, pelo grupo da administração.
 *
 * O que este teste protege:
 *
 * 1. Cada validação do mês aparece com data, hora (São Paulo), ticket e QUEM
 *    autorizou — nome e telefone. O total bate com o saldo da cota.
 * 2. Só entra o mês pedido, e só validação feita (recusa não gasta cota).
 * 3. Linha antiga, sem telefone, aparece com "—" e o rodapé explica.
 * 4. O telefone passa a ser gravado no histórico a partir da mensagem real
 *    (em grupo o id vem como @lid; o número está em participantAlt).
 * 5. Pergunta/comando vizinhos não viram relatório; só a administração vê.
 *
 * Config e histórico são reais: o cenário guarda e devolve.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
const ADMGRUPO = '120363432317888806@g.us';
const SOLOJET = '120363431859218622@g.us';

require('./cenario').montar({ hangares: { voasp: { cotaMensalValidacoes: 20, cotaExtraMes: undefined } } });

const EXTRA = ['data/mensagens-vistas.json'];
const guardado = {};
for (const a of EXTRA) { const p = path.join(RAIZ, a); guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; }
process.on('exit', () => { for (const a of EXTRA) { const p = path.join(RAIZ, a); if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) { /* já não existe */ } } else fs.writeFileSync(p, guardado[a]); } });
fs.writeFileSync(path.join(RAIZ, 'data/mensagens-vistas.json'), '{}');

// Mês corrente em dia/hora fixos (meio-dia UTC = 09:00 em São Paulo, sem virada de dia).
const agora = new Date();
const noMes = (dia, h) => new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth(), dia, h, 30)).toISOString();
const mesPassado = new Date(Date.UTC(agora.getUTCFullYear(), agora.getUTCMonth() - 1, 10, 15, 0)).toISOString();
const linha = (em, status, extra = {}) => JSON.stringify({ em, hangarId: 'voasp', status, etapa: 'validacao', ticket: '010311000000', placa: 'AAA0000', placaEhGenerica: true, remetente: 'Fulano', grupoId: 'g', ...extra });
fs.writeFileSync(path.join(RAIZ, 'data/validacoes.jsonl'), [
  linha(noMes(2, 12), 'validado', { ticket: '010311111111', remetente: 'Hamilton Araujo' }),                      // antiga: sem telefone
  linha(noMes(3, 15), 'validado', { ticket: '010311222222', remetente: 'Isa Marreiro', telefone: '5511992773041' }),
  linha(noMes(3, 16), 'sem_vagas', { ticket: '010311333333' }),                                                  // recusada: não conta
  linha(mesPassado, 'validado', { ticket: '010111444444', remetente: 'Maria Antiga', telefone: '5511988887777' }),
].join('\n') + '\n');

const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));
const msg = (de, t, extraKey = {}) => ({ data: { key: { remoteJid: de, fromMe: false, id: `M${Math.random()}`, participant: '5511999999999@s.whatsapp.net', ...extraKey }, pushName: 'Rodrigo', message: { conversation: t } } });
const noAdm = (t, extraKey) => processar(msg(ADMGRUPO, t, extraKey), {});

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

async function main() {
  console.log('Relatório do mês');
  let r = await noAdm('relatório das cotas do voa');
  const t = r.mensagemWhatsapp || '';
  conferir('status certo', r.status === 'admin_relatorio_cota', `veio "${r.status}"`);
  conferir('cabeçalho: 2 usadas de 20', /2 usadas/.test(t) && /Teto: \*20\*/.test(t), t);
  conferir('data e hora de São Paulo (12:30Z = 09:30)', /02\/\d{2}\/\d{2} 09:30/.test(t) && /03\/\d{2}\/\d{2} 12:30/.test(t), t);
  conferir('nome e telefone formatado de quem autorizou', /Isa Marreiro · \+55 11 99277-3041/.test(t), t);
  conferir('linha antiga sem telefone mostra "—"', /Hamilton Araujo · —/.test(t) && /anterior a 04\/11\/2026/.test(t), t);
  conferir('recusada e mês passado ficam de fora', !/010311333333/.test(t) && !/Maria Antiga/.test(t), t);

  r = await noAdm('extrato de cota do voasp mês passado');
  conferir('mês passado lista só o do mês passado', r.status === 'admin_relatorio_cota' && /Maria Antiga · \+55 11 98888-7777/.test(r.mensagemWhatsapp) && !/Isa Marreiro/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);

  r = await noAdm('relatório das cotas');
  conferir('sem pátio no texto, pergunta qual', r.status === 'admin_relatorio_cota_sem_hangar', `veio "${r.status}"`);

  console.log('\nTelefone gravado a partir da mensagem real');
  await noAdm('relatório das cotas do voa', { participant: '272447123230847@lid', participantAlt: '5511912345678@s.whatsapp.net' });
  const ultima = fs.readFileSync(path.join(RAIZ, 'data/validacoes.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l)).pop();
  conferir('grava o telefone de participantAlt (não o @lid)', ultima.telefone === '5511912345678', JSON.stringify(ultima.telefone));

  console.log('\nVizinhos e permissão');
  r = await noAdm('cota do voa');
  conferir('"cota do voa" segue sendo consulta', r.status === 'admin_cota_disponivel', `veio "${r.status}"`);
  r = await processar(msg(SOLOJET, 'relatório das cotas do voa'), {});
  conferir('grupo de hangar não vê o relatório', r.status !== 'admin_relatorio_cota', `veio "${r.status}"`);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main().catch((e) => { console.error('teste quebrou:', e); falhas += 1; }).finally(() => process.exit(falhas ? 1 : 0));
