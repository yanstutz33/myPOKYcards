"""
Segunda fonte de arte: pokemontcg.io -> hashes.db

Por que existe
--------------
O indexador principal (build_hash_index.py) usa a CDN do TCGdex e chegou ao
teto dela: 10.661 cartas devolvem 404 em TODOS os idiomas tentados. Conferi
de duas formas independentes em 21/08/2026 — sonda HEAD numa amostra de 120
cartas por regiao (0 acertos) e a tabela `failures`, que ja registrava as
mesmas 10.661. As URLs estao bem formadas: comparei com as que funcionam e o
formato e identico. A arte simplesmente nao existe naquela CDN.

Isso e limite de UMA fonte, nao do projeto. pokemontcg.io e uma base
independente e gratuita, com imagem de 174 colecoes em ingles — e ela cobre
justamente os buracos que mais aparecem no uso real: Shiny Vault, Trainer
Gallery, promos, McDonalds, Trainer Kits.

Por que nao trocar de fonte de vez
----------------------------------
O TCGdex e melhor onde alcanca: cobre 7 idiomas (a mesma carta em portugues,
japones, coreano) e tem 564 colecoes contra 174. Ele continua sendo a fonte
primaria. Isto aqui e complemento, e so roda para carta que ficou sem hash.

O casamento de colecoes
-----------------------
Os dois catalogos usam ids diferentes para a mesma colecao: `swsh4.5sv` la e
`swsh45sv` aqui, `swsh12.5gg` vira `swsh12pt5gg`, `2021swsh` vira `mcd21`.
Nao da para casar por id sozinho.

A regra: tenta id (com variantes de pontuacao), depois nome normalizado, e
so aceita se a DATA DE LANCAMENTO bater. A data e o desempate honesto — duas
colecoes com o mesmo nome e o mesmo dia de lancamento sao a mesma colecao.
Sem essa conferencia, um casamento errado colocaria no indice a arte de
OUTRA carta, e o leitor passaria a errar com ar de certeza — que e pior que
nao achar.

O numero da carta tambem precisa bater exatamente. `local_id` do TCGdex e
`number` do pokemontcg.io sao a mesma coisa impressa no rodape.

Uso:
    python pipeline/complementar_arte.py --cards data/cards.db --out data/hashes.db
    python pipeline/complementar_arte.py --so-mapear      # mostra o casamento e sai
"""

from __future__ import annotations

import argparse
import json
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from build_hash_index import SCHEMA, hashes_for  # noqa: E402

API = "https://api.pokemontcg.io/v2"
UA = "myPOKYcards/0.1 (indexador de catalogo; github.com/yanstutz33/myPOKYcards)"

# Marca de origem na coluna `lang`. Precisa dizer o idioma E a fonte: "en"
# sozinho ja significa "TCGdex em ingles", e misturar as duas origens sob o
# mesmo rotulo apagaria a unica pista de onde cada hash veio no dia em que
# alguma delas estiver errada.
MARCA = "en:ptcgio"


def url_imagem(carta: dict):
    """Arte em baixa.

    `_hires.png` tem ~1 MB e o hash reduz tudo a 32x32 de qualquer jeito —
    baixar 40x mais byte nao muda um bit do resultado.
    """
    im = carta.get("images") or {}
    return im.get("small") or im.get("large")


# Quantas vezes insistir, e quanto esperar entre as tentativas.
#
# A primeira rodada morreu num 502 no primeiro pedido. Nao e caso raro: o
# proprio ingest_tcgdex.py existe porque api.tcgdex.net devolvia 502 em
# 2026-08-15. Servico gratuito de terceiro cai, e uma rodada de 700 cartas
# nao pode ser refeita do zero porque um pedido pegou o servidor num mau
# momento.
#
# Espera crescente (1s, 2s, 4s...) em vez de fixa: se a base esta
# sobrecarregada, martelar no mesmo ritmo e parte do problema.
TENTATIVAS = 4
ESPERA_BASE = 1.0

# 404 e resposta, nao falha: aquela carta nao existe naquela base. Insistir
# so gasta o limite diario da API.
NAO_INSISTIR = {400, 401, 403, 404}


def buscar(url: str, timeout: int = 30) -> bytes:
    ultima = None
    for tentativa in range(TENTATIVAS):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=timeout) as r:
                return r.read()
        except urllib.error.HTTPError as exc:
            if exc.code in NAO_INSISTIR:
                raise
            ultima = exc
        except Exception as exc:  # noqa: BLE001 — timeout e queda de conexao tambem passam
            ultima = exc
        if tentativa < TENTATIVAS - 1:
            time.sleep(ESPERA_BASE * (2 ** tentativa))
    raise ultima


