"""
Os outros jogos: Disney Lorcana, One Piece e Riftbound -> data/jogos.db.

Uma fonte so para os tres, e por que esta
-----------------------------------------
TCGCSV (tcgcsv.com) e um espelho diario, publico e gratuito, da API do
TCGplayer. Cada impressao e um `productId`, e esse MESMO id carrega:

  * o catalogo (nome, numero impresso, raridade, cor/tinta/dominio),
  * a imagem (CDN do TCGplayer, com `Access-Control-Allow-Origin: *`),
  * o preco (low/mid/high/market, por acabamento: normal, foil...).

E o mesmo argumento que escolheu o TCGdex para Pokemon: join nativo, sem
tabela de correspondencia. As APIs de comunidade (Lorcast, OPTCG API,
Riftcodex) tem metadado mais rico, mas cada uma usa id proprio, e casar tres
vocabularios de id com o do preco e exatamente o tipo de juncao que
avaliou um reverse holo a 10% do valor.

Medido em 24/10/2026: Lorcast traz `tcgplayer_id`, Riftcodex tambem, a OPTCG
API nao — One Piece exigiria casar por nome e numero, e "Roronoa Zoro (001)
(Parallel)" tem preco 300x maior que o "Roronoa Zoro (001)" ao lado.

O que fica de fora, e por que
-----------------------------
  * Produto selado (booster, display, deck): nao tem `Number`. O leitor
    reconhece carta, nao caixa.
  * Produto sem imagem (`imageCount == 0`): entra no catalogo, nao no indice
    — sem arte nao ha hash, e a interface diz isso.
  * Carta em paisagem (campos de batalha do Riftbound): a camera recorta a
    carta em pe, e a arte deitada chegaria girada 90 graus para um lado ou
    para o outro. Indexar uma rotacao acertaria metade das vezes com ar de
    certeza. Registrado em `failures` com o motivo, nao escondido.

Uso:
    python pipeline/jogos.py catalogo            # ~1 min, so JSON
    python pipeline/jogos.py indexar --workers 8 # baixa e hasheia as imagens
    python pipeline/jogos.py grupos              # reimpressoes de mesma arte
    python pipeline/jogos.py precos              # -> data/prices.db
    python pipeline/jogos.py tudo
"""

from __future__ import annotations

import argparse
import io
import json
import re
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timezone
from pathlib import Path

# numpy e Pillow sao importados DENTRO de `indexar` e `grupos`, nao aqui. O
# robo diario roda `catalogo` e `precos` num runner sem dependencia nenhuma
# instalada (o resto do pipeline de preco e so biblioteca padrao), e um
# import no topo derrubaria a coleta de preco por causa de um passo que ela
# nem usa.
sys.path.insert(0, str(Path(__file__).parent))

API = "https://tcgcsv.com/tcgplayer"
UA = "myPOKYcards/0.2 (indexador de catalogo; github.com/yanstutz33/myPOKYcards)"
CDN_IMG = "https://tcgplayer-cdn.tcgplayer.com/product"

# `regiao` e o campo que a interface ja usava para separar intl de asia.
# Os jogos novos entram como regioes proprias: o leitor, a busca e a ficha
# ja leem esse campo, entao nenhuma tela precisa de um segundo seletor.
#
# O prefixo do card_id existe porque o app deriva o set cortando no ULTIMO
# hifen. "lor17690-454234" da o set "lor17690", que nao colide com nenhum
# set Pokemon (os ids do TCGdex sao "sv01", "base1", "A1"...).
JOGOS = {
    "lorcana": {"categoria": 71, "prefixo": "lor", "nome": "Disney Lorcana",
                "campo_cor": ("InkType",)},
    "onepiece": {"categoria": 68, "prefixo": "op", "nome": "One Piece Card Game",
                 "campo_cor": ("Color",)},
    "riftbound": {"categoria": 89, "prefixo": "rb", "nome": "Riftbound",
                  "campo_cor": ("Domain",)},
}

