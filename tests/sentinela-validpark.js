#!/usr/bin/env node
/**
 * A sentinela do ValidPark no monitor de saúde: a cada 5 min checa o site e, se
 * estiver fora, avisa a administração sugerindo a contingência. O que este teste
 * protege (a máquina de estado do aviso, não o login real):
 *
 * 1. Caiu agora → avisa, e vai para TODOS os destinos de administração.
 * 2. Continua caído (aviso recente) → NÃO repete (re-aviso só a cada 6h).
 * 3. Voltou → avisa que normalizou (para a pessoa poder desligar a contingência).
 * 4. Em contingência (vp.pular) → não checa nem alarma.
 *
 * `checarValidpark` (que abre o navegador) é injetado como `vp`, para o teste não
 * depender de rede nem do site.
 */

const path = require('path');

process.env.EVOLUTION_API_KEY = 'teste';
process.env.EVOLUTION_URL = 'http://127.0.0.1:9';
process.env.EVOLUTION_INSTANCE = 'teste';

const RAIZ = path.join(__dirname, '..');

// Captura os envios ao WhatsApp (o monitor usa http.request direto).
let enviados = [];
const http = require('http');
http.request = (opcoes, cb) => {
  let corpo = '';
  const req = {
    on() { return this; },
    write(c) { corpo += c; },
    end() {
      try { const d = JSON.parse(corpo); enviados.push({ number: d.number, text: d.text }); } catch (e) { /* ignore */ }
      const r = new (require('stream').PassThrough)(); r.statusCode = 200;
      process.nextTick(() => { cb(r); r.end('{}'); });
    },
    setTimeout() {}, destroy() {},
  };
  return req;
};

const monitor = require(path.join(RAIZ, 'scripts', 'monitor-saude.js'));
const { destinosAdmin } = require(path.join(RAIZ, 'scripts', 'lib', 'admins.js'));
const { carregarConfig } = require(path.join(RAIZ, 'scripts', 'lib', 'hangar.js'));

let falhas = 0;
const conferir = (nome, ok, detalhe) => { if (ok) return console.log(`  ok   ${nome}`); falhas += 1; console.log(`  FALHA ${nome}${detalhe ? ` — ${detalhe}` : ''}`); };
const avisos = () => enviados.filter((e) => /ValidPark/i.test(e.text));

async function main() {
  const destinos = destinosAdmin(carregarConfig());
  const agora = new Date().toISOString();

  console.log('Caiu agora: avisa todos os destinos de administração');
  enviados = [];
  const atual1 = { em: agora };
  await monitor.acompanharValidpark(null, atual1, { ok: false, ref: 'solojet', detalhe: 'não respondeu' });
  conferir('avisou da queda', avisos().some((a) => /fora do ar/i.test(a.text)));
  conferir('foi para todos os destinos', destinos.every((d) => avisos().some((a) => a.number === d)), `destinos=${destinos.length}`);
  conferir('sugere ligar contingência', avisos().every((a) => /ligar contingência/i.test(a.text) || /voltou/i.test(a.text)));
  conferir('marcou foraDesde e ultimoAvisoEm', Boolean(atual1.validpark.foraDesde) && Boolean(atual1.validpark.ultimoAvisoEm));

  console.log('\nContinua caído (aviso recente): não repete');
  enviados = [];
  const anterior2 = { validpark: atual1.validpark };
  const atual2 = { em: new Date().toISOString() };
  await monitor.acompanharValidpark(anterior2, atual2, { ok: false, ref: 'solojet', detalhe: 'não respondeu' });
  conferir('não repetiu em menos de 6h', avisos().length === 0, `veio ${avisos().length}`);
  conferir('preservou o ultimoAvisoEm', atual2.validpark.ultimoAvisoEm === atual1.validpark.ultimoAvisoEm);

  console.log('\nVoltou: avisa que normalizou');
  enviados = [];
  const anterior3 = { validpark: atual2.validpark };
  const atual3 = { em: new Date().toISOString() };
  await monitor.acompanharValidpark(anterior3, atual3, { ok: true, ref: 'solojet', detalhe: 'login e leitura ok' });
  conferir('avisou que voltou', avisos().some((a) => /voltou/i.test(a.text)));
  conferir('zerou o ultimoAvisoEm', atual3.validpark.ultimoAvisoEm === null);

  console.log('\nEm contingência: não checa nem alarma');
  enviados = [];
  const atual4 = { em: new Date().toISOString() };
  await monitor.acompanharValidpark(anterior3, atual4, { pular: true, motivo: 'em contingência' });
  conferir('não avisou', avisos().length === 0, `veio ${avisos().length}`);

  console.log(`\n${falhas ? `${falhas} falha(s)` : 'tudo certo'}`);
}

main().catch((e) => { console.error('teste quebrou:', e); falhas += 1; }).finally(() => process.exit(falhas ? 1 : 0));
