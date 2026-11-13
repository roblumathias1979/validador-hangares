#!/usr/bin/env node
/**
 * Índice de comandos da administração: "ajuda" e "ajuda <assunto>" (13/11/2026).
 *
 * O teste mais importante é o de HONESTIDADE: todo exemplo listado no índice tem de
 * ser reconhecido pelo bot, e toda função de comando de whatsapp.js tem de estar no
 * índice (ou na lista de exceções, com motivo). Assim a ajuda não envelhece: comando
 * novo sem entrada aqui, ou exemplo que deixou de funcionar, quebra este teste.
 */

const fs = require('fs');
const path = require('path');

process.env.EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');
require('./cenario').montar({});

const EXTRA = ['data/mensagens-vistas.json', 'data/pendencias.json'];
const guardado = {};
for (const a of EXTRA) { const p = path.join(RAIZ, a); guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; fs.writeFileSync(p, '{}'); }
process.on('exit', () => { for (const a of EXTRA) { const p = path.join(RAIZ, a); if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) { /* ok */ } } else fs.writeFileSync(p, guardado[a]); } });

const w = require(path.join(RAIZ, 'scripts', 'lib', 'whatsapp.js'));
const ajuda = require(path.join(RAIZ, 'scripts', 'lib', 'ajuda-admin.js'));
const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));

const ADM = '120363432317888806@g.us';
const ADMIN_PRIV = '5511992773041@s.whatsapp.net';
const GRUPO_HANGAR = '120363431859218622@g.us';
const PESSOA = '5511999999999@s.whatsapp.net';
const grupo = (jid, t) => ({ data: { key: { remoteJid: jid, fromMe: false, id: `G${Math.random()}`, participant: PESSOA }, pushName: 'Rodrigo', message: { conversation: t } } });
const privado = (t) => ({ data: { key: { remoteJid: ADMIN_PRIV, fromMe: false, id: `P${Math.random()}` }, pushName: 'Rodrigo', message: { conversation: t } } });

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

(async () => {
  console.log('1) Parser');
  for (const [t, topico] of [['ajuda', ''], ['Comandos', ''], ['menu', ''], ['quais comandos', ''], ['o que você faz?', ''], ['lista de comandos', ''], ['ajuda antifraude', 'antifraude'], ['ajuda de fotos', 'fotos'], ['ajuda: reiniciar', 'reiniciar']]) {
    const p = w.interpretarPedidoAjuda(t);
    conferir(`"${t}"`, p && p.topico === topico, JSON.stringify(p));
  }
  for (const t of ['bom dia', 'preciso de ajuda com o ticket 123 do hangar', 'ajuda' + ' x'.repeat(40)]) conferir(`"${t.slice(0, 40)}" NÃO é pedido de ajuda`, w.interpretarPedidoAjuda(t) === null);

  console.log('\n2) O índice é honesto: todo exemplo listado é reconhecido pelo bot');
  for (const c of ajuda.COMANDOS) {
    for (const ex of c.exemplos) conferir(`[${c.titulo}] "${ex}"`, Boolean(c.reconhece(ex, w)));
  }

  console.log('\n3) Todo comando de whatsapp.js está no índice (ou é exceção declarada)');
  const cobertas = new Set(ajuda.COMANDOS.flatMap((c) => c.parsers));
  const todos = Object.keys(w).filter((k) => /^interpretar|^ehPedido|^extrair|^formatar|^eh[A-Z]|^normalizar/.test(k));
  const sobras = todos.filter((k) => !cobertas.has(k) && !ajuda.NAO_SAO_COMANDOS.includes(k));
  conferir('nenhum comando novo ficou de fora da ajuda', sobras.length === 0, `faltam na ajuda: ${sobras.join(', ')}`);
  const inexistentes = [...cobertas].filter((k) => typeof w[k] !== 'function');
  conferir('todo parser citado na ajuda existe', inexistentes.length === 0, inexistentes.join(', '));
  conferir('toda exceção declarada existe', ajuda.NAO_SAO_COMANDOS.every((k) => typeof w[k] === 'function'));

  console.log('\n4) Forma do índice');
  const texto = ajuda.indice();
  conferir('cabe numa mensagem do WhatsApp', texto.length < 3500, String(texto.length));
  conferir('tem o cabeçalho e a dica do passo a passo', /Comandos da administração/.test(texto) && /ajuda <assunto>/.test(texto));
  conferir('lista todos os comandos', ajuda.COMANDOS.every((c) => texto.includes(c.exemplos[0])));
  conferir('agrupa por categoria', ['Sistema', 'Créditos', 'Operação', 'Pátios e cotas', 'Outros', 'Nos grupos dos pátios'].every((n) => texto.includes(n)));
  conferir('toda entrada tem descrição, detalhe e palavras-chave', ajuda.COMANDOS.every((c) => c.descricao && c.detalhe && c.chaves.length && c.titulo));

  console.log('\n5) Passo a passo por assunto');
  for (const [termo, esperado] of [['antifraude', 'Antifraude'], ['faturamento', 'Faturamento'], ['fotos', 'Fotos de referência'], ['reiniciar', 'Reiniciar'], ['crédito aws', 'Crédito da AWS'], ['contingência', 'Contingência'], ['cota', 'Cota disponível']]) {
    const d = ajuda.detalhe(termo);
    conferir(`"ajuda ${termo}" → ${esperado}`, d && d.includes(esperado), String(d).slice(0, 60));
  }
  conferir('assunto desconhecido devolve null', ajuda.detalhe('bananas') === null);
  conferir('o detalhe traz exemplos para copiar', /Exemplos?: \*/.test(ajuda.detalhe('antifraude')));

  console.log('\n6) No grupo de administração e no privado de admin');
  let r = await processar(grupo(ADM, 'ajuda'), {});
  conferir('"ajuda" devolve o índice', r.status === 'ajuda_indice' && /Comandos da administração/.test(r.mensagemWhatsapp), r.status);
  r = await processar(grupo(ADM, 'ajuda antifraude'), {});
  conferir('"ajuda antifraude" devolve o passo a passo', r.status === 'ajuda_detalhe' && /Antifraude/.test(r.mensagemWhatsapp), r.status);
  r = await processar(grupo(ADM, 'ajuda bananas'), {});
  conferir('assunto que não existe: diz e aponta o índice', r.status === 'ajuda_sem_assunto' && /Mande \*ajuda\*/.test(r.mensagemWhatsapp), r.status);
  r = await processar(grupo(ADM, 'comandos'), {});
  conferir('"comandos" também', r.status === 'ajuda_indice', r.status);
  r = await processar(privado('menu'), {});
  conferir('no privado de quem é admin também', r.status === 'ajuda_indice', r.status);

  console.log('\n7) Grupo de hangar NÃO ganha a ajuda da administração');
  r = await processar(grupo(GRUPO_HANGAR, 'ajuda'), {});
  conferir('no grupo de um pátio não vira índice', !/^ajuda_/.test(String(r.status)), r.status);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
  process.exit(falhas ? 1 : 0);
})();
