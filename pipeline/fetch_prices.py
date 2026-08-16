"""
Coletor de precos -> prices.db.

Fonte: TCGdex (`/v2/<lang>/cards/<card_id>`), que reempacota Cardmarket (EUR)
e TCGplayer (USD). Escolhida sobre o pokemontcg.io por tres motivos medidos
em 2026-08-15:

  * **Join nativo.** O TCGdex usa os mesmos `card_id` do nosso catalogo. O
    pokemontcg.io usa ids proprios (`sv3pt5` onde temos `sv03.5`), o que
    exigiria uma tabela de correspondencia inteira.
  * **Dado mais fresco.** O TCGdex marcou os dois mercados com a hora
    corrente; via pokemontcg.io o Cardmarket estava 46 dias atrasado.
  * **Confiabilidade.** O pokemontcg.io devolveu 500 em 8 de 16 chamadas.

Cobre apenas o mercado internacional em moeda estrangeira. Preco em BRL e em
JPY nao tem fonte aberta equivalente — e limitacao de mercado, nao do
coletor, e a interface precisa dizer isso em vez de converter e fingir.

Tres decisoes de modelagem:

1. **Nada de preco unico.** Cada metrica vira uma linha com `kind`:
   `listing` (pedido de anuncio), `sold` (derivado de venda concluida) ou
   `derived` (tendencia calculada pela fonte). Somar os tres num "valor de
   mercado" e o erro classico de agregador.

2. **Duas datas por linha.** `source_date` e quando a FONTE diz que o dado
   e; `fetched_at` e quando nos pegamos. Uma data so esconde defasagem.

3. **Toda tentativa vai para `fetch_log`.** Sem isso, coletor morto e
   indistinguivel de "essa carta nao tem preco".

Uso:
    python fetch_prices.py --set swsh3
    python fetch_prices.py --limit 500
    python fetch_prices.py --stale-days 7
"""

from __future__ import annotations

import argparse
import json
import random
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path

API = "https://api.tcgdex.net/v2/en/cards/"
UA = "myPOKYcards/0.1 (agregador de catalogo; github.com/yanstutz33/myPOKYcards)"

# Como interpretar cada metrica. O que nao esta mapeado nao e gravado —
# melhor faltar campo do que guardar numero sem saber o que ele significa.
TCGPLAYER_METRICS = {
    "lowPrice": "listing", "midPrice": "listing", "highPrice": "listing",
    "directLowPrice": "listing", "marketPrice": "sold",
}
CARDMARKET_METRICS = {
    "low": "listing", "avg": "sold", "avg1": "sold", "avg7": "sold",
    "avg30": "sold", "trend": "derived",
}

# Metricas que viram serie historica. Sao as de referencia (venda
# concluida) — as unicas que respondem "essa carta subiu ou caiu?".
METRICAS_HISTORICO = {"marketPrice", "avg30"}

# O Cardmarket sufixa "-holo" nos campos de reverse holo, nao de holo comum.
# Evidencia: swsh3-136 declara variants {holo: false, reverse: true} e mesmo
# assim traz avg-holo/trend-holo. Sem essa correcao o reverse ficaria com
# preco de uma variante que a carta nao tem.
CM_SUFIXO_REVERSE = "-holo"

SCHEMA = """
PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS prices (
    card_id     TEXT NOT NULL,
    variant     TEXT NOT NULL,      -- normal | holofoil | reverse-holofoil
    source      TEXT NOT NULL,      -- tcgplayer | cardmarket
    metric      TEXT NOT NULL,      -- lowPrice | marketPrice | avg30 | ...
    kind        TEXT NOT NULL,      -- listing | sold | derived
    currency    TEXT NOT NULL,      -- USD | EUR
    value       REAL NOT NULL,
    source_date TEXT,
    fetched_at  TEXT NOT NULL,
    PRIMARY KEY (card_id, variant, source, metric)
);

CREATE INDEX IF NOT EXISTS idx_prices_card ON prices(card_id);

-- Serie temporal. A tabela `prices` guarda o AGORA e e sobrescrita a cada
-- coleta; sem esta aqui, cada rodada apagaria a anterior e tendencia nunca
-- existiria. So as metricas de referencia entram, com granularidade de um
-- dia: guardar tudo multiplicaria o volume por seis sem responder nenhuma
-- pergunta a mais.
CREATE TABLE IF NOT EXISTS price_history (
    card_id  TEXT NOT NULL,
    variant  TEXT NOT NULL,
    source   TEXT NOT NULL,
    metric   TEXT NOT NULL,
    currency TEXT NOT NULL,
    value    REAL NOT NULL,
    dia      TEXT NOT NULL,          -- AAAA-MM-DD
    PRIMARY KEY (card_id, variant, source, metric, dia)
);

CREATE INDEX IF NOT EXISTS idx_hist_card ON price_history(card_id, dia);

CREATE TABLE IF NOT EXISTS fetch_log (
    card_id  TEXT PRIMARY KEY,
    ok       INTEGER NOT NULL,
    detail   TEXT,
    tried_at TEXT NOT NULL
);
"""


