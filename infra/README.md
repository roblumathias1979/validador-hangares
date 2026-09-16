# Infraestrutura do servidor

Cópias de referência dos arquivos que fazem o sistema rodar no EC2
(`3.136.166.82`, Elastic IP, t3.small, Ubuntu 26.04).

**Estes arquivos NÃO são aplicados automaticamente.** O que vale em produção é o
que está no servidor; aqui é a cópia versionada, para que a configuração não
viva só numa máquina. Ao alterar um deles no servidor, atualize aqui também.

Por que isso existe: em 09/09/2026 o `config/hangares.json` estava fora do git e
divergiu em silêncio — produção rodou semanas com seletores de slider quebrados.
Arquivo de infraestrutura fora de controle de versão é a mesma armadilha:
ninguém sabe que existe até quebrar, e não há como saber o que mudou.

Nenhum dos dois contém segredo. Senhas e chaves ficam em arquivos `.env` no
servidor, referenciados por nome (`${POSTGRES_PASSWORD}`) ou lidos pelos
scripts — esses `.env` continuam fora do git, e devem continuar.

---

## `n8n.service`

Unidade systemd do n8n. Fica em `/etc/systemd/system/n8n.service`.

Pontos que não são óbvios e já causaram problema:

- **`NODES_EXCLUDE=[]`** — sem isso o nó "Execute Command" nem é reconhecido
  ("Unrecognized node type"), e é justamente o nó que chama os scripts.
- **`N8N_SECURE_COOKIE=false`** — necessário porque o acesso é por HTTP puro,
  sem domínio nem certificado.
- **`EXECUTIONS_DATA_*`** (16/09/2026) — expurga o histórico de execuções depois
  de 7 dias (`MAX_AGE` é em HORAS: 168). O motivo é privacidade, não espaço:
  cada execução guarda o payload do WhatsApp, com nome e telefone de cliente. O
  banco tinha 6 MB com 57 execuções, então disco nunca foi o problema.

Para aplicar uma mudança:

```bash
sudo cp n8n.service /etc/systemd/system/n8n.service
sudo systemctl daemon-reload
sudo systemctl restart n8n
```

⚠️ O n8n roda fixado na versão **1.123.77**. A linha 2.x tem um bug real de
ativação de webhook (o banco confirma o registro, o log diz "Activated
workflow", e a rota nunca fica acessível). Não atualizar sem testar.

---

## `evolution-docker-compose.yaml`

Stack da Evolution API (WhatsApp), em `/home/ubuntu/evolution/`. Sobe a API, um
PostgreSQL e um Redis.

- **A API escuta só em `127.0.0.1:8080`.** O n8n roda na mesma máquina e fala
  com ela por localhost, então nada precisa ser aberto no security group —
  importante, porque o webhook do n8n não tem autenticação (ver
  `docs/perguntas-abertas.md`).
- **`max_connections=50` no Postgres** — o compose oficial usa 1000, que reserva
  memória compartilhada demais para uma máquina de 2 GB.

O `.env` que acompanha (chave da API e senha do Postgres) foi gerado no próprio
servidor com `openssl rand` e nunca saiu de lá.

```bash
cd /home/ubuntu/evolution
sudo docker compose up -d
sudo docker compose ps
```
