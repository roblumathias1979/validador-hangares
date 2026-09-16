# Estado atual do projeto — 15/09/2026

Documento de continuidade. Quem pegar este projeto (pessoa ou Claude Code) deve
ler isto antes de mexer em qualquer coisa.

---

## O que é

Automação que valida tickets de estacionamento do Aeroporto de Jundiaí (VOA-SP)
a partir de fotos que clientes de hangar mandam em grupos de WhatsApp. Hoje um
funcionário loga no portal ValidPark à mão, por hangar, e responde manualmente.

Stack: n8n (orquestração) + Playwright (automação do ValidPark) + API da
Anthropic (OCR do ticket). A operação não tem programador interno, então
confiabilidade e manutenibilidade valem mais que elegância.

---

## PRIMEIRA COISA A FAZER

**Há correções prontas que NÃO estão no GitHub.** Em 15/09 o repositório remoto
ainda estava em `9f7baaa`, sem nenhuma delas. Existe um arquivo
`correcoes-completas.patch` (ou `conferencia-local.patch`, que é o acumulado
maior) que foi verificado aplicando limpo num clone novo.

Antes de qualquer trabalho novo: aplicar, commitar, dar push, e fazer `git pull`
no servidor.

No servidor há uma alteração local à mão em `scripts/ocr-ticket.js` (a linha do
`dotenv`) que conflita com o patch. Descartar antes do pull:

```bash
cd ~/validador-hangares
git checkout -- scripts/ocr-ticket.js
git pull
```

---

## Infraestrutura

| Item | Estado |
|---|---|
| EC2 Ubuntu 26.04, us-east-2 | rodando, **t3.small**, Elastic IP `3.136.166.82` (fixo desde 15/09/2026) |
| Memória | **1.9 GB** — upgrade feito em 15/09/2026. Antes: 908 MB, com 338 MB já em swap em repouso; agora swap zerado |
| n8n | instalado, workflow roda ponta a ponta com webhook manual |
| Playwright | instalado, valida ticket real no ValidPark |
| `ANTHROPIC_API_KEY` | configurada no `.env` do servidor e **testada com sucesso** |
| Evolution API | **não instalada** |
| Número de WhatsApp dedicado | **não providenciado** |
| Acesso ao servidor | via EC2 Instance Connect (navegador) ou SSH com `~/.ssh/validador.pem` |
| Evolution API | **instalada** (v2.3.7, Docker, com Postgres e Redis), WhatsApp pareado como `BOT_OnePark` |
| Arquivos de infraestrutura | versionados em `infra/` desde 16/09/2026 — a cópia que vale é a do servidor |

~~O upgrade de memória é pré-requisito~~ — **feito em 15/09/2026**: a instância
foi para `t3.small` (1.9 GB) e ganhou um Elastic IP (`3.136.166.82`), que sobrevive
a parar/iniciar a máquina. O IP automático mudou duas vezes durante o upgrade, e
teria quebrado o webhook da Evolution API depois de configurado. O swap, que vivia
com 338 MB ocupados em repouso, zerou. Há folga para Evolution API + Redis +
Chromium.

---

## Hangares

16 no total, todos no mesmo ValidPark (`https://validpark.technext.com.br/login`),
com credencial própria por hangar em variáveis de ambiente. Os seletores CSS são
compartilhados no config, então o mapeamento feito para o Solojet vale para todos.

**Cota mensal de validação fora do prazo:** 5 para Solojet, Solojet Shares e
Alljet; 2 para os outros 13. `COTA_PADRAO` no código é 2, de propósito — hangar
novo sem a chave cai na cota menor, não na maior.

**Prazo de validação:** 20 dias para todos (`diasValidacaoPadrao`). Decisão do
usuário. A vaga do pátio é liberada quando o veículo sai, não quando o ticket
expira, então prazo longo não prende vaga. 20 é exatamente o teto do slider
(`SLIDER_MAX_DIAS`), sem folga — se a One Park reduzir esse limite, todas as
validações quebram de uma vez.

**Foto com o veículo:** só `aibm` e `aibm-2` (`exigeFotoVeiculoNoLocal: true`).
Nesses dois o cliente fotografa o ticket na mão com o carro estacionado ao fundo,
e a mesma foto serve para ticket, placa e conferência de local. Nos outros 14 vem
só o ticket.

Pendências de configuração:
- Os 16 `grupoWhatsappId` e os 16 `grupoAdministracao` estão **vazios**. Sem eles
  `identificar-hangar.js` não roteia nada. Só dá para preencher depois de parear
  a Evolution API, que é quem lista os grupos.
