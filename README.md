# Automação de validação de tickets via WhatsApp — Hangares SBJD

Implementação baseada em [briefing-automacao-tickets-whatsapp.md](briefing-automacao-tickets-whatsapp.md).

Fluxo: foto do ticket chega num grupo do WhatsApp → bot pergunta ao cliente o
que ele quer (consultar se já foi validado, consultar se está com validade
ativa, ou validar o ticket) → OCR extrai o número do ticket (e a data/hora de
emissão, se for validar) → Playwright loga no validador daquele hangar e
executa a ação escolhida → bot responde no grupo com o resultado.

## Status

Fase 1 (levantamento) em andamento — ver [docs/perguntas-abertas.md](docs/perguntas-abertas.md).

Para o hangar **Solojet** (ValidPark, React/MUI): ambiente local rodando
(Node 24 + Playwright/Chromium instalados via nvm) e **os dois scripts já
foram testados de verdade** contra o site real — login, consulta de ticket já
validado (com a correção da tolerância vinda do card, não do modal) e ticket
inexistente. Duas descobertas mudaram o escopo do briefing original:

1. O fluxo exige digitar a **placa do veículo** num modal, além do número do
   ticket. Por enquanto a placa não vem na foto — o bot deve **perguntar ao
   cliente**; se ele não souber/responder algo genérico, o bot segue com a
   validação mesmo assim usando uma placa genérica (`placaGenerica` na
   config). Isso deixa de ser necessário quando o OCR passar a extrair a
   placa direto da foto do ticket (melhoria futura).
2. Regra de negócio nova: o ticket só pode ser validado se estiverem **até 2h
   entre a emissão (impressa na foto) e a validação** — isso significa que o
   OCR também precisa extrair a data/hora de emissão, não só o número.
   Confirmado também: todo ticket já sai com **15 minutos de tolerância**
   desde a emissão, período em que nem precisa validar.

Segundo hangar identificado: **AIBM** (só cadastrado como esqueleto em
`config/hangares.example.json` ainda — falta URL, credenciais e seletores).
Diferente do Solojet, o AIBM teve muita fraude no pátio e por isso precisa de
uma etapa extra: o cliente manda também uma foto do veículo estacionado no
hangar, e o bot compara visualmente com fotos de referência do local antes de
validar (`exigeFotoVeiculoNoLocal: true`). Essa checagem não é à prova de
fraude — pega casos óbvios, não impede fraude sofisticada — e ainda depende
de uma foto da fachada do hangar (aguardando o usuário mandar).

Login/senha nunca são digitados manualmente numa tela por mim (isso é uma
restrição fixa) — mas a automação em si (Playwright rodando via `node`) usa
as credenciais reais do `.env`, que é o mecanismo desenhado pra isso. O
mapeamento inicial da estrutura do site foi feito com o usuário logando e
mandando screenshots do DevTools; os testes atuais já rodam o fluxo real.

## Estrutura

- `config/hangares.example.json` — template da tabela de hangares (grupo, URL do
  validador, referência às variáveis de ambiente com as credenciais, seletores
  da página, formato do ticket). Copiar para `config/hangares.json` (gitignored)
  e preencher.
- `.env.example` — variáveis de ambiente (n8n, OCR, credenciais por hangar).
  Copiar para `.env` (gitignored).
- `docker-compose.yml` — sobe o n8n self-hosted localmente.
- `scripts/validate-ticket.js` — script Node/Playwright que loga no validador
  de um hangar, digita o ticket (abre um modal pedindo a placa do veículo) e
  confirma a validação — inclusive para estender a tolerância de um ticket já
  ativo (cliente atrasou a saída), via os sliders "+ Horas"/"+ Dias". Pensado
  para ser chamado por um nó "Execute Command" do n8n. Uso:
  `node scripts/validate-ticket.js <hangarId> <numeroTicket> <placa> [dataEmissaoIso] [horasAdicionais] [diasAdicionais]`.
- `scripts/consultar-ticket.js` — script Node/Playwright somente-leitura: abre
  o mesmo modal do ticket sem validar nada, lê Entrada/Tolerância, confere na
  lista de tickets validados se já foi confirmado, e fecha o modal. Responde
  as opções "já foi validado?" e "está com validade ativa?" do menu do bot.
  Uso: `node scripts/consultar-ticket.js <hangarId> <numeroTicket>`.
- `scripts/lib/hangar.js` — código compartilhado entre os dois scripts acima
  (carregar config, achar hangar, fazer login).
- `n8n/workflows/validador-tickets.json` — o workflow do n8n em si (ver seção
  própria abaixo).
- `n8n/data/` — dados persistentes do n8n (gitignored).
- `docs/perguntas-abertas.md` — checklist do que falta definir antes da PoC.