# Acabamentos como o TCGplayer os escreve, no vocabulario do projeto. O que
# nao estiver aqui nao e gravado: preco de acabamento desconhecido seria
# exibido sem que a tela soubesse dizer de qual versao ele e.
ACABAMENTO = {
    "Normal": "normal",
    "Foil": "foil",
    "Holofoil": "holofoil",
    "Cold Foil": "cold-foil",
}

# Mesmo mapeamento de fetch_prices.py: o dado e do mesmo TCGplayer.
METRICAS = {
    "lowPrice": "listing", "midPrice": "listing", "highPrice": "listing",
    "directLowPrice": "listing", "marketPrice": "sold",
}
METRICAS_HISTORICO = {"marketPrice"}

SCHEMA = """
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS sets (
    set_id     TEXT PRIMARY KEY,         -- "<prefixo><groupId>"
    jogo       TEXT NOT NULL,
    group_id   INTEGER NOT NULL,
    nome       TEXT NOT NULL,
    abrev      TEXT,
    publicado  TEXT
);

CREATE TABLE IF NOT EXISTS cards (
    card_id       TEXT PRIMARY KEY,      -- "<set_id>-<productId>"
    jogo          TEXT NOT NULL,
    set_id        TEXT NOT NULL REFERENCES sets(set_id),
    product_id    INTEGER NOT NULL UNIQUE,
    nome          TEXT NOT NULL,
    numero        TEXT NOT NULL,         -- como impresso: "ST01-003", "001/298"
    raridade      TEXT,
    tipos_json    TEXT NOT NULL,         -- tinta / cor / dominio; dirige a cor da UI
    categoria     TEXT,                  -- Character, Leader, Unit, Spell...
    variants_json TEXT NOT NULL,         -- acabamentos com preco proprio
    tem_imagem    INTEGER NOT NULL,
    url           TEXT
);

CREATE TABLE IF NOT EXISTS hashes (
    card_id  TEXT PRIMARY KEY REFERENCES cards(card_id),
    phash    TEXT NOT NULL,
    dhash    TEXT NOT NULL,
    ahash    TEXT NOT NULL,
    dhash_r  TEXT NOT NULL,
    dhash_g  TEXT NOT NULL,
    dhash_b  TEXT NOT NULL,
    src_url  TEXT NOT NULL,
    built_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS failures (
    card_id  TEXT PRIMARY KEY,
    url      TEXT NOT NULL,
    reason   TEXT NOT NULL,
    tried_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS art_groups (
    card_id  TEXT PRIMARY KEY,
    group_id INTEGER NOT NULL,
    tamanho  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_jcards_set  ON cards(set_id);
CREATE INDEX IF NOT EXISTS idx_jcards_jogo ON cards(jogo);
"""


def agora() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def baixar(url: str, tentativas: int = 4) -> bytes:
    """GET com backoff; 404 nao e retentado."""
    ultimo = None
    for n in range(tentativas):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=40) as r:
                return r.read()
        except urllib.error.HTTPError as exc:
            ultimo = exc
            if exc.code == 404:
                raise
        except Exception as exc:  # noqa: BLE001
            ultimo = exc
        time.sleep(0.6 * 2 ** n)
    raise RuntimeError(f"{url}: {ultimo}")


def baixar_json(url: str):
    return json.loads(baixar(url))


def abrir(db: Path) -> sqlite3.Connection:
    db.parent.mkdir(parents=True, exist_ok=True)
    # check_same_thread=False porque `indexar` grava das threads de download,
    # sempre sob o lock — mesma solucao de build_hash_index.py.
    conn = sqlite3.connect(db, timeout=60, check_same_thread=False)
    conn.executescript(SCHEMA)
    return conn


def _ext(produto: dict) -> dict[str, str]:
    return {e["name"]: e["value"] for e in produto.get("extendedData") or []}


