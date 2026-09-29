# Coletor do aeroporto

Leva a situação dos pátios do TECHPARKING para o servidor do validador, a cada
minuto, para a fiscalização de rua (câmera no celular) saber de qual pátio é
cada placa e se o pátio está dentro da lotação.

```
TECHPARKING (172.16.10.252:7002, rede do aeroporto)
      │  GET patio, patio-avulso, patio-credenciado   (só leitura)
      ▼
coletor.py  (Servidor SBJD, a máquina do aeroporto)
      │  POST https://validador.1park.com.br/api/techparking/snapshot
      ▼
painel/servidor.js  →  data/techparking-snapshot.json  →  /api/fiscalizacao/placa
```

Por que desse jeito:
- **A máquina do aeroporto não é acessível de fora**, e o celular do fiscal
  usa 4G. O único caminho que não exige abrir porta na rede do aeroporto é a
  máquina de lá enviar para fora.
- **Só leitura no TECHPARKING.** A API dele aceita escrita sem login (validar
  ticket, criar credenciado). O coletor chama três rotas GET e nenhuma outra.
- **Só os campos que a fiscalização usa saem do aeroporto** (ver `CAMPOS` no
  script). Qualquer campo que comece com `PLACA` também passa, para o LPR da
  cancela entrar sem mudar o coletor.
- **Tudo ou nada:** se uma das três rotas falhar, o coletor não envia. Um
  snapshot sem os credenciados faria o pátio parecer mais vazio do que está.

## Instalação

### 1. No servidor do validador (EC2)

Gere o token e coloque no `.env`:

```bash
openssl rand -hex 32
```

```
TECHPARKING_COLETOR_TOKEN=<o valor gerado>
```

Depois reinicie o painel: o `.env` só é lido quando o processo sobe.

```bash
sudo systemctl restart painel-validador
```

### 2. Na máquina do aeroporto (pelo AnyDesk)

1. Crie a pasta `C:\1park\coletor` e copie para ela o `coletor.py` e o
   `coletor.ini.exemplo` (pela transferência de arquivos do AnyDesk).
2. Renomeie `coletor.ini.exemplo` para `coletor.ini` e cole o token em
   `[destino] token =`.
3. Teste uma vez, no Prompt de Comando:

   ```
   "C:\Sia\TECHPARKING\techparking_backend\venv\Scripts\python.exe" C:\1park\coletor\coletor.py --uma-vez
   ```

   Deve aparecer `enviado: N pátios, N tickets, N credenciados`.

   O Python usado é o do próprio TECHPARKING: o coletor só usa a biblioteca
   padrão, então não precisa instalar nada. Se a Technext um dia trocar esse
   Python, basta instalar um do python.org e apontar o serviço para ele.

4. Instale como serviço, num **Prompt de Comando como administrador**. O NSSM
   já existe na máquina (é ele que roda o TECHPARKING), mas está na pasta
   Downloads, então copie antes para um lugar fixo:

   ```
   mkdir C:\1park\nssm
   copy "C:\Users\user\Downloads\nssm-2.24 (2)\nssm-2.24\win64\nssm.exe" C:\1park\nssm\
   C:\1park\nssm\nssm.exe install coletor-fiscalizacao "C:\Sia\TECHPARKING\techparking_backend\venv\Scripts\python.exe" C:\1park\coletor\coletor.py
   C:\1park\nssm\nssm.exe set coletor-fiscalizacao AppDirectory C:\1park\coletor
   C:\1park\nssm\nssm.exe start coletor-fiscalizacao
   ```

   O serviço sobe sozinho quando a máquina reinicia.

## Conferindo se está rodando

- Na máquina do aeroporto: `C:\1park\coletor\coletor.log` mostra cada envio.
- No painel: `GET /api/fiscalizacao/estado` mostra há quantos minutos chegou o
  último snapshot. Se passar de `snapshotVelhoMinutos` (em
  `config/fiscalizacao.json`), a câmera avisa que os dados estão velhos.
