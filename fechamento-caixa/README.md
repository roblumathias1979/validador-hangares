# Conferência de fechamento de caixa por unidade — WhatsApp

Aplicação **independente** do validador de tickets de hangares (pasta irmã
neste mesmo repositório e servidor só por economia de infraestrutura — reusa
o mesmo EC2 e a mesma instância da Evolution API/WhatsApp já pagos, mas não
compartilha código de negócio com ele).

## O que faz

Cada unidade de estacionamento tem o seu **próprio grupo de WhatsApp**
(mesmo padrão do validador de hangares: um grupo por unidade, todas usando o
mesmo número/instância da Evolution API) para onde manda a foto do relatório
impresso de fechamento de caixa do sistema "#1 Park" — às vezes grampeada
junto com um segundo comprovante (resumo da maquininha de cartão, ex:
PagVendas/PagBank, ou envelope de depósito bancário em dinheiro). O bot:

1. Lê o relatório por OCR (API da Anthropic, com visão) — valor faturado,
   recebido por cartão/dinheiro/outra forma, a tabela de "Formas de
   Pagamento" (rótulos variam por unidade: MAQ. CARTAO, MASTER Crédito,
   SEMPARAR, ...), se é um fechamento final ou parcial ("Caixa Em Aberto"), e
   o comprovante anexado, quando houver.
2. Identifica a unidade **pelo grupo** (autoritativo — administrado por quem
   configura o bot, não pelo que a pessoa digita) e cruza com o nome impresso
   no relatório/legenda só para **alertar** quando parecem divergir (ex: foto
   do Ibis Styles mandada sem querer no grupo do Argentina Mall) — ver
   `scripts/lib/unidades.js`. O grupo sempre decide a unidade; a divergência
   vira aviso à administração, nunca um bloqueio. **Não usa CNPJ**:
   confirmado que máquinas de unidades diferentes compartilham o mesmo CNPJ.
3. Confere a matemática do PRÓPRIO relatório (a soma das formas de pagamento
   bate com o valor faturado?) e compara com o comprovante anexado na mesma
   foto, quando houver.
4. Grava o registro em `data/fechamentos.jsonl` (append-only) e responde no
   grupo — avisando a administração quando há algo para conferir.
5. O painel web (`painel/`) lista os fechamentos (com o detalhe de cada
   forma de pagamento) e exporta planilha (CSV).

## As duas conferências, e por que uma delas nunca "trava" nada

- **`conferirFechamentoInterno`** (`scripts/lib/conferencia.js`): a
  matemática do relatório fecha? Isso é exato — mesmo papel, mesmos números
  — então usa tolerância de 1 centavo e devolve `consistente` /
  `inconsistente` / `indeterminada` (quando falta algum valor legível).

- **`conferirMaquininha`**: compara o total NÃO-dinheiro do relatório contra
  o "Total Geral" do resumo da maquininha anexado na mesma foto (ou o valor
  do depósito, quando é um envelope de banco). **Isso não precisa de API
  nenhuma** — a unidade já grampeia o comprovante físico e fotografa os dois
  juntos; o ganho aqui foi perceber isso em vez de tentar integrar com
  Stone/PagSeguro. MAS: medido em fotos reais, o período impresso no
  relatório #1 Park e no resumo da maquininha nem sempre coincidem (ex: caixa
  parcial aberto há poucas horas vs. resumo da maquininha do dia inteiro), e
  "Recebido Outra Forma" costuma ser convênio faturado — dinheiro que nunca
  passou pela maquininha. Por isso esta checagem **nunca devolve um veredito
  fechado**: só `dentro_do_esperado` / `a_conferir` (diferença acima de uma
  tolerância percentual, hoje 5%) / `sem_referencia` (nada anexado, ou
  comprovante sem valor legível). Decidir se uma divergência é normal ou não
  fica para quem olha o painel.

## Pendência real: integração com API de maquininha/banco

O usuário pediu, além da conferência por foto, buscar as vendas diretamente
na **API da operadora de cartão** (Stone e PagSeguro/PagBank, hoje) em vez de
confiar só no que está impresso no comprovante fotografado. Isso é uma fonte
mais forte (a foto pode estar ilegível, cortada, ou simplesmente não ser
anexada), mas **eu não tenho como escrever essa integração de verdade sem**:

1. Confirmação de qual produto de API cada uma oferece (Stone e PagBank têm
   mais de uma API — conciliação, recebíveis, extrato de vendas — com
   formatos diferentes);
2. Credenciais reais (client id/secret ou token) de pelo menos uma unidade,
   para testar contra a API de verdade — não vou adivinhar endpoint/formato
   de resposta e fingir que está pronto;
3. O identificador do lojista/recebedor de cada unidade na respectiva
   operadora, para saber de qual unidade são as vendas retornadas.

**Nunca cole essas credenciais no chat** — coloque direto no `.env` do
servidor (ou peça para eu ler de lá). Quando isso existir, o ponto de
extensão já está reservado: hoje `conferirMaquininha` usa só o que veio na
foto; o próximo passo é uma função irmã que busca o extrato pela API e chama
a mesma comparação, sem mexer na conferência por foto (as duas podem
conviver — foto é conferência imediata, API é conferência mais forte quando
disponível).