def api(caminho: str) -> dict:
    return json.loads(buscar(f"{API}/{caminho}"))


def normalizar(s: str) -> str:
    return "".join(ch for ch in (s or "").lower() if ch.isalnum())


def variantes_de_id(sid: str):
    """Mesma colecao, pontuacao diferente entre os dois catalogos."""
    yield sid
    yield sid.replace(".", "")
    yield sid.replace(".", "pt")
    yield sid.replace(".5", "pt5")


def mapear(cards_db: Path, hashes_db: Path):
    """Colecoes com carta faltando -> colecao equivalente no pokemontcg.io.

    Devolve (casadas, orfas). Orfa nao e erro: e colecao que aquela base nao
    tem, quase sempre porque e exclusiva de um idioma que ela nao cobre.
    """
    c = sqlite3.connect(f"file:{cards_db}?mode=ro", uri=True)
    c.execute(f"ATTACH DATABASE 'file:{hashes_db}?mode=ro' AS h")

    faltando = c.execute(
        "SELECT c.set_id, COUNT(*) FROM cards c WHERE c.region = 'intl'"
        "  AND NOT EXISTS (SELECT 1 FROM h.hashes x WHERE x.card_id = c.card_id)"
        " GROUP BY c.set_id ORDER BY COUNT(*) DESC").fetchall()

    meta = {}
    for sid, nj, rj in c.execute("SELECT set_id, names_json, release_json FROM sets"):
        try:
            data = (json.loads(rj or "{}") or {}).get("*") or ""
        except Exception:
            data = ""
        meta[sid] = ((json.loads(nj or "{}") or {}).get("en") or "", data)

    remotos = api("sets?pageSize=250")["data"]
    por_id = {s["id"]: s for s in remotos}
    por_nome = {}
    for s in remotos:
        por_nome.setdefault(normalizar(s["name"]), []).append(s)

    casadas, orfas = {}, []
    for sid, n in faltando:
        nome, data = meta.get(sid, ("", ""))
        alvo = por_id_exato = None
        for v in variantes_de_id(sid):
            if v in por_id:
                alvo = por_id[v]
                por_id_exato = True
                break
        if alvo is None:
            for cand in por_nome.get(normalizar(nome), []):
                alvo = cand
                por_id_exato = False
                break

        # A data so manda quando o casamento foi por NOME.
        #
        # Nome repete: "Base", "Promos" e "Trainer Kit" existem em varias
        # formas, e casar por nome sem conferir data poe arte de OUTRA carta
        # no indice — o leitor passaria a errar com ar de certeza, que e pior
        # que nao achar.
        #
        # Id nao repete. Os dois catalogos escolheram o mesmo identificador
        # para a mesma colecao, e uma colisao acidental entre bases
        # independentes nao e plausivel. Ai a data vira detalhe de convencao:
        # `svp` esta como 2023-01-01 la e 2023-03-31 aqui, e e a mesma caixa
        # de promos. Exigir data nesse caso jogava fora 15 cartas boas.
        if alvo and data and not por_id_exato:
            remota = (alvo.get("releaseDate") or "").replace("/", "-")
            if remota != data:
                orfas.append((sid, n, nome,
                              f"data diverge: {alvo['id']} e de {remota}, nao {data}"))
                continue
        if alvo:
            casadas[sid] = (alvo["id"], n, nome)
        else:
            orfas.append((sid, n, nome, "sem equivalente"))
    return casadas, orfas


def pendentes(cards_db: Path, hashes_db: Path, sets):
    c = sqlite3.connect(f"file:{cards_db}?mode=ro", uri=True)
    c.execute(f"ATTACH DATABASE 'file:{hashes_db}?mode=ro' AS h")
    marcas = ",".join("?" * len(sets))
    return c.execute(
        f"SELECT c.card_id, c.set_id, c.local_id FROM cards c"
        f" WHERE c.region = 'intl' AND c.set_id IN ({marcas})"
        f"   AND NOT EXISTS (SELECT 1 FROM h.hashes x WHERE x.card_id = c.card_id)",
        tuple(sets)).fetchall()