- `AIBM_USUARIO` / `AIBM_SENHA`: login `BOT_AIBM` criado, falta pôr no `.env`.
- ~~`AIBM_2_USUARIO` / `AIBM_2_SENHA`: indefinido se o AIBM 2 tem acesso
  próprio~~ — **RESOLVIDO em 16/09/2026**: são pátios SEPARADOS, confirmado pelo
  usuário e por medição. `BOT_AIBM2` autentica e mostra "AIBM 2 | Total de vagas:
  41". Grupo cadastrado, hangar no ar.
- ~~`AIBM_SENHA` está errada~~ — **corrigida em 16/09/2026** e testada contra o
  site real: `BOT_AIBM` autentica e o pátio responde "AIBM | Total de vagas: 12".
  Falta só o grupo do WhatsApp para este hangar entrar no ar.
- `placaGenerica` de `aibm` e `aibm-2` está vazia. No Solojet é `AAA0000`. Se a
  leitura da placa falhar no AIBM, o script fica sem valor para mandar.

---

## Descoberta importante: o ticket carrega a própria data

```
01 | 1109 | 085843
     dia/mês  hh:mm:ss   ->  11/09 08:58:43
```

Prefixo de 2 dígitos, dia, mês, hora, minuto, segundo. Confirmado em 12 tickets
reais (4 fotos novas + todos os documentados no repo).

Isso virou a verificação de integridade do OCR (`conferirTicketComData` em
`ocr-ticket.js`): o número e a data impressa são lidos de partes **diferentes**
do papel, então eles concordarem prova que nenhum dos dois foi lido errado. Vale
mais que o campo `confianca`, que é o modelo se autoavaliando. Um dígito trocado
validaria o ticket de outra pessoa.

Limite conhecido: o **ano** não está no número. Ano lido errado não é pego — mas
falha do lado seguro, porque joga a emissão para fora da janela de 2h.

Achado secundário: os dois tickets com prefixo `03` conhecidos (`030809194400`,
`030809210500`) terminam em segundo `:00` redondo, e foram justamente os que a
API do ValidPark ignorou silenciosamente na escrita. Ticket de totem real nunca
cai em segundo redondo. Hipótese: prefixo `03` = ticket emulado, e o backend
recusa escrita neles. **Não vale testar de novo** — custaria queimar o ticket de
um cliente real, e o caminho pelo Playwright já funciona.

---

## O que já foi testado de verdade

- OCR lendo 4 fotos reais (amassado, contraluz, mão com luva, foto de longe com
  o carro). Acertou os 4, dígito por dígito.
- Conferência cruzada: passa nos 5 tickets com data impressa conhecida; bloqueia
  1 segundo trocado, dia trocado, data ilegível e mês impossível.
- Normalização de placa: `FJ09C04` vira `FJO9C04` pela posição; `BRU0503` e
  `AAA0000` passam intactas.
- Trava da cota: 20 processos simultâneos gravam 20. A versão antiga, na mesma
  disputa, gravou 6 e corrompeu o JSON em 14 processos.
- Chamada real à API da Anthropic a partir do servidor: funcionou.
- Validação de ticket real pelo Playwright no ValidPark (feito antes).

## O que NUNCA foi testado

- OCR com ticket real **no servidor** (só rodou contra uma imagem branca 8x8).
- Conferência de local com foto de close — as fotos de referência são
  panorâmicas, e a do cliente vai ser close.
- Validação com o prazo de 20 dias.
- Qualquer coisa envolvendo WhatsApp.
- Faturamento via Asaas (está em sandbox por padrão).

---

## Decisões em aberto (travam produção)

1. **Quantas horas/dias o bot adiciona** — resolvido: 20 dias. Mas nunca
   validado contra o site.
2. **Placa no Solojet** — a foto traz só o ticket, e o ValidPark exige placa.
   Ou o bot pergunta (exige máquina de estados), ou usa `AAA0000` sempre (registra
   placa errada no sistema de todo cliente; já aconteceu uma vez com ticket real).
3. **Máquina de estados de conversa** — não existe. Cada execução do n8n é
   isolada. Num grupo com várias pessoas e vários tickets pendentes, uma resposta
   solta ("3", uma placa, "pode cobrar") não tem a quem ser atribuída. Isso agora
   carrega **autorização de cobrança** junto, o que é irreversível.
4. **Faturamento automático** — recomendação forte: manter humano no passo de
   emitir. O script calcula tudo e para; uma pessoa emite o boleto no Asaas.
   Validar errado custa desculpa; cobrar errado custa dinheiro e confiança.

---

## Conferência de local (AIBM 1 e 2)

`scripts/lib/conferir-local.js`. As descrições de referência ficam no
`config/hangares.json` em `localReferencia`, em português, editáveis sem código.

