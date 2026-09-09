# Perguntas em aberto (bloqueiam início da Fase 2 — PoC Solojet)

Copiado da seção 7 do briefing. Preencher antes de tentar rodar o fluxo real.

## 🐛 Bug real corrigido (09/09/2026): fuso horário no `consultar-ticket.js`

`parseDataBr()` construía o `Date` a partir do texto do ValidPark
("18/11/2025 13:37:47", hora de São Paulo) **sem offset de fuso horário**.
Sem isso, o `Date` do JavaScript é interpretado no fuso do processo Node —
no servidor, isso é **UTC**, 3h à frente de São Paulo. Resultado: qualquer
ticket bem recente aparecia como "tolerância já vencida" mesmo quando ainda
estava dentro dos 15 minutos de verdade (descoberto testando um ticket
emitido 7 minutos antes, que deveria mostrar `ativo: true`).

**Corrigido**: adicionado `-03:00` explícito na string antes de criar o
`Date`. Testado e confirmado (o mesmo ticket, depois de corrigido, mostrou
que já tinha sido validado por outro pátio nesse meio tempo — resultado
diferente, mas correto).

**Impacto**: esse bug pode ter afetado qualquer resposta de `ativo`/"prazo
já venceu" para tickets consultados poucas horas após a emissão durante
toda a sessão até agora — vale desconfiar de conclusões antigas sobre
"tolerância vencida" tiradas antes dessa correção.

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

### 🐛 Investigação em aberto: sliders "+ Horas"/"+ Dias" (tickets emulados)

**⚠️ Atualização importante (09/09/2026):** os tickets usados nos testes
abaixo (`010409183948`, `010809202610`, `010809201717`, `030809194400`,
`030809210500`) eram **emulados/simulados para teste**, não tickets reais
emitidos pelo totem — confirmado pelo usuário. O `usuario: "AVULSO"` visto
nas respostas da API provavelmente reflete isso. **Isso pode explicar por
que a escrita via API era ignorada silenciosamente** — talvez tickets
emulados tenham alguma restrição/flag que tickets reais não têm. **Ainda não
sabemos se o bug do slider (JS quebrado calculando `nova_tolerancia`) e o
bloqueio da escrita via API acontecem também com um ticket real** — isso
precisa ser testado de novo assim que tivermos um.

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

- [x] **Testada a chamada direta à API (09/09/2026), sem sucesso ainda**:
      com um ticket isolado (`030809194400`, sem risco de colisão com outro
      pátio), autenticamos via `/api-token-auth/`, calculamos
      `nova_tolerancia` corretamente (formato `-03:00`, sem milissegundos,
      igual ao resto do payload) e mandamos o `PUT /tickets/{ticket}/`.
      Resultado: **HTTP 200, mas o servidor devolve o registro sem nenhuma
      mudança** (mesma placa vazia, `status: "A"`, `usuario: "AVULSO"`) —
      como se a escrita fosse silenciosamente ignorada. Testado também com
      cabeçalhos de navegador (Origin/Referer/Accept) — mesmo resultado.
      Confirmado que o ticket ficou intacto (sem efeito colateral).
      **Atualização (mesmo dia)**: descobrimos o `id_patio` real e correto
      do Solojet fazendo um GET (só leitura, sem risco) num ticket que
      sabíamos ter sido validado pelo Solojet — confirmado: **`id_patio: 30`**
      (o `31` visto antes era de outro pátio/hangar, então ainda bem que não
      arriscamos usar aquele número). Repetimos o teste com um ticket novo
      isolado (`030809210500`) e `id_patio: 30` correto — **mesmo resultado:
      HTTP 200, escrita ignorada silenciosamente**, sem CSRF ou erro visível
      nos headers de resposta. Descartamos `id_patio` como a causa.
      **Conclusão: precisamos parar de tentar "no escuro"** — falta alguma
      informação que só dá pra descobrir com documentação da API (Technext/
      1Park) ou inspecionando mais a fundo o tráfego de um navegador real
      autenticado (ex: cookies de sessão que a automação não está enviando).
      Ticket de teste confirmado intacto, sem efeito colateral.
