# Perguntas em aberto (bloqueiam início da Fase 2 — PoC Solojet)

Copiado da seção 7 do briefing. Preencher antes de tentar rodar o fluxo real.

- [ ] Quantos hangares no total, e quais são os grupos/URLs/credenciais de cada um? Segundo hangar identificado: **AIBM** (ver seção própria abaixo) — ainda faltam URL do validador, credenciais e grupo do WhatsApp dele.
- [x] Qual o formato exato do número de ticket — ver seção "Formato real do ticket (foto confirmada)" abaixo.
- [x] O que o bot deve responder em cada tipo de resultado — ver tabela completa na seção "Mensagens do bot" abaixo.
- [ ] Quem será o responsável por acompanhar a manutenção após a entrega?
- [ ] Existe um número de WhatsApp dedicado disponível para o bot, ou será necessário providenciar um?

## ✅ Deploy no servidor AWS — workflow do n8n testado de ponta a ponta

O servidor (EC2, IP `18.191.250.76`, Ubuntu, 2 vCPU / ~900MB RAM) está no ar
com n8n rodando como serviço systemd (reinicia sozinho). O workflow
`n8n/workflows/validador-tickets.json` foi testado de verdade via HTTP real
(não só dentro do editor) — ver [README.md](../README.md), seção "Workflow
do n8n", para os comandos de teste e a lista de bugs reais encontrados e
corrigidos (versão do n8n, caminho da URL do webhook, caminhos hardcoded do
Mac local, e um bug de quoting que embaralhava argumentos vazios no Execute
Command).

- [x] Casos testados com sucesso via `curl` direto no webhook de produção:
      consultar ticket já validado (opção 1) e validar ticket inexistente
      (opção 3) — ambos retornaram a mensagem certa.
- [x] **Caminho de sucesso real de validação testado (08/09/2026)** com um
      ticket de verdade (`010809201717`), placa genérica `AAA0000` — toast
      verde "Ticket validado com sucesso!!" confirmado. ⚠️ Efeito colateral
      real: esse ticket de um cliente de verdade ficou registrado no sistema
      com a placa genérica, não a placa real do carro dele.
- [ ] RAM do servidor é apertada (~900MB) — funcionou nos testes, mas ainda
      não foi testado sob carga real (WhatsApp conectado + Playwright rodando
      ao mesmo tempo). Se travar, considerar upgrade pra t3.small (2GB).

### 🐛 Bug real AINDA NÃO RESOLVIDO: sliders "+ Horas"/"+ Dias"

Testando a validação de um ticket com a tolerância de 15min já vencida
(exige mexer nos sliders — ver abaixo), percorremos 3 métodos diferentes:

1. **Focar o thumb visível e apertar `ArrowRight`** — nunca funcionou, o
   valor ficava sempre em 0 (`aria-valuenow=0`). O `<input type="range">`
   real fica escondido dentro do `<span>` do thumb (via `clip-path`), com os
   atributos de acessibilidade nele, não no `<span>` selecionado antes.
2. **`.fill(String(quantidade))` direto no `input[type="range"]`** —
   atualiza o `aria-valuenow` corretamente, e o site chega a mostrar um toast
   verde de sucesso ao clicar VALIDAR — **mas isso é enganoso**: confirmamos
   depois (consultando de novo e o usuário conferindo no site de verdade) que
   a validação **não persistiu**.
3. **Arrastar o slider de verdade com o mouse** (`mouse.down` → `mouse.move`
   em steps → `mouse.up`, simulando um usuário real) — **mesmo resultado**:
   toast de sucesso, mas não persiste.

**Causa raiz encontrada** capturando a requisição de rede real: o próprio
JavaScript do site calcula um campo `nova_tolerancia` **corrompido** (ex:
`"20, -/2-9/T:3:27:0-03:00"`) e manda assim mesmo pro backend — isso
acontece com os 3 métodos de interação, então **é um bug do próprio
ValidPark**, não de como automatizamos o slider.

**Endpoint real descoberto** (útil para uma futura solução via chamada
direta de API, sem depender do JS quebrado do site):
```
POST https://1parkvalidador.technext.com.br/api-token-auth/
  body: {"username": "...", "password": "..."}
  → {"token": "..."}

PUT https://1parkvalidador.technext.com.br/tickets/{numeroTicket}/
  body: {
    "n_ticket": "...", "tp_ticket": "A", "placa": "...",
    "dt_entrada": "2026-09-08T20:17:27-03:00",
    "tolerancia": "2026-09-08T20:32:27-03:00",
    "add_min": 0, "add_hora": 2, "add_dia": 0,
    "indeterminado": false,
    "nova_tolerancia": "<calcular certo: tolerancia + add_hora horas + add_dia dias>",
    "id_patio": null, "usuario": "1park", "status": "V"
  }
```
`nova_tolerancia` parece ser calculado a partir de `tolerancia` (não de
`dt_entrada`) — confirmado comparando um caso real onde `add_dia: 20` e
`tolerancia` original geraram `nova_tolerancia` exatamente 20 dias depois.

