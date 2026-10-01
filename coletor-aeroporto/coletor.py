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
from datetime import datetime, timedelta, timezone

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
        # Validações são puxadas MUITO mais rápido que o snapshot: na
        # contingência (ValidPark fora), o cliente espera a resposta na hora,
        # como no ValidPark. Puxar a fila é leve (um GET ao nosso servidor), ao
        # contrário do snapshot, que varre o TECHPARKING inteiro.
        "intervalo_validacoes": c.getint("coletor", "intervalo_validacoes", fallback=3),
        # Arquivo de raízes para validar o HTTPS do destino. Padrão: o
        # ca-validador.pem que vem junto do coletor. Deixe em branco no .ini
        # para usar as raízes da máquina.
        "ca": resolver_ca(c.get("destino", "ca_bundle", fallback="ca-validador.pem").strip()),
        # Validação de ticket vencido (seção [validador], toda opcional). O
        # pátio #1PARK (id 31) é o que a 1Park usa para tickets sem trava,
        # confirmado pelo usuário em 29/09/2026.
        "patio_id": c.getint("validador", "patio_id", fallback=31),
        "patio_label": c.get("validador", "patio_label", fallback="#1PARK").strip(),
        "dias": c.getint("validador", "dias", fallback=20),
        # usuario_logged é o nome que fica registrado como quem validou. O
        # capturado do navegador era "ADMIN"; para separar o automático do
        # manual na auditoria, o padrão aqui é BOT_1PARK.
        "usuario_logged": c.get("validador", "usuario_logged", fallback="BOT_1PARK").strip(),
        # Token Bearer da API, se ela exigir. Vazio: tenta sem — o GET funciona
        # sem token, e ainda não sabemos se o PUT exige.
        "tk_token": c.get("validador", "token", fallback="").strip(),
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


def enviar_snapshot(cfg, log):
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


def ciclo(cfg, log):
    # Uma rodada completa: snapshot + validações. Usada no --uma-vez. No modo
    # contínuo, snapshot e validações têm ritmos diferentes (ver main).
    enviou = enviar_snapshot(cfg, log)
    executar_validacoes(cfg, log)
    return enviou


def _abrir(req):
    """urlopen que, no erro HTTP, devolve corpo e código em vez de estourar —
    é o corpo do erro que diz se faltou token (401), campo (422) ou se quebrou
    do lado deles (500)."""
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            return r.status, r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8", "replace")


def ler_ticket(cfg, ticket):
    """GET do estado do ticket. Leitura pura, não altera nada."""
    url = f"{cfg['techparking']}/validador/ticket/{ticket}"
    req = urllib.request.Request(url, headers={"accept": "application/json"})
    codigo, corpo = _abrir(req)
    return codigo, corpo


def validar_ticket(cfg, ticket, patio_id=None, patio_label=None, dias=None, placa=None, simular=False):
    """Valida um ticket no TECHPARKING, sob o pátio de tickets sem trava.

    Reproduz o corpo que o validador web (:85) envia ao salvar, capturado em
    29/09/2026. Muda só a tolerância (para hoje + `dias`); a data de entrada vem
    do próprio registro, lido antes. `patio_id`/`patio_label`/`dias`/`placa`
    sobrescrevem o padrão do cfg quando o pedido traz valores próprios.

    `simular=True` faz tudo MENOS o PUT: prova que o coletor lê o ticket e
    monta o corpo, sem escrever. É como se testa o canal sem tocar em dado real.

    NÃO É REVERSÍVEL fora da simulação: escreve no sistema real.
    """
    pid = patio_id if patio_id is not None else cfg["patio_id"]
    plabel = patio_label or cfg["patio_label"]
    ndias = dias if dias is not None else cfg["dias"]

    codigo, bruto = ler_ticket(cfg, ticket)
    if codigo != 200:
        return {"ok": False, "etapa": "leitura", "codigo": codigo, "resposta": bruto}
    try:
        res = (json.loads(bruto).get("results") or {})
    except ValueError:
        return {"ok": False, "etapa": "leitura", "codigo": codigo, "resposta": bruto}

    nova = datetime.now(timezone.utc) + timedelta(days=ndias)
    corpo = {
        "patio": {"label": plabel, "id": pid, "data": {"id": pid, "label": plabel}},
        "usuario": plabel,
        "data_ent": res.get("data_ent") or res.get("datahoraentrada"),
        "tolerancia": nova.astimezone().strftime("%Y-%m-%dT%H:%M:%S"),
        "placa": placa if placa is not None else (res.get("placa", "") or ""),
        "nova_tolerancia": nova.strftime("%Y-%m-%dT%H:%M:%S.000Z"),
        "usuario_logged": cfg["usuario_logged"],
    }
    if simular:
        return {"ok": True, "etapa": "simulado", "codigo": 200,
                "resposta": "simulacao: PUT nao enviado", "enviado": corpo}

    dados = json.dumps(corpo).encode("utf-8")
    headers = {"Content-Type": "application/json", "accept": "application/json"}
    if cfg["tk_token"]:
        headers["Authorization"] = "Bearer " + cfg["tk_token"]

    url = f"{cfg['techparking']}/validador/ticket/{ticket}"
    codigo, resposta = _abrir(urllib.request.Request(url, data=dados, method="PUT", headers=headers))
    return {"ok": codigo == 200, "etapa": "put", "codigo": codigo, "resposta": resposta, "enviado": corpo}


