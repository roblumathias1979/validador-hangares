# Perguntas em aberto (bloqueiam início da Fase 2 — PoC Solojet)

Copiado da seção 7 do briefing. Preencher antes de tentar rodar o fluxo real.

- [ ] Quantos hangares no total, e quais são os grupos/URLs/credenciais de cada um? Segundo hangar identificado: **AIBM** (ver seção própria abaixo) — ainda faltam URL do validador, credenciais e grupo do WhatsApp dele.
- [x] Qual o formato exato do número de ticket — ver seção "Formato real do ticket (foto confirmada)" abaixo.
- [x] O que o bot deve responder em cada tipo de resultado — ver tabela completa na seção "Mensagens do bot" abaixo.
- [ ] Quem será o responsável por acompanhar a manutenção após a entrega?
- [ ] Existe um número de WhatsApp dedicado disponível para o bot, ou será necessário providenciar um?

## Específico do hangar Solojet (necessário para a PoC)

- [x] URL do site validador — `https://validpark.technext.com.br/login`
- [x] Usuário e senha de login — obtidos, mas **não guardados nem usados por mim** (ver nota de segurança abaixo)
- [x] Seletores de login — `input[name="username"]`, `input[name="senha"]`, `button[type="submit"]`
- [x] Seletor do campo de ticket — `#standard-basic`
- [x] Seletor do campo "Placa" dentro do modal — `#outlined-error-helper-text`
- [x] Seletor do botão "VALIDAR" do modal — `.modal-footer .buttons button[type="submit"]`
- [x] Seletor do erro inline de placa — `#outlined-error-helper-text-helper-text`
- [ ] Seletor do toast de erro (`.Toastify__toast` foi inferido pelo visual, não confirmado no DOM)
- [x] **Caso de sucesso confirmado** — ao validar com placa correta, o modal fecha e um novo card aparece em `.card-ticket-validados` (visto com `Placa: BRU0503`, `Validado por: bruno.mart.solojet`). Script atualizado para refletir isso com confiança.
- [ ] ID do grupo do WhatsApp "Grupo Solojet" (via Baileys, geralmente `<numero>@g.us` ou nome exato do grupo)

### ⚠️ Descoberta importante: o fluxo real é diferente do briefing original

O briefing assumia "digitar ticket → validar → ler resultado". Na prática, o
ValidPark (Solojet) abre um **modal obrigatório pedindo a Placa do veículo**
antes de permitir clicar em VALIDAR — junto com sliders de "+ Horas" / "+ Dias"
de tolerância. Isso significa:

- [x] A foto do ticket também traz a placa do veículo, ou o responsável do
      hangar precisa informar a placa separadamente? — **Respondido:** por
      enquanto (a placa impressa no ticket é uma melhoria futura, ainda não
      disponível), o bot deve **perguntar a placa ao cliente** no grupo do
      WhatsApp. Se o cliente responder com algo genérico/não específico
      (ex: não souber a placa exata na hora), o bot **segue com a validação
      mesmo assim**, usando uma placa genérica — não deve travar o cliente
      por falta desse dado.
      - [x] Valor de placa genérica testado e confirmado pelo usuário:
            `placaGenerica: "AAA0000"` (em `config/hangares.json`) passa na
            validação de formato do ValidPark.
      - [ ] Quando o OCR passar a extrair a placa direto da foto do ticket,
            essa etapa de perguntar ao cliente deixa de ser necessária.
- [x] Uso dos sliders "+ Horas" / "+ Dias" — confirmado: servem para **estender
      a tolerância de um ticket já validado/ativo** quando o cliente atrasa a
      saída (mesmo modal e mesmo botão VALIDAR de uma validação nova, só que
      com os sliders movidos antes). Implementado em
      [scripts/validate-ticket.js](../scripts/validate-ticket.js) via
      `horasAdicionais`/`diasAdicionais` (parâmetros opcionais, focam o thumb
      do MUI Slider e apertam ArrowRight N vezes). Limites CONFIRMADOS: **máximo
      de 24 horas e 20 dias** — pedidos acima disso retornam
      `status: 'valor_invalido'` sem abrir o navegador, com mensagem própria
      pro WhatsApp.

### ⚠️ Nova regra de negócio: prazo de 2h desde a emissão

O ticket só pode ser validado se estiver dentro de **2h desde a hora de
emissão impressa na foto do ticket** (confirmado com o usuário — não é a hora
que a mensagem chegou no WhatsApp). Isso é uma regra adicional, separada da
"Tolerância" que o próprio ValidPark já calcula internamente (que é bem mais
longa, de dias).

Configurado em `config/hangares.json` como `prazoValidacaoHoras: 2` e
verificado em [scripts/validate-ticket.js](../scripts/validate-ticket.js)
antes de abrir o navegador — mas o script só recebe a data de emissão como
parâmetro opcional; **quem ainda precisa ser construído é o OCR que lê essa
data/hora impressa na foto** (o briefing original, seção 3.3, só previa
extrair o número do ticket, não a data de emissão).