Os dois locais são visualmente bem distintos:
- **AIBM 1**: concreto liso sem demarcação, cobertura encostada no prédio, parede
  de bloco branco atrás dos carros, ar-condicionados na fachada, telhado curvo azul.
- **AIBM 2**: asfalto com vagas em faixa amarela, cobertura isolada em campo
  aberto sem parede, cerca viva, gramado em declive, morros ao fundo.

Três vereditos: `compativel`, `incompativel`, `indeterminado`. **Só
`compativel` valida** (desde 16/09/2026). `incompativel` bloqueia e notifica o
admin — é sinal de fraude. `indeterminado` não valida, mas não aciona ninguém:
é enquadramento ruim, e o cliente reenvia só a foto do carro, sem repetir o
ticket.

O prompt continua instruindo a responder `indeterminado` quando não há
evidência, em vez de forçar um veredito — dizer `incompativel` sem base
acusaria de fraude um cliente honesto. O que mudou foi a consequência: antes
`indeterminado` passava, e isso esvaziava o controle.

Havia uma aeronave `PT-07` visível na foto do AIBM 2 — não foi usada como sinal
porque, se ela voar, vira falso negativo.

---

## Caminho recomendado até produção

A recomendação repetida ao longo do projeto, e que segue valendo:

**Ligar primeiro só a CONSULTA no Solojet.** Cliente manda a foto, o bot lê e
responde se o ticket já foi validado e se está ativo. Não valida nada.

Por quê: não precisa de placa, não precisa de máquina de estados, não mexe em
cota nem em cobrança, não ocupa vaga, e é uma ida e volta só. O Solojet é o único
hangar com credencial, seletores e scripts já testados contra o site real.

Começar pelo AIBM é o caminho mais difícil: é o hangar que exige foto com o carro,
leitura de placa e conferência de local, e é o que tem menos coisa testada.

Depois que a consulta rodar alguns dias em paralelo com o processo manual — e se
provar que o OCR aguenta foto de cliente de verdade, que o servidor segura e que
a sessão do WhatsApp não cai — aí entra a validação.

---

## Sequência técnica pendente

1. ~~Aplicar o patch, commitar, push, pull no servidor.~~ **Feito em 15/09/2026**
   (commit `0c169fe`). O servidor não era um repositório git — foi convertido em
   clone de verdade, então agora `git pull` funciona mesmo.
2. ~~Subir o EC2 para 2 GB.~~ **Feito em 15/09/2026**, com Elastic IP junto.
3. Chip dedicado num celular guardado, no CNPJ. Não pode ser chip que viva em
   outro aparelho: a conta principal precisa existir num celular, e o WhatsApp
   derruba dispositivos vinculados se o celular passar ~14 dias sem conectar.
4. Instalar Evolution API, parear, apontar webhook para o n8n.
5. Listar os grupos e preencher `grupoWhatsappId` e `grupoAdministracao`.
6. Encaixar o nó de OCR no workflow, incluindo um passo que grave a foto do
   webhook (base64) em arquivo temporário — `ocr-ticket.js` recebe **caminho**,
   não base64. Alternativa melhor: adaptar o script para aceitar base64 via
   stdin, evitando gravar foto de cliente no disco.
7. Trocar os dois nós placeholder (`respondToWebhook` e `noOp`) por nós de envio
   da Evolution API.
8. Fazer o bot ignorar as próprias mensagens (senão responde a si mesmo em loop).

---

## Segurança — pendências

- Uma chave de API da Anthropic foi colada em chat três vezes e ficou também no
  `~/.bash_history` do servidor. O usuário optou por **não revogar**, e configurou
  limite de gasto e sem recarga automática. Limite protege o valor, não o acesso.
  Recomendado ainda: revogar e gerar outra, e limpar o histórico
  (`history -c && rm -f ~/.bash_history`).
- A senha do `BOT_AIBM` também passou por chat. Trocar quando possível.
- `config/hangares.json` é versionado e o repositório é **público**. Ele guarda
  só o *nome* das variáveis de ambiente, nunca valores — manter assim.
- Confirmar sempre que `.env` não aparece em `git status`.

---

## Reuso de foto — o que está fechado e o que não está

O fluxo de dois passos (ticket primeiro, foto do carro depois) melhorou a ordem
mas cortou o vínculo entre a foto e o ticket: a foto do carro não tem nada que a
ligue àquele número. Guardar uma foto e reenviá-la passava na conferência de
local — porque o local está certo mesmo. Apareceu no AIBM 2, com fotos repetidas
validadas (16/09/2026).

