#!/usr/bin/env node
/**
 * Criar pátio pelo painel.
 *
 * Até 17/09/2026 cadastrar um pátio era editar config/hangares.json no
 * servidor, e todo hangar novo passava por quem tem acesso SSH.
 *
 * O que merece teste aqui não é o caminho feliz — é o que o formulário pode
 * estragar: id que vira nome de pasta e de variável de ambiente, e credencial
 * sobrescrita por engano na tela de CRIAR.
 *
 * Sobe o painel numa porta própria e fala com ele por HTTP, para exercitar a
 * rota de verdade. Config e .env são reais: o teste guarda e devolve.
 */

const fs = require('fs');
const path = require('path');
const http = require('http');

const RAIZ = path.join(__dirname, '..');
const ARQUIVOS = ['config/hangares.json', '.env', 'data/usuarios.json'];
const guardado = {};
for (const a of ARQUIVOS) {
  const p = path.join(RAIZ, a);
  guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
}
let restaurado = false;
const restaurar = () => {
  if (restaurado) return;
  restaurado = true;
  for (const a of ARQUIVOS) {
    const p = path.join(RAIZ, a);
    if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) { /* já não existe */ } }
    else fs.writeFileSync(p, guardado[a]);
  }

};
process.on('exit', restaurar);
process.on('uncaughtException', (e) => { restaurar(); console.error(e); process.exit(1); });

process.env.PAINEL_SENHA = 'senha-de-teste';
process.env.PAINEL_PORTA = '0';

// Um usuário só deste teste. A senha de resgate (PAINEL_SENHA) não serve: ela
// só vale enquanto NÃO existe usuário nenhum, e aqui existem os de verdade —
// que o teste guarda e devolve junto com os demais arquivos.
const USUARIO = 'teste-automatizado';
const SENHA_TESTE = 'senha-de-teste-longa';
{
  const usuarios = require(path.join(RAIZ, 'painel', 'usuarios.js'));
  fs.mkdirSync(path.dirname(usuarios.ARQUIVO), { recursive: true });
  fs.writeFileSync(usuarios.ARQUIVO, '{}');
  usuarios.criar({ nome: USUARIO, senha: SENHA_TESTE });
}

// O painel commita E EMPURRA a cada alteração. Num teste isso sujaria o
// histórico do repositório e mandaria lixo para o GitHub — aconteceu na
// primeira versão deste arquivo, que criou três commits de verdade.
//
// O stub tem que ser instalado ANTES de carregar o painel: servidor.js captura
// `execFileSync` por desestruturação no topo, e trocar depois não teria efeito.
const child = require('child_process');
const gitReal = child.execFileSync;
child.execFileSync = (cmd, args, opcoes) => {
  // O comando de commit vem como ['-c','user.name=…','-c','…','commit','-m',…],
  // então olhar args[0] não basta: o subcomando pode estar em qualquer posição.
  if (cmd === 'git') {
    if (args.some((a) => ['add', 'commit', 'push'].includes(a))) return '';
    if (args.includes('rev-parse')) return 'commit-de-teste';
  }
  return gitReal(cmd, args, opcoes);
};

const { servidor } = require(path.join(RAIZ, 'painel', 'servidor.js'));

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  if (ok) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

function chamar(porta, caminho, corpo) {
  return new Promise((resolve, reject) => {
    const dados = JSON.stringify(corpo);
    const req = http.request({
      host: '127.0.0.1', port: porta, path: caminho, method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(dados),
        Authorization: 'Basic ' + Buffer.from(`${USUARIO}:${SENHA_TESTE}`).toString('base64'),
      },
    }, (res) => {
      let c = '';
      res.on('data', (x) => (c += x));
      res.on('end', () => { try { resolve({ codigo: res.statusCode, corpo: JSON.parse(c) }); } catch (e) { resolve({ codigo: res.statusCode, corpo: c }); } });
    });
    req.on('error', reject);
    req.end(dados);
  });
}

const criar = (porta, corpo) => chamar(porta, '/api/hangar-novo', corpo);
const excluir = (porta, corpo) => chamar(porta, '/api/hangar-excluir', corpo);

