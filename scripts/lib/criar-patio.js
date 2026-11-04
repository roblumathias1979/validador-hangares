/**
 * criar-patio.js — o que é comum a criar um pátio pelo PAINEL e pelo WHATSAPP.
 *
 * Nasceu em 04/11/2026, quando "criar pátio" passou a existir também no grupo
 * da administração. Antes a montagem do hangar e a gravação das credenciais
 * viviam dentro do painel; duas cópias do mesmo molde de hangar divergiriam na
 * primeira vez que o ValidPark mudasse um seletor.
 *
 * O molde (URL, seletores, formato do ticket) é copiado de um hangar que já
 * opera: o ValidPark é um site só, e copiar do config evita uma segunda fonte.
 */

const fs = require('fs');
const path = require('path');

const RAIZ = path.join(__dirname, '..', '..');
const ENV = path.join(RAIZ, '.env');
const SNAPSHOT = path.join(RAIZ, 'data', 'techparking-snapshot.json');

const REGEX_ID = /^[a-z][a-z0-9-]{1,30}$/;

/** Nome comparável: sem acento, maiúsculo, só letras e números. */
function chave(nome) {
  return String(nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase().replace(/[^A-Z0-9]/g, '');
}

/** "Hangar Aristek" -> "hangar-aristek". Devolve '' se não sobrar nada utilizável. */
function slugDe(nome) {
  const s = String(nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 31).replace(/-+$/, '');
  return REGEX_ID.test(s) ? s : '';
}

/** O id vira nome de pasta e de variável de ambiente: a regra é estreita de propósito. */
function idValido(id) {
  return REGEX_ID.test(String(id || ''));
}

function variaveisDe(id) {
  const prefixo = String(id).toUpperCase().replace(/-/g, '_');
  return { usuarioEnvVar: `${prefixo}_USUARIO`, senhaEnvVar: `${prefixo}_SENHA` };
}

/**
 * O .env como objeto. Serve para saber QUAIS variáveis existem — o valor de
 * uma credencial nunca é mostrado.
 */
function lerEnv() {
  try {
    const mapa = {};
    for (const linha of fs.readFileSync(ENV, 'utf-8').split('\n')) {
      const m = linha.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
      if (m) mapa[m[1]] = m[2].trim();
    }
    return mapa;
  } catch (e) {
    return {};
  }
}

/**
 * Acrescenta credenciais ao .env. NUNCA sobrescreve: trocar a senha de um
 * hangar em funcionamento pela tela de CRIAR seria um acidente caro e
 * silencioso — o pátio pararia de validar e o motivo estaria num arquivo que
 * ninguém abre. Alterar credencial segue sendo trabalho de quem tem acesso ao
 * servidor, de propósito.
 */
function acrescentarCredenciais(pares, origem = 'painel') {
  const atual = lerEnv();
  for (const [nome] of pares) {
    if (atual[nome]) throw new Error(`${nome} já existe no .env — não vou sobrescrever. Altere no servidor.`);
  }
  fs.appendFileSync(ENV, `\n# ${new Date().toISOString().slice(0, 10)} — criado pelo ${origem}\n`
    + pares.map(([nome, valor]) => `${nome}=${valor}`).join('\n') + '\n');
}

/**
 * Monta o hangar novo e o acrescenta a `config.hangares`. Lança se o id já
 * existe ou o grupo já pertence a outro pátio. Não grava nada em disco.
 */
function acrescentarHangar(config, { id, nome, bolsao, cotaMensal, grupoId }) {
  if (!idValido(id)) throw new Error('Identificador deve começar com letra e ter de 2 a 31 caracteres: só letras, números e hífen.');
  if (!String(nome || '').trim()) throw new Error('Informe o nome do pátio.');
  if (config.hangares.some((h) => h.id === id)) throw new Error(`Já existe um pátio com o identificador "${id}".`);
  const grupo = String(grupoId || '').trim();
  if (grupo) {
    const dono = config.hangares.find((h) => (h.grupoWhatsappId || '').trim() === grupo);
    if (dono) throw new Error(`Esse grupo já pertence ao pátio ${dono.hangar || dono.id}.`);
  }

  const { usuarioEnvVar, senhaEnvVar } = variaveisDe(id);
  const modelo = config.hangares[0];
  const hangar = {
    id,
    hangar: String(nome).trim(),
    grupoWhatsapp: '',
    grupoWhatsappId: grupo,
    validadorUrl: modelo.validadorUrl,
    usuarioEnvVar,
    senhaEnvVar,
    seletores: JSON.parse(JSON.stringify(modelo.seletores)),
    formatoTicket: JSON.parse(JSON.stringify(modelo.formatoTicket)),
    placaGenerica: 'AAA0000',
    prazoValidacaoHoras: modelo.prazoValidacaoHoras,
    // Herdado de quem já opera: sem destino de aviso, um problema que precisa
    // de gente não chega a ninguém.
    grupoAdministracao: (config.hangares.find((h) => (h.grupoAdministracao || '').trim()) || {}).grupoAdministracao || '',
    cotaMensalForaPrazo: 2,
    asaas: { customerId: '', cnpj: '', razaoSocial: '', email: '' },
    diasValidacaoPadrao: modelo.diasValidacaoPadrao,
    exigeFotoVeiculoNoLocal: false,
  };
  if (bolsao) hangar.bolsaoTechparking = String(bolsao).trim();
  // Ausência da chave = sem teto (o caso de quase todos os pátios).
  if (Number.isInteger(cotaMensal) && cotaMensal >= 0) hangar.cotaMensalValidacoes = cotaMensal;
  config.hangares.push(hangar);
  return hangar;
}

/**
 * Procura um pátio pelo nome na foto do TechParking.
 * Devolve { foto, achou, label, id, vagas, sugestoes }. `foto: false` quando
 * não há foto — aí não dá para afirmar nada, e quem chama segue sem validar.
 */
function buscarPatioTechparking(nome) {
  let foto = null;
  try { foto = JSON.parse(fs.readFileSync(SNAPSHOT, 'utf-8')); } catch (e) { /* sem foto */ }
  const patios = (foto && foto.patios) || [];
  if (!patios.length) return { foto: false, achou: false, sugestoes: [] };

  const alvo = chave(nome);
  const exato = patios.find((p) => chave(p.PATIO) === alvo);
  if (exato) {
    return {
      foto: true, achou: true, label: String(exato.PATIO).trim(),
      id: exato.IDPATIO, vagas: Number.isFinite(Number(exato.VAGAS)) ? Number(exato.VAGAS) : null, sugestoes: [],
    };
  }
  // Sugere os que dividem alguma palavra de 3+ letras com o que foi digitado.
  const palavras = String(nome || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toUpperCase()
    .split(/[^A-Z0-9]+/).filter((w) => w.length >= 3);
  const sugestoes = patios
    .filter((p) => palavras.some((w) => chave(p.PATIO).includes(w)))
    .map((p) => String(p.PATIO).trim()).slice(0, 5);
  return { foto: true, achou: false, sugestoes };
}

module.exports = { slugDe, idValido, variaveisDe, lerEnv, acrescentarCredenciais, acrescentarHangar, buscarPatioTechparking, chave };