**Complicador**: no teste que capturou essa requisição, a resposta do
servidor voltou com placa e `add_dia` **diferentes** do que enviamos — o
usuário confirmou que **esse ticket específico foi validado em outro pátio**
ao mesmo tempo (mesmo totem compartilhado entre hangares). Isso significa
que não temos 100% de certeza se nossa requisição (com o dado corrompido)
teria sido aceita ou rejeitada isoladamente — só sabemos que, na prática, o
resultado final não bateu com o que mandamos.

- [ ] **Não resolvido**: testar a chamada direta à API (calculando
      `nova_tolerancia` corretamente nós mesmos, em vez de depender do
      slider/JS do site) com um ticket isolado, sem risco de colisão com
      outro pátio.
- [ ] Definir a regra de negócio: quando o bot for validar um ticket dentro
      da janela 15min–2h (primeira validação, não extensão), que valor
      padrão de horasAdicionais/diasAdicionais deve mandar automaticamente?
      (ex: sempre 1h por padrão, ou perguntar ao cliente quanto tempo mais precisa)

### ⚠️ Limitação conhecida: `jaValidado` pode não detectar tickets recentes

O `consultar-ticket.js` procura o ticket na lista `.card-ticket-validados`
da tela — mas essa lista mostra só os ~21 mais recentes, e é **compartilhada
entre hangares** (mesmo totem). Confirmado na prática: um ticket validado há
poucos minutos já não aparecia mais na lista (provavelmente porque outros
hangares validaram vários tickets nesse meio tempo). Ou seja, `jaValidado:
false` não é garantia de que o ticket não foi validado — só garante que não
está entre os ~21 mais recentes visíveis. Não identificamos um jeito melhor
de checar isso na interface do ValidPark até agora.

## Específico do hangar Solojet (necessário para a PoC)

- [x] URL do site validador — `https://validpark.technext.com.br/login`
- [x] Usuário e senha de login — obtidos, mas **não guardados nem usados por mim** (ver nota de segurança abaixo)
- [x] **Usuário dedicado para o bot criado** (08/09/2026): `BOT_SOLOJET` /
      "BOT_ONEPARK_SOLOJET", vinculado ao Hangar Solojet, substitui o login
      pessoal (`alessan.solojet`) que era usado até então. Agora as
      validações automáticas aparecem como "Validado por: BOT_SOLOJET" nos
      cards, distinguindo claramente ação automática de ação manual de
      funcionário. `.env` local e do servidor já atualizados e testados.
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

### ✅ Descoberta: tickets são de um totem compartilhado entre hangares

O número do ticket **não pertence exclusivamente ao Solojet** — é emitido por
um totem do aeroporto e pode ser validado por qualquer hangar. Isso foi
confirmado testando com um ticket real (`010409183948`) que já tinha sido
usado: o ValidPark mostra um **toast "Este ticket já foi utilizado!"** em vez
de abrir o modal — e isso acontece mesmo que o ticket nunca apareça na lista
`.card-ticket-validados` **deste** hangar (porque pode ter sido validado por
outro).

Isso é um status **diferente** de "não encontrado" (`ticket_nao_encontrado`)
— antes os dois casos ficavam misturados, porque em ambos o modal não abre.
Corrigido em [scripts/consultar-ticket.js](../scripts/consultar-ticket.js) e
[scripts/validate-ticket.js](../scripts/validate-ticket.js): agora, ao digitar
o ticket, o script espera por **modal OU toast**, e distingue:

- `ticket_ja_utilizado` (validate) / `jaValidado: true` (consultar) — toast
  com "já foi utilizado"
- `ticket_nao_encontrado` — nem modal nem toast aparecem (timeout)
- `erro_validacao` — toast com outro texto (ex: mensagem de erro diferente)

Mensagem de WhatsApp para `ticket_ja_utilizado`:
`⚠️ Ticket {ticket} já foi utilizado anteriormente — não pode ser validado de novo.`

- [ ] Confirmar se isso significa que a placa também não é mais necessária
      (já que o ticket já foi "resolvido" por outro hangar) — hoje o bot só
      informa que já foi usado, sem checar/comparar a placa de quem está
      perguntando agora.

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
| `ticket_ja_utilizado` (ticket já usado, mesmo que por outro hangar) | ⚠️ Ticket {ticket} já foi utilizado anteriormente — não pode ser validado de novo. | não |
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

A senha real do usuário pessoal de login do Solojet (`alessan.solojet`) foi
compartilhada em texto nesta conversa (duas vezes) e salva em `.env`
(gitignored) para uso pelos scripts — nunca digitada manualmente numa tela
por mim. **Esse usuário não é mais usado** pela automação desde 08/09/2026:
foi substituído por um usuário dedicado (`BOT_SOLOJET`, ver seção do Solojet
acima), o que já reduz a exposição da conta pessoal. Ainda assim, como a
senha antiga ficou registrada em texto no histórico da conversa, recomenda-se
trocá-la quando for conveniente.

A senha do `BOT_SOLOJET` também apareceu em texto/print nesta conversa
(visível no formulário "Adicionar Usuário"). Como é uma conta dedicada só
para a automação (não uma conta pessoal), o risco é menor, mas vale
considerar trocar por uma senha mais forte que "botteste" antes de ir para
produção de verdade.