- [x] Formato exato da data/hora impressa no ticket — ver seção "Formato real
      do ticket (foto confirmada)" abaixo.
- [x] Mensagem do bot quando o ticket está fora do prazo de 2h — definida:
      `⚠️ Ticket {ticket} está fora do prazo de 2 horas da emissão para validação.`
      (implementada em `mensagemWhatsapp` no retorno de `fora_do_prazo` em
      [scripts/validate-ticket.js](../scripts/validate-ticket.js))
- [x] **Linha do tempo completa confirmada** (isso explica o "Tolerância"
      padrão do modal = Entrada + 15min, visto em testes reais):
      1. **0–15min desde a emissão**: todo ticket impresso já sai com essa
         tolerância — o cliente **não precisa validar**.
      2. **15min–2h desde a emissão**: precisa validar (fluxo normal do
         `validate-ticket.js`).
      3. **Depois de 2h**: `status: 'fora_do_prazo'`, não deixa mais validar.
      Implementado em [scripts/consultar-ticket.js](../scripts/consultar-ticket.js):
      quando o ticket ainda não foi validado e está dentro dos 15min, a
      mensagem já avisa que não precisa validar ainda.

### ⚠️ Nova regra de negócio: checar vagas disponíveis antes de validar

Validar um ticket **ocupa uma vaga no pátio até o veículo sair** — se não
houver vaga disponível, o bot não deve validar. O contador "Disponíveis"
aparece na mesma tela do campo de ticket (`.qtd-veiculo-patio`, formato
"Total de vagas: 90 | Disponíveis: 82").

Implementado em [scripts/validate-ticket.js](../scripts/validate-ticket.js):
depois do login, o script lê esse texto e, se "Disponíveis" for 0, retorna
`status: 'sem_vagas'` sem tentar validar. Confirmado: bloqueia a validação
automática (não é caso de escalar para grupo de administração) e orienta o
cliente a resolver por conta própria. Mensagem de WhatsApp definida:
`⚠️ Não há vagas disponíveis no pátio no momento. Procure o totem de autopagamento no terminal do aeroporto para validação e pagamento.`

## Mensagens do bot (por status retornado por `scripts/validate-ticket.js`)

Todo resultado do script agora vem com `mensagemWhatsapp` (texto pronto para
responder no grupo do cliente) e `notificarAdmin` (se `true`, o n8n também
deve avisar o grupo de administração — ver briefing seção 3.6).

| status | mensagemWhatsapp | notificarAdmin |
|---|---|---|
| `validado` | ✅ Ticket {ticket} validado com sucesso. Placa: {placa}. | não |
| `ticket_nao_encontrado` | ⚠️ Ticket {ticket} não encontrado — verifique o número e tente novamente. | não |
| `formato_invalido` | ⚠️ Não consegui reconhecer o número do ticket direito. Pode reenviar a foto ou digitar o número manualmente? | não |
| `valor_invalido` (extensão de tolerância acima de 24h/20d) | ⚠️ Não é possível estender o ticket {ticket} por esse tempo — o máximo permitido é 24 horas ou 20 dias. | não |
| `fora_do_prazo` | ⚠️ Ticket {ticket} está fora do prazo de 2 horas da emissão para validação. | não |
| `sem_vagas` | ⚠️ Não há vagas disponíveis no pátio no momento. Procure o totem de autopagamento no terminal do aeroporto para validação e pagamento. | não |
| `erro_validacao` | ⚠️ Não foi possível validar o ticket {ticket}: {mensagem do site, ex: "Placa inválida"}. Confira a placa e tente novamente. | não |
| `indeterminado` | ⚠️ Não conseguimos confirmar a validação do ticket {ticket}. Nossa equipe foi avisada e vai verificar manualmente. | **sim** |
| `erro` (falha técnica: login, config faltando, etc.) | ⚠️ Não conseguimos processar a validação do ticket {ticket} no momento. Nossa equipe foi avisada. | **sim** |

- [x] Canal para `notificarAdmin: true` — confirmado que já existe um grupo
      de administração no WhatsApp (`config/hangares.json` tem o campo
      `grupoAdministracao` para isso).
- [ ] Falta só o nome/ID exato desse grupo de administração para preencher em
      `grupoAdministracao` (mesmo formato do `grupoWhatsappId`, ex:
      `<numero>@g.us` via Baileys).

### ⚠️ Nova regra de negócio: menu de opções quando o ticket chega no WhatsApp

Mudança no fluxo do bot (briefing seção 2 assumia ida direta à validação):
quando a foto do ticket chega no grupo, o bot deve perguntar ao cliente o que
ele quer fazer, com 3 opções:

1. Consultar se o ticket já foi validado
2. Consultar se está com a validade (tolerância) ativa
3. Validar o ticket

As opções 1 e 2 **não precisam de duas consultas separadas** — o mesmo
`scripts/consultar-ticket.js` já responde as duas de uma vez (retorna
`jaValidado` e `ativo` no mesmo resultado), sem preencher placa nem validar
nada de verdade. A opção 3 usa `scripts/validate-ticket.js` (que pede a
placa, como já documentado acima).