- [x] **Definida a regra de negócio da tolerância na primeira validação**
      (09/09/2026): o bot **pergunta ao cliente quanto tempo ele pretende
      ficar** e converte a resposta em horasAdicionais/diasAdicionais, em vez
      de aplicar um valor fixo. Motivo: valor fixo alto concede
      estacionamento gratuito a quem ficaria minutos, e valor fixo baixo faz
      a validação vencer com o carro ainda no pátio. Limites dos sliders:
      24 horas e 20 dias.
      **Ainda falta implementar** o passo que faz essa pergunta e interpreta
      a resposta — depende do nó de WhatsApp, que ainda é placeholder. Os
      scripts já aceitam os dois valores por argumento, e o workflow já os
      repassa (`{{$json.horasAdicionais || 0}}`), então o que falta é só a
      camada de conversa. Decidir também o formato da pergunta: texto livre
      ("umas 3 horas", "dois dias") exige interpretação e tratamento de
      resposta vaga; um menu numerado é mais confiável e combina com o menu
      de opções que já existe.
- [x] **Removida a orientação de esperar os 15 minutos** (09/09/2026): não
      existia nenhuma trava de código para isso — `validate-ticket.js` só
      checa formato, prazo de 2h e vagas, e o workflow decide por
      `opcao === 3`, sem condição de tempo. A "regra" era só a mensagem do
      `consultar-ticket.js`, que dizia "ainda não precisa validar" e na
      prática empurrava o cliente para depois. Cliente que vai deixar o
      veículo no hangar precisa validar já na entrada; a mensagem agora
      convida a validar informando quanto tempo vai ficar.
      ⚠️ Atenção ao implementar: validar dentro dessa janela com os sliders
      em 0 concede só a tolerância padrão (~15min), que vence com o carro
      ainda no pátio — a pergunta ao cliente não é opcional nesse caminho.

### ✅ Corrigido: falso negativo reportava falha em validação bem-sucedida

Descoberto em 09/09/2026 na **primeira validação real feita a partir do
MacBook** (ticket `010909141913`, placa ABC5432, +5 dias): o site validou
corretamente — tolerância foi de 09/09 14:34:22 para 14/09 14:34:22, com
"Validado por: BOT_SOLOJET" no card, confirmado por print da tela — mas o
`validate-ticket.js` retornou `erro_validacao` com mensagem vazia. O cliente
receberia "não foi possível validar" para um ticket já validado.

Causa: depois de clicar em VALIDAR, a detecção era um `Promise.race` entre
três seletores, e **dois dos três sinais são traiçoeiros**:

1. **O toast serve para sucesso E para erro** (mesmo `.Toastify__toast`).
   O código tratava "apareceu um toast" como erro — ou seja, reportaria
   falha justamente quando a validação dava certo.
2. **O campo de erro inline fica "visível" mesmo no sucesso**, contendo só um
   caractere zero-width. Já sabíamos disso no caso de recusa por falta de
   tolerância, mas **acontece no sucesso também** — e foi ele que ganhou a
   corrida, produzindo o falso negativo com mensagem vazia.
3. O modal fechar indica sucesso, mas numa corrida perde para os outros dois.

Correção: não há mais corrida entre seletores. Espera-se o toast — o único
sinal que diz O QUE aconteceu — e o resultado é classificado **pelo
conteúdo**, com o erro inline valendo só se tiver texto legível de verdade e
o modal fechado como última reserva. A decisão foi extraída para
`classificarResultadoValidacao()`, exportada e coberta por 8 casos de teste
que rodam sem tocar o site, incluindo o caso exato deste falso negativo.

Dois status novos saíram daí: `ticket_ja_utilizado` (que antes não tinha
mensagem no mapa, resultando em `mensagemWhatsapp: undefined` se acontecesse
depois de o modal abrir) e `tolerancia_obrigatoria`, para a recusa por
tolerância vencida — que agora pede ao cliente quanto tempo ele vai ficar,
casando com a decisão de perguntar em vez de usar valor fixo.

### ✅ Um número de WhatsApp, vários hangares — roteamento por grupo

