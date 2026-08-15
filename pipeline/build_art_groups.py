"""
Agrupa cartas que compartilham a MESMA arte -> tabela `art_groups`.

Por que isto existe
-------------------
O autoteste mostrou que quase todo erro de top-1 e a mesma carta em outra
impressao: `sv09-119` (ingles) confundido com `SV9-077` (japones), `A1-006`
(TCG Pocket) com `sm1-2` (Sun & Moon). Arte identica, hash quase identico.

Duas hipoteses foram testadas e REFUTADAS antes de chegar aqui:

  1. Hash de regiao especifica (faixa do nome, tarja do numero). Nos pares
     dificeis a separacao foi de 14% para 20% dos bits — melhora marginal,
     nao resolve.
  2. Usar a imagem em alta resolucao. Praticamente sem efeito (51->50,
     43->46, 71->72 bits): quem limita e a grade do hash, nao a fonte.

A conclusao e que a ambiguidade nao e ruido a ser filtrado — e informacao
real sobre o mundo. A mesma arte existe mesmo em varias impressoes, e elas
tem precos diferentes. Entao o sistema para de tentar adivinhar e passa a
apresentar o grupo, deixando a escolha explicita.

Por que o ilustrador entra na regra
-----------------------------------
So a distancia de hash nao serve. Os pares reais vao de 3 a 46 bits
ponderados, e um limiar alto o bastante para pegar todos deixaria ~20 mil
pares falsos entre 458 milhoes — que o union-find fundiria em blobs.

A mesma arte tem, necessariamente, o mesmo ilustrador. Os 7 pares medidos
compartilham (Tomomi Ozaki, sowsow, Atsuko Nishida, Yuka Morii, Eri Yamaki,
Yuya Oka, Ryo Ueda), o campo cobre 93,6% do catalogo e tem 432 valores
distintos. Comparar so dentro do mesmo ilustrador corta o falso positivo em
ordens de grandeza — e reduz o trabalho de 458 milhoes de pares para ~2
milhoes.

Cartas sem ilustrador nao sao agrupadas: e melhor perder um grupo do que
inventar um.

Uso:
    python build_art_groups.py --limiar 40
"""

from __future__ import annotations

import argparse
import sqlite3
import time
from pathlib import Path

import numpy as np

FIELDS = ("phash", "dhash", "ahash", "dhash_r", "dhash_g", "dhash_b")
PESOS = np.array([1.0, 1.0, 0.4, 0.4, 0.4, 0.4])

SCHEMA = """
CREATE TABLE IF NOT EXISTS art_groups (
    card_id  TEXT PRIMARY KEY,
    group_id INTEGER NOT NULL,
    tamanho  INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_art_group ON art_groups(group_id);
"""

_POP = np.array([bin(i).count("1") for i in range(256)], dtype=np.uint8)


def popcount(x: np.ndarray) -> np.ndarray:
    return _POP[x.view(np.uint8).reshape(*x.shape, 8)].sum(axis=-1)


class UnionFind:
    def __init__(self, n: int):
        self.pai = list(range(n))

    def find(self, a: int) -> int:
        while self.pai[a] != a:
            self.pai[a] = self.pai[self.pai[a]]
            a = self.pai[a]
        return a

    def union(self, a: int, b: int) -> None:
        ra, rb = self.find(a), self.find(b)
        if ra != rb:
            self.pai[rb] = ra


