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
CDN = "https://assets.tcgdex.net"
FIELDS = ("phash", "dhash", "ahash", "dhash_r", "dhash_g", "dhash_b")

# Idioma preferido para o rotulo principal, por regiao da carta.
LABEL_ORDER = {
    "intl": ("pt", "pt-br", "en"),
    "asia": ("ja", "zh-tw", "ko", "en"),
}


def _export_prices(out_dir: Path, known_ids: set[str], prices_db: Path = Path("data/prices.db")) -> None:
    """Leituras de preco para as cartas que estao no indice.

    Vai num arquivo separado de proposito: o catalogo e estavel e o preco
    muda todo dia. Juntar os dois obrigaria a rebaixar o cache do catalogo
    ao ritmo do preco.

    Cada entrada carrega moeda, variante, fonte e data — a interface nao tem
    permissao de exibir numero sem isso.
    """
    if not prices_db.exists():
        print("  (sem prices.db — a tela vai mostrar 'sem dados de preco')")
        return

    sys.path.insert(0, str(Path(__file__).parent))
    from price_model import leitura  # noqa: PLC0415

    conn = sqlite3.connect(f"file:{prices_db}?mode=ro", uri=True)
    ids = [r[0] for r in conn.execute("SELECT DISTINCT card_id FROM prices")]

    payload = {}
    for card_id in ids:
        if card_id not in known_ids:
            continue  # carta sem hash: preco dela nunca seria exibido
        r = leitura(conn, card_id)
        if not r.get("tem_preco"):
            continue
        payload[card_id] = [
            {
                "v": m["variante"], "f": m["fonte"], "c": m["moeda"],
                "ref": m["referencia"], "faixa": m["faixa"],
                "em": m["atualizado_em"], "idade": m["idade_dias"],
            }
            for m in r["mercados"] if m["referencia"] is not None
        ]
        if not payload[card_id]:
            del payload[card_id]
    conn.close()

    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    (out_dir / "prices.json").write_bytes(raw)
    with gzip.open(out_dir / "prices.json.gz", "wb", compresslevel=9) as fh:
        fh.write(raw)
    print(f"  prices.json     : {len(raw)/1024/1024:.2f} MB  ({len(payload)} cartas)")


def _indices_por_grupo(ids: list[str], meta: list[list]) -> dict[str, list[int]]:
    out: dict[str, list[int]] = {}
    for i, m in enumerate(meta):
        g = m[8]
        if g != -1:
            out.setdefault(str(g), []).append(i)
    return out


def export(cards_db: Path, hashes_db: Path, out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)

    conn = sqlite3.connect(f"file:{hashes_db}?mode=ro", uri=True)
    conn.execute(f"ATTACH DATABASE 'file:{cards_db}?mode=ro' AS cat")

    rows = conn.execute(
        f"""SELECT h.card_id, h.lang, {', '.join('h.' + f for f in FIELDS)},
                   c.region, c.set_id, c.local_id, c.rarity, c.variants_json,
                   c.names_json, s.names_json, h.src_url
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

    # Grupos de impressoes que o reconhecimento por imagem NAO distingue.
    # Nao e "mesma arte": inclui os Unown, que diferem so por uma letra.
    grupo_de: dict[str, int] = {}
    try:
        gconn = sqlite3.connect(f"file:{hashes_db}?mode=ro", uri=True)
        grupo_de = dict(gconn.execute("SELECT card_id, group_id FROM art_groups"))
        gconn.close()
    except sqlite3.OperationalError:
        pass  # indice sem art_groups: a UI simplesmente nao mostra grupos

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

        # Caminho da arte no CDN de origem, nao a imagem. O site nunca
        # redistribui arte: quando precisa mostrar uma carta, aponta para a
        # fonte (que serve com Access-Control-Allow-Origin: *).
        # So o sufixo — o prefixo e reconstruido no cliente.
        caminho = r[15].removeprefix(f"{CDN}/").removesuffix("/low.png") if r[15] else ""

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
            caminho,
            grupo_de.get(card_id, -1),
        ])

    (out_dir / "index.bin").write_bytes(buf)
    _export_prices(out_dir, set(ids))

    payload = {
        "version": VERSION,
        "count": len(ids),
        "fields": list(FIELDS),
        "schema": ["nome", "set", "numero", "raridade", "regiao", "variantes",
                   "idiomas", "caminho_arte", "grupo"],
        "cdn": CDN,
        "ids": ids,
        "meta": meta,
        # grupo -> posicoes, para a UI listar as irmas sem varrer tudo.
        "grupos": _indices_por_grupo(ids, meta),
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