## Como testar o script de validação isoladamente

```bash
npm install
npx playwright install chromium
cp config/hangares.example.json config/hangares.json
# preencher .env com SOLOJET_USUARIO e SOLOJET_SENHA reais
node scripts/validate-ticket.js solojet 011610095435 ABC1234

# com a checagem de prazo de 2h (dataEmissaoIso é opcional):
node scripts/validate-ticket.js solojet 011610095435 ABC1234 2026-08-27T20:00:00-03:00

# estendendo tolerância de um ticket já ativo (+3 horas, sem data de emissão):
node scripts/validate-ticket.js solojet 011811132237 ABC1234 "" 3
```

Limites confirmados dos sliders: **máximo de 24 horas e 20 dias**. Pedidos
acima disso são recusados pelo próprio script (`status: 'valor_invalido'`)
antes de abrir o navegador.

```bash
# consultar sem validar (o cliente escolheu "só quero saber o status"):
node scripts/consultar-ticket.js solojet 011811132237
```

Testado com sucesso: ticket já validado (`011811132237`) retorna
`jaValidado: true`, `ativo: false` (tolerância real do card, não a do modal),
e ticket inexistente (`000000000000`) retorna `ticket_nao_encontrado`.

## Workflow do n8n

[n8n/workflows/validador-tickets.json](n8n/workflows/validador-tickets.json)
implementa o fluxo: Webhook (placeholder) → identifica o hangar pelo grupo →
decide entre consultar ou validar → roda o script certo via "Execute
Command" → interpreta o JSON de resultado → responde o cliente e,
se necessário, avisa o grupo de administração.

**O que já está pronto e testado:**
- A estrutura do workflow foi validada via `n8n import:workflow` (aceita sem
  erros — nós e conexões corretos).
- A lógica dos dois nós de código ("Identificar Hangar" e "Parse Resultado")
  foi testada isoladamente fora do n8n, incluindo casos de borda (grupo
  desconhecido, stdout vazio, saída inválida) — todos passaram.
- Os comandos dos nós "Execute Command" são os mesmos que já rodamos
  manualmente o tempo todo nesta sessão.

**O que ainda falta, e por quê eu não fiz sozinho:**
- **Rodar de ponta a ponta pela interface do n8n** — a primeira tela do n8n
  pede pra criar uma conta local (email/senha). Não crio contas nem insiro
  senhas em telas, mesmo sendo só uma conta local do próprio software — é uma
  restrição fixa minha. Você precisa abrir **http://localhost:5678** você
  mesmo, criar essa conta (invente um e-mail/senha, é só local, não precisa
  ser real), importar o `n8n/workflows/validador-tickets.json` pela interface
  (menu **⋯ → Import from File**), e dar uma olhada rápida nos dois nós "IF"
  (condições) — a UI é o jeito mais confiável de confirmar visualmente que as
  condições ficaram do jeito certo.
- **Trocar o nó Webhook pelo nó real de WhatsApp** (Baileys/Evolution API,
  ainda não escolhido/instalado).
- **Adicionar o passo de OCR** antes de "Identificar Hangar" (ver nota
  amarela dentro do próprio workflow).
- **Preencher o mapa `GRUPO_PARA_HANGAR`** dentro do nó "Identificar Hangar"
  com os IDs reais dos grupos do WhatsApp (Solojet, AIBM, administração).
- **Trocar os dois nós "placeholder"** (Responder Cliente / Notificar Admin)
  pelos nós reais de envio de mensagem, quando o WhatsApp estiver conectado.

**⚠️ Importante — nó "Execute Command" vem desabilitado por padrão no n8n 2.x**
(por segurança, já que ele deixa rodar comandos no sistema — mas é exatamente
o nó que este workflow usa pra chamar os scripts). Sem a variável
`NODES_EXCLUDE=[]`, o workflow dá erro **"Unrecognized node type:
n8n-nodes-base.executeCommand"**.

**Para rodar o n8n localmente (sem Docker):**

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd "/Users/rodrigobmmathias/Automacao Validador hangares SBJD "
NODES_EXCLUDE='[]' N8N_USER_FOLDER="$(pwd)/n8n/data" npx n8n start
```

Acessar http://localhost:5678. (O `docker-compose.yml` continua sendo a
referência para quando for hospedar num VPS de produção 24/7 — lembrar de
adicionar `NODES_EXCLUDE=[]` nas variáveis de ambiente dele também.)

## Próximos passos (ver briefing, seção 6)

1. Levantamento completo dos hangares (grupos, URLs, credenciais).
2. PoC para o hangar Solojet, ponta a ponta.
3. Testes em paralelo com o processo manual.
4. Expansão para os demais hangares.
5. Documentação de manutenção e entrega.