def build(hashes_db: Path, cards_db: Path, limiar: float,
          limiar_fraco: float) -> None:
    conn = sqlite3.connect(hashes_db)
    conn.executescript(SCHEMA)
    # ATTACH com URI exige que a conexao principal tenha sido aberta com
    # uri=True; aqui ela nao foi, entao vai o caminho puro.
    conn.execute("ATTACH DATABASE ? AS cat", (str(cards_db),))

    rows = conn.execute(
        f"""SELECT h.card_id, {', '.join('h.' + f for f in FIELDS)},
                   c.illustrator, c.dex_id
            FROM hashes h JOIN cat.cards c ON c.card_id = h.card_id
            WHERE c.illustrator IS NOT NULL
            ORDER BY h.card_id"""
    ).fetchall()
    ids = [r[0] for r in rows]
    n = len(ids)
    mat = np.array([[int(r[1 + i], 16) for i in range(len(FIELDS))] for r in rows],
                   dtype=np.uint64)

    # Duas particoes com regras diferentes.
    #
    # Com dexId (mesma especie + mesmo ilustrador) a chave semantica e forte,
    # entao a distancia pode ser folgada: os pares reais chegam a 46 bits.
    #
    # Sem dexId (treinador, energia) so resta o ilustrador, que e fraco — um
    # ilustrador desenha dezenas de treinadores do mesmo set, com layout
    # quase igual. Ai a distancia precisa ser estrita, ou o union-find funde
    # 72 cartas diferentes num grupo so (medido).
    forte: dict[tuple, list[int]] = {}
    fraca: dict[str, list[int]] = {}
    for i, r in enumerate(rows):
        ilustrador, dex = r[-2], r[-1]
        if dex:
            forte.setdefault((ilustrador, dex), []).append(i)
        else:
            fraca.setdefault(ilustrador, []).append(i)

    print(f"{n} cartas com ilustrador")
    print(f"  chave forte (ilustrador+dexId): {len(forte)} grupos, limiar {limiar}")
    print(f"  chave fraca (so ilustrador)   : {len(fraca)} grupos, limiar {limiar_fraco}")

    uf = UnionFind(n)
    pares = 0
    t0 = time.monotonic()

    def ligar(idxs: list[int], corte: float) -> int:
        if len(idxs) < 2:
            return 0
        sub = mat[idxs]
        d = popcount(sub[:, None, :] ^ sub[None, :, :]).astype(np.float32) @ PESOS
        d[np.tril_indices(len(idxs))] = 1e9
        n_ = 0
        for a, b in zip(*np.nonzero(d <= corte)):
            uf.union(idxs[int(a)], idxs[int(b)])
            n_ += 1
        return n_

    for idxs in forte.values():
        pares += ligar(idxs, limiar)
    for idxs in fraca.values():
        pares += ligar(idxs, limiar_fraco)

    grupos: dict[int, list[int]] = {}
    for i in range(n):
        grupos.setdefault(uf.find(i), []).append(i)
    multi = {g: v for g, v in grupos.items() if len(v) > 1}

    conn.execute("DELETE FROM art_groups")
    conn.executemany(
        "INSERT INTO art_groups VALUES (?,?,?)",
        [(ids[i], g, len(v)) for g, v in multi.items() for i in v],
    )
    conn.commit()

    cartas = sum(len(v) for v in multi.values())
    print(f"\n{len(multi)} grupos de arte compartilhada, cobrindo {cartas} cartas "
          f"({100*cartas/n:.1f}%)")
    print(f"pares abaixo do limiar: {pares} | {(time.monotonic()-t0)/60:.1f}min")

    print("\nmaiores grupos:")
    for g, v in sorted(multi.items(), key=lambda kv: -len(kv[1]))[:5]:
        print(f"  {len(v)} impressões: {', '.join(ids[i] for i in v[:6])}"
              + (" …" if len(v) > 6 else ""))
    conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--hashes", default=Path("data/hashes.db"), type=Path)
    ap.add_argument("--cards", default=Path("data/cards.db"), type=Path)
    ap.add_argument("--limiar", default=40.0, type=float,
                    help="distancia maxima quando ilustrador E dexId coincidem")
    ap.add_argument("--limiar-fraco", default=8.0, type=float,
                    help="distancia maxima quando so o ilustrador coincide")
    a = ap.parse_args()
    build(a.hashes, a.cards, a.limiar, a.limiar_fraco)
