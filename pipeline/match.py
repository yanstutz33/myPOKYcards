"""
Busca de carta por imagem contra o indice de hashes.

Distancia de Hamming ponderada sobre os cinco hashes. Os pesos vem da
confiabilidade de cada um: pHash e dHash carregam o sinal, aHash e os
canais de cor desempatam.

Uso:
    python match.py --image foto.jpg
    python match.py --selftest          # prova que o indice discrimina
"""

from __future__ import annotations

import argparse
import io
import sqlite3
import sys
import urllib.request
from pathlib import Path

import numpy as np
from PIL import Image, ImageEnhance

sys.path.insert(0, str(Path(__file__).parent))
from build_hash_index import UA, hashes_for  # noqa: E402

FIELDS = ("phash", "dhash", "ahash", "dhash_r", "dhash_g", "dhash_b")
# pHash e dHash em escala de cinza sao o sinal principal. Os canais de cor
# entram com peso menor: separam cartas de layout igual sem dominar quando
# a foto tem dominante de cor da iluminacao do ambiente.
WEIGHTS = np.array([1.0, 1.0, 0.4, 0.4, 0.4, 0.4])
MAX_DIST = float(WEIGHTS.sum() * 64)

_POPCOUNT = np.array([bin(i).count("1") for i in range(256)], dtype=np.uint8)


def _popcount64(x: np.ndarray) -> np.ndarray:
    """Bits setados por elemento de um array uint64."""
    return _POPCOUNT[x.view(np.uint8).reshape(*x.shape, 8)].sum(axis=-1)


class Index:
    def __init__(self, db: Path):
        conn = sqlite3.connect(f"file:{db}?mode=ro", uri=True)
        rows = conn.execute(
            f"SELECT card_id, lang, {', '.join(FIELDS)} FROM hashes"
        ).fetchall()
        conn.close()
        if not rows:
            raise SystemExit(f"indice vazio: {db}")
        self.card_ids = [r[0] for r in rows]
        self.langs = [r[1] for r in rows]
        # (n_cartas, 6) de uint64
        self.mat = np.array(
            [[int(r[2 + i], 16) for i in range(len(FIELDS))] for r in rows],
            dtype=np.uint64,
        )

    def __len__(self) -> int:
        return len(self.card_ids)

    def query(self, h: dict[str, int], k: int = 5) -> list[tuple[str, str, float, float]]:
        q = np.array([h[f] for f in FIELDS], dtype=np.uint64)
        dist = _popcount64(self.mat ^ q).astype(np.float64)   # (n, 6)
        score = dist @ WEIGHTS
        top = np.argpartition(score, min(k, len(score) - 1))[:k]
        top = top[np.argsort(score[top])]
        return [
            (self.card_ids[i], self.langs[i], float(score[i]), 1.0 - score[i] / MAX_DIST)
            for i in top
        ]


def _fetch(url: str) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=30) as r:
        return r.read()


# ---------------------------------------------------------------- selftest