def _lista(valor: str | None) -> list[str]:
    """ "Amber;Steel", "Red/Green" e "Fury, Order" viram listas.

    Cada fonte separa cor dupla de um jeito. Sem isso uma carta bicolor
    viraria um tipo "Red/Green" que nenhuma cor da interface reconhece.
    """
    if not valor:
        return []
    # Riftbound escreve o texto "None" no dominio de runas e campos (96
    # cartas). Sem o filtro ele virava um tipo de verdade.
    return [p.strip() for p in re.split(r"[;/,]", valor)
            if p.strip() and p.strip().lower() not in ("none", "n/a")]


# ---------------------------------------------------------------- catalogo

def catalogo(db: Path, so_jogo: str | None) -> None:
    conn = abrir(db)
    for jogo, cfg in JOGOS.items():
        if so_jogo and jogo != so_jogo:
            continue
        cat = cfg["categoria"]
        grupos = baixar_json(f"{API}/{cat}/groups")["results"]
        print(f"{cfg['nome']}: {len(grupos)} grupos", flush=True)

        def um_grupo(g):
            gid = g["groupId"]
            prods = baixar_json(f"{API}/{cat}/{gid}/products")["results"]
            # Os acabamentos que EXISTEM vem do arquivo de preco: o catalogo
            # do TCGplayer nao diz se a carta tem versao foil, o preco diz.
            try:
                precos = baixar_json(f"{API}/{cat}/{gid}/prices")["results"]
            except urllib.error.HTTPError:
                precos = []
            return g, prods, precos

        with ThreadPoolExecutor(max_workers=4) as pool:
            resultados = list(pool.map(um_grupo, grupos))

        n_cartas = n_selados = 0
        for g, prods, precos in resultados:
            set_id = f"{cfg['prefixo']}{g['groupId']}"
            conn.execute(
                "INSERT OR REPLACE INTO sets VALUES (?,?,?,?,?,?)",
                (set_id, jogo, g["groupId"], g["name"], g.get("abbreviation"),
                 (g.get("publishedOn") or "")[:10] or None))

            acab: dict[int, set[str]] = {}
            for p in precos:
                a = ACABAMENTO.get(p.get("subTypeName"))
                if a:
                    acab.setdefault(p["productId"], set()).add(a)

            for p in prods:
                e = _ext(p)
                numero = (e.get("Number") or "").strip()
                if not numero:
                    n_selados += 1
                    continue
                cores = []
                for campo in cfg["campo_cor"]:
                    cores += _lista(e.get(campo))
                # "normal" primeiro: e a versao que a maioria tem na mao.
                variantes = sorted(acab.get(p["productId"], {"normal"}),
                                   key=lambda v: (v != "normal", v))
                conn.execute(
                    """INSERT OR REPLACE INTO cards
                       (card_id, jogo, set_id, product_id, nome, numero, raridade,
                        tipos_json, categoria, variants_json, tem_imagem, url)
                       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)""",
                    (f"{set_id}-{p['productId']}", jogo, set_id, p["productId"],
                     # Mesmo "None" literal do dominio, agora na raridade (12
                     # cartas de Riftbound): vazio e "nao sei", "None" na tela
                     # pareceria uma raridade chamada None.
                     p["name"], numero,
                     e.get("Rarity") if e.get("Rarity") not in (None, "", "None") else None,
                     json.dumps(cores, ensure_ascii=False),
                     e.get("CardType") or e.get("Card Type"),
                     json.dumps(variantes), 1 if p.get("imageCount") else 0,
                     p.get("url")))
                n_cartas += 1
        conn.commit()
        print(f"  {n_cartas} cartas, {n_selados} produtos selados ignorados")

    for jogo, n, com in conn.execute(
            "SELECT jogo, COUNT(*), SUM(tem_imagem) FROM cards GROUP BY jogo"):
        print(f"  {jogo:10} {n:6} cartas  {com:6} com imagem")
    conn.close()


# ---------------------------------------------------------------- indice

def url_imagem(product_id: int, largura: int = 400) -> str:
    # 400 px de largura: o hash reduz tudo a 32x32, e a TCGdex que alimenta o
    # indice Pokemon serve 245 px. Mais que isso e banda sem ganho medido.
    return f"{CDN_IMG}/{product_id}_{largura}w.jpg"


