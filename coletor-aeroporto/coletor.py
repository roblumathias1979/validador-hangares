"""
coletor.py — leva a situação dos pátios do TECHPARKING para o nosso servidor.

Roda na máquina do aeroporto (Servidor SBJD), que é a única que enxerga a API
do TECHPARKING: ela fica na rede interna (172.16.10.252:7002), e a máquina não
é acessível de fora. Por isso o sentido é este, de dentro para fora: o coletor
LÊ a API local e ENVIA para validador.1park.com.br. Nada precisa ser aberto
na rede do aeroporto.

Só leitura no TECHPARKING: chama apenas rotas GET de pátio. A API aceita
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
import ssl
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
        # Arquivo de raízes para validar o HTTPS do destino. Padrão: o
        # ca-validador.pem que vem junto do coletor. Deixe em branco no .ini
        # para usar as raízes da máquina.
        "ca": resolver_ca(c.get("destino", "ca_bundle", fallback="ca-validador.pem").strip()),
    }


def resolver_ca(valor):
    """Caminho do arquivo de raízes, ou None para usar as da máquina.

    A máquina do aeroporto tem o repositório de certificados desatualizado, e
    o Python de lá recusa o nosso servidor com CERTIFICATE_VERIFY_FAILED /
    "certificate has expired" — apesar de o certificado do site estar válido
    (visto em 29/09/2026). O que venceu é uma raiz antiga que aquela máquina
    ainda considera necessária.

    Por isso o padrão é o arquivo que acompanha o coletor. Não desligamos a
    verificação: um coletor que aceita qualquer certificado manda o pátio
    inteiro para quem estiver no meio do caminho.
    """
    if not valor:
        return None
    caminho = valor if os.path.isabs(valor) else os.path.join(PASTA, valor)
    if not os.path.exists(caminho):
        sys.exit(f"Falta o arquivo de certificados {caminho}. Baixe-o junto com o coletor, "
                 "ou deixe ca_bundle em branco no coletor.ini para usar os da máquina.")
    return caminho


def filtrar(lista, campos):
    saida = []
    for item in lista if isinstance(lista, list) else []:
        if not isinstance(item, dict):
            continue
        saida.append({k: v for k, v in item.items() if k in campos or k.startswith("PLACA")})
    return saida


# A rota por pátio usa nomes em minúscula; o snapshot mantém o formato da rota
# geral, para o servidor e o bot não precisarem conhecer os dois.
DE_PARA_POR_PATIO = {
    "cartao": "CARTAO", "usuario": "USUARIO", "data_ent": "DATA_ENT",
    "tolerancia": "TOLERANCIA", "placa": "PLACA", "pista": "PISTA", "id_patio": "IDPATIO",
}


def ler_json(url):
    with urllib.request.urlopen(url, timeout=30) as r:
        texto = r.read().decode("utf-8").strip()
    # Pátio sem ticket pode responder corpo vazio (visto em /patio/avulso/2).
    # Isso é "nenhum ticket", não falha; erro de rede ou HTTP continua
    # derrubando o ciclo inteiro, como deve.
    if not texto:
        return []
    dados = json.loads(texto)
    # A rota por pátio devolve o JSON embrulhado numa string (JSON dentro de
    # JSON). Visto em 29/09/2026.
    return json.loads(dados) if isinstance(dados, str) else dados


def ler_techparking(base):
    dados = {nome: filtrar(ler_json(base + rota), CAMPOS[nome]) for nome, rota in ROTAS.items()}

    # A rota geral de tickets CORTA EM 100, sem parâmetro que mude isso: em
    # 29/09/2026 ela devolvia 100 e, somando pátio por pátio, eram 371. O corte
    # deixava de fora justamente os validados há mais dias, e a lotação dos
    # mensalistas saía bem menor que a real. A rota por pátio não tem o corte.
    #
    # A geral continua sendo lida porque é a única que traz os rotativos ainda
    # sem validação, que não pertencem a pátio nenhum.
    por_cartao = {}
    for p in dados["patios"]:
        for t in ler_json(f"{base}/patio/avulso/{p['IDPATIO']}") or []:
            if isinstance(t, dict) and t.get("cartao"):
                item = {novo: t.get(velho) for velho, novo in DE_PARA_POR_PATIO.items()}
                item.update({k.upper(): v for k, v in t.items() if k.upper().startswith("PLACA_")})
                por_cartao[t["cartao"]] = item
    for t in dados["avulsos"]:
        por_cartao.setdefault(t.get("CARTAO"), t)
    dados["avulsos"] = list(por_cartao.values())
    return dados


def enviar(cfg, dados):
    corpo = json.dumps({"coletadoEm": datetime.now().astimezone().isoformat(), **dados}).encode("utf-8")
    pedido = urllib.request.Request(
        cfg["destino"],
        data=corpo,
        method="POST",
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + cfg["token"]},
    )
    contexto = ssl.create_default_context(cafile=cfg["ca"]) if cfg["ca"] else None
    with urllib.request.urlopen(pedido, timeout=30, context=contexto) as r:
        return json.loads(r.read().decode("utf-8"))


def ciclo(cfg, log):
    # Tudo ou nada: se qualquer leitura falhar, não envia. Um snapshot só com
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