Requisito confirmado em 09/09/2026: **um único número** recebe os tickets de
todos os hangares, **cada hangar tem seu grupo** de WhatsApp, e **cada hangar
tem seu login** no ValidPark.

A arquitetura já suportava isso — `config/hangares.json` sempre teve
`grupoWhatsappId`, `usuarioEnvVar` e `senhaEnvVar` por hangar, e o `login()`
resolve as credenciais por hangar em tempo de execução. Suportar um hangar novo
não exige mudança de código: uma entrada no config e um par de variáveis no
`.env`.

O que estava errado era a **duplicação**: a tabela grupo → hangar vivia também
dentro do nó "Identificar Hangar" do workflow, num objeto `GRUPO_PARA_HANGAR`
escrito à mão, cujo próprio comentário mandava "adicionar uma linha aqui E uma
entrada em config/hangares.json". Removida: o nó agora chama
`scripts/identificar-hangar.js`, que lê o config. Cadastrar hangar é mexer em um
lugar só.

Casos de borda cobertos por teste no resolvedor (`buscarHangarPorGrupo`):
grupo com espaços em volta, grupo desconhecido, `grupoId` vazio, o mesmo grupo
cadastrado em dois hangares, e — importante — **hangar com `grupoWhatsappId`
vazio não pode casar** com um `grupoId` vazio, que era o comportamento
acidental de uma comparação ingênua.

- [ ] **Preencher `grupoWhatsappId` de cada hangar** com os IDs reais dos
      grupos (Solojet, AIBM, administração). Hoje estão vazios, então a
      identificação por grupo ainda não funciona de fato — só o atalho manual.
- [ ] **Decidir o que responder quando o grupo não é identificado.** O Code
      node hoje lança erro, mantendo o comportamento anterior, e o cliente não
      recebe nada. O script já devolve `mensagemWhatsapp` e
      `notificarAdmin: true` prontos; falta ligar isso ao nó de resposta.

### 🔴 SEGURANÇA: o webhook não tem autenticação, e o hangar é escolhível de fora

Descoberto ao montar o roteamento por grupo. Duas coisas que juntas viram um
problema real:

1. O nó Webhook do workflow está com `"options": {}` — **sem autenticação
   nenhuma**. Qualquer um que saiba a URL pode chamar.
2. O `hangarId` pode vir direto no corpo da requisição, como atalho de teste
   manual (é o que os exemplos de curl do README usam).

Somando: quem descobrir a URL **escolhe em qual hangar validar um ticket**,
usando o login daquele hangar e ocupando vaga do pátio dele. Com um hangar só
isso já era ruim; com vários, é validação cruzada entre clientes de hangares
diferentes, e cada validação tem efeito financeiro.

Agravante: a porta 5678 está exposta na internet (o README documenta chamadas
via `http://18.191.250.76:5678/...`), em HTTP puro, sem TLS.

**Antes de plugar o WhatsApp de verdade:** ativar autenticação no nó Webhook,
restringir ou remover o atalho `hangarId`, e considerar fechar a 5678 para o
mundo (deixando só o provedor de WhatsApp alcançá-la).

### ⚠️ A conferir: como o "Execute Command" trata código de saída != 0

`identificar-hangar.js` sai com **0 mesmo em falha**, de propósito: o `status`
no json é que carrega o resultado, e quem decide é o nó seguinte. Isso evita
depender de como o nó "Execute Command" trata código de saída não-zero —
comportamento que este projeto nunca verificou.

`validate-ticket.js` e `consultar-ticket.js` ainda fazem `process.exit(1)` no
caminho de erro. **Se o Execute Command falhar o nó nesse caso, o "Parse
Resultado" não roda e a `mensagemWhatsapp` de erro nunca chega ao cliente** —
justamente nos casos em que ele mais precisa de resposta. Vale testar e, se
confirmado, alinhar os dois scripts com a saída 0.

### ⚠️ CORRIGIDO: o site exige tolerância > 0 em TODA validação

Acreditávamos que a exigência de `horasAdicionais`/`diasAdicionais` > 0
aparecia **só** quando a tolerância padrão de 15min do ticket já tinha
vencido. **Isso está errado.**

