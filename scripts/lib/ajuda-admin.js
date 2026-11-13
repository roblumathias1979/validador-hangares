/**
 * ajuda-admin.js — o ÍNDICE de comandos da administração ("ajuda") e o passo a
 * passo de cada um ("ajuda antifraude").
 *
 * Uma lista só (COMANDOS) alimenta o índice e os detalhes, e cada entrada diz qual
 * função de whatsapp.js reconhece os seus exemplos (`parsers`, `reconhece`). O
 * teste tests/ajuda-admin.js usa isso para manter o índice HONESTO: todo exemplo
 * listado tem de ser reconhecido pelo bot, e todo comando novo da administração
 * em whatsapp.js tem de estar aqui (ou numa lista de exceções com motivo) — senão
 * o teste quebra. Comando que existe e não aparece na ajuda é comando que ninguém usa.
 */

const CATEGORIAS = [
  ['sistema', '🩺 *Sistema*'],
  ['creditos', '💳 *Créditos*'],
  ['operacao', '🔀 *Operação*'],
  ['patios', '📊 *Pátios e cotas*'],
  ['outros', '🧰 *Outros*'],
  ['grupos', '👥 *Nos grupos dos pátios*'],
];

// `exemplos[0]` é o que aparece em negrito no índice. `reconhece(texto, w)` confere
// um exemplo contra os parsers de whatsapp.js (`w`).
const COMANDOS = [
  {
    categoria: 'sistema', titulo: 'Status do sistema', chaves: ['status', 'sistema', 'diagnostico', 'problema'],
    descricao: 'como está tudo (WhatsApp, servidor, backup, créditos)',
    exemplos: ['status do sistema', 'por que não está funcionando?'],
    parsers: ['interpretarPedidoDiagnostico'], reconhece: (t, w) => w.interpretarPedidoDiagnostico(t),
    detalhe: 'Mostra tudo de uma vez: WhatsApp, n8n, *servidor* (memória, disco, carga, tempo ligado, reinício pendente), último backup, *créditos* (Anthropic e AWS), ValidPark, coletor do aeroporto e contingência — e o que fazer em cada problema.',
  },
  {
    categoria: 'sistema', titulo: 'Consertar', chaves: ['consertar', 'conserto', 'arrumar'],
    descricao: 'o bot tenta corrigir o que caiu',
    exemplos: ['consertar'],
    parsers: ['interpretarPedidoConserto'], reconhece: (t, w) => w.interpretarPedidoConserto(t),
    detalhe: 'O bot corrige sozinho o que tem conserto seguro: reinicia o n8n ou o painel que caíram, libera disco e liga a contingência se o ValidPark está fora. O que depende de gente (crédito, celular do WhatsApp, coletor do aeroporto) ele só avisa.',
  },
  {
    categoria: 'sistema', titulo: 'Investigar', chaves: ['investigar', 'logs', 'log'],
    descricao: 'junta os logs de erro para análise',
    exemplos: ['investigar'],
    parsers: ['interpretarPedidoInvestigar'], reconhece: (t, w) => w.interpretarPedidoInvestigar(t),
    detalhe: 'Junta os problemas ativos, a versão no ar e os logs de erro dos serviços num pacote, para levar a uma sessão do Claude Code, que acha a causa e propõe a correção.',
  },
  {
    categoria: 'sistema', titulo: 'Reiniciar', chaves: ['reiniciar', 'reboot', 'reinicio'],
    descricao: 'só os serviços ou o servidor inteiro',
    exemplos: ['reiniciar sistema'],
    parsers: ['interpretarPedidoReiniciar'], reconhece: (t, w) => w.interpretarPedidoReiniciar(t),
    detalhe: 'O bot pergunta: *1* só os serviços (n8n, painel e WhatsApp — cerca de 1 minuto, a máquina continua ligada) ou *2* o servidor inteiro (2 a 3 minutos, pede SIM). Quando volta, avisa "Voltei!" aqui no grupo.',
  },
  {
    categoria: 'sistema', titulo: 'Atualizar servidor', chaves: ['atualizar servidor', 'atualizacao', 'apt', 'pacotes'],
    descricao: 'procurar ou instalar atualizações do Ubuntu',
    exemplos: ['atualizar servidor'],
    parsers: ['interpretarPedidoAtualizar'], reconhece: (t, w) => w.interpretarPedidoAtualizar(t),
    detalhe: 'Menu: *1* procura o que há para atualizar (só mostra, não altera nada) e *2* instala (pede SIM). Pacotes em liberação gradual do Ubuntu ficam de fora. Uma vez por mês o bot avisa sozinho se houver pendência. Depois de instalar, ele sugere reiniciar se for preciso.',
  },
  {
    categoria: 'creditos', titulo: 'Créditos da Anthropic', chaves: ['recarregar', 'anthropic', 'credito', 'creditos', 'ocr', 'saldo'],
    descricao: 'saldo estimado e como recarregar',
    exemplos: ['recarregar sistema'],
    parsers: ['interpretarPedidoRecargaAnthropic'], reconhece: (t, w) => w.interpretarPedidoRecargaAnthropic(t),
    detalhe: 'Mostra o saldo estimado dos créditos da Anthropic (o que o bot usa para ler as fotos dos tickets) e o passo a passo para comprar mais. Depois de comprar, diga *recarreguei US$ 50* (o valor) para o bot passar a estimar o saldo e avisar quando estiver acabando.',
  },
  {
    categoria: 'creditos', titulo: 'Crédito da AWS', chaves: ['aws', 'amazon', 'credito aws'],
    descricao: 'informar o crédito do servidor e vigiar o vencimento',
    exemplos: ['crédito aws 79,52 até 03/03/2027'],
    parsers: ['interpretarCreditoAws'], reconhece: (t, w) => w.interpretarCreditoAws(t),
    detalhe: 'A AWS não deixa o bot ler o saldo, então você copia do painel dela: *crédito aws 79,52 até 03/03/2027* (saldo e data final). O bot conta os dias e avisa quando o crédito estiver acabando. *crédito aws* sozinho mostra o que está anotado. Atualize sempre que olhar o painel.',
  },
  {
    categoria: 'operacao', titulo: 'Contingência do ValidPark', chaves: ['contingencia', 'validpark'],
    descricao: 'validar pelo sistema do aeroporto quando o ValidPark cai',
    exemplos: ['ligar contingência', 'desligar contingência'],
    parsers: ['interpretarComandoContingencia'], reconhece: (t, w) => w.interpretarComandoContingencia(t) !== null,
    detalhe: '*ligar contingência* faz as validações deixarem o ValidPark e irem pelo sistema do aeroporto (use quando o ValidPark cair; pede SIM). *desligar contingência* volta ao normal, e vale desligar assim que o ValidPark voltar.',
  },
  {
    categoria: 'operacao', titulo: 'Faturamento', chaves: ['faturamento', 'fatura', 'boleto', 'cobranca'],
    descricao: 'liga/desliga a cobrança de ticket vencido por pátio',
    exemplos: ['desligar faturamento', 'ligar faturamento'],
    parsers: ['interpretarComandoFaturamento'], reconhece: (t, w) => w.interpretarComandoFaturamento(t) !== null,
    detalhe: 'Escolha os pátios (TODOS ou os números da lista) e confirme com SIM; CANCELAR desiste. Ligado, o bot passa a oferecer cobrança de ticket vencido sem cota e de pátio sem vaga — o boleto é real e só sai com o seu SIM.',
  },
  {
    categoria: 'operacao', titulo: 'Antifraude', chaves: ['antifraude', 'anti-fraude', 'fraude', 'foto do veiculo'],
    descricao: 'foto do veículo + conferência do local, por pátio',
    exemplos: ['ativar antifraude', 'desativar antifraude', 'quais pátios estão com antifraude'],
    parsers: ['interpretarComandoAntifraude', 'interpretarConsultaAntifraude'],
    reconhece: (t, w) => w.interpretarComandoAntifraude(t) !== null || w.interpretarConsultaAntifraude(t),
    detalhe: '*ativar antifraude* / *desativar antifraude*: escolha o pátio (número ou TODOS) e confirme com SIM. Ligado, o cliente manda a foto do ticket e depois a do veículo no pátio, e o bot confere o local. Só liga onde o local está cadastrado (hoje AIBM 1 e 2). Desligar avisa o que se perde. *quais pátios estão com antifraude* mostra o estado de cada um.',
  },
  {
    categoria: 'operacao', titulo: 'Fotos de referência dos pátios', chaves: ['fotos', 'foto', 'referencia', 'video', 'patios'],
    descricao: 'trocar as fotos que o antifraude compara',
    exemplos: ['atualizar fotos dos pátios'],
    parsers: ['interpretarComandoFotosPatio'], reconhece: (t, w) => w.interpretarComandoFotosPatio(t),
    detalhe: 'Escolha UM pátio, mande até 5 fotos (uma por mensagem ou várias de uma vez) ou um *vídeo curto* (até 60 s: o bot tira os quadros e mostra aqui), responda *PRONTO* e confirme com SIM. *LIMPAR* recomeça, *CANCELAR* desiste. As fotos antigas ficam guardadas numa cópia. Mostre piso, parede e fundo do local, de ângulos diferentes.',
  },
  {
    categoria: 'patios', titulo: 'Situação do pátio', chaves: ['patio', 'vagas', 'credenciados', 'tickets'],
    descricao: 'vagas, credenciados e tickets de um pátio',
    exemplos: ['como está o pátio do Solojet', 'quais os credenciados do Solojet', 'quais tickets foram validados no Alljet'],
    parsers: ['interpretarPedidoPatio'], reconhece: (t, w) => w.interpretarPedidoPatio(t) !== null,
    detalhe: 'Sempre cite o pátio. *como está o pátio do Solojet* mostra as vagas; *quais os credenciados do Solojet* lista os credenciados que estão dentro; *quais tickets foram validados no Alljet* lista os tickets validados.',
  },
  {
    categoria: 'patios', titulo: 'Entrada e saída', chaves: ['movimentacao', 'entrada', 'saida', 'historico'],
    descricao: 'quem entrou e saiu num pátio',
    exemplos: ['entrada e saída do Solojet'],
    parsers: ['interpretarPedidoMovimentacao'], reconhece: (t, w) => w.interpretarPedidoMovimentacao(t),
    detalhe: '*entrada e saída do Solojet* (ou *histórico do João*): o bot pergunta o período e mostra a movimentação dos credenciados; pode mandar em PDF.',
  },
  {
    categoria: 'patios', titulo: 'Cota disponível', chaves: ['cota', 'cotas', 'restam', 'validacoes'],
    descricao: 'quantas validações restam no mês',
    exemplos: ['quantas validações restam no VOASP'],
    parsers: ['interpretarPedidoCotaDisponivel'], reconhece: (t, w) => w.interpretarPedidoCotaDisponivel(t),
    detalhe: '*quantas validações restam no VOASP* (ou *cota do voa*) mostra o que ainda resta da cota do mês do pátio.',
  },
  {
    categoria: 'patios', titulo: 'Adicionar cota', chaves: ['adicionar cota', 'aumentar cota', 'liberar mais'],
    descricao: 'somar validações à cota de um pátio',
    exemplos: ['adicionar 5 cotas no voa'],
    parsers: ['interpretarComandoAdicionarCota'], reconhece: (t, w) => w.interpretarComandoAdicionarCota(t) !== null,
    detalhe: '*adicionar 5 cotas no voa* soma validações à cota do mês daquele pátio. Se esquecer o número ou o pátio, o bot pergunta.',
  },
  {
    categoria: 'patios', titulo: 'Relatório de cotas', chaves: ['relatorio', 'extrato'],
    descricao: 'quem usou cada liberação',
    exemplos: ['relatório das cotas do voa', 'relatório de cotas mês passado'],
    parsers: ['interpretarPedidoRelatorioCota'], reconhece: (t, w) => w.interpretarPedidoRelatorioCota(t) !== null,
    detalhe: '*relatório das cotas do voa* mostra as liberações usadas no mês; acrescente *mês passado* para o anterior.',
  },
  {
    categoria: 'outros', titulo: 'Pendências e decisões', chaves: ['pendencias', 'decidir', 'sim', 'nao', 'aguardando'],
    descricao: 'ver e decidir pedidos aguardando você',
    exemplos: ['pendências'],
    parsers: ['interpretarPedidoPendencias'], reconhece: (t, w) => w.interpretarPedidoPendencias(t),
    detalhe: '*pendências* lista os pedidos esperando a sua decisão (faturar ticket vencido, pátio cheio). Decida com o número do ticket: *SIM 010611085718* ou *NÃO 010611085718*. Com um só pedido aberto, um *SIM* ou *NÃO* simples basta.',
  },
  {
    categoria: 'outros', titulo: 'Disparo de mensagem', chaves: ['disparo', 'broadcast', 'comunicado', 'aviso', 'mensagem'],
    descricao: 'mandar um aviso a vários grupos',
    exemplos: ['mandar mensagem para os grupos'],
    parsers: ['interpretarComandoBroadcast'], reconhece: (t, w) => w.interpretarComandoBroadcast(t),
    detalhe: 'Escolha os grupos (TODOS ou os números), mande o texto ou uma arte (imagem, com legenda) e confirme com SIM antes de enviar. CANCELAR desiste.',
  },
  {
    categoria: 'outros', titulo: 'Criar pátio', chaves: ['criar', 'cadastrar', 'novo patio', 'novo hangar'],
    descricao: 'cadastrar um pátio novo',
    exemplos: ['criar pátio'],
    parsers: ['interpretarComandoCriarPatio'], reconhece: (t, w) => w.interpretarComandoCriarPatio(t),
    detalhe: '*criar pátio* abre o cadastro de um pátio novo, passo a passo, aqui mesmo no grupo.',
  },
  {
    categoria: 'outros', titulo: 'Ajuda', chaves: ['ajuda', 'comandos', 'menu', 'indice'],
    descricao: 'este índice',
    exemplos: ['ajuda', 'ajuda antifraude'],
    parsers: ['interpretarPedidoAjuda'], reconhece: (t, w) => w.interpretarPedidoAjuda(t) !== null,
    detalhe: '*ajuda* mostra todos os comandos. *ajuda <assunto>* mostra o passo a passo de um deles (ex.: *ajuda faturamento*, *ajuda fotos*, *ajuda reiniciar*).',
  },
  {
    categoria: 'grupos', titulo: 'Identificação do ticket', chaves: ['identificacao', 'identificar'],
    descricao: 'a pergunta "quer identificar esse ticket?"',
    exemplos: ['desativar identificação', 'ativar identificação'],
    parsers: ['interpretarComandoIdentificacao'], reconhece: (t, w) => w.interpretarComandoIdentificacao(t) !== null,
    detalhe: 'Vale DENTRO do grupo de cada pátio (não neste): *ativar identificação* / *desativar identificação* liga ou desliga a pergunta "você quer identificar esse ticket com nome, carro ou placa?". Qualquer pessoa do grupo pode, e a administração é avisada de quem mudou.',
  },
];

