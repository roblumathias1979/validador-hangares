/**
 * snapshot-techparking.js — leitura da foto do pátio enviada pelo aeroporto.
 *
 * O painel RECEBE a foto (POST /api/techparking/snapshot, do coletor que roda
 * na máquina do aeroporto) e grava em data/techparking-snapshot.json. Este
 * módulo é o lado de quem LÊ: o bot, quando alguém pergunta no grupo quem está
 * no pátio.
 *
 * Existe para não haver duas constantes com o mesmo caminho de arquivo nem
 * duas ideias de "está velho demais" — quem escreve e quem lê precisam
 * concordar, e concordar por coincidência não dura.
 *
 * POR QUE A VALIDADE IMPORTA
 * A foto vem de outra máquina, por uma ponte que pode cair sem avisar. Uma
 * lista de meia hora atrás é pior que nenhuma: quem pergunta quem está no
 * pátio AGORA e recebe a de antes decide errado achando que está informado.
 * Fora da validade, este módulo diz que não sabe.
 */

const path = require('path');
const { lerJson } = require('./trava-arquivo');
const { chavePatio } = require('./fiscalizacao');
const { extrairPlaca } = require('./whatsapp');

const ARQUIVO = path.join(__dirname, '..', '..', 'data', 'techparking-snapshot.json');

// O coletor envia de minuto em minuto. 10 minutos absorve uma falha de rede
// sem mentir sobre o presente.
const VALIDADE_MS = 10 * 60 * 1000;

function ler() {
  const foto = lerJson(ARQUIVO, null);
  if (!foto || !foto.recebidoEm) {
    return { existe: false, fresca: false, em: null, idadeMs: null, credenciados: [], avulsos: [] };
  }
  const idadeMs = Date.now() - new Date(foto.recebidoEm).getTime();
  return {
    existe: true,
    fresca: idadeMs <= VALIDADE_MS,
    idadeMs,
    em: foto.recebidoEm,
    credenciados: foto.credenciados || [],
    avulsos: foto.avulsos || [],
  };
}

/**
 * Os credenciados de um pátio, prontos para a mensagem.
 *
 * `semVinculo` é diferente de lista vazia, e confundir os dois faria o bot
 * afirmar "não há credenciados" num pátio que só não foi ligado ao nome que a
 * API do aeroporto usa.
 */
function credenciadosDoPatio(bolsao) {
  const foto = ler();
  const alvo = chavePatio(bolsao || '');
  if (!alvo) return { ...foto, semVinculo: true, lista: [] };

  const lista = foto.credenciados
    .filter((c) => chavePatio(c.BOLSAO || c.GRUPO || '') === alvo)
    .map((c) => {
      const nome = String(c.USUARIO || '').trim();
      return {
        nome: nome || null,
        // A PLACA vem VAZIA nos credenciados. Quando alguém digitou a placa no
        // meio do nome, ela é aproveitada dali — é a única fonte que existe.
        placa: String(c.PLACA || '').trim() || extrairPlaca(nome) || null,
        desde: c.DATAHORA || null,
      };
    })
    .sort((a, b) => String(a.nome).localeCompare(String(b.nome), 'pt-BR'));

  return { ...foto, semVinculo: false, lista };
}

module.exports = { ler, credenciadosDoPatio, ARQUIVO, VALIDADE_MS };