def indexar(db: Path, workers: int, so_jogo: str | None, limite: int | None,
            refazer_falhas: bool) -> None:
    from PIL import Image  # noqa: PLC0415
    from build_hash_index import hashes_for  # noqa: PLC0415

    conn = abrir(db)
    q = """SELECT card_id, product_id FROM cards
           WHERE tem_imagem = 1
             AND card_id NOT IN (SELECT card_id FROM hashes)"""
    if not refazer_falhas:
        q += " AND card_id NOT IN (SELECT card_id FROM failures)"
    args: list = []
    if so_jogo:
        q += " AND jogo = ?"
        args.append(so_jogo)
    todo = conn.execute(q + " ORDER BY card_id", args).fetchall()
    if limite:
        todo = todo[:limite]
    if not todo:
        print("nada pendente — indice dos jogos ja completo")
        return
    print(f"{len(todo)} cartas a indexar | {workers} workers", flush=True)

    lock = threading.Lock()
    st = {"ok": 0, "falha": 0, "paisagem": 0}
    t0 = time.monotonic()

    def falhar(card_id, url, motivo):
        conn.execute("INSERT OR REPLACE INTO failures(card_id,url,reason) VALUES (?,?,?)",
                     (card_id, url, motivo))

    def trabalho(linha):
        card_id, pid = linha
        url = url_imagem(pid)
        try:
            bruto = baixar(url)
            with Image.open(io.BytesIO(bruto)) as im:
                largura, altura = im.size
            if largura > altura:
                with lock:
                    falhar(card_id, url, f"paisagem {largura}x{altura}")
                    st["paisagem"] += 1
                return
            h = hashes_for(bruto)
        except Exception as exc:  # noqa: BLE001 — uma carta ruim nao para o indice
            with lock:
                falhar(card_id, url, str(exc)[:120])
                st["falha"] += 1
            return
        with lock:
            conn.execute(
                """INSERT OR REPLACE INTO hashes
                   (card_id,phash,dhash,ahash,dhash_r,dhash_g,dhash_b,src_url)
                   VALUES (?,?,?,?,?,?,?,?)""",
                (card_id, *(f"{h[k]:016x}" for k in
                 ("phash", "dhash", "ahash", "dhash_r", "dhash_g", "dhash_b")), url))
            conn.execute("DELETE FROM failures WHERE card_id = ?", (card_id,))
            st["ok"] += 1
            n = st["ok"] + st["falha"] + st["paisagem"]
            if n % 250 == 0:
                conn.commit()
                taxa = n / max(time.monotonic() - t0, 1e-9)
                print(f"  {n}/{len(todo)}  ok={st['ok']} falha={st['falha']} "
                      f"paisagem={st['paisagem']}  {taxa:.1f}/s  "
                      f"ETA {(len(todo) - n) / max(taxa, 1e-9) / 60:.0f}min", flush=True)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(trabalho, todo))
    conn.commit()
    print(f"\nsessao: {st} em {(time.monotonic() - t0) / 60:.1f} min")
    for jogo, n in conn.execute(
            """SELECT c.jogo, COUNT(*) FROM hashes h JOIN cards c USING(card_id)
               GROUP BY c.jogo"""):
        print(f"  {jogo:10} {n:6} com hash")
    conn.close()


# ---------------------------------------------------------------- grupos

PESOS = (1.0, 1.0, 0.4, 0.4, 0.4, 0.4)   # os mesmos do matcher e do Pokemon


def _nome_base(nome: str) -> str:
    """Nome sem os marcadores de versao que o TCGplayer poe entre parenteses.

    "Monkey.D.Luffy (Parallel)" e "Monkey.D.Luffy (Reprint)" tem que cair na
    MESMA chave para a distancia decidir; quem separa arte diferente e o
    hash, nao o nome.
    """
    return re.sub(r"\s*[\(\[].*?[\)\]]", "", nome).strip().lower()