def _base_servidor(cfg):
    """A URL do nosso servidor sem o /snapshot final — as rotas de validação
    são irmãs dela."""
    return cfg["destino"].rsplit("/", 1)[0]


def _ctx_https(cfg):
    return ssl.create_default_context(cafile=cfg["ca"]) if cfg["ca"] else None


def executar_validacoes(cfg, log):
    """Puxa as validações autorizadas do nosso servidor, executa cada uma no
    TECHPARKING e reporta o resultado. Roda a cada ciclo, depois do snapshot.

    Uma validação que falha não derruba as outras: cada uma é reportada por si,
    e o servidor avisa o grupo do cliente conforme o resultado."""
    try:
        url = _base_servidor(cfg) + "/validacoes"
        req = urllib.request.Request(url, headers={
            "Authorization": "Bearer " + cfg["token"], "accept": "application/json"})
        with urllib.request.urlopen(req, timeout=30, context=_ctx_https(cfg)) as r:
            pendentes = json.loads(r.read().decode("utf-8")).get("validacoes", [])
    except Exception as e:  # noqa: BLE001 — rede instável não pode quebrar o ciclo
        log.warning("nao consegui buscar validacoes: %s", e)
        return

    for v in pendentes:
        try:
            r = validar_ticket(
                cfg, v["ticket"],
                patio_id=v.get("patioId"), patio_label=v.get("patioLabel"),
                dias=v.get("dias"), placa=v.get("placa"),
                simular=v.get("simular") is True,
            )
            log.info("validacao %s ticket %s -> %s (%s)", v["id"], v["ticket"],
                     "ok" if r["ok"] else "falhou", r["codigo"])
        except Exception as e:  # noqa: BLE001
            r = {"ok": False, "codigo": None, "resposta": str(e)[:300]}
            log.warning("validacao %s estourou: %s", v.get("id"), e)
        _reportar(cfg, v["id"], r, log)


def _reportar(cfg, id_validacao, r, log):
    try:
        url = _base_servidor(cfg) + "/validacao-resultado"
        dados = json.dumps({"id": id_validacao, "ok": r["ok"],
                            "codigo": r.get("codigo"), "resposta": r.get("resposta")}).encode("utf-8")
        req = urllib.request.Request(url, data=dados, method="POST", headers={
            "Authorization": "Bearer " + cfg["token"], "Content-Type": "application/json"})
        with urllib.request.urlopen(req, timeout=30, context=_ctx_https(cfg)):
            pass
    except Exception as e:  # noqa: BLE001
        # Se o report se perde, o servidor devolve a validação à fila depois do
        # tempo de reentrega — melhor repetir que dar por feito o que não foi.
        log.warning("nao consegui reportar validacao %s: %s", id_validacao, e)


def teste_validacao(cfg, ticket):
    """Um-shot para provar a validação com o olho humano: mostra o ticket
    ANTES, o que foi enviado, e o ticket DEPOIS. É como se confere, sem crer."""
    c1, antes = ler_ticket(cfg, ticket)
    print("=== ANTES ===", c1)
    print(antes)
    r = validar_ticket(cfg, ticket)
    print("\n=== PUT ===", r["codigo"], "ok" if r["ok"] else "FALHOU")
    if "enviado" in r:
        print("enviado:", json.dumps(r["enviado"], ensure_ascii=False))
    print("resposta:", r["resposta"])
    c2, depois = ler_ticket(cfg, ticket)
    print("\n=== DEPOIS ===", c2)
    print(depois)
    return r["ok"]


def main():
    log = configurar_log()
    cfg = ler_config()
    if "--validar" in sys.argv:
        i = sys.argv.index("--validar")
        if i + 1 >= len(sys.argv):
            sys.exit("uso: python coletor.py --validar NUMERO_DO_TICKET")
        sys.exit(0 if teste_validacao(cfg, sys.argv[i + 1]) else 1)
    if "--uma-vez" in sys.argv:
        sys.exit(0 if ciclo(cfg, log) else 1)
    intervalo = cfg["intervalo"]
    intervalo_val = cfg["intervalo_validacoes"]
    log.info("coletor iniciado — snapshot a cada %ss, validações a cada %ss", intervalo, intervalo_val)
    # Dois ritmos num laço só: o snapshot (pesado, varre o TECHPARKING) sai no
    # intervalo longo; as validações (leves, um GET ao nosso servidor) saem no
    # curto, para a contingência responder quase na hora, como o ValidPark.
    proximo_snapshot = 0.0
    while True:
        if time.monotonic() >= proximo_snapshot:
            enviar_snapshot(cfg, log)
            proximo_snapshot = time.monotonic() + intervalo
        try:
            executar_validacoes(cfg, log)
        except Exception as e:  # noqa: BLE001 — uma falha não pode parar o laço
            log.warning("executar_validacoes falhou: %s", e)
        time.sleep(max(1, intervalo_val))


if __name__ == "__main__":
    main()
