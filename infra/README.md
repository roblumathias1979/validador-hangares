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

---

## Comando "reiniciar sistema" (WhatsApp da administração)

O grupo de administração manda *reiniciar sistema* e o bot pergunta: *1* só os
serviços (n8n, painel, Evolution) ou *2* o servidor inteiro (esta pede SIM).
O bot não reinicia nada sozinho: ele só dispara uma unidade systemd, que espera
8 s (para a resposta sair antes) e roda fora do processo do n8n.

**Instalar no servidor (uma vez):**

```bash
cd ~/validador-hangares/infra
sudo cp reiniciar-servicos.service reiniciar-servidor.service avisar-religado.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable avisar-religado.service

# Libera SÓ estes dois comandos exatos para o usuário do bot:
sudo visudo -f /etc/sudoers.d/validador-reiniciar
```

Conteúdo do `/etc/sudoers.d/validador-reiniciar` (uma linha só):

```
ubuntu ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block reiniciar-servicos.service, /usr/bin/systemctl start --no-block reiniciar-servidor.service
```

Antes de depender disto, confira o caminho do compose da Evolution em
`reiniciar-servicos.service` (`/home/ubuntu/evolution`) e teste a opção 1 num
horário calmo. O aviso "voltei" só sai quando o reinício foi pedido pelo
comando (`data/reinicio-pedido.json`); reinício que ninguém pediu fica com o
`monitor-saude`.

---

## Comando "atualizar servidor" (WhatsApp da administração)

O grupo de administração manda *atualizar servidor* e o bot pergunta: *1*
**procurar** (só mostra o que há para atualizar — pacotes, quantos são de
segurança, quais mexem em Docker/Node/Caddy, quais o Ubuntu está liberando aos
poucos) ou *2* **instalar** (pede SIM e roda o `apt upgrade`). Depois da
instalação o bot avisa o resultado e sugere *reiniciar sistema* quando vale.

A instalação roda na unidade `atualizar-servidor.service`, fora do processo do
n8n (o Docker e o n8n reiniciam no meio do upgrade). É não interativa: mantém
sempre a configuração atual dos arquivos e não força pacote em liberação gradual.

**Instalar no servidor (uma vez):**

```bash
cd ~/validador-hangares/infra
sudo cp atualizar-servidor.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo visudo -f /etc/sudoers.d/validador-reiniciar
```

No arquivo, a linha **inteira** passa a ter os TRÊS comandos (uma linha só):

```
ubuntu ALL=(root) NOPASSWD: /usr/bin/systemctl start --no-block reiniciar-servicos.service, /usr/bin/systemctl start --no-block reiniciar-servidor.service, /usr/bin/systemctl start --no-block atualizar-servidor.service
```

Em *procurar* o bot só lê (`apt list`, `apt-get -s`): não precisa de sudo.

## Backup: snapshot automático do disco (AWS Data Lifecycle Manager)

Antes de atualizar, o que protege de verdade é ter um snapshot recente. Isto é
feito no console da AWS, não no bot (que não tem, nem deve ter, permissão de
AWS). Uma vez configurado, tira um snapshot por dia sozinho:

1. EC2 → **Volumes** → marque o volume → **Tags** → **Manage tags** → adicione
   `Backup` = `diario`.
2. EC2 → **Lifecycle Manager** → **Create lifecycle policy** → *EBS snapshot policy*.
3. *Target resources*: **Volumes**, tag `Backup` = `diario`. Role: *Default role*.
4. Agenda: a cada **24 horas**, em horário calmo (ex.: 06:00 UTC = 03:00 em
   Brasília). Retenção: **7** snapshots.
5. *Create policy*. O primeiro snapshot sai no próximo horário da agenda.

Custo: centavos por mês (o snapshot guarda só o que mudou).
Restaurar: EC2 → Snapshots → o snapshot → *Create volume*, e trocar o volume da
instância (instância parada). Guarde esse passo a passo antes de precisar dele.

## Aviso mensal de atualização pendente

No dia 1 de cada mês, 09:00 em Brasília, o servidor confere se há atualização
para instalar (ou reinício pendente) e avisa os grupos de administração. Sem
pendência, não manda nada. Quem instala continua sendo o comando *atualizar
servidor*. `Persistent=true`: se o servidor estava desligado no horário, avisa
assim que ligar.

```bash
cd ~/validador-hangares/infra
sudo cp avisar-atualizacoes.service avisar-atualizacoes.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now avisar-atualizacoes.timer
systemctl list-timers avisar-atualizacoes.timer --no-pager   # mostra a próxima execução
```

Para testar na hora (só manda mensagem se houver pendência):
`sudo systemctl start avisar-atualizacoes.service` e `journalctl -u avisar-atualizacoes -n 5 --no-pager`.

## Limpeza de cache do disco (manual, de tempos em tempos)

A instalação pelo bot já roda `apt-get clean` no fim. O que sobra para limpar à mão:

```bash
sudo npm cache clean --force            # cache do npm do root (~1,3 GB); baixa de novo se precisar
sudo journalctl --vacuum-size=100M      # logs antigos do sistema (o n8n em nível debug enche isto)
sudo apt-get clean                      # pacotes baixados (~300 MB)
df -h /                                 # confere o espaço
```

NÃO apague `~/.cache/ms-playwright` (o Chromium do Playwright mora ali) nem
`~/validador-hangares/n8n/data` (o banco do n8n, com o workflow).
