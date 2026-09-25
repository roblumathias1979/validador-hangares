#!/usr/bin/env node
/**
 * painel/servidor.js — lista os fechamentos recebidos, destaca inconsistência
 * e exporta planilha (CSV). Autenticação simplificada (uma senha só, via
 * Basic Auth) — este é o V1; se o volume justificar contas por pessoa depois,
 * vale copiar o cadastro de usuários do painel do validador de hangares.
 *
 * Escuta só em 127.0.0.1, mesmo motivo do outro painel: acesso por túnel SSH,
 * nunca exposto direto à internet.
 *
 *     ssh -i ~/.ssh/validador.pem -L 8082:127.0.0.1:8082 ubuntu@<IP>
 *     abrir http://localhost:8082
 */

const fs = require('fs');
const http = require('http');
const path = require('path');

const RAIZ = path.join(__dirname, '..');
require('dotenv').config({ path: path.join(RAIZ, '.env'), override: true });

const { listarFechamentos } = require('../scripts/lib/armazenamento');
const { gerarCsv } = require('../scripts/exportar-planilha');

const PORTA = Number(process.env.PAINEL_CAIXA_PORTA) || 8082;
const SENHA = process.env.PAINEL_CAIXA_SENHA || '';

function autorizado(req) {
  if (!SENHA) return false;
  const cabecalho = req.headers.authorization || '';
  if (!cabecalho.startsWith('Basic ')) return false;
  const decodificado = Buffer.from(cabecalho.slice(6), 'base64').toString();
  const valor = decodificado.slice(decodificado.indexOf(':') + 1);
  const a = Buffer.from(valor || '');
  const b = Buffer.from(SENHA);
  return a.length === b.length && require('crypto').timingSafeEqual(a, b);
}

function json(res, codigo, corpo) {
  const texto = JSON.stringify(corpo);
  res.writeHead(codigo, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': Buffer.byteLength(texto) });
  res.end(texto);
}

const servidor = http.createServer((req, res) => {
  if (!autorizado(req)) {
    res.writeHead(401, { 'WWW-Authenticate': 'Basic realm="Fechamento de Caixa"' });
    res.end('Acesso restrito.');
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host}`);

  try {
    if (req.method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(fs.readFileSync(path.join(__dirname, 'index.html'), 'utf-8'));
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/fechamentos') {
      const fechamentos = listarFechamentos({
        unidadeId: url.searchParams.get('unidade') || undefined,
        desde: url.searchParams.get('desde') || undefined,
        ate: url.searchParams.get('ate') || undefined,
        apenasInconsistentes: url.searchParams.get('apenasInconsistentes') === 'true',
      });
      json(res, 200, { fechamentos });
      return;
    }

    if (req.method === 'GET' && url.pathname === '/api/planilha') {
      const csv = gerarCsv({
        unidadeId: url.searchParams.get('unidade') || undefined,
        desde: url.searchParams.get('desde') || undefined,
        ate: url.searchParams.get('ate') || undefined,
      });
      res.writeHead(200, {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="fechamentos-${new Date().toISOString().slice(0, 10)}.csv"`,
      });
      res.end(csv);
      return;
    }

    json(res, 404, { erro: 'Rota não encontrada.' });
  } catch (erro) {
    json(res, 500, { erro: erro.message });
  }
});

if (require.main === module) {
  if (!SENHA) {
    console.error('PAINEL_CAIXA_SENHA não configurada no .env — o painel não sobe sem senha.');
    process.exit(1);
  }
  servidor.listen(PORTA, '127.0.0.1', () => {
    console.log(`Painel de fechamento de caixa em http://127.0.0.1:${PORTA} (apenas local — use túnel SSH)`);
  });
}

module.exports = { servidor };