def now() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def fetch_card(card_id: str, tries: int = 4) -> dict | None:
    """GET com backoff exponencial e jitter; 404 nao e retentado."""
    last = None
    for attempt in range(tries):
        try:
            req = urllib.request.Request(API + card_id, headers={"User-Agent": UA})
            with urllib.request.urlopen(req, timeout=25) as r:
                return json.load(r)
        except urllib.error.HTTPError as e:
            last = f"HTTP {e.code}"
            if e.code == 404:
                return None
        except Exception as e:  # noqa: BLE001
            last = type(e).__name__
        time.sleep((2 ** attempt) * 0.5 + random.random() * 0.3)
    raise RuntimeError(last or "falha desconhecida")


def rows_from(card_id: str, data: dict) -> list[tuple]:
    pricing = data.get("pricing") or {}
    stamp = now()
    out: list[tuple] = []

    tp = pricing.get("tcgplayer") or {}
    tp_unit = tp.get("unit", "USD")
    tp_date = tp.get("updated")
    for variant, block in tp.items():
        if not isinstance(block, dict):
            continue  # 'unit' e 'updated' sao escalares
        for metric, value in block.items():
            kind = TCGPLAYER_METRICS.get(metric)
            if kind is None or not isinstance(value, (int, float)) or value <= 0:
                continue
            out.append((card_id, variant, "tcgplayer", metric, kind,
                        tp_unit, float(value), tp_date, stamp))

    cm = pricing.get("cardmarket") or {}
    cm_unit = cm.get("unit", "EUR")
    cm_date = cm.get("updated")
    for field, value in cm.items():
        if not isinstance(value, (int, float)) or value <= 0:
            continue
        if field.endswith(CM_SUFIXO_REVERSE):
            metric, variant = field[: -len(CM_SUFIXO_REVERSE)], "reverse-holofoil"
        else:
            metric, variant = field, "normal"
        kind = CARDMARKET_METRICS.get(metric)
        if kind is None:
            continue
        out.append((card_id, variant, "cardmarket", metric, kind,
                    cm_unit, float(value), cm_date, stamp))
    return out


def pending(cards_db: Path, prices_db: Path, only_set: str | None, limit: int | None,
            stale_days: int | None, region: str | None) -> list[str]:
    """Cartas a consultar.

    O filtro de regiao existe por medicao: 99,4% das cartas internacionais
    tem preco na fonte, contra 2,2% das asiaticas. Cardmarket e TCGplayer
    sao mercados ocidentais — carta japonesa nao esta neles. Consultar asia
    queima 98% das requisicoes para nada.
    """
    src = sqlite3.connect(f"file:{cards_db}?mode=ro", uri=True)
    # NAO filtre por tcgplayer_id/cardmarket_id.
    #
    # O filtro parecia obvio — "so pergunta o preco de quem tem id externo" —
    # e estava errado. Esses ids vem do repo estatico, que os traz para 57%
    # das cartas; a API de preco nao depende deles. Numa amostra de 20 cartas
    # internacionais SEM id externo, 12 tinham preco (60%). O filtro excluia
    # 10.677 cartas internacionais que nunca chegaram a ser perguntadas.
    #
    # Proxy nao e a verdade: pergunte, e deixe o `fetch_log` registrar quem
    # realmente nao tem.
    q = "SELECT card_id FROM cards WHERE 1=1"
    args: list = []
    if region:
        q += " AND region = ?"
        args.append(region)
    if only_set:
        q += " AND set_id = ?"
        args.append(only_set)
    ids = [r[0] for r in src.execute(q + " ORDER BY card_id", args)]
    src.close()

    done = sqlite3.connect(prices_db)
    if stale_days is None:
        seen = {r[0] for r in done.execute("SELECT card_id FROM fetch_log")}
    else:
        cutoff = (datetime.now(timezone.utc) - timedelta(days=stale_days)).isoformat()
        seen = {r[0] for r in done.execute(
            "SELECT card_id FROM fetch_log WHERE tried_at >= ?", (cutoff,))}
    done.close()

    todo = [i for i in ids if i not in seen]
    return todo[:limit] if limit else todo


