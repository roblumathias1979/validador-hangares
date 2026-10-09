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

---

## Status do sistema: servidor, backup e créditos

O *status do sistema* (grupo de administração) traz, além do que já tinha:

- **Servidor:** memória, swap, disco (em %), carga, tempo ligado e se há
  reinício pendente. Limites com folga: disco vermelho a partir de **85%** ou
  menos de **2 GB** livres; memória vermelha abaixo de **300 MB** disponíveis.
  O monitor (a cada 5 min) usa os mesmos limites e avisa sozinho.
- **Último backup:** a data do último snapshot do disco. Verde até ~30 h,
  amarelo até ~50 h, vermelho depois (a política diária parou).
- **Créditos:** o saldo estimado da Anthropic e o **crédito da AWS**.

### Crédito da AWS

A AWS não deixa o bot ler o saldo sem dar permissão de cobrança à máquina; por
isso a administração informa o que o painel mostra, no grupo:

```
crédito aws 79,52 até 03/03/2027
```

O bot guarda, conta os dias até vencer e, com duas leituras, estima o ritmo de
gasto. O monitor **avisa sozinho** quando o crédito está acabando — saldo de
US$ 10 ou menos, 30 dias ou menos para vencer, ou menos de 30 dias de saldo no
ritmo atual — ao entrar em alerta e depois 1 vez por dia. Sem informação (ou com
mais de 30 dias), lembra a cada 7 dias. *crédito aws* sozinho mostra o que está
anotado. Atualize sempre que olhar o painel (Billing → Credits).

Quando o crédito ou o prazo do plano gratuito acaba, a conta pode ser suspensa e
o servidor sair do ar: a decisão do plano (pago ou não) é do dono da conta, no
painel de cobrança da AWS.

### Ver o último backup no status (opcional, só leitura)

Sem isto a linha mostra "Backup: não consegui consultar", e o resto funciona. Para
ligar, o servidor precisa de uma **permissão de leitura** dos snapshots (nada de
criar nem apagar), dada pela *role* da instância — sem chave guardada no servidor:

1. AWS → **IAM** → *Policies* → *Create policy* → aba **JSON**:
   ```json
   {"Version":"2012-10-17","Statement":[{"Effect":"Allow","Action":"ec2:DescribeSnapshots","Resource":"*"}]}
   ```
   Nome: `validador-le-snapshots`.
2. **IAM** → *Roles* → *Create role* → *AWS service* → **EC2** → anexe a policy
   acima → nome `validador-servidor`.
3. **EC2** → *Instances* → a instância → **Actions** → **Security** →
   **Modify IAM role** → escolha `validador-servidor` → *Update IAM role*.
4. No servidor, instale a CLI e teste:
   ```bash
   sudo snap install aws-cli --classic
   aws ec2 describe-snapshots --owner-ids self --region us-east-2 --query 'length(Snapshots)'
   ```
   Deve imprimir um número (quantos snapshots existem). Se der erro de permissão,
   a role ainda não pegou: espere 1 minuto e repita.

---

## Backup externo cifrado (fora da AWS)

O snapshot do disco mora na MESMA conta da AWS: se a conta for suspensa (o plano
gratuito acaba), ele vai junto. Por isso, todo mês (dia 1, 03:00 em
Brasília) o servidor empacota o que só existe nele — `.env`, `config/`, `data/`,
o workflow do n8n e os arquivos pequenos da Evolution — **cifra** (AES-256) e
manda ao grupo de administração do WhatsApp. Guarda também as 8 últimas cópias
(8 meses) em `~/backups/`. O arquivo é cifrado porque o `.env` tem chaves e senhas e
`data/` tem nome e telefone de cliente.

**Ativar (uma vez), no servidor:**

```bash
cd ~/validador-hangares && git pull
node scripts/backup-externo.js --criar-senha     # mostra a SENHA uma única vez — guarde num gerenciador de senhas
node scripts/backup-externo.js                   # teste: faz o backup e envia ao grupo agora
sudo cp infra/backup-externo.service infra/backup-externo.timer /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now backup-externo.timer
systemctl list-timers backup-externo.timer --no-pager
```

⚠️ **A senha é o que abre os backups.** Ela fica em `~/.backup-passphrase` (só o
usuário `ubuntu` lê), mas se o servidor for perdido, esse arquivo vai junto: a
única cópia útil é a que VOCÊ guardou ao rodar `--criar-senha`. Nunca mande a
senha no mesmo grupo do arquivo. O comando não sobrescreve a senha existente
(trocá-la deixaria os backups antigos ilegíveis).

**Recriar o servidor a partir do backup:**

1. Baixe o último `validador-AAAA-MM-DD.bak` do grupo (ou de `~/backups/`).
2. Numa máquina com `openssl` e `tar`:
   ```bash
   mkdir restaurado && openssl enc -d -aes-256-cbc -pbkdf2 -iter 200000 -in validador-2026-10-09.bak | tar xzf - -C restaurado
   ```
   Ele pede a senha. Sai `.env`, `config/`, `data/`, `n8n-workflows.json` e `evolution/`.
3. Num servidor novo: `git clone` do repositório; copie `.env`, `config/` e `data/`
   para dentro dele; instale as unidades de `infra/`; importe o workflow
   (`n8n import:workflow --input=n8n-workflows.json`); suba a Evolution com os
   arquivos de `evolution/` e **pareie o WhatsApp de novo (QR)**, porque a sessão
   do WhatsApp fica no banco da Evolution, que este backup não inclui.

Acima de 60 MB o WhatsApp recusa o arquivo: o backup fica só no servidor e o
bot avisa. Falha no backup também avisa o grupo.