// Funções interpretar* de whatsapp.js que NÃO são comandos de administração.
const NAO_SAO_COMANDOS = [
  'interpretarMensagem', 'interpretarResposta', 'interpretarEscolhaPatio', 'extrairPlaca', 'ehGrupo', 'ehPedidoDeStatus',
  'formatarTelefone', 'normalizar',
  'interpretarConsultaValidacao', // "o ticket X foi validado?" — consulta nos grupos dos pátios
];

function indice() {
  const linhas = [
    '📋 *Comandos da administração*',
    'Escreva o comando aqui no grupo. Para o passo a passo: *ajuda <assunto>* (ex.: _ajuda antifraude_).',
  ];
  for (const [id, rotulo] of CATEGORIAS) {
    const itens = COMANDOS.filter((c) => c.categoria === id);
    if (!itens.length) continue;
    linhas.push('', rotulo);
    for (const c of itens) linhas.push(`• *${c.exemplos[0]}* — ${c.descricao}`);
  }
  return linhas.join('\n');
}

const sem = (t) => String(t || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Passo a passo de um assunto; null quando nada casa. Vários casos: lista para escolher. */
function detalhe(termo) {
  const t = sem(termo).trim();
  if (!t) return null;
  const palavras = t.split(/\s+/).filter((p) => p.length >= 3);
  const casa = COMANDOS.filter((c) => c.chaves.some((k) => {
    const kk = sem(k);
    return t.includes(kk) || kk.includes(t) || palavras.some((p) => kk === p || (p.length >= 5 && kk.startsWith(p.slice(0, 5)))); // "fotos" ~ "foto"
  }));
  if (!casa.length) return null;
  const exatos = casa.filter((c) => sem(c.titulo) === t || c.chaves.some((k) => sem(k) === t));
  const lista = exatos.length ? exatos : casa;
  if (lista.length === 1) {
    const c = lista[0];
    return `🔎 *${c.titulo}*\n\n${c.detalhe}\n\nExemplo${c.exemplos.length > 1 ? 's' : ''}: ${c.exemplos.map((e) => `*${e}*`).join(' · ')}`;
  }
  return `Achei mais de um assunto para "${termo.trim()}":\n\n${lista.map((c) => `• *ajuda ${c.chaves[0]}* — ${c.titulo}`).join('\n')}\n\nMande o que você quer ver.`;
}

module.exports = { COMANDOS, CATEGORIAS, NAO_SAO_COMANDOS, indice, detalhe };