def run(cards_db: Path, prices_db: Path, only_set: str | None, limit: int | None,
        stale_days: int | None, workers: int, region: str | None) -> None:
    prices_db.parent.mkdir(parents=True, exist_ok=True)
    sqlite3.connect(prices_db).executescript(SCHEMA)

    hoje = datetime.now(timezone.utc).strftime("%Y-%m-%d")
    todo = pending(cards_db, prices_db, only_set, limit, stale_days, region)
    if not todo:
        print("nada pendente")
        return
    print(f"{len(todo)} cartas a consultar | {workers} workers\n")

    conn = sqlite3.connect(prices_db, check_same_thread=False)
    lock = threading.Lock()
    stat = {"ok": 0, "sem": 0, "erro": 0}
    t0 = time.monotonic()

    def work(card_id: str) -> None:
        try:
            data = fetch_card(card_id)
        except Exception as exc:  # noqa: BLE001
            with lock:
                conn.execute("INSERT OR REPLACE INTO fetch_log VALUES (?,?,?,?)",
                             (card_id, 0, str(exc)[:80], now()))
                stat["erro"] += 1
            return
        rows = rows_from(card_id, data) if data else []
        with lock:
            if rows:
                conn.executemany(
                    "INSERT OR REPLACE INTO prices VALUES (?,?,?,?,?,?,?,?,?)", rows)
                # INSERT OR IGNORE, nao REPLACE: se o dia ja foi registrado,
                # o primeiro valor do dia e o que vale. Rodar a coleta duas
                # vezes no mesmo dia nao pode reescrever a historia.
                conn.executemany(
                    "INSERT OR IGNORE INTO price_history VALUES (?,?,?,?,?,?,?)",
                    [(r[0], r[1], r[2], r[3], r[5], r[6], hoje) for r in rows
                     if r[3] in METRICAS_HISTORICO])
                stat["ok"] += 1
            else:
                stat["sem"] += 1
            conn.execute("INSERT OR REPLACE INTO fetch_log VALUES (?,?,?,?)",
                         (card_id, 1, f"{len(rows)} precos", now()))
            n = stat["ok"] + stat["sem"] + stat["erro"]
            if n % 100 == 0:
                conn.commit()
                taxa = n / max(time.monotonic() - t0, 1e-9)
                print(f"  {n}/{len(todo)}  com_preco={stat['ok']} sem={stat['sem']} "
                      f"erro={stat['erro']}  {taxa:.1f}/s  "
                      f"ETA {(len(todo)-n)/max(taxa,1e-9)/60:.0f}min", flush=True)

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(work, todo))

    conn.commit()
    total = conn.execute("SELECT COUNT(*) FROM prices").fetchone()[0]
    cartas = conn.execute("SELECT COUNT(DISTINCT card_id) FROM prices").fetchone()[0]
    print(f"\nsessao: com_preco={stat['ok']} sem_preco={stat['sem']} erro={stat['erro']}"
          f"  em {(time.monotonic()-t0)/60:.1f}min")
    dias = conn.execute("SELECT COUNT(DISTINCT dia) FROM price_history").fetchone()[0]
    hist = conn.execute("SELECT COUNT(*) FROM price_history").fetchone()[0]
    print(f"base:   {total} precos em {cartas} cartas -> {prices_db}")
    print(f"        historico: {hist} pontos em {dias} dia(s)")
    if stat["erro"]:
        print(f"\n{stat['erro']} cartas falharam apos 4 tentativas — rode de novo.")
    conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--cards", default=Path("data/cards.db"), type=Path)
    ap.add_argument("--out", default=Path("data/prices.db"), type=Path)
    ap.add_argument("--set", dest="only_set", default=None)
    ap.add_argument("--limit", default=None, type=int)
    ap.add_argument("--stale-days", default=None, type=int)
    ap.add_argument("--workers", default=8, type=int)
    ap.add_argument("--region", default="intl", choices=["intl", "asia", "all"],
                    help="'asia' tem 2,2%% de cobertura na fonte; padrao e so intl")
    a = ap.parse_args()
    if not a.cards.exists():
        sys.exit(f"catalogo ausente: {a.cards}")
    run(a.cards, a.out, a.only_set, a.limit, a.stale_days, a.workers,
        None if a.region == 'all' else a.region)
