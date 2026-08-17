"""
Indice de hashes perceptuais das cartas -> hashes.db.

Baixa a imagem de cada carta do CDN do TCGdex, calcula cinco hashes de 64
bits e descarta a imagem. O indice inteiro cabe em poucos MB, roda offline
no celular e e o que transforma "foto de carta" em "card_id".

Hashes calculados por carta:
    phash    DCT 32x32 -> 8x8 (sem o termo DC). Robusto a brilho e escala.
    dhash    gradiente horizontal 9x8. Robusto a contraste.
    ahash    media 8x8. Fraco sozinho, bom como desempate.
    dhash_r/g/b  gradiente por canal. Separa cartas de layout igual e
                 paleta diferente — o caso que derruba hash em escala de
                 cinza.

E resumivel: rodar de novo so pega o que falta. Falha de download vira
linha em `failures`, nunca silencio.

Uso:
    python build_hash_index.py --cards data/cards.db --out data/hashes.db
    python build_hash_index.py ... --limit 200          # piloto
    python build_hash_index.py ... --set swsh3          # um set so
"""

from __future__ import annotations

import argparse
import io
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import numpy as np
from PIL import Image

CDN = "https://assets.tcgdex.net"
UA = "myPOKYcards/0.1 (indexador de catalogo; github.com/yanstutz33/myPOKYcards)"

# Idioma da imagem por regiao. A arte e a mesma em todos os idiomas, entao
# uma impressao por carta basta para o match; o idioma real e resolvido
# depois por OCR (ver agente tcg-vision).
LANG_BY_REGION = {"intl": "en", "asia": "ja"}

# Ordem de tentativa quando o idioma principal devolve 404.
#
# O indexador tentava UM idioma por regiao e desistia. Medido numa amostra de
# 60 cartas hoje sem hash: 8% delas tem arte em algum outro idioma — pt, pt-br
# ou zh-tw. Nao e muito, mas sao ~900 cartas que o leitor simplesmente nao
# conseguia reconhecer, e o caso que levou a isto foi uma carta REAL do
# usuario (mep-047, Cyndaquil) que existe no catalogo e nao tinha hash.
#
# A arte e a mesma entre idiomas; muda o texto do nome e dos ataques. Isso
# desloca alguns bits do hash, mas hash de arte certa em outro idioma e
# incomparavelmente melhor que carta ausente do indice — sem hash a carta nao
# tem como ser achada, e o leitor devolve o vizinho mais parecido com ar de
# certeza. A coluna `lang` registra de onde veio cada uma.
FALLBACK_LANGS = {
    "intl": ["en", "pt", "pt-br", "es", "fr", "de", "it"],
    "asia": ["ja", "zh-tw", "zh-cn", "ko", "en"],
}


# ---------------------------------------------------------------- hashing

def _dct2(a: np.ndarray) -> np.ndarray:
    """DCT-II 2D por multiplicacao de matriz.

    scipy nao e dependencia — em 32x32 a matriz direta e instantanea e
    evita arrastar 40MB de binario para um app que precisa ser leve.
    """
    n = a.shape[0]
    k = np.arange(n)
    m = np.cos(np.pi * (2 * k[:, None] + 1) * k[None, :] / (2 * n))
    return m.T @ a @ m


def _bits_to_int(bits: np.ndarray) -> int:
    out = 0
    for b in bits.flatten():
        out = (out << 1) | int(b)
    return out


def phash(gray: Image.Image) -> int:
    a = np.asarray(gray.resize((32, 32), Image.LANCZOS), dtype=np.float64)
    d = _dct2(a)[:8, :8]
    # O termo DC carrega brilho medio e domina a mediana; fora.
    flat = d.flatten()[1:]
    return _bits_to_int(flat > np.median(flat))


def dhash(img: Image.Image) -> int:
    a = np.asarray(img.resize((9, 8), Image.LANCZOS), dtype=np.int16)
    return _bits_to_int(a[:, 1:] > a[:, :-1])


def ahash(gray: Image.Image) -> int:
    a = np.asarray(gray.resize((8, 8), Image.LANCZOS), dtype=np.float64)
    return _bits_to_int(a > a.mean())


