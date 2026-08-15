"""
Exporta e importa `price_history` como CSV comprimido.

Por que existe
-------------
A atualizacao diaria roda em maquina descartavel (GitHub Actions). O
`cards.db` se reconstroi em 2 minutos e o `prices.db` inteiro tem 77 MB —
grande demais para versionar e mudando todo dia. Mas a serie historica NAO
pode ser reconstruida: um dia perdido e um dia perdido para sempre.

`price_history` comprimido da 0,32 MB. Esse arquivo vai para o repositorio,
e e a unica coisa que precisa sobreviver entre execucoes.

Uso:
    python history_io.py exportar   # prices.db -> data/price_history.csv.gz
    python history_io.py importar   # csv.gz -> prices.db (nao sobrescreve)
"""

from __future__ import annotations

import argparse
import csv
import gzip
import io
import sqlite3
import sys
from pathlib import Path

COLUNAS = ("card_id", "variant", "source", "metric", "currency", "value", "dia")

SCHEMA = """
CREATE TABLE IF NOT EXISTS price_history (
    card_id  TEXT NOT NULL,
    variant  TEXT NOT NULL,
    source   TEXT NOT NULL,
    metric   TEXT NOT NULL,
    currency TEXT NOT NULL,
    value    REAL NOT NULL,
    dia      TEXT NOT NULL,
    PRIMARY KEY (card_id, variant, source, metric, dia)
);
CREATE INDEX IF NOT EXISTS idx_hist_card ON price_history(card_id, dia);
"""


def exportar(db: Path, out: Path) -> None:
    conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
    linhas = conn.execute(
        f"SELECT {', '.join(COLUNAS)} FROM price_history ORDER BY dia, card_id"
    ).fetchall()
    conn.close()

    out.parent.mkdir(parents=True, exist_ok=True)
    # mtime=0 é obrigatório: o gzip grava a data de modificação DENTRO do
    # arquivo, então conteúdo idêntico gerava bytes diferentes a cada
    # execução. O commit diário vinha com "0 insertions, 0 deletions" e o
    # repositório encheria de commits vazios.
    with open(out, "wb") as bruto, gzip.GzipFile(
            fileobj=bruto, mode="wb", compresslevel=9, mtime=0) as gz:
        w = csv.writer(io.TextIOWrapper(gz, encoding="utf-8", newline=""))
        w.writerow(COLUNAS)
        w.writerows(linhas)
    dias = len({l[-1] for l in linhas})
    print(f"{len(linhas)} pontos em {dias} dia(s) -> {out} "
          f"({out.stat().st_size/1024/1024:.2f} MB)")


def importar(db: Path, src: Path) -> None:
    if not src.exists():
        print(f"{src} não existe — começando série do zero")
        return
    db.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(db)
    conn.executescript(SCHEMA)

    with gzip.open(src, "rt", encoding="utf-8", newline="") as fh:
        r = csv.reader(fh)
        next(r, None)  # cabeçalho
        # INSERT OR IGNORE: o arquivo é a memória, não a autoridade. Se o
        # banco local já tem o ponto do dia, ele prevalece.
        n = conn.executemany(
            f"INSERT OR IGNORE INTO price_history ({', '.join(COLUNAS)}) "
            "VALUES (?,?,?,?,?,?,?)", r).rowcount
    conn.commit()
    total = conn.execute("SELECT COUNT(*) FROM price_history").fetchone()[0]
    dias = conn.execute("SELECT COUNT(DISTINCT dia) FROM price_history").fetchone()[0]
    conn.close()
    print(f"{n} pontos importados | base: {total} pontos em {dias} dia(s)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("acao", choices=["exportar", "importar"])
    ap.add_argument("--db", default=Path("data/prices.db"), type=Path)
    ap.add_argument("--arquivo", default=Path("data/price_history.csv.gz"), type=Path)
    a = ap.parse_args()
    if a.acao == "exportar":
        if not a.db.exists():
            sys.exit(f"{a.db} não existe")
        exportar(a.db, a.arquivo)
    else:
        importar(a.db, a.arquivo)