def _degrade(raw: bytes, kind: str) -> bytes:
    """Simula o que a camera de um celular faz com a carta."""
    im = Image.open(io.BytesIO(raw)).convert("RGB")
    w, h = im.size
    if kind == "jpeg":
        buf = io.BytesIO()
        im.save(buf, "JPEG", quality=55)
        return buf.getvalue()
    if kind == "pequena":
        im = im.resize((w // 4, h // 4), Image.LANCZOS)
    elif kind == "escura":
        im = ImageEnhance.Brightness(im).enhance(0.62)
    elif kind == "estourada":
        im = ImageEnhance.Brightness(im).enhance(1.45)
    elif kind == "torta":
        im = im.rotate(2.5, resample=Image.BICUBIC, expand=False, fillcolor=(255, 255, 255))
    elif kind == "cortada":
        m = int(min(w, h) * 0.035)
        im = im.crop((m, m, w - m, h - m))
    elif kind == "quente":  # luz amarelada de ambiente
        r, g, b = im.split()
        im = Image.merge("RGB", (ImageEnhance.Brightness(r).enhance(1.12), g,
                                 ImageEnhance.Brightness(b).enhance(0.85)))
    buf = io.BytesIO()
    im.save(buf, "PNG")
    return buf.getvalue()


def selftest(index: Index, hashes_db: Path, n_cards: int, seed: int = 7) -> int:
    """Amostra ALEATORIA com semente fixa.

    Amostrar por `ORDER BY card_id` media o pior caso e chamava de media: os
    primeiros ids em ordem alfabetica sao os do TCG Pocket (`A1-*`), um set
    inteiro de arte reimpressa de Sun & Moon. A acurácia caia para 75% e o
    numero descrevia aquele cluster, nao o catalogo.
    """
    conn = sqlite3.connect(f"file:{hashes_db}?mode=ro", uri=True)
    # Embaralhamento deterministico: multiplicador de Knuth sobre o rowid.
    # Mesma semente -> mesma amostra, entao a metrica e comparavel entre
    # rodadas sem ficar presa a uma fatia do alfabeto.
    sample = conn.execute(
        "SELECT card_id, src_url FROM hashes ORDER BY (rowid * 2654435761 + ?) % 1000003 LIMIT ?",
        (seed, n_cards),
    ).fetchall()
    conn.close()

    kinds = ["jpeg", "pequena", "escura", "estourada", "torta", "cortada", "quente"]
    print(f"indice: {len(index)} cartas | testando {len(sample)} cartas "
          f"x {len(kinds)} degradacoes\n")

    tally = {k: {"hit": 0, "n": 0, "conf": []} for k in kinds}
    misses = []
    for card_id, url in sample:
        try:
            raw = _fetch(url)
        except Exception as exc:  # noqa: BLE001
            print(f"  ! {card_id}: {exc}")
            continue
        for kind in kinds:
            got = index.query(hashes_for(_degrade(raw, kind)), k=3)
            t = tally[kind]
            t["n"] += 1
            if got[0][0] == card_id:
                t["hit"] += 1
                t["conf"].append(got[0][3])
            else:
                rank = next((i for i, g in enumerate(got) if g[0] == card_id), None)
                misses.append((card_id, kind, got[0][0], rank))

    print(f"{'degradacao':<12} {'acerto top-1':>13} {'confianca media':>17}")
    print("-" * 45)
    worst = 1.0
    for kind in kinds:
        t = tally[kind]
        if not t["n"]:
            continue
        acc = t["hit"] / t["n"]
        worst = min(worst, acc)
        conf = np.mean(t["conf"]) if t["conf"] else float("nan")
        print(f"{kind:<12} {acc:>12.1%} {conf:>17.1%}")

    if misses:
        print(f"\n{len(misses)} erros de top-1:")
        for card_id, kind, got, rank in misses[:10]:
            r = f"top-{rank+1}" if rank is not None else "fora do top-3"
            print(f"  {card_id} ({kind}) -> {got}   [correto em {r}]")

    print(f"\npior caso: {worst:.1%} de acerto em top-1")
    return 0 if worst >= 0.90 else 1


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--hashes", default=Path("data/hashes.db"), type=Path)
    ap.add_argument("--image", type=Path)
    ap.add_argument("--top", default=5, type=int)
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--sample", default=25, type=int)
    ap.add_argument("--seed", default=7, type=int)
    a = ap.parse_args()

    idx = Index(a.hashes)
    if a.selftest:
        sys.exit(selftest(idx, a.hashes, a.sample, a.seed))
    if not a.image:
        sys.exit("informe --image ou --selftest")

    for cid, lang, dist, conf in idx.query(hashes_for(a.image.read_bytes()), a.top):
        print(f"  {cid:<16} {lang:<3} dist={dist:>6.1f}  confianca={conf:.1%}")