def run(cards_db: Path, hashes_db: Path, workers: int, so_mapear: bool) -> None:
    casadas, orfas = mapear(cards_db, hashes_db)
    alcance = sum(v[1] for v in casadas.values())
    perdidas = sum(o[1] for o in orfas)

    print(f"colecoes casadas : {len(casadas)}  ({alcance} cartas ao alcance)")
    for sid, (rid, n, nome) in sorted(casadas.items(), key=lambda kv: -kv[1][1])[:15]:
        print(f"  {sid:14} -> {rid:14} {n:5} cartas  {nome[:30]}")
    print(f"\nsem equivalente  : {len(orfas)}  ({perdidas} cartas fora de alcance)")
    for sid, n, nome, por in orfas[:12]:
        print(f"  {sid:14} {n:5} cartas  {nome[:26]:28} {por}")
    if so_mapear:
        return

    todo = pendentes(cards_db, hashes_db, set(casadas))
    print(f"\ncartas a tentar  : {len(todo)}")
    if not todo:
        return

    # Um pedido por colecao traz ate 250 cartas. Buscar carta a carta gastaria
    # o limite diario da API (1000 pedidos sem chave) antes da metade.
    catalogo = {}
    for sid, (rid, _, _) in casadas.items():
        try:
            d = api(f"cards?q=set.id:{rid}&pageSize=250")["data"]
        except Exception as exc:  # noqa: BLE001
            print(f"  ! {rid}: {str(exc)[:80]}")
            continue
        catalogo[sid] = {str(x.get("number")): x for x in d}
        print(f"  {rid:14} {len(d):4} cartas no indice remoto", flush=True)

    # check_same_thread=False porque os trabalhadores escrevem daqui; e seguro
    # porque TODA escrita acontece sob `lock`. Mesmo arranjo do indexador
    # principal, que ja roda assim desde a primeira versao.
    conn = sqlite3.connect(hashes_db, check_same_thread=False, timeout=60)
    conn.executescript(SCHEMA)
    conn.execute("PRAGMA busy_timeout = 60000")
    lock = threading.Lock()
    contas = {"ok": 0, "sem_carta": 0, "sem_imagem": 0, "erro": 0}
    t0 = time.monotonic()

    def trabalhar(row):
        card_id, set_id, local_id = row
        remota = (catalogo.get(set_id) or {}).get(str(local_id))
        if remota is None:
            with lock:
                contas["sem_carta"] += 1
            return
        u = url_imagem(remota)
        if not u:
            with lock:
                contas["sem_imagem"] += 1
            return
        try:
            h = hashes_for(buscar(u))
        except Exception as exc:  # noqa: BLE001 — uma carta ruim nao para a rodada
            with lock:
                contas["erro"] += 1
                try:
                    conn.execute(
                        "INSERT OR REPLACE INTO failures(card_id,url,reason) VALUES (?,?,?)",
                        (card_id, u, f"ptcgio: {str(exc)[:100]}"))
                except sqlite3.OperationalError:
                    pass
            return
        with lock:
            conn.execute(
                "INSERT OR REPLACE INTO hashes"
                " (card_id,lang,phash,dhash,ahash,dhash_r,dhash_g,dhash_b,src_url)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (card_id, MARCA, *(f"{h[k]:016x}" for k in
                 ("phash", "dhash", "ahash", "dhash_r", "dhash_g", "dhash_b")), u))
            conn.execute("DELETE FROM failures WHERE card_id = ?", (card_id,))
            contas["ok"] += 1
            n = sum(contas.values())
            if n % 100 == 0:
                conn.commit()
                taxa = n / max(time.monotonic() - t0, 1e-9)
                print(f"  {n}/{len(todo)}  ok={contas['ok']}  {taxa:.1f}/s", flush=True)

    with ThreadPoolExecutor(workers) as ex:
        list(ex.map(trabalhar, todo))
    conn.commit()
    conn.close()

    print(f"\nrecuperadas       : {contas['ok']}")
    print(f"carta ausente la  : {contas['sem_carta']}")
    print(f"sem imagem la     : {contas['sem_imagem']}")
    print(f"erro ao baixar    : {contas['erro']}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--cards", default=Path("data/cards.db"), type=Path)
    ap.add_argument("--out", default=Path("data/hashes.db"), type=Path)
    ap.add_argument("--workers", default=8, type=int)
    ap.add_argument("--so-mapear", action="store_true")
    a = ap.parse_args()
    run(a.cards, a.out, a.workers, a.so_mapear)
