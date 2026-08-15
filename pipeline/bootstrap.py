"""
Prepara um clone novo para trabalhar — inclusive numa sessao pela nuvem.

O problema que isto resolve
--------------------------
`data/` esta no .gitignore, entao quem clona o repo (voce pelo celular, uma
sessao do Claude Code na web, ou outra pessoa) recebe o codigo sem nenhum
banco. Sem catalogo, quase todo script falha logo na primeira linha.

Os tres estagios tem custos MUITO diferentes, e por isso sao separados:

    catalogo   ~2 min    clona o repo TCGdex e monta cards.db
    precos     ~25 min   consulta a API carta por carta
    imagens    ~2 h      baixa 30 mil imagens para gerar os hashes

O padrao (`--quick`) faz so o catalogo. E o suficiente para mexer em codigo,
consultar cartas e rodar testes — que e o que se faz do celular. Os estagios
caros ficam explicitos, para ninguem dispara-los sem querer numa conexao de
dados movel.

Uso:
    python pipeline/bootstrap.py             # so catalogo (rapido)
    python pipeline/bootstrap.py --precos    # + precos
    python pipeline/bootstrap.py --tudo      # + indice de imagens (horas)
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
REPO_TCGDEX = "https://github.com/tcgdex/cards-database.git"


def passo(titulo: str, cmd: list[str], cwd: Path | None = None) -> None:
    print(f"\n=== {titulo} ===", flush=True)
    r = subprocess.run(cmd, cwd=cwd or RAIZ)
    if r.returncode != 0:
        sys.exit(f"falhou: {' '.join(cmd)}")


def main(precos: bool, imagens: bool, manter_fonte: Path | None) -> None:
    (RAIZ / "data").mkdir(exist_ok=True)

    if (RAIZ / "data" / "cards.db").exists():
        print("cards.db já existe — pulando o catálogo (apague para refazer)")
    else:
        fonte = manter_fonte or Path(tempfile.mkdtemp()) / "tcgdex"
        if not fonte.exists():
            passo("clonando o catálogo TCGdex (~110 MB)",
                  ["git", "clone", "--depth", "1", "--quiet", REPO_TCGDEX, str(fonte)])
        passo("montando cards.db",
              [sys.executable, "pipeline/ingest_tcgdex.py",
               "--repo", str(fonte), "--out", "data/cards.db"])
        if manter_fonte is None:
            shutil.rmtree(fonte.parent, ignore_errors=True)

    passo("taxas de câmbio (PTAX)", [sys.executable, "pipeline/fetch_fx.py"])

    if imagens:
        passo("índice de hashes — HORAS de download",
              [sys.executable, "pipeline/build_hash_index.py", "--workers", "16"])
        passo("grupos de impressões indistinguíveis",
              [sys.executable, "pipeline/build_art_groups.py"])

    if precos:
        passo("preços (~25 min)",
              [sys.executable, "pipeline/fetch_prices.py", "--region", "intl", "--workers", "10"])

    if imagens:
        passo("exportando índice para o navegador",
              [sys.executable, "pipeline/export_web_index.py"])
    passo("painel", [sys.executable, "pipeline/export_dashboard.py"])

    print("\npronto.")
    if not imagens:
        print("O leitor precisa do índice de imagens: "
              "python pipeline/bootstrap.py --tudo (leva horas).")
    print("Consultar o catálogo:\n"
          "  sqlite3 data/cards.db \"SELECT card_id, rarity FROM cards LIMIT 5\"")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--precos", action="store_true", help="também coleta preços (~25 min)")
    ap.add_argument("--tudo", action="store_true", help="tudo, incluindo imagens (horas)")
    ap.add_argument("--fonte", type=Path, default=None,
                    help="reaproveita um clone do cards-database em vez de baixar")
    a = ap.parse_args()
    main(precos=a.precos or a.tudo, imagens=a.tudo, manter_fonte=a.fonte)
