#!/usr/bin/env node
/**
 * Rota da câmera: POST /api/fiscalizacao/ler.
 *
 * O leitor de placas (que chama o modelo, pago) é trocado por um falso: o que
 * se testa aqui é o que o servidor faz em volta dele — conta somente leitura
 * pode usar, o freio de custo segura, a placa lida já volta avaliada, e o
 * vermelho deixa histórico e foto.
 *
 * Usuários, snapshot, histórico e fotos são arquivos reais: o teste guarda e
 * devolve.
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
const ARQUIVOS = ['data/usuarios.json', 'data/techparking-snapshot.json', 'data/fiscalizacao.jsonl'];
const FOTOS = path.join(RAIZ, 'data', 'fiscalizacao-fotos');
const guardado = {};
for (const a of ARQUIVOS) {
  const p = path.join(RAIZ, a);
  guardado[a] = fs.existsSync(p) ? fs.readFileSync(p, 'utf-8') : null;
}
const fotosAntes = fs.existsSync(FOTOS);
const restaurar = () => {
  for (const a of ARQUIVOS) {
    const p = path.join(RAIZ, a);
    if (guardado[a] === null) { try { fs.unlinkSync(p); } catch (e) { /* não existia */ } } else fs.writeFileSync(p, guardado[a]);
  }
  if (!fotosAntes) fs.rmSync(FOTOS, { recursive: true, force: true });
};

// Leitor falso: devolve as placas que o teste mandar no "quadro".
const caminhoLeitor = require.resolve('../scripts/lib/ler-placas');
require.cache[caminhoLeitor] = {
  id: caminhoLeitor, filename: caminhoLeitor, loaded: true,
  exports: { lerPlacas: async (b64) => ({ placas: JSON.parse(Buffer.from(b64, 'base64').toString()).slice(0, 5).map((placa) => ({ placa, veiculo: 'moto' })), descartadas: [] }) },
};

let falhas = 0;
const conferir = (nome, ok, detalhe) => {
  if (ok) return console.log(`  ok   ${nome}`);
  falhas += 1;
  console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`);
};

async function main() {
  process.env.PAINEL_SENHA = 'x';
  const usuarios = require('../painel/usuarios');
  const { servidor } = require('../painel/servidor');
  usuarios.criar({ nome: 'fiscal-teste', senha: 'senha-do-teste-123', somenteLeitura: true });

  fs.writeFileSync(path.join(RAIZ, 'data', 'techparking-snapshot.json'), JSON.stringify({
    recebidoEm: new Date().toISOString(),
    patios: [{ IDPATIO: 30, PATIO: 'HANGAR SOLOJET ', VAGAS: 90 }, { IDPATIO: 18, PATIO: 'AIBM', VAGAS: 12 }],
    avulsos: [
      { CARTAO: '1', USUARIO: 'HANGAR SOLOJET', IDPATIO: 30, DATA_ENT: '2026-09-29T10:00:00', TOLERANCIA: '2099-01-01T00:00:00', PLACA: 'BOR6666' },
      { CARTAO: '2', USUARIO: 'AIBM', IDPATIO: 18, DATA_ENT: '2026-09-29T10:00:00', TOLERANCIA: '2099-01-01T00:00:00', PLACA: 'AIB1234' },
    ],
    credenciados: [],
  }));

  await new Promise((r) => servidor.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${servidor.address().port}`;
  const auth = { Authorization: `Basic ${Buffer.from('fiscal-teste:senha-do-teste-123').toString('base64')}` };
  // O "quadro" é a lista de placas em base64, com folga para passar do mínimo.
  const quadro = (placas) => Buffer.from(JSON.stringify(placas) + ' '.repeat(1200)).toString('base64');
  const ler = (placas) => fetch(`${base}/api/fiscalizacao/ler`, {
    method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify({ imagem: quadro(placas), lat: -23.18, lng: -46.94 }),
  });

  console.log('Conta somente leitura');
  const r1 = await ler(['BOR6666', 'AIB1234']);
  conferir('pode ler placas', r1.status === 200, `status ${r1.status}`);
  const d1 = await r1.json();
  conferir('volta avaliada', d1.placas.length === 2 && d1.placas[0].situacao === 'regular' && d1.placas[1].situacao === 'irregular',
    JSON.stringify(d1.placas.map((p) => p.situacao)));
  const outroPost = await fetch(`${base}/api/hangar/solojet`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' });
  conferir('mas não pode mexer em configuração', outroPost.status === 403, `status ${outroPost.status}`);
  const pagina = await fetch(`${base}/fiscalizar`, { headers: auth });
  conferir('abre a página da câmera', pagina.status === 200 && /Iniciar ronda/.test(await pagina.text()));
  const semLogin = await fetch(`${base}/fiscalizar`);
  conferir('página exige login', semLogin.status === 401);

  console.log('\nFreio de custo');
  const r2 = await ler(['BOR6666']);
  conferir('segundo quadro imediato é recusado', r2.status === 429, `status ${r2.status}`);
  await new Promise((r) => setTimeout(r, 1600));
  const r3 = await ler(['BOR6666']);
  conferir('depois do intervalo, volta a ler', r3.status === 200, `status ${r3.status}`);

  console.log('\nHistórico e foto');
  const linhas = fs.readFileSync(path.join(RAIZ, 'data', 'fiscalizacao.jsonl'), 'utf-8').trim().split('\n').map(JSON.parse);
  const deTeste = linhas.filter((l) => l.usuario === 'fiscal-teste');
  conferir('uma linha por placa, sem repetir a mesma leitura', deTeste.length === 2, `${deTeste.length} linhas`);
  const vermelha = deTeste.find((l) => l.placa === 'AIB1234');
  conferir('guarda o local', vermelha && vermelha.local && vermelha.local.lat === -23.18);
  conferir('vermelho tem foto', vermelha && vermelha.foto && fs.existsSync(path.join(FOTOS, vermelha.foto)));
  conferir('verde não tem foto', deTeste.find((l) => l.placa === 'BOR6666').foto === null);

  console.log('\nImagem ausente');
  await new Promise((r) => setTimeout(r, 1600));
  const r4 = await fetch(`${base}/api/fiscalizacao/ler`, { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: '{}' });
  conferir('recusa sem imagem', r4.status === 400, `status ${r4.status}`);

  servidor.close();
}

main()
  .catch((e) => { console.error('teste quebrou:', e); falhas += 1; })
  .finally(() => {
    restaurar();
    console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
    process.exit(falhas ? 1 : 0);
  });