## Estrutura

- `config/unidades.json` — cadastro das unidades (nome, apelidos para
  conferir contra o relatório/legenda, `grupoWhatsappId` — um grupo por
  unidade —, grupo de administração). Não guarda segredo nenhum — só
  configuração, versionado de propósito.
- `.env.example` — variáveis de ambiente (Evolution API, Anthropic, painel).
  Copie para `.env` (gitignored).
- `scripts/lib/unidades.js` — cadastro + `buscarUnidadePorGrupo` (autoritativo,
  lança se o grupo não estiver cadastrado) + `identificarUnidade` (chama a
  busca por grupo e cruza com o nome impresso/legenda só para alertar
  divergência).
- `scripts/lib/ocr-fechamento.js` — lê a foto do relatório via Claude.
  Esquema **confirmado contra três fotos reais** (25/09/2026: Hotel Nacional
  Inn Poços de Caldas, Hotel Ibis Styles, Argentina Mall).
- `scripts/lib/conferencia.js` — `conferirFechamentoInterno` e
  `conferirMaquininha`, com os testes descritos acima.
- `scripts/lib/armazenamento.js` — grava/lê `data/fechamentos.jsonl`.
- `scripts/lib/evolution.js` — cliente HTTP da Evolution API (baixar foto,
  mandar texto). Mesma instância do validador de hangares, módulo próprio.
- `scripts/lib/whatsapp-fechamento.js` — interpreta o evento
  `messages.upsert` da Evolution (versão enxuta do equivalente no validador
  de hangares — aqui só existe "chegou foto no grupo, ou não").
- `scripts/processar-fechamento.js` — orquestrador chamado pelo n8n via
  "Execute Command" (mesmo desenho do `processar-mensagem.js` do validador de
  hangares): um script só, com toda a lógica versionada e testável.
- `scripts/exportar-planilha.js` — gera CSV a partir de
  `data/fechamentos.jsonl`, usado pelo painel e utilizável direto no
  terminal.
- `painel/` — painel web (Basic Auth por senha única) que lista os
  fechamentos (com detalhe por linha) e exporta a planilha.
- `n8n/workflows/fechamento-caixa.json` — o workflow: Webhook → Execute
  Command → responde 200. O envio de mensagens (grupo e administração) já
  acontece dentro do próprio script (`--enviar`), não em nós separados.
- `scripts/listar-grupos.js` — lista os grupos de WhatsApp de que o bot já
  participa e sugere qual unidade cadastrada cada um parece ser, para
  preencher `grupoWhatsappId` sem catar o id manualmente. **Só funciona onde
  a Evolution API for alcançável** (hoje, o servidor AWS) — não roda em
  ambiente de desenvolvimento local.
- `tests/` — testes da lógica pura, com fixtures tiradas das três fotos reais
  (`tests/conferencia.js`) e da identificação de unidade
  (`tests/unidades.js`). Sem dependência de rede.

## Como testar

```bash
cd fechamento-caixa
node tests/conferencia.js
node tests/unidades.js
```

Testar o fluxo completo sem WhatsApp de verdade (equivalente a
`processar-mensagem.js --enviar` do validador de hangares, mas ainda exige
uma mensagem real no grupo para ter um `messageId` de onde baixar a foto):

```bash
# sem --enviar: só imprime o resultado calculado, não manda nada ao WhatsApp
node scripts/processar-fechamento.js "$(node -e "console.log(Buffer.from(JSON.stringify({
  event: 'messages.upsert',
  data: {
    key: { remoteJid: '<grupoFechamentoCaixaId>', id: '<messageId real>', participantAlt: '<telefone>@s.whatsapp.net' },
    pushName: 'Teste',
    message: { imageMessage: { caption: 'fechamento norte', mimetype: 'image/jpeg' } },
  },
}).toString('base64')))")"
```

## Antes de ir para produção

1. Preencher `config/unidades.json`: `grupoFechamentoCaixaId` (o grupo do
   WhatsApp) e cada unidade (nome exatamente como impresso no cabeçalho do
   relatório, apelidos, telefones).
2. Preencher `fechamento-caixa/.env` com as mesmas credenciais da Evolution
   API já em uso (ou uma instância própria) e a `ANTHROPIC_API_KEY`.
3. Rodar o OCR contra fotos reais de CADA unidade antes de confiar — o
   esquema foi confirmado em 3 unidades, mas rótulos de "Formas de
   Pagamento" variam (cada unidade pode ter máquinas diferentes).
4. Ajustar a tolerância de `conferirMaquininha` (`TOLERANCIA_MAQUININHA_PADRAO`
   em `scripts/lib/conferencia.js`, hoje 5%) depois de ver alguns dias reais
   de diferença "normal" entre o período do #1 Park e o da maquininha.
5. Ajustar o caminho do "Execute Command" no workflow do n8n para onde este
   repositório fica no servidor.
6. Configurar o webhook da Evolution API para este workflow, apontando para
   o grupo de fechamento de caixa (não o mesmo webhook do validador de
   hangares — são workflows separados).
7. Decidir a integração com API de Stone/PagBank só depois de confirmar
   qual produto de API cada uma oferece e ter credenciais de teste — ver
   seção acima.
