"""
Ingestao do catalogo TCGdex (repo MIT, offline) -> SQLite normalizado.

Por que parser proprio e nao a API: api.tcgdex.net estava retornando 502 em
2026-08-15, e a app nao pode depender de um servico de terceiros para o
catalogo base. O repo cards-database e MIT e contem tudo. A API fica como
fonte de atualizacao incremental, nao como dependencia critica.

Uso:
    python ingest_tcgdex.py --repo <caminho/cards-database> --out cards.db
"""

from __future__ import annotations

import argparse
import collections
import json
import re
import sqlite3
import sys
from pathlib import Path

# ---------------------------------------------------------------- parsing

# Campos "name: { en: "...", pt: "..." }" — bloco multilingue de um nivel.
_BLOCK_RE = re.compile(
    r"^\s*(?P<key>name|releaseDate|abbreviations|cardCount)\s*:\s*\{(?P<body>.*?)^\s*\}",
    re.MULTILINE | re.DOTALL,
)
_PAIR_RE = re.compile(
    r"""['"]?(?P<k>[A-Za-z][\w-]*)['"]?\s*:\s*(?P<v>"[^"]*"|'[^']*'|-?\d+)"""
)
_SCALAR_RE = re.compile(
    r"""^\s*(?P<key>id|rarity|illustrator|category|stage|suffix|regulationMark|hp|retreat|localId)\s*:\s*(?P<val>"[^"]*"|'[^']*'|-?\d+)""",
    re.MULTILINE,
)
_THIRDPARTY_RE = re.compile(r"(?P<src>cardmarket|tcgplayer)\s*:\s*(?P<id>\d+)")
# dexId e o numero na Pokedex. Independe de idioma, entao e a unica chave
# que liga a mesma especie entre a impressao inglesa e a japonesa.
_DEXID_RE = re.compile(r"dexId:\s*\[([\d,\s]*)\]")
_VARIANT_TYPE_RE = re.compile(r"type\s*:\s*['\"](?P<t>[\w-]+)['\"]")
_RELEASE_SCALAR_RE = re.compile(r"""^\s*releaseDate\s*:\s*["'](?P<v>[\d-]+)["']""", re.MULTILINE)


def _unquote(v: str):
    if v and v[0] in "\"'":
        return v[1:-1]
    return int(v)


def _blocks(src: str) -> dict[str, dict]:
    """Primeira ocorrencia de cada bloco vence.

    Critico: um arquivo de carta tem varios blocos `name:` — o da carta e
    depois um por ataque. Sobrescrever faria a carta herdar o nome do ultimo
    ataque.
    """
    out: dict[str, dict] = {}
    for m in _BLOCK_RE.finditer(src):
        key = m.group("key")
        if key in out:
            continue
        out[key] = {
            p.group("k"): _unquote(p.group("v")) for p in _PAIR_RE.finditer(m.group("body"))
        }
    return out


def _top_level_only(src: str) -> str:
    """Apaga tudo que esta aninhado, preservando offsets de linha.

    `id` e uma chave legitima de set/serie E tambem o codigo de idioma do
    indonesio dentro de blocos `name`. Sem mascarar o aninhado, a serie
    "Sword & Shield" era gravada como "Pedang & Perisai".
    """
    out, depth = [], 0
    for ch in src:
        if ch == "{":
            depth += 1
            out.append(ch)
        elif ch == "}":
            depth -= 1
            out.append(ch)
        elif depth > 1 and ch != "\n":
            out.append(" ")  # dentro do objeto raiz -> aninhado
        else:
            out.append(ch)
    return "".join(out)


def _scalars(src: str) -> dict:
    """Le so as chaves do objeto raiz; primeira ocorrencia vence."""
    out: dict = {}
    for m in _SCALAR_RE.finditer(_top_level_only(src)):
        out.setdefault(m.group("key"), _unquote(m.group("val")))
    return out


def parse_set(path: Path) -> dict:
    src = path.read_text(encoding="utf-8")
    b, s = _blocks(src), _scalars(src)
    release = b.get("releaseDate") or {}
    if not release:
        m = _RELEASE_SCALAR_RE.search(src)
        if m:
            release = {"*": m.group("v")}
    return {
        "id": s.get("id") or path.stem,
        "names": b.get("name", {}),
        "card_count": (b.get("cardCount") or {}).get("official"),
        "release_date": release,
        "abbreviations": b.get("abbreviations", {}),
        "third_party": {m.group("src"): int(m.group("id")) for m in _THIRDPARTY_RE.finditer(src)},
    }


