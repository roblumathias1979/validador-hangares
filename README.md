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
   desde a emissão — quem for sair nesse prazo nem precisa validar. Quem vai
   deixar o veículo no hangar, porém, **valida já na entrada**, sem esperar
   esses 15 minutos: nesse caso o bot pergunta quanto tempo o cliente vai
   ficar e manda o valor nos sliders de tolerância, senão a validação
   venceria em minutos.

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

**✅ Testado de ponta a ponta de verdade**, rodando no servidor AWS
(18.191.250.76), via HTTP real (não só dentro do editor do n8n):

```bash
# consultar (opção 1/2 do menu) — ticket já validado, tolerância expirada:
curl -X POST http://18.191.250.76:5678/webhook/validador-tickets-hangares-sbjd/webhookwhatsapp/ticket-hangar \
  -H "Content-Type: application/json" \
  -d '{"hangarId": "solojet", "opcao": 1, "ticket": "011811132237"}'
# → {"mensagem":"⚠️ Ticket 011811132237 foi validado, mas a validade já expirou..."}

# validar (opção 3) — ticket inexistente, sem efeito colateral:
curl -X POST http://18.191.250.76:5678/webhook/validador-tickets-hangares-sbjd/webhookwhatsapp/ticket-hangar \
  -H "Content-Type: application/json" \
  -d '{"hangarId": "solojet", "opcao": 3, "ticket": "000000000000", "placa": "AAA0000"}'
# → {"mensagem":"⚠️ Ticket 000000000000 não encontrado — verifique o número..."}
```

**✅ Caminho de sucesso real também confirmado** (08/09/2026, ticket real
`010809201717`, placa genérica `AAA0000`, +2h de tolerância via slider) —
toast verde "Ticket validado com sucesso!!" no site. Ver
[docs/perguntas-abertas.md](docs/perguntas-abertas.md) para o bug do slider
que foi corrigido nesse processo (usava `ArrowRight`, que nunca funcionava de
verdade). ⚠️ **Corrigido em 09/09/2026:** acreditava-se que só tickets com a
tolerância de 15min já vencida exigiam horas/dias adicionais > 0. Na verdade
**o site exige isso em toda validação** — um ticket emitido 45 segundos antes
foi recusado igual. Ou seja, o bot **nunca** valida sem antes perguntar ao
cliente quanto tempo ele vai ficar.

### Bugs reais encontrados e corrigidos no processo

Colocar esse workflow pra funcionar de verdade (não só abrir sem erro) expôs
vários problemas que só apareceram testando de ponta a ponta:

1. **n8n 2.x (a versão "latest" instalada por padrão) tem um bug real de
   ativação de webhook** — o banco de dados confirma o registro, os logs
   dizem "Activated workflow", mas a rota nunca fica acessível de verdade.
   Solução: fixamos a versão em **n8n 1.123.77** (linha estável 1.x), que não
   tem esse problema. `npm install -g n8n@1.123.77` em vez de `npm install -g
   n8n` (que pega a "latest", hoje 2.x).
2. **Ativar um workflow via banco de dados direto não é suficiente** — o
   registro real do webhook (tabela `webhook_entity`) só acontece quando o
   n8n processa a ativação de verdade. O jeito confiável sem precisar abrir a
   interface: `n8n update:workflow --id=<id> --active=true` (isso só marca a
   flag; **precisa reiniciar o serviço** depois pra ele de fato registrar o
   webhook no restart).
3. **O caminho da URL do webhook não é só o `path` configurado** — o n8n
   monta a URL como `/webhook/{idDoWorkflow}/{nomeDoNoEmMinusculas}/{path}`.
   Por isso demos nome simples ao nó Webhook (`WebhookWhatsApp`, sem espaços
   nem parênteses) — nomes com espaço/caracteres especiais viram `%20` etc.
   na URL e podem não bater com o que o n8n espera internamente.
4. **Os nós "Execute Command" tinham o caminho do Mac local** (`/Users/...`)
   em vez do caminho real no servidor (`/home/ubuntu/validador-hangares/...`)
   — ficou assim de quando montamos o workflow testando localmente, e nunca
   foi atualizado ao migrar pro servidor.
5. **Parâmetros opcionais vazios na expressão do "Execute Command" sem aspas
   quebravam a ordem dos argumentos** — `{{$json.dataEmissaoIso || ""}}`
   quando vazio produzia uma string vazia SEM aspas no comando do shell, que
   o shell simplesmente descarta (não conta como argumento) — isso empurrava
   todos os parâmetros seguintes uma posição pra trás. Corrigido envolvendo
   cada argumento em aspas duplas na própria expressão:
   `"{{$json.dataEmissaoIso || ''}}"`.

### O que ainda falta

- **Trocar o nó Webhook pelo nó real de WhatsApp** (Baileys/Evolution API,
  ainda não escolhido/instalado).
- **Adicionar o passo de OCR** antes de "Identificar Hangar" (ver nota
  amarela dentro do próprio workflow).
- **Preencher o mapa `GRUPO_PARA_HANGAR`** dentro do nó "Identificar Hangar"
  com os IDs reais dos grupos do WhatsApp (Solojet, AIBM, administração).
- **Trocar os dois nós "placeholder"** (Responder Cliente / Notificar Admin)
  pelos nós reais de envio de mensagem, quando o WhatsApp estiver conectado.
- Os caminhos dos scripts no "Execute Command" estão fixos pro servidor AWS
  atual (`/home/ubuntu/validador-hangares/...`) — se o projeto mudar de
  servidor, precisa atualizar isso no workflow.

**⚠️ Nó "Execute Command" vem desabilitado por padrão no n8n** (por
segurança — mas é exatamente o nó que este workflow usa pra chamar os
scripts). Sem a variável `NODES_EXCLUDE=[]`, dá erro **"Unrecognized node
type: n8n-nodes-base.executeCommand"**.

**Como o n8n está rodando hoje (servidor AWS, systemd):**

```bash
sudo systemctl status n8n      # ver status
sudo systemctl restart n8n     # reiniciar (necessário depois de ativar um workflow)
sudo journalctl -u n8n -f      # acompanhar logs ao vivo
```

Serviço em `/etc/systemd/system/n8n.service`, com `NODES_EXCLUDE=[]`,
`N8N_USER_FOLDER=/home/ubuntu/validador-hangares/n8n/data` e
`N8N_SECURE_COOKIE=false` (necessário por estarmos em HTTP puro, sem
domínio/certificado ainda).

**Para rodar localmente (sem Docker), se precisar testar fora do servidor:**

```bash
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh"
cd "/Users/rodrigobmmathias/Automacao Validador hangares SBJD "
NODES_EXCLUDE='[]' N8N_USER_FOLDER="$(pwd)/n8n/data" npx n8n start
```

(O `docker-compose.yml` continua sendo a referência para hospedagem em
container — lembrar de adicionar `NODES_EXCLUDE=[]` nas variáveis dele
também, e considerar pinar `n8nio/n8n:1.123.77` em vez de `:latest` dado o
bug encontrado na versão 2.x.)

## Próximos passos (ver briefing, seção 6)

1. Levantamento completo dos hangares (grupos, URLs, credenciais).
2. PoC para o hangar Solojet, ponta a ponta.
3. Testes em paralelo com o processo manual.
4. Expansão para os demais hangares.
5. Documentação de manutenção e entrega.