def hashes_for(raw: bytes) -> dict[str, int]:
    im = Image.open(io.BytesIO(raw))
    im.load()
    if im.mode in ("RGBA", "LA", "P"):
        bg = Image.new("RGB", im.size, (255, 255, 255))
        bg.paste(im.convert("RGBA"), mask=im.convert("RGBA").split()[-1])
        im = bg
    else:
        im = im.convert("RGB")

    gray = im.convert("L")
    r, g, b = im.split()
    return {
        "phash": phash(gray),
        "dhash": dhash(gray),
        "ahash": ahash(gray),
        "dhash_r": dhash(r),
        "dhash_g": dhash(g),
        "dhash_b": dhash(b),
    }


# ---------------------------------------------------------------- fetching

def image_url(lang: str, serie: str, set_id: str, local_id: str, quality: str) -> str:
    return f"{CDN}/{lang}/{serie}/{set_id}/{local_id}/{quality}.png"


def fetch(url: str, timeout: int = 30) -> bytes:
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return resp.read()


# ---------------------------------------------------------------- schema

SCHEMA = """
PRAGMA journal_mode = WAL;

-- Hashes vao como hex de 16 chars, nao INTEGER: dhash tem 64 bits cheios e
-- estoura o INTEGER com sinal do SQLite (max 2^63-1). Hex tambem viaja
-- limpo para JSON e para o cliente no celular.
CREATE TABLE IF NOT EXISTS hashes (
    card_id  TEXT PRIMARY KEY,
    lang     TEXT NOT NULL,          -- idioma da imagem indexada
    phash    TEXT NOT NULL,
    dhash    TEXT NOT NULL,
    ahash    TEXT NOT NULL,
    dhash_r  TEXT NOT NULL,
    dhash_g  TEXT NOT NULL,
    dhash_b  TEXT NOT NULL,
    src_url  TEXT NOT NULL,
    built_at TEXT NOT NULL DEFAULT (datetime('now'))
);

-- Falha e dado, nao silencio: sem isso um indice pela metade parece pronto.
CREATE TABLE IF NOT EXISTS failures (
    card_id  TEXT PRIMARY KEY,
    url      TEXT NOT NULL,
    reason   TEXT NOT NULL,
    tried_at TEXT NOT NULL DEFAULT (datetime('now'))
);
"""


def pending(cards_db: Path, out_db: Path, only_set: str | None, limit: int | None,
            retry_failed: bool) -> list[tuple]:
    src = sqlite3.connect(f"file:{cards_db}?mode=ro", uri=True)
    rows = src.execute(
        """SELECT c.card_id, c.region, c.local_id, c.set_id, s.serie
           FROM cards c JOIN sets s USING(set_id)
           WHERE s.serie IS NOT NULL AND s.serie != 'null'
           ORDER BY c.card_id"""
    ).fetchall()
    src.close()

    if only_set:
        rows = [r for r in rows if r[3] == only_set]

    done = sqlite3.connect(out_db)
    have = {r[0] for r in done.execute("SELECT card_id FROM hashes")}
    if not retry_failed:
        have |= {r[0] for r in done.execute("SELECT card_id FROM failures")}
    done.close()

    todo = [r for r in rows if r[0] not in have]
    return todo[:limit] if limit else todo