def parse_card(path: Path) -> dict:
    src = path.read_text(encoding="utf-8")
    b, s = _blocks(src), _scalars(src)
    # variants ficam depois de "variants:"; thirdParty do card vive la dentro.
    vpos = src.find("variants:")
    vtail = src[vpos:] if vpos != -1 else ""
    m = _DEXID_RE.search(src)
    dex = ",".join(x.strip() for x in m.group(1).split(",") if x.strip()) if m else None

    return {
        "dex_id": dex or None,
        "local_id": str(s.get("localId") or path.stem),
        "names": b.get("name", {}),
        "rarity": s.get("rarity"),
        "illustrator": s.get("illustrator"),
        "category": s.get("category"),
        "hp": s.get("hp"),
        "regulation_mark": s.get("regulationMark"),
        "variants": sorted({m.group("t") for m in _VARIANT_TYPE_RE.finditer(vtail)}),
        "third_party": {m.group("src"): int(m.group("id")) for m in _THIRDPARTY_RE.finditer(vtail)},
    }


# ---------------------------------------------------------------- schema

SCHEMA = """
PRAGMA journal_mode = WAL;

-- Todo id que precisou ser renomeado fica registrado. Colisao silenciosa
-- ja custou 15 cartas sobrescritas por INSERT OR REPLACE.
CREATE TABLE IF NOT EXISTS collisions (
    final_id    TEXT PRIMARY KEY,
    declared_id TEXT NOT NULL,
    source_file TEXT NOT NULL,
    reason      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sets (
    set_id        TEXT PRIMARY KEY,
    region        TEXT NOT NULL,           -- 'intl' | 'asia'
    serie         TEXT,
    names_json    TEXT NOT NULL,
    card_count    INTEGER,
    release_json  TEXT,
    abbrev_json   TEXT,
    cardmarket_id INTEGER,
    tcgplayer_id  INTEGER
);

CREATE TABLE IF NOT EXISTS cards (
    card_id       TEXT PRIMARY KEY,        -- "<set_id>-<local_id>"
    set_id        TEXT NOT NULL REFERENCES sets(set_id),
    local_id      TEXT NOT NULL,
    region        TEXT NOT NULL,
    rarity        TEXT,
    illustrator   TEXT,
    category      TEXT,
    dex_id        TEXT,             -- numero(s) na Pokedex; chave entre idiomas
    hp            INTEGER,
    regulation_mark TEXT,
    variants_json TEXT,
    cardmarket_id INTEGER,
    tcgplayer_id  INTEGER,
    names_json    TEXT NOT NULL
);

-- Uma linha por (carta, idioma). E aqui que EN / PT / JA viram consultaveis.
CREATE TABLE IF NOT EXISTS card_names (
    card_id  TEXT NOT NULL REFERENCES cards(card_id),
    lang     TEXT NOT NULL,
    name     TEXT NOT NULL,
    PRIMARY KEY (card_id, lang)
);

CREATE INDEX IF NOT EXISTS idx_cards_set     ON cards(set_id);
CREATE INDEX IF NOT EXISTS idx_cards_rarity  ON cards(rarity);
CREATE INDEX IF NOT EXISTS idx_cards_dex     ON cards(dex_id);
CREATE INDEX IF NOT EXISTS idx_names_lang    ON card_names(lang, name);
"""


REGIONS = (("intl", "data"), ("asia", "data-asia"))


def discover(repo: Path) -> tuple[dict, dict, list]:
    """Varre o repo e resolve set_ids ANTES de gravar qualquer coisa.

    Duas fontes de colisao, ambas reais e ambas ja observadas:

    1. Entre regioes — `neo1`..`neo4` e `miscp` existem em ingles e em
       japones com o mesmo id. Colisao legitima: sao sets diferentes.
       Resolucao: o lado asiatico recebe prefixo `ja-`.

    2. Dentro da mesma regiao — erro de copiar-colar no upstream:
       `BW3b.ts` declara `id: 'BW3a'`, `AC1b.ts` declara `'AC1a'`,
       `CBB1C.ts` declara `'CSV1C'`. Resolucao: cai para o nome do arquivo.

    Determinismo importa: a regra depende so do conteudo do repo, entao o
    mesmo repo produz sempre os mesmos ids — e os card_ids ja indexados
    nao mudam de rodada para rodada.
    """
    series: dict[Path, str] = {}
    raw: list[tuple[str, Path, str]] = []  # (regiao, arquivo, id declarado)

    for region, folder in REGIONS:
        base = repo / folder
        if not base.is_dir():
            print(f"  ! pasta ausente: {base}", file=sys.stderr)
            continue
        for f in sorted(base.rglob("*.ts")):
            src = f.read_text(encoding="utf-8")
            if ": Serie =" in src[:400]:
                series[f.with_suffix("")] = _scalars(src).get("id")
            elif ": Set =" in src[:400]:
                raw.append((region, f, _scalars(src).get("id") or f.stem))

    # Um id declarado duas vezes DENTRO da mesma regiao nao e confiavel para
    # nenhum dos arquivos — quem "chega primeiro" seria decidido pela ordem
    # alfabetica, e AC1D.ts acabaria ficando com o id 'AC1a'. Nesse caso
    # todos caem para o nome do arquivo, que e a unica fonte estavel.
    dentro = collections.Counter((region, declared) for region, _, declared in raw)

    taken: dict[str, str] = {}     # id final -> regiao que o ocupou
    resolved: dict[Path, tuple[str, str]] = {}
    collisions: list[tuple] = []

    # intl primeiro: o lado internacional mantem o id declarado e o asiatico
    # e que cede. Sem isso a resolucao dependeria da ordem do sistema de
    # arquivos e mudaria entre rodadas.
    for region, f, declared in sorted(raw, key=lambda r: (r[0] != "intl", str(r[1]))):
        if dentro[(region, declared)] > 1:
            final = f.stem
            reason = "id duplicado dentro da regiao (bug do upstream)"
        else:
            final, reason = declared, None

        if final in taken and taken[final] != region:
            final = f"ja-{final}" if region == "asia" else f"intl-{final}"
            reason = "mesmo id usado nas duas regioes"

        n = 2
        while final in taken:  # rede de seguranca; nao deve disparar
            final, reason = f"{f.stem}-{n}", "colisao residual apos fallback"
            n += 1

        if reason:
            collisions.append((final, declared, str(f.relative_to(repo)), reason))
        taken[final] = region
        resolved[f] = (final, region)

    return series, resolved, collisions


