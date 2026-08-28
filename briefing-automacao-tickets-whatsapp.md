# Briefing técnico — Automação de validação de tickets via WhatsApp

## 1. Contexto e objetivo

Hoje, clientes de cada hangar enviam fotos de tickets em grupos específicos do WhatsApp. Um responsável precisa:
1. Ver a mensagem no grupo do hangar correspondente
2. Acessar manualmente o site validador daquele hangar (login com usuário/senha próprios)
3. Digitar o número do ticket
4. Validar
5. Responder no grupo confirmando

**Objetivo:** automatizar esse fluxo de ponta a ponta, mantendo a lógica de "cada hangar tem seu grupo e seu login".

## 2. Escopo do fluxo automatizado

```
Foto do ticket chega no grupo do WhatsApp
        ↓
Bot identifica de qual grupo/hangar veio a mensagem
        ↓
Bot extrai o número do ticket da foto (OCR)
        ↓
Robô abre o navegador e loga no validador daquele hangar específico
        ↓
Robô digita o número do ticket e valida
        ↓
Bot lê o resultado da validação
        ↓
Bot responde no mesmo grupo confirmando o status
```

## 3. Requisitos funcionais

### 3.1 Identificação do hangar por grupo
O sistema deve manter uma tabela de configuração (editável sem precisar mexer no código) relacionando:

| Grupo do WhatsApp | Hangar | URL do validador | Usuário de login |
|---|---|---|---|
| Grupo Solojet | Solojet | (definir) | (definir) |
| Grupo [hangar 2] | [hangar 2] | (definir) | (definir) |
| Grupo [hangar 3] | [hangar 3] | (definir) | (definir) |

> **Preencher esta tabela com todos os hangares antes de iniciar o desenvolvimento.**

### 3.2 Leitura de mensagens do WhatsApp
- Conectar a um número de WhatsApp (recomenda-se um número **secundário/dedicado** para testes iniciais, migrando para o definitivo só após validação).
- Monitorar apenas os grupos cadastrados na tabela acima (ignorar outros grupos/conversas).
- Identificar mensagens que contenham uma imagem (o ticket é enviado como foto).

### 3.3 Extração do número do ticket (OCR)
- A imagem recebida deve passar por reconhecimento de texto (OCR) para extrair o número do ticket.
- Validar que o texto extraído corresponde ao formato esperado de um número de ticket (definir o padrão — ex: apenas números, quantidade de dígitos, prefixo, etc.).
- Se o OCR falhar ou o número não for reconhecido com confiança, o bot deve responder no grupo pedindo reenvio ou confirmação manual — **nunca deve seguir adiante com um número incerto**.

### 3.4 Automação do navegador (RPA)
- Para cada hangar, abrir o site validador correspondente (via Playwright ou ferramenta equivalente).
- Realizar login com as credenciais daquele hangar específico.
- Inserir o número do ticket extraído.
- Executar a validação.
- Capturar o resultado exibido na tela (validado, inválido, erro, ticket já usado, etc.).

### 3.5 Resposta ao grupo
- Enviar mensagem de volta ao mesmo grupo de origem, informando o resultado (ex: "✅ Ticket 12345 validado com sucesso" ou "⚠️ Ticket 12345 não encontrado — verifique o número").

### 3.6 Tratamento de erros
O que fazer em cada cenário de falha precisa estar definido antes do desenvolvimento:
- OCR não conseguiu ler a foto
- Login no validador falhou (senha expirada, site fora do ar)
- Ticket não encontrado ou já validado anteriormente
- Timeout do site validador

Em todos os casos, o bot deve **avisar no grupo** e, idealmente, notificar um responsável interno (ex: mensagem também para um grupo de administração).

## 4. Requisitos não funcionais

### 4.1 Segurança
- Credenciais de login de cada hangar **não podem** ficar em texto simples dentro do código ou da planilha de configuração.
- Usar armazenamento seguro (variáveis de ambiente, cofre de credenciais, ou sistema de secrets do próprio n8n, se essa for a ferramenta escolhida).
- Acesso à configuração (tabela de hangares/credenciais) deve ser restrito.

### 4.2 Confiabilidade
- O processo deve rodar 24/7 em um servidor (não em um computador pessoal que pode ser desligado).
- Deve haver reconexão automática caso o WhatsApp desconecte.
- Logs de cada validação realizada (data, hora, hangar, ticket, resultado) para auditoria futura.

### 4.3 Escalabilidade
- Adicionar um novo hangar no futuro deve ser simples: apenas uma nova linha na tabela de configuração (novo grupo, nova URL, novas credenciais) — sem precisar reescrever o fluxo inteiro.

## 5. Stack técnica sugerida

| Componente | Ferramenta sugerida | Observação |
|---|---|---|
| Orquestração do fluxo | n8n (self-hosted) | Interface visual, editável sem programar |
| Leitura/envio no WhatsApp | Baileys (via nó comunitário do n8n) | **Não oficial** — risco de bloqueio pela Meta; usar número dedicado |
| OCR da foto do ticket | Google Cloud Vision, ou API de visão da Anthropic/OpenAI | Comparar precisão com fotos reais dos tickets antes de decidir |
| Automação do navegador | Playwright | Roda via script Node.js chamado pelo n8n, ou nó de execução de código |
| Hospedagem | VPS (ex: DigitalOcean, Hetzner) | Precisa rodar 24/7 |
| Armazenamento de credenciais | Credenciais nativas do n8n | Já vem com criptografia |

## 6. Fases do projeto

1. **Levantamento completo** — lista final de todos os hangares, grupos, URLs de validador e credenciais.
2. **Prova de conceito** — fluxo funcionando para **um único hangar** (ex: Solojet), do recebimento da foto até a resposta no grupo.
3. **Testes em paralelo** — rodar 1–2 semanas junto com o processo manual, comparando resultados.
4. **Expansão** — replicar a configuração para os demais hangares.
5. **Entrega e documentação** — manual de "o que fazer se parar de funcionar" (ex: reconectar o WhatsApp via QR code) e definição de responsável por manutenção.

## 7. Perguntas em aberto (a definir antes de começar)

- [ ] Quantos hangares no total, e quais são os grupos/URLs/credenciais de cada um?
- [ ] Qual o formato exato do número de ticket (dígitos, prefixo, padrão visual na foto)?
- [ ] O que o bot deve responder em cada tipo de resultado (validado, inválido, ticket duplicado, erro)?
- [ ] Quem será o responsável por acompanhar a manutenção após a entrega?
- [ ] Existe um número de WhatsApp dedicado disponível para o bot, ou será necessário providenciar um?

---

*Este documento serve como ponto de partida para orçamento com freelancer/agência, ou como instrução inicial para desenvolvimento assistido (ex: Claude Code).*
