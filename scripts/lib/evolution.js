/**
 * evolution.js — o que o painel precisa saber da Evolution API.
 *
 * Hoje só uma coisa: a lista de grupos de que o bot participa.
 *
 * POR QUE NÃO REUSA O CLIENTE DO processar-mensagem.js
 * Aquele é POST, e carrega um `Connection: close` com `agent: false` que existe
 * por um bug real — entre o "recebi seu ticket" e a resposta final passam ~11s,
 * a Evolution fecha a conexão ociosa nesse intervalo, e o Node reaproveitava o
 * socket morto (15/09/2026). Nada disso se aplica a um GET de meio segundo
 * feito pelo painel, e importar processar-mensagem.js aqui arrastaria Playwright,
 * OCR e o fluxo inteiro para dentro de um servidor web.
 *
 * O que NÃO se duplica é o que muda: URL, instância e chave continuam vindo das
 * mesmas variáveis de ambiente.
 */

const http = require('http');
const path = require('path');

require('dotenv').config({ path: path.join(__dirname, '..', '..', '.env'), override: true });

const URL_BASE = process.env.EVOLUTION_URL || 'http://127.0.0.1:8080';
const INSTANCIA = process.env.EVOLUTION_INSTANCE || 'validador-hangares';

/**
 * Grupos de que o número do bot participa, como [{ id, nome }].
 *
 * Rejeita com mensagem legível em vez de estourar: o painel precisa continuar
 * funcionando com a Evolution fora do ar — quem entrou lá para ver os pátios
 * não pode topar com uma tela branca porque o WhatsApp caiu.
 */
function listarGrupos({ timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    const chave = process.env.EVOLUTION_API_KEY;
    if (!chave) {
      reject(new Error('EVOLUTION_API_KEY não configurada no .env.'));
      return;
    }
    const url = new URL(`/group/fetchAllGroups/${INSTANCIA}?getParticipants=false`, URL_BASE);
    const req = http.get(
      { hostname: url.hostname, port: url.port, path: url.pathname + url.search, headers: { apikey: chave }, timeout: timeoutMs },
      (res) => {
        let corpo = '';
        res.on('data', (c) => (corpo += c));
        res.on('end', () => {
          let dados;
          try { dados = JSON.parse(corpo); } catch (e) {
            reject(new Error(`Evolution devolveu resposta não-json (HTTP ${res.statusCode}).`));
            return;
          }
          if (!Array.isArray(dados)) {
            reject(new Error(`Evolution não devolveu uma lista de grupos (HTTP ${res.statusCode}).`));
            return;
          }
          resolve(dados
            // O nome vem como o usuário digitou no WhatsApp, aspas e tudo —
            // o grupo do Solojet está cadastrado lá como "Bot_Solojet", com
            // aspas no nome. Limpar aqui evita que a tela fique estranha.
            .map((g) => ({ id: g.id, nome: String(g.subject || '').replace(/^"|"$/g, '').trim() || g.id }))
            .filter((g) => g.id && g.id.endsWith('@g.us'))
            .sort((a, b) => a.nome.localeCompare(b.nome, 'pt-BR')));
        });
      }
    );
    req.on('error', (e) => reject(new Error(`Não consegui falar com a Evolution: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error(`Evolution não respondeu em ${timeoutMs / 1000}s.`)); });
  });
}

/**
 * Cria um grupo no WhatsApp e devolve { id, nome }.
 *
 * O número do bot entra sozinho, como criador. Os `participantes` são os
 * telefones a incluir junto — a Evolution recusa criar grupo vazio, e um grupo
 * só com o bot também não serve para nada.
 *
 * Só dígitos: a Evolution espera "5511999999999", sem +, espaço ou hífen, e
 * sem o sufixo @s.whatsapp.net que aparece no config.
 */
function criarGrupo({ nome, participantes = [], descricao = '' , timeoutMs = 30000 }) {
  return new Promise((resolve, reject) => {
    const chave = process.env.EVOLUTION_API_KEY;
    if (!chave) { reject(new Error('EVOLUTION_API_KEY não configurada no .env.')); return; }

    const numeros = participantes
      .map((p) => String(p || '').split('@')[0].replace(/\D/g, ''))
      .filter(Boolean);
    if (!numeros.length) {
      reject(new Error('Informe ao menos um telefone para entrar no grupo — o WhatsApp não cria grupo só com o bot.'));
      return;
    }

    const corpo = JSON.stringify({ subject: String(nome || '').trim(), description: descricao, participants: numeros });
    const url = new URL(`/group/create/${INSTANCIA}`, URL_BASE);
    const req = http.request(
      {
        hostname: url.hostname, port: url.port, path: url.pathname, method: 'POST',
        headers: { apikey: chave, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(corpo) },
        timeout: timeoutMs,
      },
      (res) => {
        let resposta = '';
        res.on('data', (c) => (resposta += c));
        res.on('end', () => {
          let dados;
          try { dados = JSON.parse(resposta); } catch (e) {
            reject(new Error(`Evolution devolveu resposta não-json (HTTP ${res.statusCode}).`));
            return;
          }
          // O id pode vir em `id` ou aninhado, conforme a versão. Sem id não
          // há como cadastrar o grupo, e devolver sucesso seria pior que falhar.
          const id = dados.id || (dados.groupJid) || (dados.data && dados.data.id);
          if (res.statusCode >= 400 || !id) {
            reject(new Error(`Não consegui criar o grupo (HTTP ${res.statusCode}): ${String(dados.message || dados.error || resposta).slice(0, 200)}`));
            return;
          }
          resolve({ id, nome: dados.subject || String(nome || '').trim() });
        });
      }
    );
    req.on('error', (e) => reject(new Error(`Não consegui falar com a Evolution: ${e.message}`)));
    req.on('timeout', () => { req.destroy(); reject(new Error(`Evolution não respondeu em ${timeoutMs / 1000}s.`)); });
    req.end(corpo);
  });
}

module.exports = { listarGrupos, criarGrupo };
