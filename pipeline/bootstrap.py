"""
Prepara um clone novo para trabalhar.

O problema que isto resolve
--------------------------
`data/` e `web/data/` estao no .gitignore, entao quem clona o repositorio
recebe o codigo sem nenhum dado. Sem catalogo, quase todo script falha na
primeira linha; sem indice, o leitor abre e nao reconhece nada.

O caminho rapido, e por que ele e o padrao
------------------------------------------
Durante muito tempo o unico jeito de ter o indice era construi-lo: ~2h
baixando 30 mil imagens. Isso deixou de ser verdade quando o indice passou a
ser publicado numa release do GitHub — hoje sao 7 MB comprimidos e uns 10
segundos.

E melhor que rapido: mais FIEL. A reconstrucao depende de CDNs de terceiros
que mudam, e 10.661 cartas ja tem arte que sumiu da fonte. O indice
publicado e um registro do que existia no dia em que foi montado; refaze-lo
hoje daria um indice PIOR.

O preco e a cotacao vem do site publicado, que o robo atualiza todo dia.
Assim um clone novo abre com preco de hoje e o grafico com a serie inteira,
sem coletar nada.

Nada aqui exige autenticacao: o repositorio, a release e o site sao
publicos. Um agente de codigo ou uma sessao na nuvem chegam ao app rodando
sem nenhuma credencial.

Uso:
    python pipeline/bootstrap.py              # rapido: baixa tudo o que da
    python pipeline/bootstrap.py --construir  # monta do zero (horas)
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
import urllib.request
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
REPO_TCGDEX = "https://github.com/tcgdex/cards-database.git"

# Dados que o robo publica todo dia no gh-pages. Vem de la em vez de serem
# coletados: sao os MESMOS bytes que o site serve, e coletar de novo levaria
# 25 minutos para chegar a um resultado equivalente.
DO_SITE = ("prices.json", "fx.json", "dashboard.json", "numeros.json",
           "historico.json", "nomes.json")


def passo(titulo: str, cmd: list[str], cwd: Path | None = None) -> None:
    print(f"\n=== {titulo} ===", flush=True)
    r = subprocess.run(cmd, cwd=cwd or RAIZ)
    if r.returncode != 0:
        sys.exit(f"falhou: {' '.join(cmd)}")


def slug() -> str:
    r = subprocess.run(["git", "remote", "get-url", "origin"], cwd=RAIZ,
                       capture_output=True, text=True)
    if r.returncode == 0 and r.stdout.strip():
        corte = r.stdout.strip().removesuffix(".git").split("github.com")[-1].strip(":/")
        if corte.count("/") == 1:
            return corte
    return "yanstutz33/myPOKYcards"


def baixar_do_site() -> None:
    """Preco, cotacao e serie historica, do site que o robo mantem.

    Falha de um arquivo nao derruba o resto: a interface ja sabe abrir sem
    preco (mostra "sem dados de preco") e sem historico (nao desenha o
    grafico). Meio dado e melhor que nenhum, desde que a tela nao minta
    sobre o que tem.
    """
    user, _, nome = slug().partition("/")
    base = f"https://{user}.github.io/{nome}/data"
    destino = RAIZ / "web" / "data"
    destino.mkdir(parents=True, exist_ok=True)

    print(f"\n=== preco e cotacao, de {base} ===", flush=True)
    for arquivo in DO_SITE:
        try:
            req = urllib.request.Request(
                f"{base}/{arquivo}", headers={"User-Agent": "myPOKYcards/0.1"})
            with urllib.request.urlopen(req, timeout=180) as r, \
                    open(destino / arquivo, "wb") as f:
                shutil.copyfileobj(r, f)
            mb = (destino / arquivo).stat().st_size / 1048576
            print(f"  {arquivo:18} {mb:5.2f} MB")
        except Exception as exc:  # noqa: BLE001
            print(f"  {arquivo:18} nao veio ({str(exc)[:60]})")


def montar_catalogo(manter_fonte: Path | None) -> None:
    if (RAIZ / "data" / "cards.db").exists():
        print("cards.db já existe — pulando o catálogo (apague para refazer)")
        return
    fonte = manter_fonte or Path(tempfile.mkdtemp()) / "tcgdex"
    if not fonte.exists():
        passo("clonando o catálogo TCGdex (~110 MB)",
              ["git", "clone", "--depth", "1", "--quiet", REPO_TCGDEX, str(fonte)])
    passo("montando cards.db",
          [sys.executable, "pipeline/ingest_tcgdex.py",
           "--repo", str(fonte), "--out", "data/cards.db"])
    if manter_fonte is None:
        shutil.rmtree(fonte.parent, ignore_errors=True)


def main(construir: bool, precos: bool, manter_fonte: Path | None) -> None:
    (RAIZ / "data").mkdir(exist_ok=True)

    if construir:
        montar_catalogo(manter_fonte)
        passo("índice de hashes — HORAS de download",
              [sys.executable, "pipeline/build_hash_index.py", "--workers", "16"])
        passo("grupos de impressões indistinguíveis",
              [sys.executable, "pipeline/build_art_groups.py"])
    else:
        # `--restaurar` traz o PAR hashes.db + cards.db, então não há catálogo
        # a montar depois. Ele se recusa a sobrescrever banco existente, e é
        # bom que se recuse: quem já tem dado aqui não quer perdê-lo por um
        # bootstrap distraído.
        if (RAIZ / "data" / "hashes.db").exists():
            print("hashes.db já existe — pulando o índice (apague para rebaixar)")
            montar_catalogo(manter_fonte)
        else:
            passo("índice de reconhecimento, da release pública (~7 MB)",
                  [sys.executable, "pipeline/salvar_indice.py", "--restaurar"])

    if precos:
        passo("preços (~25 min)",
              [sys.executable, "pipeline/fetch_prices.py",
               "--region", "intl", "--workers", "10"])
        passo("taxas de câmbio (PTAX)", [sys.executable, "pipeline/fetch_fx.py"])

    passo("exportando índice para o navegador",
          [sys.executable, "pipeline/export_web_index.py"])

    # Depois do export, não antes: `export_web_index` escreve prices.json a
    # partir do prices.db local, que num clone novo não existe — e escreveria
    # por cima do arquivo bom que acabou de ser baixado.
    if not precos:
        baixar_do_site()

    print("\npronto. Para ver o app:")
    print("  python pipeline/servir.py --porta 8137")
    print("  http://localhost:8137")
    print("\nConferir o conjunto:")
    print("  python tests/test_invariantes.py")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--construir", action="store_true",
                    help="monta o índice do zero em vez de baixar (horas)")
    ap.add_argument("--precos", action="store_true",
                    help="coleta preços em vez de usar os publicados (~25 min)")
    ap.add_argument("--fonte", type=Path, default=None,
                    help="reaproveita um clone do cards-database em vez de baixar")
    a = ap.parse_args()
    main(construir=a.construir, precos=a.precos, manter_fonte=a.fonte)
