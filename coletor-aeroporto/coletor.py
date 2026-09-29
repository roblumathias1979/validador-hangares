"""
coletor.py — leva a situação dos pátios do TECHPARKING para o nosso servidor.

Roda na máquina do aeroporto (Servidor SBJD), que é a única que enxerga a API
do TECHPARKING: ela fica na rede interna (172.16.10.252:7002), e a máquina não
é acessível de fora. Por isso o sentido é este, de dentro para fora: o coletor
LÊ a API local e ENVIA para validador.1park.com.br. Nada precisa ser aberto
na rede do aeroporto.

Só leitura no TECHPARKING: chama três rotas GET e nada mais. A API aceita
escrita sem login (PUT /validador/ticket etc.), e é justamente por isso que
este script não chama nenhuma outra rota.

Só biblioteca padrão, sem pip install: roda com o Python que já está na
máquina (o do próprio TECHPARKING).

Uso:
    python coletor.py            # fica rodando, envia a cada `intervalo` segundos
    python coletor.py --uma-vez  # envia uma vez e mostra o resultado (para testar)
"""

import configparser
import json
import logging
import logging.handlers
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime

PASTA = os.path.dirname(os.path.abspath(__file__))

# Campos que a fiscalização usa. O resto (nomes de operador, terminal etc.)
# não sai do aeroporto. Qualquer campo que comece com PLACA passa, para o LPR
# entrar sem mexer aqui quando for instalado (ex.: PLACA_LPR).
CAMPOS = {
    "patios": ["IDPATIO", "PATIO", "VAGAS"],
    "avulsos": ["CARTAO", "USUARIO", "DATA_ENT", "TOLERANCIA", "PLACA", "PISTA"],
    "credenciados": ["CARTAO", "USUARIO", "DATAHORA", "PLACA", "GRUPO", "BOLSAO", "PISTA"],
}
ROTAS = {
    "patios": "/api/v1/patio",
    "avulsos": "/api/v1/patio-avulso",
    "credenciados": "/api/v1/patio-credenciado",
}


def configurar_log():
    log = logging.getLogger("coletor")
    log.setLevel(logging.INFO)
    # Rotativo: a máquina fica ligada 24h, e um log que só cresce acaba
    # enchendo o disco em silêncio.
    arquivo = logging.handlers.RotatingFileHandler(
        os.path.join(PASTA, "coletor.log"), maxBytes=1_000_000, backupCount=3, encoding="utf-8"
    )
    arquivo.setFormatter(logging.Formatter("%(asctime)s %(levelname)s %(message)s"))
    log.addHandler(arquivo)
    log.addHandler(logging.StreamHandler(sys.stdout))
    return log


def ler_config():
    caminho = os.path.join(PASTA, "coletor.ini")
    if not os.path.exists(caminho):
        sys.exit(f"Falta {caminho}. Copie coletor.ini.exemplo para coletor.ini e preencha o token.")
    c = configparser.ConfigParser()
    c.read(caminho, encoding="utf-8")
    token = c.get("destino", "token", fallback="").strip()
    if not token:
        sys.exit("coletor.ini sem token em [destino].")
    return {
        "techparking": c.get("techparking", "url", fallback="http://172.16.10.252:7002").rstrip("/"),
        "destino": c.get("destino", "url", fallback="https://validador.1park.com.br/api/techparking/snapshot"),
        "token": token,
        "intervalo": c.getint("coletor", "intervalo", fallback=60),
    }


def filtrar(lista, campos):
    saida = []
    for item in lista if isinstance(lista, list) else []:
        if not isinstance(item, dict):
            continue
        saida.append({k: v for k, v in item.items() if k in campos or k.startswith("PLACA")})
    return saida


def ler_techparking(base):
    dados = {}
    for nome, rota in ROTAS.items():
        with urllib.request.urlopen(base + rota, timeout=30) as r:
            dados[nome] = filtrar(json.loads(r.read().decode("utf-8")), CAMPOS[nome])
    return dados


def enviar(cfg, dados):
    corpo = json.dumps({"coletadoEm": datetime.now().astimezone().isoformat(), **dados}).encode("utf-8")
    pedido = urllib.request.Request(
        cfg["destino"],
        data=corpo,
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + cfg["token"]},
    )
    with urllib.request.urlopen(pedido, timeout=30) as r:
        return json.loads(r.read().decode("utf-8"))


def ciclo(cfg, log):
    # Tudo ou nada: se uma das três rotas falhar, não envia. Um snapshot só com
    # os tickets e sem os credenciados faria o pátio parecer mais vazio do que
    # está, e a câmera daria "regular" para quem excedeu.
    try:
        dados = ler_techparking(cfg["techparking"])
    except Exception as e:
        log.error("TECHPARKING não respondeu: %s", e)
        return False
    try:
        r = enviar(cfg, dados)
        log.info("enviado: %s pátios, %s tickets, %s credenciados", r.get("patios"), r.get("avulsos"), r.get("credenciados"))
        return True
    except urllib.error.HTTPError as e:
        log.error("servidor recusou (%s): %s", e.code, e.read().decode("utf-8", "replace")[:300])
    except Exception as e:
        log.error("não consegui enviar: %s", e)
    return False


def main():
    log = configurar_log()
    cfg = ler_config()
    if "--uma-vez" in sys.argv:
        sys.exit(0 if ciclo(cfg, log) else 1)
    log.info("coletor iniciado, a cada %ss", cfg["intervalo"])
    while True:
        inicio = time.monotonic()
        ciclo(cfg, log)
        time.sleep(max(5, cfg["intervalo"] - (time.monotonic() - inicio)))


if __name__ == "__main__":
    main()