Testado em 09/09/2026 com o ticket `010909143054`, emitido **45 segundos
antes** da tentativa, tolerância gratuita válida até 14:46:04: validar com os
dois sliders em 0 foi **recusado** com o mesmo toast
`OPS! Digite uma tolêrancia para validar o ticket!`. Em seguida, o mesmo
ticket com **1 hora** foi aceito — tolerância resultante 15:46:04, ou seja
`entrada + 15min + 1h`.

**Consequência de desenho, e ela é importante:** o bot **nunca** consegue
validar sem antes saber quanto tempo o cliente vai ficar. Perguntar não é um
refinamento para o caso da tolerância vencida — é obrigatório em todos os
caminhos de validação. Isso reforça a decisão já tomada de perguntar ao
cliente, e elimina a alternativa de "validar direto com um padrão 0".

Um valor padrão de reserva continua fazendo sentido para quando o cliente não
responde ou responde algo ininterpretável — mas ele não pode ser 0.

De onde vinha o erro: a exigência foi descoberta testando justamente um ticket
com a tolerância vencida, e a correlação foi tomada como causa. Nenhum teste
anterior tentou validar um ticket recém-emitido com os sliders em 0.

### ✅ Caminho de sucesso confirmado com a classificação nova

Ticket `010909143054`, placa `AAA0000`, +1h: `status: validado`, mensagem lida
do toast verde `Ticket 010909143054 validado com sucesso!!`, e a consulta
seguinte confirmou `jaValidado: true`, `ativo: true`, tolerância 15:46:04.

Esse é o teste que fechava a lacuna deixada pela correção do falso negativo:
**antes da correção, este caso exato teria retornado `erro_validacao`.**
Cobertura dos caminhos de `validate-ticket.js` agora completa, com a única
exceção de `sem_vagas`, que exigiria o pátio de fato cheio.

### ✅ Confirmado: o número do ticket carrega a data/hora de emissão

O número segue o formato `01` + `DDMM` + `HHMMSS`. Confirmado com 7 amostras
(4 delas lidas dos cards do ValidPark em 09/09/2026): a hora codificada no
número fica de 8 a 12 segundos ANTES do campo "Entrada" do card, o que faz
sentido se `Entrada` é registrada logo depois da impressão.

| Número | Decodificado | Entrada real | Δ |
| --- | --- | --- | --- |
| `011903092521` | 19/03 09:25:21 | (impresso no ticket: 09:25:21) | 0s |
| `010909124732` | 09/09 12:47:32 | 12:47:40 | 8s |
| `010909134836` | 09/09 13:48:36 | 13:48:48 | 12s |
| `010909135126` | 09/09 13:51:26 | 13:51:36 | 10s |
| `010909141913` | 09/09 14:19:13 | 14:19:22 | 9s |
| `011811132237` | 18/11 13:22:37 | 13:22:47 | 10s |

**Consequência prática: o OCR não precisa extrair a data de emissão** — basta
o número, e a data sai dele. Isso simplifica bastante o passo de OCR, que era
apontado como requisito novo em relação ao briefing original.

⚠️ Ressalva: **o ano não está no número**. Precisa ser inferido, com cuidado
na virada de ano (um ticket de 31/12 consultado em 01/01 não é do ano
corrente). A regra de 2h de prazo limita o dano, mas a inferência precisa
existir.

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
         tolerância gratuita — quem for sair nesse prazo **não precisa
         validar**. Mas quem vai deixar o veículo no hangar **pode e deve
         validar já aqui**, sem esperar (revisto em 09/09/2026 — antes a
         mensagem do bot mandava esperar).
      2. **15min–2h desde a emissão**: precisa validar (fluxo normal do
         `validate-ticket.js`).
      3. **Depois de 2h**: `status: 'fora_do_prazo'`, não deixa mais validar.
      Implementado em [scripts/consultar-ticket.js](../scripts/consultar-ticket.js):
      dentro dos 15min a mensagem informa até quando vale a tolerância
      gratuita e oferece validar na hora, perguntando quanto tempo o cliente
      vai ficar.

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
