"""
Vocabulario de nomes para o OCR -> web/data/nomes.json(.gz)

Por que este arquivo existe
---------------------------
O leitor identifica carta comparando hash de imagem, e por isso e
estruturalmente incapaz de reconhecer as cartas que nao tem imagem em fonte
nenhuma. Ler o nome impresso e o unico caminho que nao depende de imagem de
referencia — e o catalogo ja sabe o nome de todas as 41.694.

Por que NAO basta o rotulo que cards.json ja exporta
----------------------------------------------------
`cards.json` traz UM nome por carta, escolhido por regiao (portugues para
internacional, japones para asia). O OCR le o que esta impresso na carta que
a pessoa tem na mao, e essa carta pode estar em qualquer idioma.

Medido na bancada: "Martelo Avancado" foi lido como "nammer" (de "Enhanced
Hammer", a arte inglesa) e nao casou com nada; "Moltres de Galar" foi lido
como "Galarian Moltres"; "Persian ex da Equipe Rocket" como "Team Rocket's
Persian ex". Nos tres casos o OCR acertou a leitura e o casamento falhou
porque o vocabulario so tinha o rotulo em portugues.

Aqui entram TODOS os idiomas: 5.814 nomes distintos contra 5.057 do rotulo,
por 0,11 MB comprimido.

O que fica de fora, e por que
-----------------------------
Nomes com menos de 4 letras. Sem esse corte eles vencem qualquer comparacao
por contencao — "Aerodactyl V" foi lido corretamente e perdeu para uma carta
chamada "a", com 100%. O catalogo tem cartas de uma e duas letras (energias e
promos antigas) e elas envenenavam toda a busca.

Nomes que normalizam para vazio tambem saem: japones e chines viram string
vazia ao remover o que nao e latino. Isso NAO e perda — OCR com dados de
idioma latino nao le esses alfabetos de qualquer forma, e fingir que le seria
pior que admitir o limite.

Uso:
    python pipeline/export_ocr_names.py
"""

from __future__ import annotations

import argparse
import gzip
import json
import re
import sqlite3
import unicodedata
from pathlib import Path

# Mesmo corte usado no cliente. Se um mudar sem o outro, o vocabulario
# exportado deixa de corresponder ao que a busca espera.
MIN_LETRAS = 4


def normalizar(s: str) -> str:
    """Minusculas, sem acento, so letras e digitos.

    Precisa ser identica a funcao do cliente: o casamento e feito sobre a
    forma normalizada dos dois lados, e qualquer divergencia aqui vira carta
    que nunca casa, sem erro nenhum aparecendo.
    """
    s = unicodedata.normalize("NFD", str(s).lower())
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", s)).strip()


def montar(cards_db: Path) -> dict[str, list[str]]:
    c = sqlite3.connect(f"file:{cards_db}?mode=ro", uri=True)
    nomes: dict[str, set[str]] = {}
    for card_id, nome in c.execute("SELECT card_id, name FROM card_names"):
        n = normalizar(nome)
        if len(n) >= MIN_LETRAS:
            nomes.setdefault(n, set()).add(card_id)
    c.close()
    return {k: sorted(v) for k, v in sorted(nomes.items())}


def main(cards_db: Path, out_dir: Path) -> None:
    vocab = montar(cards_db)
    out_dir.mkdir(parents=True, exist_ok=True)

    bruto = json.dumps(vocab, ensure_ascii=False, separators=(",", ":"))
    (out_dir / "nomes.json").write_text(bruto, encoding="utf-8")

    # mtime=0 para o arquivo ser identico entre execucoes com o mesmo dado —
    # sem isso cada publicacao vira um diff, e o cache do aparelho baixa de
    # novo 0,11 MB por nada.
    dados = bruto.encode("utf-8")
    with gzip.GzipFile(out_dir / "nomes.json.gz", "wb", mtime=0) as g:
        g.write(dados)

    cartas = len({cid for ids in vocab.values() for cid in ids})
    print(f"vocabulario OCR: {len(vocab)} nomes | {cartas} cartas alcancadas")
    print(f"  nomes.json    : {len(dados)/1048576:.2f} MB")
    print(f"  nomes.json.gz : {(out_dir / 'nomes.json.gz').stat().st_size/1048576:.2f} MB")
    print(f"  -> {out_dir}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--cards", default=Path("data/cards.db"), type=Path)
    ap.add_argument("--out", default=Path("web/data"), type=Path)
    a = ap.parse_args()
    main(a.cards, a.out)