def grupos(db: Path, limiar: float) -> None:
    """Reimpressoes com a mesma arte, que o leitor nao tem como separar.

    Mesma regra do Pokemon (build_art_groups.py): chave semantica limita a
    comparacao, a distancia decide. Aqui a chave e jogo + nome, que e mais
    FRACA que ilustrador + Pokedex — One Piece tem dezenas de "Monkey.D.Luffy"
    com artes diferentes. Por isso o limiar padrao e apertado.
    """
    import numpy as np  # noqa: PLC0415

    pesos = np.array(PESOS)
    pop = np.array([bin(i).count("1") for i in range(256)], dtype=np.uint8)
    conn = abrir(db)
    linhas = conn.execute(
        """SELECT h.card_id, c.jogo, c.nome, h.phash, h.dhash, h.ahash,
                  h.dhash_r, h.dhash_g, h.dhash_b
           FROM hashes h JOIN cards c USING(card_id) ORDER BY h.card_id""").fetchall()
    mat = np.array([[int(x, 16) for x in r[3:]] for r in linhas], dtype=np.uint64)
    chaves: dict[tuple, list[int]] = {}
    for i, r in enumerate(linhas):
        chaves.setdefault((r[1], _nome_base(r[2])), []).append(i)

    pai = list(range(len(linhas)))

    def raiz(a):
        while pai[a] != a:
            pai[a] = pai[pai[a]]
            a = pai[a]
        return a

    pares = 0
    for idx in chaves.values():
        if len(idx) < 2:
            continue
        sub = mat[idx]
        x = sub[:, None, :] ^ sub[None, :, :]
        d = pop[x.view(np.uint8).reshape(*x.shape, 8)].sum(axis=-1) @ pesos
        d[np.tril_indices(len(idx))] = 1e9
        for a, b in zip(*np.nonzero(d <= limiar)):
            ra, rb = raiz(idx[int(a)]), raiz(idx[int(b)])
            if ra != rb:
                pai[rb] = ra
            pares += 1

    membros: dict[int, list[int]] = {}
    for i in range(len(linhas)):
        membros.setdefault(raiz(i), []).append(i)
    conn.execute("DELETE FROM art_groups")
    gid = 0
    for ms in membros.values():
        if len(ms) < 2:
            continue
        for i in ms:
            conn.execute("INSERT INTO art_groups VALUES (?,?,?)",
                         (linhas[i][0], gid, len(ms)))
        gid += 1
    conn.commit()
    maior = conn.execute("SELECT COALESCE(MAX(tamanho),0) FROM art_groups").fetchone()[0]
    cobertas = conn.execute("SELECT COUNT(*) FROM art_groups").fetchone()[0]
    print(f"{pares} pares abaixo de {limiar} -> {gid} grupos, {cobertas} cartas, "
          f"maior com {maior}")
    conn.close()


# ---------------------------------------------------------------- precos