def build(repo: Path, out: Path, langs: set[str] | None = None) -> None:
    if out.exists():
        out.unlink()
    conn = sqlite3.connect(out)
    conn.executescript(SCHEMA)

    series_ids, resolved, collisions = discover(repo)
    conn.executemany("INSERT INTO collisions VALUES (?,?,?,?)", collisions)
    if collisions:
        print(f"{len(collisions)} set_ids renomeados para evitar sobrescrita:")
        for final, declared, path, reason in collisions:
            print(f"  {declared!r} -> {final!r}  ({reason})  {path}")
        print()

    n_sets = n_cards = n_names = n_skip = 0
    for set_file, (set_id, region) in resolved.items():
        try:
            st = parse_set(set_file)
        except Exception as exc:  # noqa: BLE001 - arquivo malformado nao derruba o build
            print(f"  ! set {set_file.name}: {exc}", file=sys.stderr)
            continue

        # INSERT puro, nao OR REPLACE: depois de discover() nao pode haver
        # colisao, e se houver e melhor estourar que perder carta calado.
        conn.execute(
            "INSERT INTO sets VALUES (?,?,?,?,?,?,?,?,?)",
            (
                set_id, region, series_ids.get(set_file.parent),
                json.dumps(st["names"], ensure_ascii=False),
                st["card_count"],
                json.dumps(st["release_date"], ensure_ascii=False),
                json.dumps(st["abbreviations"], ensure_ascii=False),
                st["third_party"].get("cardmarket"),
                st["third_party"].get("tcgplayer"),
            ),
        )
        n_sets += 1

        card_dir = set_file.with_suffix("")
        if not card_dir.is_dir():
            continue  # set anunciado mas ainda sem cartas no repo

        for card_file in sorted(card_dir.glob("*.ts")):
            try:
                cd = parse_card(card_file)
            except Exception as exc:  # noqa: BLE001
                print(f"  ! card {card_file}: {exc}", file=sys.stderr)
                continue

            card_id = f"{set_id}-{cd['local_id']}"
            conn.execute(
                "INSERT INTO cards VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
                (
                    card_id, set_id, cd["local_id"], region,
                    cd["rarity"], cd["illustrator"], cd["category"],
                    cd["dex_id"], cd["hp"], cd["regulation_mark"],
                    json.dumps(cd["variants"]),
                    cd["third_party"].get("cardmarket"),
                    cd["third_party"].get("tcgplayer"),
                    json.dumps(cd["names"], ensure_ascii=False),
                ),
            )
            n_cards += 1
            for lang, name in cd["names"].items():
                if langs and lang not in langs:
                    n_skip += 1
                    continue
                conn.execute("INSERT INTO card_names VALUES (?,?,?)",
                             (card_id, lang, str(name)))
                n_names += 1

    conn.commit()
    print(f"sets={n_sets}  cards={n_cards}  nomes={n_names}"
          + (f"  (descartados {n_skip} de idiomas fora do escopo)" if n_skip else "")
          + f"  ->  {out}")

    print("\nCobertura por idioma:")
    for lang, cnt in conn.execute(
        "SELECT lang, COUNT(*) c FROM card_names GROUP BY lang ORDER BY c DESC"
    ):
        print(f"  {lang:<6} {cnt:>7}")
    conn.close()


# Escopo de mercado do projeto: ingles, japones, coreano, chines e
# portugues. `pt` e a traducao dentro do registro internacional; `pt-br` e a
# impressao brasileira. Os dois entram.
LANGS_PADRAO = "en,ja,ko,zh-tw,zh-cn,pt,pt-br"

if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", required=True, type=Path)
    ap.add_argument("--out", default=Path("cards.db"), type=Path)
    ap.add_argument("--langs", default=LANGS_PADRAO,
                    help="idiomas a indexar, separados por virgula; 'all' mantem todos")
    a = ap.parse_args()
    langs = None if a.langs.strip().lower() == "all" else {
        s.strip() for s in a.langs.split(",") if s.strip()
    }
    build(a.repo, a.out, langs)
