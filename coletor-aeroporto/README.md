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
  ticket, criar credenciado). O coletor só chama rotas GET de pátio (a lista
  geral e a de cada pátio, porque a geral corta em 100 tickets).
- **Só os campos que a fiscalização usa saem do aeroporto** (ver `CAMPOS` no
  script). Qualquer campo que comece com `PLACA` também passa, para o LPR da
  cancela entrar sem mudar o coletor.
- **Tudo ou nada:** se qualquer leitura falhar, o coletor não envia. Um
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

**Como está instalado (conferido em 29/09/2026):**

| | |
|---|---|
| Pasta | `C:\Sia\coletor-aeroporto` (`coletor.py`, `coletor.ini`, `ca-validador.pem`) |
| Serviço do Windows | `coletor-aeroporto` |
| Python | `C:\Users\user\AppData\Local\Programs\Python\Python311\python.exe` |

O coletor só usa a biblioteca padrão, então qualquer Python 3 serve.

**Para atualizar o `coletor.py`:**

1. Copie o arquivo novo do Mac para a máquina do aeroporto pelo AnyDesk.
   Cai em `C:\Users\user\Downloads`.
2. Num **Prompt de Comando como administrador**:

   ```
   copy /Y "C:\Users\user\Downloads\coletor.py" C:\Sia\coletor-aeroporto\coletor.py
   net stop coletor-aeroporto && net start coletor-aeroporto
   ```

   Sem reiniciar, o serviço continua rodando a versão antiga que está na
   memória.

**Para testar à mão, sem o serviço:**

```
"C:\Users\user\AppData\Local\Programs\Python\Python311\python.exe" C:\Sia\coletor-aeroporto\coletor.py --uma-vez
```

Deve aparecer `enviado: N pátios, N tickets, N credenciados`.

## Conferindo se está rodando

- Na máquina do aeroporto: `C:\Sia\coletor-aeroporto\coletor.log` mostra cada envio.
- No painel: `GET /api/fiscalizacao/estado` mostra há quantos minutos chegou o
  último snapshot. Se passar de `snapshotVelhoMinutos` (em
  `config/fiscalizacao.json`), a câmera avisa que os dados estão velhos.