async function main() {
  const srv = servidor.listen(0, '127.0.0.1');
  await new Promise((r) => srv.on('listening', r));
  const porta = srv.address().port;

  try {
    console.log('Criação com login');
    const r = await criar(porta, { id: 'patio-teste', nome: 'Pátio de Teste', usuario: 'BOT_TESTE', senha: 'segredo123' });
    conferir('aceita', r.codigo === 200, JSON.stringify(r.corpo).slice(0, 120));
    conferir('deriva o nome das variáveis', r.corpo.usuarioEnvVar === 'PATIO_TESTE_USUARIO' && r.corpo.senhaEnvVar === 'PATIO_TESTE_SENHA',
      `${r.corpo.usuarioEnvVar} / ${r.corpo.senhaEnvVar}`);

    const cfg = JSON.parse(fs.readFileSync(path.join(RAIZ, 'config/hangares.json'), 'utf-8'));
    const novo = cfg.hangares.find((h) => h.id === 'patio-teste');
    conferir('entrou no config', Boolean(novo));
    conferir('nasce inativo, sem grupo', novo.grupoWhatsappId === '');
    conferir('herda a URL do ValidPark', novo.validadorUrl === cfg.hangares[0].validadorUrl);
    conferir('herda os seletores', JSON.stringify(novo.seletores) === JSON.stringify(cfg.hangares[0].seletores));
    conferir('já nasce com destino de aviso', Boolean((novo.grupoAdministracao || '').trim()));

    const env = fs.readFileSync(path.join(RAIZ, '.env'), 'utf-8');
    conferir('gravou o usuário no .env', /^PATIO_TESTE_USUARIO=BOT_TESTE$/m.test(env));
    conferir('gravou a senha no .env', /^PATIO_TESTE_SENHA=segredo123$/m.test(env));
    conferir('não devolveu a senha na resposta', !JSON.stringify(r.corpo).includes('segredo123'));

    console.log('\nO que o formulário poderia estragar');
    const repetido = await criar(porta, { id: 'patio-teste', nome: 'Outro' });
    conferir('recusa id repetido', repetido.codigo === 400 && /Já existe/.test(repetido.corpo.erro), JSON.stringify(repetido.corpo));

    const semNome = await criar(porta, { id: 'sem-nome-x', nome: '  ' });
    conferir('recusa sem nome', semNome.codigo === 400);

    for (const ruim of ['../fuga', '1comeca-com-numero', 'com ponto.e', 'a', 'tem_underline']) {
      const r2 = await criar(porta, { id: ruim, nome: 'X' });
      conferir(`recusa id "${ruim}"`, r2.codigo === 400, JSON.stringify(r2.corpo).slice(0, 80));
    }

    // Maiúscula NÃO é recusada: é normalizada. Quem digita "Hangar-Aristek"
    // quer o mesmo pátio que "hangar-aristek", e recusar seria pedantismo.
    const maiuscula = await criar(porta, { id: 'COM-MAIUSCULA', nome: 'Com Maiúscula' });
    conferir('normaliza id em maiúsculas', maiuscula.codigo === 200 && maiuscula.corpo.id === 'com-maiuscula',
      JSON.stringify(maiuscula.corpo).slice(0, 100));

    console.log('\nCredencial existente não é sobrescrita pela tela de criar');
    // Remove o hangar do config mas deixa as variáveis no .env, simulando
    // alguém tentando recriar um pátio que já tem login.
    const cfg2 = JSON.parse(fs.readFileSync(path.join(RAIZ, 'config/hangares.json'), 'utf-8'));
    cfg2.hangares = cfg2.hangares.filter((h) => h.id !== 'patio-teste');
    fs.writeFileSync(path.join(RAIZ, 'config/hangares.json'), JSON.stringify(cfg2, null, 2) + '\n');

    const recriar = await criar(porta, { id: 'patio-teste', nome: 'Pátio de Teste', usuario: 'OUTRO', senha: 'outra-senha' });
    conferir('recusa sobrescrever credencial', recriar.codigo === 400 && /já existe no \.env/i.test(recriar.corpo.erro || ''),
      JSON.stringify(recriar.corpo).slice(0, 140));
    const envDepois = fs.readFileSync(path.join(RAIZ, '.env'), 'utf-8');
    conferir('a senha original ficou intacta', /^PATIO_TESTE_SENHA=segredo123$/m.test(envDepois) && !envDepois.includes('outra-senha'));

    console.log('\nCriação sem login: permitida, marcada como pendente');
    const semLogin = await criar(porta, { id: 'patio-sem-login', nome: 'Sem Login' });
    conferir('aceita', semLogin.codigo === 200, JSON.stringify(semLogin.corpo).slice(0, 120));
    conferir('avisa que falta credencial', semLogin.corpo.credenciais === false);
    conferir('não inventou variável no .env', !fs.readFileSync(path.join(RAIZ, '.env'), 'utf-8').includes('PATIO_SEM_LOGIN_SENHA='));
    console.log('\nExcluir pátio');
    const semConfirmar = await excluir(porta, { id: 'patio-sem-login' });
    conferir('recusa sem a confirmação digitada', semConfirmar.codigo === 400 && /digite exatamente/i.test(semConfirmar.corpo.erro || ''),
      JSON.stringify(semConfirmar.corpo).slice(0, 100));

    const errado = await excluir(porta, { id: 'patio-sem-login', confirmacao: 'patio-sem-logim' });
    conferir('recusa confirmação com erro de digitação', errado.codigo === 400);

    const inexistente = await excluir(porta, { id: 'nao-existe', confirmacao: 'nao-existe' });
    conferir('recusa pátio inexistente', inexistente.codigo === 404);

    const ok = await excluir(porta, { id: 'patio-sem-login', confirmacao: 'patio-sem-login' });
    conferir('exclui quando confirmado', ok.codigo === 200, JSON.stringify(ok.corpo).slice(0, 120));
    const cfgDepois = JSON.parse(fs.readFileSync(path.join(RAIZ, 'config/hangares.json'), 'utf-8'));
    conferir('saiu do config', !cfgDepois.hangares.some((h) => h.id === 'patio-sem-login'));

    console.log('\nO que a exclusão NÃO leva junto');
    const envFinal = fs.readFileSync(path.join(RAIZ, '.env'), 'utf-8');
    conferir('credenciais do outro pátio intactas', /^PATIO_TESTE_SENHA=segredo123$/m.test(envFinal));
    conferir('diz quais credenciais ficaram', Array.isArray(ok.corpo.mantido.credenciais) && ok.corpo.mantido.credenciais.length === 2,
      JSON.stringify(ok.corpo.mantido));
    conferir('informa quanto histórico ficou', typeof ok.corpo.mantido.historico === 'number');
  } finally {
    srv.close();
  }

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main()
  .catch((e) => { console.error('teste quebrou:', e); falhas += 1; })
  .finally(() => { restaurar(); process.exit(falhas ? 1 : 0); });
