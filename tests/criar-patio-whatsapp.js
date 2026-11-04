#!/usr/bin/env node
/**
 * Criar pátio pelo WhatsApp da administração.
 *
 * O que este teste protege:
 *
 * 1. Só a administração cria: grupo de hangar e número estranho não abrem o cadastro.
 * 2. A conversa percorre nome, identificador, TechParking, login, cota e grupo, e
 *    só o SIM grava. NÃO e CANCELAR não criam nada.
 * 3. "Ainda não existe no TechParking" e "ainda não tem usuário" criam o pátio
 *    sem vínculo/credencial, e a resposta diz o que falta.
 * 4. Pátio do TechParking que não existe na foto é recusado (a menos de "mesmo assim").
 * 5. A senha vai para o .env, NUNCA para o config nem para uma mensagem do bot.
 * 6. Identificador repetido e variável já existente no .env não são sobrescritos.
 *
 * Config, .env e a foto do TechParking são reais: o teste guarda e devolve.
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

require('./cenario').montar({ hangares: { solojet: {} } });

const EXTRA = ['data/mensagens-vistas.json', '.env', 'data/techparking-snapshot.json'];
const guardado = {};
for (const a of EXTRA) { const p = path.join(RAIZ, a); guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null; }
process.on('exit', () => { for (const a of EXTRA) { const p = path.join(RAIZ, a); if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) { /* já não existe */ } } else fs.writeFileSync(p, guardado[a]); } });
fs.writeFileSync(path.join(RAIZ, 'data/mensagens-vistas.json'), '{}');
fs.writeFileSync(path.join(RAIZ, '.env'), 'OUTRO_PATIO_USUARIO=ja-existe\n');
// Foto "velha" de propósito: não é um coletor ao vivo, e o teste manda no conteúdo.
fs.writeFileSync(path.join(RAIZ, 'data/techparking-snapshot.json'), JSON.stringify({
  recebidoEm: '2020-01-01T00:00:00.000Z',
  patios: [{ IDPATIO: 39, PATIO: 'PATIO VOA BOT', VAGAS: 20 }, { IDPATIO: 7, PATIO: 'HANGAR TESTE UM', VAGAS: 30 }],
  credenciados: [],
}));

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
const CONFIG = path.join(RAIZ, 'config', 'hangares.json');
const lerConfig = () => JSON.parse(fs.readFileSync(CONFIG, 'utf-8'));
const achar = (id) => lerConfig().hangares.find((h) => h.id === id);
const env = () => fs.readFileSync(path.join(RAIZ, '.env'), 'utf-8');

const noAdm = (t) => ({ data: { key: { remoteJid: ADMGRUPO, fromMe: false, id: `G${Math.random()}`, participant: PESSOA }, pushName: 'Rodrigo', message: { conversation: t } } });
const noPrivado = (de, t) => ({ data: { key: { remoteJid: de, fromMe: false, id: `P${Math.random()}` }, pushName: 'Rodrigo', message: { conversation: t } } });
const noGrupoHangar = (t) => ({ data: { key: { remoteJid: SOLOJET, fromMe: false, id: `H${Math.random()}`, participant: PESSOA }, pushName: 'Cliente', message: { conversation: t } } });

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };
const diz = async (t, de = noAdm) => processar(de(t), {});