**Fechado:** a validação exige um PAR — a foto do ticket que abriu o pedido e a
foto do veículo que o fechou. `lib/fotos-usadas.js` guarda o SHA-256 das duas,
gastas juntas e apontando para o mesmo registro, e recusa o reenvio de qualquer
uma delas em qualquer hangar por 90 dias. Foto fora do par não é usada: o OCR
responde `temTicket`, e uma foto sem ticket ouve que o ticket vem primeiro, em
vez do antigo "reenvie mais de perto" que convidava a repetir o erro.

**Aberto:** foto NOVA do mesmo carro, no mesmo lugar, tirada de novo. Bytes
diferentes, hash diferente, local correto: passa. Nenhum controle atual pega.

Para fechar é preciso exigir algo imprevisível na foto, e o caminho natural é
**o próprio ticket visível junto do carro** — era assim antes do fluxo de dois
passos, e o número do ticket amarra a foto àquela validação específica. Custa
pedir ao cliente que leve o ticket até o veículo. É decisão de fluxo, do
usuário, não de código.

Vale lembrar que a conferência de local funciona: medido com a foto real que
validou o AIBM 1, deu `compativel` no AIBM 1 e `incompativel` no AIBM 2. O
problema nunca foi distinguir os pátios.

## Armadilhas já encontradas (não repetir)

- **O n8n congela o `.env` na memória dele** (16/09/2026 — custou uma tarde). O
  n8n embute o próprio dotenv e roda com o diretório do projeto como working
  directory, então carrega o `.env` ao subir e todo script que dispara herda
  esse ambiente. Sem `override: true`, o dotenv do script respeita o que já está
  definido e o arquivo em disco é ignorado — o valor congelado no start vence
  para sempre. A senha do AIBM 1 foi corrigida às 15:51 com o n8n no ar desde as
  13:02, e a partir daí toda validação daquele hangar falhava com "usuário ou
  senha incorretos" enquanto o mesmo comando no terminal entrava, porque o
  terminal não herda nada do n8n. **Depois de editar o `.env`, reinicie o n8n** —
  e os cinco pontos que carregam o arquivo usam `override: true` desde então.
- **A mensagem de erro do ValidPark aparece mesmo em login BEM-SUCEDIDO**
  (16/09/2026). "*Usúario ou senha incorretos" surge no instante do clique,
  continua aos 300ms e some por volta de 1,5s, quando a API responde 200. É
  artefato de renderização do React. Casar por ela sem esperar derruba TODOS os
  logins — aconteceu por quatro minutos em produção. Só conta se persistir 2,5s.
  Note ainda a grafia: o site escreve **Usúario**, com o acento no U; uma regex
  com "usuário" nunca casa, e foi assim que recusas reais passaram meses sendo
  reportadas como "não consegui confirmar o login".
- **Variável `const` usada acima da declaração** (zona morta temporal): só
  explode no ramo que a usa, então passa nos testes que não percorrem aquele
  caminho. Derrubou o AIBM 1 em silêncio — o cliente mandava o ticket e o grupo
  não respondia nada, porque o tratamento de erro também não respondia.
- **Teste que chama `processar()` escreve em PRODUÇÃO**: grava no histórico e
  deixa pendências vivas. Uma pendência de teste faz a próxima foto de um cliente
  real ser lida como resposta a um ticket que ninguém mandou. `registro` e
  `pendencias` têm que ser substituídos no teste.

- **`process.exit(1)` depois de imprimir JSON**: o nó Execute Command do n8n trata
  código != 0 como falha e engole a saída, então a mensagem amigável nunca chega
  ao cliente. Todos os scripts agora saem com 0 e quem decide é o campo `status`.
- **`ocr-ticket.js` não carregava `dotenv`**: os outros scripts leem o `.env`
  indiretamente via `lib/hangar.js`, mas esse não usa `hangar.js` (não recebe
  hangarId). Resultado: "ANTHROPIC_API_KEY não configurada" mesmo com a chave
  certa no arquivo.
- **`paraIso` aceitava data inexistente**: `31/02/26` virava `2026-02-31` e o
  `Date` rolava silenciosamente para 3 de março. Data plausível e errada.
- **Cota sem trava**: leitura e escrita concorrentes perdiam incrementos e
  corrompiam o JSON. Resolvido com trava exclusiva (`openSync` com flag `wx`) e
  gravação atômica (tmp + rename).
- **Cota debitada antes do navegador abrir**: se a validação falhasse depois
  (pátio cheio, ticket já usado, tolerância obrigatória), a cota era perdida sem
  validar nada. Resolvido com `devolverUmaValidacao` chamado em todo retorno que
  não seja `validado`.
- **Normalização de placa forçando Mercosul**: transformava `BRU0503` em
  `BRU0S03` e, pior, a placa genérica `AAA0000` em `AAA0O00`. Agora placa que já
  é válida passa intacta.