- [ ] Confirmar o texto exato do menu que o bot deve mandar no WhatsApp (ex:
      lista numerada, "responda 1/2/3", botões interativos do WhatsApp
      Business API, etc. — depende de como o Baileys for configurado no n8n)
- [x] `scripts/consultar-ticket.js` assume que os campos "Entrada" e
      "Tolerância" do modal são os dois primeiros `<input>` de `.modal-body`
      — **testado e confirmado** com execução real (ticket `011811132237`:
      `entrada: "18/11/2025 13:22:47"`, bateu com o valor real do card).

### ✅ Formato real do ticket (foto confirmada)

O usuário mandou uma foto de um ticket real do Solojet. Layout impresso:

```
#1PARK
SEJA BEM-VINDO
AEROPORTO DE JUNDIAI/VOA-SP
NAO DEIXE O TICKET NO VEICULO

1park.com.br
[QR code]

Ticket/Seq:  011903092521
Data/Hora:   19/03/26 09:25:21
Tolerancia 15min

technext.com.br
```

Isso confirma, para calibrar o OCR:

- **Número do ticket**: linha "Ticket/Seq: " seguida de **12 dígitos
  numéricos** (ex: `011903092521`). Regex `^\d{12}$` já configurada em
  `config/hangares.json` → `formatoTicket.regex`.
- **Data/hora de emissão**: linha "Data/Hora: " no formato
  **DD/MM/AA HH:MM:SS** — atenção, **ano com 2 dígitos** (`26`, não `2026`),
  diferente do formato que o próprio ValidPark mostra na tela (`2025` com 4
  dígitos). O OCR precisa converter para ISO 8601 assumindo século 20xx antes
  de passar como `dataEmissaoIso` para os scripts (documentado em
  `formatoDataEmissao` em `config/hangares.json`).
- **"Tolerancia 15min"** vem impresso no próprio ticket — confirma de vez a
  regra dos 15 minutos de tolerância automática.
- **Sem placa impressa** — confirma que por enquanto o bot precisa perguntar
  a placa ao cliente (ver seção acima).
- O ticket não tem prefixo de hangar/nome do cliente — só QR code + número +
  data/hora + aviso de tolerância. O nome do hangar vem só do grupo de
  WhatsApp de onde a foto chegou, não do próprio ticket.

## Segundo hangar: AIBM — requisito exclusivo de verificação de local

Hangar novo, ainda não configurado no projeto (só o Solojet tinha dados até
agora). Diferente do Solojet: teve **muita fraude no pátio**, então além da
foto do ticket, o cliente também precisa mandar **uma foto do veículo
estacionado no hangar** antes de validar — só pra esse hangar, não pra todos.

- [x] Confirmado: dá pra ler a placa direto de uma foto do veículo (mesma
      capacidade usada para ler o ticket). Testado com uma foto de exemplo:
      Haval cinza, **placa UQB2A42**, estacionado sob uma estrutura de
      telhado metálico azul, parede branca de azulejo, viga de sustentação
      azul, outros carros pretos ao redor.
- [x] Escopo confirmado: essa exigência de foto do veículo é **só do AIBM**
      (`exigeFotoVeiculoNoLocal: true` em `config/hangares.json`, no hangar
      `aibm`) — Solojet e demais hangares não precisam disso.
- ⚠️ **Limitação importante, já avisada ao usuário:** isso não é uma prova
  técnica à prova de fraude. Não dá pra confiar em GPS da foto (o WhatsApp
  normalmente remove metadados de localização antes de enviar). O que dá pra
  fazer é comparar visualmente o fundo/cenário da foto do carro com fotos de
  referência do pátio/fachada do hangar — pega fraudes óbvias (foto de outro
  lugar completamente diferente), mas não impede alguém insistente de tentar
  simular um ângulo parecido ou reenviar uma foto antiga.
- [ ] **Aguardando**: o usuário disse que vai mandar uma foto da **fachada**
      do hangar AIBM (no dia seguinte a esta conversa) para servir de
      referência visual da comparação de local. Sem isso, a checagem de
      "veículo está no hangar certo" ainda não pode ser implementada.
- [ ] Ainda faltam pro AIBM (igual fizemos pro Solojet): URL do site
      validador, credenciais de login, seletores da página, grupo do
      WhatsApp do cliente. Não sabemos ainda se o AIBM usa o mesmo sistema
      ValidPark do Solojet ou outro validador.

### Nota de segurança

A senha real do usuário de login do Solojet foi compartilhada em texto nesta
conversa (duas vezes). Ela foi salva localmente em `.env` (arquivo
gitignored, nunca vai para o repositório) e usada pelos scripts
`validate-ticket.js`/`consultar-ticket.js`, que rodam via Playwright — em
nenhum momento a senha foi digitada manualmente numa tela por mim. Ainda
assim, **como ficou registrada em texto no histórico da conversa,
recomenda-se trocar essa senha** quando for conveniente.