async function main() {
  const antes = lerConfig().hangares.length;

  console.log('Quem não é admin não cria');
  const estranho = await processar(noPrivado('5511900000000@s.whatsapp.net', 'criar pátio'), {});
  conferir('número estranho ignorado', estranho.status === 'ignorado', `veio "${estranho.status}"`);
  const doHangar = await diz('criar pátio', noGrupoHangar);
  conferir('grupo de hangar não abre cadastro', !String(doHangar.status || '').startsWith('criar_patio'), `veio "${doHangar.status}"`);

  console.log('\nCaminho completo, com TechParking e login');
  let r = await diz('criar pátio');
  conferir('pergunta o nome', r.status === 'criar_patio_pergunta' && /nome/i.test(r.mensagemWhatsapp), r.status);
  r = await diz('Hangar Teste Um');
  conferir('sugere o identificador', /hangar-teste-um/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  r = await diz('ok');
  conferir('pergunta se já existe no TechParking', /TechParking/.test(r.mensagemWhatsapp) && /SIM/.test(r.mensagemWhatsapp), `${r.status}: ${r.mensagemWhatsapp}`);
  r = await diz('sim');
  conferir('pede o nome no TechParking', /nome do pátio no TechParking/i.test(r.mensagemWhatsapp));
  r = await diz('PATIO NAO EXISTE XYZ');
  conferir('nome que não está na foto é recusado', r.status === 'criar_patio_nao_entendido' && /Não achei/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  r = await diz('hangar teste um');
  conferir('casa ignorando maiúsculas e acento', /HANGAR TESTE UM/.test(r.mensagemWhatsapp) && /30 vagas/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  conferir('pergunta se já tem usuário e senha', /usuário e a senha/.test(r.mensagemWhatsapp));
  r = await diz('sim');
  r = await diz('teste01');
  conferir('pede a senha sem repeti-la', /senha/i.test(r.mensagemWhatsapp));
  r = await diz('S3nh@Secreta!');
  conferir('não repete a senha na resposta', !/S3nh@Secreta/.test(r.mensagemWhatsapp));
  r = await diz('20');
  conferir('pede o grupo', /@g\.us/.test(r.mensagemWhatsapp));
  r = await diz('120363499999999999@g.us');
  conferir('resumo para confirmar, sem a senha', r.status === 'criar_patio_confirmar' && /hangar-teste-um/.test(r.mensagemWhatsapp) && !/S3nh@Secreta/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  conferir('ainda não gravou', !achar('hangar-teste-um'));
  r = await diz('sim');
  conferir('criou o pátio', r.status === 'criar_patio_criado', `veio "${r.status}" ${r.mensagemWhatsapp}`);
  const h = achar('hangar-teste-um');
  conferir('pátio no config com bolsão, cota e grupo', h && h.bolsaoTechparking === 'HANGAR TESTE UM' && h.cotaMensalValidacoes === 20 && h.grupoWhatsappId === '120363499999999999@g.us', JSON.stringify(h && { b: h.bolsaoTechparking, c: h.cotaMensalValidacoes, g: h.grupoWhatsappId }));
  conferir('senha no .env', /HANGAR_TESTE_UM_SENHA=S3nh@Secreta!/.test(env()) && /HANGAR_TESTE_UM_USUARIO=teste01/.test(env()));
  conferir('senha NÃO está no config', !JSON.stringify(lerConfig()).includes('S3nh@Secreta'));
  conferir('molde do ValidPark copiado', h && h.seletores && h.validadorUrl === lerConfig().hangares[0].validadorUrl);

  console.log('\nSem TechParking e sem usuário: cria e diz o que falta');
  await diz('cadastrar um novo pátio');
  await diz('Pátio Teste Dois');
  await diz('ok');
  await diz('não');
  await diz('não');
  r = await diz('sem limite');
  r = await diz('depois');
  conferir('resumo avisa as pendências', /sem vínculo/.test(r.mensagemWhatsapp) && /ainda não cadastrado/.test(r.mensagemWhatsapp) && /não vinculado/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  r = await diz('sim');
  conferir('criou sem credencial', r.status === 'criar_patio_criado' && /Falta/.test(r.mensagemWhatsapp) && /usuário e a senha/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  const h2 = achar('patio-teste-dois');
  conferir('sem bolsão e sem cota (sem teto)', h2 && !('bolsaoTechparking' in h2) && !('cotaMensalValidacoes' in h2) && h2.grupoWhatsappId === '', JSON.stringify(h2 && Object.keys(h2)));
  conferir('nada novo no .env', !/PATIO_TESTE_DOIS/.test(env()));

  console.log('\nNão e CANCELAR não criam');
  const total = lerConfig().hangares.length;
  await diz('criar pátio'); await diz('Pátio Cancelado'); await diz('ok'); await diz('não'); await diz('não'); await diz('5');
  await diz('depois');
  r = await diz('não');
  conferir('NÃO na confirmação cancela', r.status === 'criar_patio_cancelado' && lerConfig().hangares.length === total, r.status);
  await diz('criar pátio');
  r = await diz('cancelar');
  conferir('CANCELAR no meio cancela', r.status === 'criar_patio_cancelado' && lerConfig().hangares.length === total, r.status);

  console.log('\nProteções');
  await diz('criar pátio'); await diz('Outro Nome');
  r = await diz('solojet');
  conferir('identificador repetido é recusado', r.status === 'criar_patio_nao_entendido' && /Já existe/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  r = await diz('Bad ID!');
  conferir('identificador inválido é recusado', r.status === 'criar_patio_nao_entendido', r.status);
  await diz('outro-patio-env'); await diz('não'); // sem TechParking
  await diz('sim'); // login existe
  await diz('x'); await diz('y'); await diz('1'); await diz('depois');
  fs.appendFileSync(path.join(RAIZ, '.env'), 'OUTRO_PATIO_ENV_USUARIO=ja-existe\n');
  r = await diz('sim');
  conferir('variável já existente no .env não é sobrescrita', r.status === 'erro' && !achar('outro-patio-env') && /já existe no \.env/.test(r.mensagemWhatsapp), `${r.status} ${r.mensagemWhatsapp}`);
  conferir('o .env continua com o valor antigo', /OUTRO_PATIO_ENV_USUARIO=ja-existe/.test(env()) && !/OUTRO_PATIO_ENV_SENHA/.test(env()));

  const grupoRepetido = lerConfig().hangares.find((x) => (x.grupoWhatsappId || '').trim()).grupoWhatsappId;
  await diz('criar pátio'); await diz('Com Grupo Repetido'); await diz('ok'); await diz('não'); await diz('não'); await diz('1');
  r = await diz(grupoRepetido);
  conferir('grupo de outro pátio é recusado', r.status === 'criar_patio_nao_entendido' && /já pertence/.test(r.mensagemWhatsapp), r.mensagemWhatsapp);
  await diz('cancelar');

  conferir('só os dois pátios esperados foram criados', lerConfig().hangares.length === antes + 2, `${antes} -> ${lerConfig().hangares.length}`);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main().catch((e) => { console.error('teste quebrou:', e); falhas += 1; }).finally(() => process.exit(falhas ? 1 : 0));
