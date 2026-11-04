#!/usr/bin/env node
/**
 * Adicionar cota ao pátio pelo grupo da administração.
 *
 * O que este teste protege:
 *
 * 1. O bot pergunta o pátio (se não veio), a QUANTIDADE e confirma; só o SIM grava.
 * 2. A cota extra vale SÓ NO MÊS: soma ao teto de agora e some na virada.
 * 3. Extras se acumulam no mesmo mês, e meses antigos saem do config.
 * 4. Pátio sem cota contratada não ganha extra. Quantidade inválida é refeita.
 * 5. "Tem mais cota?" é pergunta, não comando. Só a administração comanda.
 *
 * Config é real: o cenário guarda e devolve.
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

require('./cenario').montar({ hangares: {
  voasp: { cotaMensalValidacoes: 20, cotaExtraMes: { '2000-01': 9 } },
  solojet: { cotaMensalValidacoes: 10 },
  alljet: { cotaMensalValidacoes: undefined },
} });

const EXTRA = ['data/mensagens-vistas.json'];
const guardado = {};
for (const a of EXTRA) { const p = path.join(RAIZ, a); guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; }
process.on('exit', () => { for (const a of EXTRA) { const p = path.join(RAIZ, a); if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) { /* já não existe */ } } else fs.writeFileSync(p, guardado[a]); } });
fs.writeFileSync(path.join(RAIZ, 'data/mensagens-vistas.json'), '{}');

// O comando commita o config: git vira no-op para não sujar o repositório.
const child = require('child_process');
const gitReal = child.execFileSync;
child.execFileSync = (cmd, args, opcoes) => {
  if (cmd === 'git') {
    if (args.some((a) => ['add', 'commit', 'push'].includes(a))) return '';
    if (args.includes('rev-parse')) return 'commit-de-teste';
    return gitReal(cmd, args, opcoes);
  }
  throw new Error('script inesperado: ' + path.basename((args && args[0]) || String(cmd)));
};

const { processar } = require(path.join(RAIZ, 'scripts', 'processar-mensagem.js'));
const cotaMensal = require(path.join(RAIZ, 'scripts', 'lib', 'cota-mensal.js'));
const lerConfig = () => JSON.parse(fs.readFileSync(path.join(RAIZ, 'config', 'hangares.json'), 'utf-8'));
const voasp = () => lerConfig().hangares.find((h) => h.id === 'voasp');
const mes = cotaMensal.mesAtual();

const msg = (de, t) => ({ data: { key: { remoteJid: de, fromMe: false, id: `M${Math.random()}`, participant: PESSOA }, pushName: 'Rodrigo', message: { conversation: t } } });
const diz = (t, de = ADMGRUPO) => processar(msg(de, t), {});

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };

async function main() {
  console.log('Pergunta o pátio, a quantidade e confirma');
  let r = await diz('adicionar cota');
  conferir('pergunta o pátio (há mais de um com cota)', r.status === 'adicionar_cota_pergunta' && /Em qual pátio/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  r = await diz('xyz');
  conferir('pátio não reconhecido é refeito', r.status === 'adicionar_cota_nao_entendido', r.status);
  r = await diz('voa');
  conferir('"voa" acha o VOASP e pergunta a quantidade', /Quantas validações/.test(r.mensagemWhatsapp) && /20/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  r = await diz('muitas');
  conferir('quantidade que não é número é refeita', r.status === 'adicionar_cota_nao_entendido', r.status);
  r = await diz('5');
  conferir('resume: 20 → 25, só neste mês', r.status === 'adicionar_cota_confirmar' && /20 → \*25\*/.test(r.mensagemWhatsapp) && /só em/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  conferir('ainda não gravou', !(voasp().cotaExtraMes || {})[mes]);
  r = await diz('sim');
  conferir('adicionou', r.status === 'cota_adicionada' && /25/.test(r.mensagemWhatsapp), `${r.status} ${r.mensagemWhatsapp}`);
  conferir('gravou só o mês corrente (mês antigo saiu)', JSON.stringify(voasp().cotaExtraMes) === JSON.stringify({ [mes]: 5 }), JSON.stringify(voasp().cotaExtraMes));
  conferir('teto do mês agora é 25', cotaMensal.situacao(voasp()).limite === 25);
  conferir('contratado continua 20', voasp().cotaMensalValidacoes === 20);

  console.log('\nExtras se acumulam no mês; na virada voltam ao normal');
  r = await diz('adicionar 3 cotas no voa');
  conferir('número no comando pula a pergunta', r.status === 'adicionar_cota_confirmar' && /25 → \*28\*/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  r = await diz('sim');
  conferir('acumulou: 8 extras, teto 28', cotaMensal.situacao(voasp()).limite === 28 && voasp().cotaExtraMes[mes] === 8, JSON.stringify(voasp().cotaExtraMes));
  const proximo = new Date(); proximo.setMonth(proximo.getMonth() + 1, 15);
  conferir('no mês seguinte o teto volta a 20', cotaMensal.situacao(voasp(), proximo).limite === 20, String(cotaMensal.situacao(voasp(), proximo).limite));

  console.log('\nNão grava quando não deve');
  r = await diz('adicionar 4 cotas no voa'); r = await diz('não');
  conferir('NÃO cancela', r.status === 'adicionar_cota_cancelado' && voasp().cotaExtraMes[mes] === 8, r.status);
  r = await diz('adicionar cota no voa'); r = await diz('cancelar');
  conferir('CANCELAR cancela', r.status === 'adicionar_cota_cancelado' && voasp().cotaExtraMes[mes] === 8, r.status);
  r = await diz('adicionar cota no voa'); r = await diz('0');
  conferir('zero é recusado', r.status === 'adicionar_cota_nao_entendido', r.status);
  r = await diz('2000');
  conferir('exagero (2000) é recusado', r.status === 'adicionar_cota_nao_entendido', r.status);
  await diz('cancelar');
  r = await diz('adicionar 5 cotas no alljet');
  conferir('pátio sem cota não ganha extra', r.status === 'adicionar_cota_sem_cota', r.status);

  console.log('\nQuem pergunta não comanda');
  r = await diz('tem mais cota no voa?');
  conferir('"tem mais cota?" é consulta', r.status === 'admin_cota_disponivel', `veio "${r.status}"`);
  r = await diz('adicionar cota no voa', SOLOJET);
  conferir('grupo de hangar não comanda', !String(r.status || '').startsWith('adicionar_cota') && voasp().cotaExtraMes[mes] === 8, `veio "${r.status}"`);
  r = await processar(msg('5511900000000@s.whatsapp.net', 'adicionar 5 cotas no voa'), {});
  conferir('número estranho ignorado', r.status === 'ignorado' && voasp().cotaExtraMes[mes] === 8, `veio "${r.status}"`);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main().catch((e) => { console.error('teste quebrou:', e); falhas += 1; }).finally(() => process.exit(falhas ? 1 : 0));