def precos(db: Path, prices_db: Path) -> None:
    """Cotacao do dia -> as mesmas tabelas que o Pokemon usa em prices.db.

    Grava no mesmo `prices` e no mesmo `price_history`, com o mesmo
    vocabulario de fonte e metrica. Assim `price_model.leitura`, o
    prices.json, o grafico da ficha e o valor da colecao funcionam sem saber
    de qual jogo a carta e.

    `source_date` e o carimbo do proprio TCGCSV (last-updated.txt), nao a
    hora desta coleta: a tela mostra a idade do DADO, e o espelho atualiza
    uma vez por dia.
    """
    sys.path.insert(0, str(Path(__file__).parent))
    from fetch_prices import SCHEMA as SCHEMA_PRECOS  # noqa: PLC0415

    jconn = abrir(db)
    sets = jconn.execute("SELECT set_id, jogo, group_id FROM sets").fetchall()
    # So produto que o catalogo reconheceu como CARTA. O arquivo de preco do
    # TCGplayer traz booster, display e deck no mesmo bloco, e a serie
    # historica e versionada no git: guardar selado todo dia incharia o
    # unico arquivo que nao se recompra com dado que nenhuma tela usa.
    ids = dict(jconn.execute("SELECT product_id, card_id FROM cards"))
    jconn.close()
    if not sets:
        sys.exit("jogos.db sem catalogo — rode `jogos.py catalogo` antes")

    carimbo = baixar(f"{API.rsplit('/', 1)[0]}/last-updated.txt").decode().strip()
    try:
        data_fonte = datetime.strptime(carimbo, "%Y-%m-%dT%H:%M:%S%z").isoformat()
    except ValueError:
        data_fonte = None
    hoje = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    coletado = agora()

    def um_set(s):
        _set_id, jogo, gid = s
        try:
            return baixar_json(f"{API}/{JOGOS[jogo]['categoria']}/{gid}/prices")["results"]
        except urllib.error.HTTPError:
            return []

    with ThreadPoolExecutor(max_workers=4) as pool:
        blocos = list(pool.map(um_set, sets))

    linhas = []
    for bloco in blocos:
        for p in bloco:
            card_id = ids.get(p["productId"])
            variante = ACABAMENTO.get(p.get("subTypeName"))
            if not card_id or not variante:
                continue      # selado, ou acabamento que nao sabemos nomear
            for metrica, kind in METRICAS.items():
                v = p.get(metrica)
                if isinstance(v, (int, float)) and v > 0:
                    linhas.append((card_id, variante, "tcgplayer", metrica, kind,
                                   "USD", float(v), data_fonte, coletado))

    conn = sqlite3.connect(prices_db, timeout=60)
    conn.executescript(SCHEMA_PRECOS)
    # A tabela `prices` e o AGORA: sai a cotacao de ontem destes jogos antes
    # de entrar a de hoje, ou um acabamento que deixou de ser cotado ficaria
    # para sempre com o ultimo preco que teve.
    # Pelos ids do catalogo, nao por prefixo: um LIKE 'op%' apagaria tambem
    # qualquer set Pokemon que algum dia comecar com essas letras.
    conn.execute("CREATE TEMP TABLE nossos (card_id TEXT PRIMARY KEY)")
    conn.executemany("INSERT INTO nossos VALUES (?)", [(i,) for i in ids.values()])
    conn.execute("DELETE FROM prices WHERE card_id IN (SELECT card_id FROM nossos)")
    conn.executemany("INSERT OR REPLACE INTO prices VALUES (?,?,?,?,?,?,?,?,?)", linhas)
    # OR IGNORE: o primeiro valor do dia vale. Rodar duas vezes no mesmo dia
    # nao reescreve a historia (mesma regra de fetch_prices.py).
    conn.executemany(
        "INSERT OR IGNORE INTO price_history VALUES (?,?,?,?,?,?,?)",
        [(r[0], r[1], r[2], r[3], r[5], r[6], hoje) for r in linhas
         if r[3] in METRICAS_HISTORICO])
    conn.commit()
    cartas = len({r[0] for r in linhas})
    conn.close()
    print(f"{len(linhas)} cotacoes em {cartas} cartas (fonte de {carimbo}) -> {prices_db}")
    if cartas < 1000:
        sys.exit(f"apenas {cartas} cartas com preco nos jogos — abaixo do esperado")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("passo", choices=["catalogo", "indexar", "grupos", "precos", "tudo"])
    ap.add_argument("--db", default=Path("data/jogos.db"), type=Path)
    ap.add_argument("--precos-db", default=Path("data/prices.db"), type=Path)
    ap.add_argument("--jogo", choices=list(JOGOS), default=None)
    ap.add_argument("--workers", default=8, type=int)
    ap.add_argument("--limite", default=None, type=int)
    ap.add_argument("--refazer-falhas", action="store_true")
    ap.add_argument("--limiar", default=40.0, type=float,
                    help="distancia ponderada maxima para duas cartas serem a mesma arte")
    a = ap.parse_args()
    if a.passo in ("catalogo", "tudo"):
        catalogo(a.db, a.jogo)
    if a.passo in ("indexar", "tudo"):
        indexar(a.db, a.workers, a.jogo, a.limite, a.refazer_falhas)
    if a.passo in ("grupos", "tudo"):
        grupos(a.db, a.limiar)
    if a.passo in ("precos", "tudo"):
        precos(a.db, a.precos_db)