def run(cards_db: Path, out_db: Path, workers: int, quality: str,
        only_set: str | None, limit: int | None, retry_failed: bool) -> None:
    out_db.parent.mkdir(parents=True, exist_ok=True)
    sqlite3.connect(out_db).executescript(SCHEMA)

    todo = pending(cards_db, out_db, only_set, limit, retry_failed)
    if not todo:
        print("nada pendente — indice ja completo para este filtro")
        return
    print(f"{len(todo)} cartas pendentes | {workers} workers | qualidade={quality}")

    # `timeout` NAO e detalhe: dezesseis threads escrevem no mesmo arquivo, e
    # sem ele qualquer disputa de lock derruba a rodada inteira com
    # "database is locked" — foi o que aconteceu, e as duas horas de download
    # anteriores foram perdidas. Com timeout, a thread espera a vez.
    conn = sqlite3.connect(out_db, check_same_thread=False, timeout=60)
    conn.execute("PRAGMA busy_timeout = 60000")
    lock = threading.Lock()
    stats = {"ok": 0, "fail": 0}
    t0 = time.monotonic()

    def marcar():
        """Progresso e commit. Chamada com o lock ja tomado, pelos dois caminhos."""
        n = stats["ok"] + stats["fail"]
        if n % 200:
            return
        conn.commit()
        taxa = n / max(time.monotonic() - t0, 1e-9)
        eta = (len(todo) - n) / max(taxa, 1e-9) / 60
        print(f"  {n}/{len(todo)}  ok={stats['ok']} fail={stats['fail']}  "
              f"{taxa:.1f}/s  ETA {eta:.0f}min", flush=True)

    def work(row):
        card_id, region, local_id, set_id, serie = row
        idiomas = FALLBACK_LANGS.get(region, [LANG_BY_REGION.get(region, "en")])
        h = url = None
        ultima_falha = "sem tentativa"
        for lang in idiomas:
            url = image_url(lang, serie, set_id, local_id, quality)
            try:
                h = hashes_for(fetch(url))
                break
            except urllib.error.HTTPError as exc:
                ultima_falha = f"HTTP {exc.code}"
                if exc.code != 404:
                    break        # 500 ou 403 nao melhoram trocando de idioma
            except Exception as exc:  # noqa: BLE001 — uma carta ruim nao para o indice
                ultima_falha = str(exc)[:120]
                break
        if h is None:
            with lock:
                try:
                    conn.execute("INSERT OR REPLACE INTO failures(card_id,url,reason) VALUES (?,?,?)",
                                 (card_id, url, f"{ultima_falha} (tentou {len(idiomas)} idiomas)"))
                except sqlite3.OperationalError:
                    pass   # registrar a falha nao pode derrubar a rodada
                stats["fail"] += 1
                marcar()
            return
        with lock:
            conn.execute(
                """INSERT OR REPLACE INTO hashes
                   (card_id,lang,phash,dhash,ahash,dhash_r,dhash_g,dhash_b,src_url)
                   VALUES (?,?,?,?,?,?,?,?,?)""",
                (card_id, lang, *(f"{h[k]:016x}" for k in
                 ("phash", "dhash", "ahash", "dhash_r", "dhash_g", "dhash_b")), url),
            )
            conn.execute("DELETE FROM failures WHERE card_id = ?", (card_id,))
            stats["ok"] += 1
            marcar()

    with ThreadPoolExecutor(max_workers=workers) as pool:
        list(pool.map(work, todo))

    conn.commit()
    total = conn.execute("SELECT COUNT(*) FROM hashes").fetchone()[0]
    failed = conn.execute("SELECT COUNT(*) FROM failures").fetchone()[0]
    print(f"\nsessao: ok={stats['ok']} fail={stats['fail']} "
          f"em {(time.monotonic()-t0)/60:.1f}min")
    print(f"indice: {total} cartas | {failed} falhas pendentes -> {out_db}")
    if failed:
        print("\nmotivos mais comuns de falha:")
        for reason, n in conn.execute(
            "SELECT reason, COUNT(*) n FROM failures GROUP BY reason ORDER BY n DESC LIMIT 5"
        ):
            print(f"  {n:>6}  {reason}")
    conn.close()


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--cards", default=Path("data/cards.db"), type=Path)
    ap.add_argument("--out", default=Path("data/hashes.db"), type=Path)
    ap.add_argument("--workers", default=12, type=int)
    ap.add_argument("--quality", default="low", choices=["low", "high"],
                    help="low basta: tudo e reduzido a 32x32 antes de hashear")
    ap.add_argument("--set", dest="only_set", default=None)
    ap.add_argument("--limit", default=None, type=int)
    ap.add_argument("--retry-failed", action="store_true")
    a = ap.parse_args()
    if not a.cards.exists():
        sys.exit(f"catalogo nao encontrado: {a.cards} — rode ingest_tcgdex.py antes")
    run(a.cards, a.out, a.workers, a.quality, a.only_set, a.limit, a.retry_failed)
