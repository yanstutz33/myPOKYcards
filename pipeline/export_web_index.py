"""
Exporta catalogo + indice de hashes para o cliente web.

Dois arquivos, porque tem dois padroes de acesso muito diferentes:

  index.bin   6 hashes x 8 bytes por carta, contiguo. O matcher varre isso
              inteiro a cada frame; precisa ser um buffer que o JS le como
              BigUint64Array sem parsear nada.

  cards.json  metadados de exibicao. Lido uma vez, so para o card que o
              usuario confirmou.

A ordem das cartas e a MESMA nos dois: a posicao i em index.bin corresponde
a cards.json.ids[i]. E isso que permite o matcher devolver so um indice
inteiro e a UI resolver o resto.

Uso:
    python export_web_index.py --cards data/cards.db --hashes data/hashes.db --out web/data
"""

from __future__ import annotations

import argparse
import gzip
import json
import sqlite3
import struct
import sys
from pathlib import Path

MAGIC = b"YTCG"
VERSION = 1
FIELDS = ("phash", "dhash", "ahash", "dhash_r", "dhash_g", "dhash_b")

# Idioma preferido para o rotulo principal, por regiao da carta.
LABEL_ORDER = {
    "intl": ("pt", "pt-br", "en"),
    "asia": ("ja", "zh-tw", "ko", "en"),
}


def export(cards_db: Path, hashes_db: Path, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(f"file:{hashes_db}?mode=ro", uri=True)
    conn.execute(f"ATTACH DATABASE 'file:{cards_db}?mode=ro' AS cat")

    rows = conn.execute(
        f"""SELECT h.card_id, h.lang, {', '.join('h.' + f for f in FIELDS)},
                   c.region, c.set_id, c.local_id, c.rarity, c.variants_json,
                   c.names_json, s.names_json
            FROM hashes h
            JOIN cat.cards c ON c.card_id = h.card_id
            JOIN cat.sets  s ON s.set_id  = c.set_id
            ORDER BY h.card_id"""
    ).fetchall()
    conn.close()

    if not rows:
        sys.exit("indice vazio — rode build_hash_index.py antes")

    # Header de 16 bytes (4 magic + 2 versao + 4 contagem + 6 de padding).
    # O padding nao e decoracao: o cliente le os hashes como Uint32Array, que
    # exige byteOffset multiplo de 4. Com header de 10 o construtor estoura.
    buf = bytearray(MAGIC + struct.pack("<HI", VERSION, len(rows)) + b"\0" * 6)
    ids: list[str] = []
    meta: list[list] = []

    for r in rows:
        card_id, _lang = r[0], r[1]
        hashes = r[2:8]
        region, set_id, local_id, rarity, variants_json = r[8:13]
        card_names = json.loads(r[13])
        set_names = json.loads(r[14])

        buf += struct.pack("<6Q", *(int(h, 16) for h in hashes))
        ids.append(card_id)

        label = next((card_names[l] for l in LABEL_ORDER.get(region, ("en",))
                      if card_names.get(l)), None) or next(iter(card_names.values()), "?")
        set_label = (set_names.get("en") or set_names.get("ja")
                     or next(iter(set_names.values()), set_id))

        meta.append([
            label,
            set_label,
            local_id,
            rarity or "",
            region,
            json.loads(variants_json),
            # Todos os idiomas disponiveis: a UI usa isso para avisar que o
            # match e ambiguo entre impressoes, em vez de fingir certeza.
            sorted(card_names.keys()),
        ])

    (out_dir / "index.bin").write_bytes(buf)

    payload = {
        "version": VERSION,
        "count": len(ids),
        "fields": list(FIELDS),
        "schema": ["nome", "set", "numero", "raridade", "regiao", "variantes", "idiomas"],
        "ids": ids,
        "meta": meta,
    }
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    (out_dir / "cards.json").write_bytes(raw)
    with gzip.open(out_dir / "cards.json.gz", "wb", compresslevel=9) as fh:
        fh.write(raw)

    mb = lambda n: f"{n/1024/1024:.2f} MB"  # noqa: E731
    print(f"cartas exportadas : {len(ids)}")
    print(f"  index.bin       : {mb(len(buf))}")
    print(f"  cards.json      : {mb(len(raw))}")
    print(f"  cards.json.gz   : {mb((out_dir / 'cards.json.gz').stat().st_size)}")
    print(f"  -> {out_dir}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--cards", default=Path("data/cards.db"), type=Path)
    ap.add_argument("--hashes", default=Path("data/hashes.db"), type=Path)
    ap.add_argument("--out", default=Path("web/data"), type=Path)
    a = ap.parse_args()
    export(a.cards, a.hashes, a.out)
