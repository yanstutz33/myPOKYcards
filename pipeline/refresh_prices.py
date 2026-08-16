"""
Atualizacao diaria de preco, para rodar em maquina descartavel.

O que precisa existir e o que nao precisa
-----------------------------------------
NAO precisa: `hashes.db` (8 MB, horas para reconstruir) nem `index.bin`.
O indice de reconhecimento nao muda quando o preco muda — ele ja esta
publicado e fica onde esta. Este script toca apenas em `prices.json`,
`fx.json` e a parte de preco do `dashboard.json`.

A lista de cartas a exibir vem do `cards.json` JA PUBLICADO, baixado do
site. E por isso que o `hashes.db` e dispensavel aqui.

PRECISA: `cards.db` (reconstruivel em 2 min) e o historico
(`price_history.csv.gz`, 0,32 MB, versionado). O historico e a unica coisa
insubstituivel: um dia perdido e perdido para sempre.

Uso:
    python refresh_prices.py --site https://yanstutz33.github.io/myPOKYcards
"""

from __future__ import annotations

import argparse
import gzip
import json
import subprocess
import sys
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent


def rodar(titulo: str, *args: str) -> None:
    print(f"\n=== {titulo} ===", flush=True)
    r = subprocess.run([sys.executable, *args], cwd=RAIZ)
    if r.returncode != 0:
        sys.exit(f"falhou: {' '.join(args)}")


def baixar_json(url: str) -> dict | None:
    try:
        with urllib.request.urlopen(url, timeout=60) as r:
            bruto = r.read()
        if url.endswith(".gz"):
            bruto = gzip.decompress(bruto)
        return json.loads(bruto)
    except Exception as exc:  # noqa: BLE001
        print(f"  ! não consegui baixar {url}: {type(exc).__name__}")
        return None


def main(site: str, stale_days: int, workers: int, saida: Path) -> None:
    saida.mkdir(parents=True, exist_ok=True)

    # A lista de cartas exibíveis vem do site publicado. Se ele estiver fora
    # do ar, abortar é melhor que gerar um prices.json com escopo errado.
    cards = baixar_json(f"{site}/data/cards.json")
    if not cards or not cards.get("ids"):
        sys.exit("não foi possível ler o cards.json publicado — abortando")
    ids = set(cards["ids"])
    print(f"{len(ids)} cartas no índice publicado")

    rodar("histórico: importando a série acumulada",
          "pipeline/history_io.py", "importar")
    rodar(f"preços: reconsultando o que tem mais de {stale_days} dia(s)",
          "pipeline/fetch_prices.py", "--region", "intl",
          "--workers", str(workers), "--stale-days", str(stale_days))
    rodar("histórico: exportando a série atualizada",
          "pipeline/history_io.py", "exportar")
    rodar("câmbio", "pipeline/fetch_fx.py", "--out", str(saida / "fx.json"))

    # --- prices.json, restrito às cartas que o site sabe exibir -----------
    print("\n=== preços: gerando prices.json ===")
    sys.path.insert(0, str(RAIZ / "pipeline"))
    import sqlite3
    from price_model import leitura  # noqa: PLC0415

    conn = sqlite3.connect(f"file:{RAIZ / 'data' / 'prices.db'}?mode=ro", uri=True)
    payload = {}
    for (card_id,) in conn.execute("SELECT DISTINCT card_id FROM prices"):
        if card_id not in ids:
            continue
        r = leitura(conn, card_id)
        if not r.get("tem_preco"):
            continue
        mercados = [
            {"v": m["variante"], "f": m["fonte"], "c": m["moeda"],
             "ref": m["referencia"], "faixa": m["faixa"],
             # Sem o carimbo ISO completo: a interface só usa a IDADE, e o
             # timestamp custava 26% do arquivo que o celular baixa e parseia.
             "idade": m["idade_dias"]}
            for m in r["mercados"] if m["referencia"] is not None
        ]
        if mercados:
            payload[card_id] = mercados
    conn.close()

    bruto = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode()
    (saida / "prices.json").write_bytes(bruto)
    with gzip.open(saida / "prices.json.gz", "wb", compresslevel=9) as fh:
        fh.write(bruto)
    print(f"  {len(payload)} cartas  ({len(bruto)/1024/1024:.2f} MB)")

    # --- dashboard.json: preserva o bloco de reconhecimento ---------------
    # Ele descreve o índice, que não muda numa atualização de preço. Recalcular
    # sem o hashes.db zeraria a seção e o painel diria que o leitor não existe.
    print("\n=== painel ===")
    antigo = baixar_json(f"{site}/data/dashboard.json") or {}
    subprocess.run([sys.executable, "pipeline/export_dashboard.py",
                    "--out", str(saida / "dashboard.json")], cwd=RAIZ, check=True)
    novo = json.loads((saida / "dashboard.json").read_text(encoding="utf-8"))
    if novo.get("reconhecimento") is None and antigo.get("reconhecimento"):
        novo["reconhecimento"] = antigo["reconhecimento"]
        print("  bloco de reconhecimento preservado do painel publicado")
    novo["gerado_em"] = datetime.now(timezone.utc).isoformat(timespec="seconds")
    (saida / "dashboard.json").write_text(
        json.dumps(novo, ensure_ascii=False, indent=1), encoding="utf-8")

    print(f"\npronto. Arquivos para publicar em {saida}:")
    for f in sorted(saida.iterdir()):
        print(f"  {f.name}  ({f.stat().st_size/1024:.0f} KB)")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--site", default="https://yanstutz33.github.io/myPOKYcards")
    ap.add_argument("--stale-days", default=1, type=int)
    ap.add_argument("--workers", default=10, type=int)
    ap.add_argument("--saida", default=Path("web/data"), type=Path)
    a = ap.parse_args()
    main(a.site, a.stale_days, a.workers, a.saida)
