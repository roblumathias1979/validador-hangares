/**
 * registro-fiscalizacao.js — o que a ronda viu, e o freio de custo da câmera.
 *
 * HISTÓRICO: cada placa consultada vira uma linha em data/fiscalizacao.jsonl
 * (quem, quando, onde, resultado). É o que sustenta uma cobrança ou uma
 * conversa com o hangar depois: "o Alljet estava 3 acima da lotação às 14:10".
 *
 * FOTO: só dos resultados vermelhos, e uma por placa a cada 30 minutos. O
 * fiscal passa pela mesma moto várias vezes numa ronda, e guardar todos os
 * quadros encheria o disco de fotos iguais.
 *
 * PRIVACIDADE: placa + local + hora é dado pessoal. Fotos e histórico são
 * apagados depois de `diasGuardar` dias (padrão 30).
 *
 * CUSTO: cada quadro lido é uma chamada paga ao modelo. Dois freios, os dois
 * aqui no servidor porque a página não é confiável para isso: intervalo mínimo
 * por usuário (um celular com defeito, ou alguém forçando, não dispara dez por
 * segundo) e teto diário para o sistema inteiro.
 */

const fs = require('fs');
const path = require('path');

const DATA = path.join(__dirname, '..', '..', 'data');
const HISTORICO = path.join(DATA, 'fiscalizacao.jsonl');
const FOTOS = path.join(DATA, 'fiscalizacao-fotos');
const FOTO_A_CADA_MS = 30 * 60 * 1000;

const ultimaLeituraPorUsuario = new Map();
const leiturasPorDia = new Map();
const ultimaFotoPorPlaca = new Map();

function hojeEmSaoPaulo(agora = new Date()) {
  return new Date(agora.getTime() - 3 * 3600000).toISOString().slice(0, 10);
}

/**
 * Pode ler mais um quadro? Devolve null se pode, ou o motivo se não pode.
 * Conta a leitura quando libera.
 */
function liberarLeitura(usuario, regras, agora = Date.now()) {
  const intervalo = regras.intervaloMinimoLeituraMs ?? 1500;
  const teto = regras.maxLeiturasPorDia ?? 6000;
  const anterior = ultimaLeituraPorUsuario.get(usuario) || 0;
  if (agora - anterior < intervalo) return 'rapido_demais';

  const dia = hojeEmSaoPaulo(new Date(agora));
  const feitas = leiturasPorDia.get(dia) || 0;
  if (feitas >= teto) return 'teto_diario';

  ultimaLeituraPorUsuario.set(usuario, agora);
  leiturasPorDia.clear();
  leiturasPorDia.set(dia, feitas + 1);
  return null;
}

function leiturasHoje(agora = new Date()) {
  return leiturasPorDia.get(hojeEmSaoPaulo(agora)) || 0;
}

function registrar(linha) {
  fs.mkdirSync(DATA, { recursive: true });
  fs.appendFileSync(HISTORICO, `${JSON.stringify({ em: new Date().toISOString(), ...linha })}\n`);
}

/** Guarda a foto de um resultado vermelho. Devolve o nome do arquivo, ou null. */
function guardarFoto(placa, base64, agora = Date.now()) {
  if (agora - (ultimaFotoPorPlaca.get(placa) || 0) < FOTO_A_CADA_MS) return null;
  ultimaFotoPorPlaca.set(placa, agora);
  const dia = hojeEmSaoPaulo(new Date(agora));
  const pasta = path.join(FOTOS, dia);
  fs.mkdirSync(pasta, { recursive: true });
  const nome = `${placa}-${new Date(agora).toISOString().slice(11, 19).replace(/:/g, '')}.jpg`;
  fs.writeFileSync(path.join(pasta, nome), Buffer.from(base64, 'base64'));
  return `${dia}/${nome}`;
}

/**
 * Apaga fotos e linhas de histórico mais velhas que `dias`. Barato o bastante
 * para rodar a cada leitura com foto: são no máximo algumas dezenas de pastas.
 */
function expurgar(dias = 30, agora = new Date()) {
  const corte = hojeEmSaoPaulo(new Date(agora.getTime() - dias * 86400000));
  if (fs.existsSync(FOTOS)) {
    for (const pasta of fs.readdirSync(FOTOS)) {
      if (/^\d{4}-\d{2}-\d{2}$/.test(pasta) && pasta < corte) fs.rmSync(path.join(FOTOS, pasta), { recursive: true, force: true });
    }
  }
  if (fs.existsSync(HISTORICO)) {
    const limite = new Date(agora.getTime() - dias * 86400000).toISOString();
    const linhas = fs.readFileSync(HISTORICO, 'utf-8').split('\n').filter(Boolean);
    const ficam = linhas.filter((l) => { try { return JSON.parse(l).em >= limite; } catch (e) { return false; } });
    if (ficam.length !== linhas.length) fs.writeFileSync(HISTORICO, ficam.map((l) => `${l}\n`).join(''));
  }
}

module.exports = { liberarLeitura, leiturasHoje, registrar, guardarFoto, expurgar, HISTORICO, FOTOS };
