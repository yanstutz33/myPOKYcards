"""
Agrega catalogo + indice + precos num JSON para o painel.

Isto NAO e um relatorio de mercado. E um painel do estado do proprio
sistema: o que ja foi coberto, o que falta, e quao fresco esta o dado. Um
painel que so mostra numero bonito esconde justamente o que precisa de
atencao.

Por isso cada metrica vem com o denominador. "4.691 cartas com preco" nao
diz nada; "4.691 de 12.962 internacionais" diz.

Uso:
    python export_dashboard.py --out web/data/dashboard.json
"""

from __future__ import annotations

import argparse
import json
import sqlite3
from datetime import datetime, timezone
from pathlib import Path


def build(cards_db: Path, hashes_db: Path, prices_db: Path, out: Path) -> dict:
    c = sqlite3.connect(f"file:{cards_db}?mode=ro", uri=True)
    if hashes_db.exists():
        c.execute(f"ATTACH DATABASE 'file:{hashes_db}?mode=ro' AS hx")
    if prices_db.exists():
        c.execute(f"ATTACH DATABASE 'file:{prices_db}?mode=ro' AS px")
    q = lambda s, a=(): c.execute(s, a).fetchone()[0]  # noqa: E731

    catalogo = {
        "cartas": q("SELECT COUNT(*) FROM cards"),
        "sets": q("SELECT COUNT(*) FROM sets"),
        "cartas_por_regiao": {
            r[0]: r[1] for r in c.execute(
                "SELECT region, COUNT(*) FROM cards GROUP BY region")
        },
        "sets_por_regiao": {
            r[0]: r[1] for r in c.execute(
                "SELECT region, COUNT(*) FROM sets GROUP BY region")
        },
        "idiomas": [
            {"lang": r[0], "cartas": r[1]} for r in c.execute(
                "SELECT lang, COUNT(*) n FROM card_names GROUP BY lang ORDER BY n DESC")
        ],
        "colisoes_tratadas": q("SELECT COUNT(*) FROM collisions"),
    }

    reconhecimento = None
    if hashes_db.exists():
        com_hash = q("SELECT COUNT(*) FROM hx.hashes")
        sem_img = q("SELECT COUNT(*) FROM hx.failures")
        reconhecimento = {
            "com_hash": com_hash,
            "sem_imagem": sem_img,
            "total": com_hash + sem_img,
            # A lacuna de imagem e quase toda asiatica; separar por regiao e
            # o que transforma "84% de cobertura" numa informacao acionavel.
            "por_regiao": [
                {"regiao": r[0], "com_hash": r[1], "sem_imagem": r[2]}
                for r in c.execute("""
                    SELECT cd.region,
                           SUM(CASE WHEN h.card_id IS NOT NULL THEN 1 ELSE 0 END),
                           SUM(CASE WHEN f.card_id IS NOT NULL THEN 1 ELSE 0 END)
                    FROM cards cd
                    LEFT JOIN hx.hashes   h ON h.card_id = cd.card_id
                    LEFT JOIN hx.failures f ON f.card_id = cd.card_id
                    GROUP BY cd.region""")
            ],
        }

    precos = None
    if prices_db.exists():
        alvo = q("""SELECT COUNT(*) FROM cards
                    WHERE region='intl'
                      AND (tcgplayer_id IS NOT NULL OR cardmarket_id IS NOT NULL)""")
        consultadas = q("""SELECT COUNT(*) FROM px.fetch_log f
                           JOIN cards cd ON cd.card_id = f.card_id
                           WHERE cd.region='intl'""")
        precos = {
            "linhas": q("SELECT COUNT(*) FROM px.prices"),
            "cartas_com_preco": q("SELECT COUNT(DISTINCT card_id) FROM px.prices"),
            "intl_alvo": alvo,
            "intl_consultadas": consultadas,
            "por_kind": {r[0]: r[1] for r in c.execute(
                "SELECT kind, COUNT(*) FROM px.prices GROUP BY kind")},
            "por_fonte": {r[0]: r[1] for r in c.execute(
                "SELECT source, COUNT(DISTINCT card_id) FROM px.prices GROUP BY source")},
            "falhas_coleta": q("SELECT COUNT(*) FROM px.fetch_log WHERE ok=0"),
            # Heartbeat: sem isto, coletor morto parece coletor ocioso.
            "ultima_coleta": q("SELECT MAX(tried_at) FROM px.fetch_log") or None,
            "mais_caras": [
                {"card_id": r[0], "nome": json.loads(r[3]).get("en") or "?",
                 "set": r[4], "valor": round(r[1], 2), "moeda": r[2]}
                for r in c.execute("""
                    SELECT p.card_id, MAX(p.value), p.currency, cd.names_json, cd.set_id
                    FROM px.prices p JOIN cards cd ON cd.card_id = p.card_id
                    WHERE p.kind='sold'
                    GROUP BY p.card_id
                    ORDER BY MAX(p.value) DESC LIMIT 12""")
            ],
        }

    c.close()
    data = {
        "gerado_em": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "catalogo": catalogo,
        "reconhecimento": reconhecimento,
        "precos": precos,
    }
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"painel -> {out}")
    print(f"  catalogo: {catalogo['cartas']} cartas, {catalogo['sets']} sets")
    if reconhecimento:
        r = reconhecimento
        print(f"  hashes:   {r['com_hash']}/{r['total']} "
              f"({100*r['com_hash']/r['total']:.0f}%)")
    if precos:
        p = precos
        print(f"  precos:   {p['cartas_com_preco']} cartas, "
              f"intl {p['intl_consultadas']}/{p['intl_alvo']} consultadas")
    return data


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--cards", default=Path("data/cards.db"), type=Path)
    ap.add_argument("--hashes", default=Path("data/hashes.db"), type=Path)
    ap.add_argument("--prices", default=Path("data/prices.db"), type=Path)
    ap.add_argument("--out", default=Path("web/data/dashboard.json"), type=Path)
    a = ap.parse_args()
    build(a.cards, a.hashes, a.prices, a.out)
