"""
Publica `web/` no GitHub Pages, pelo branch `gh-pages`.

Por que um branch separado e nao a pasta `web/` do `main`:

  Os arquivos de dados (`index.bin`, `cards.json`, `prices.json`) sao
  derivados e somam ~6 MB, e o de precos muda TODO dia. Versiona-los no
  `main` incharia o historico com binario que ninguem vai revisar. O
  `gh-pages` e reescrito a cada publicacao com historico raso, entao o peso
  nao acumula.

E por que nao gerar no CI: reconstruir o indice exige baixar 30 mil imagens
do CDN, o que leva horas. O artefato pronto e a unica opcao pratica.

O deploy falha de proposito se faltar dado — publicar uma pagina que carrega
e nao reconhece nada e pior que nao publicar.

Uso:
    python deploy_pages.py
    python deploy_pages.py --dry-run
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

OBRIGATORIOS = [
    ("index.html", 1_000),
    ("app.js", 5_000),
    ("matcher.worker.js", 3_000),
    ("capture.js", 3_000),
    ("style.css", 3_000),
    ("tema.css", 2_000),
    ("scan.css", 2_000),
    ("pokedex.css", 4_000),
    ("detectar.js", 2_000),
    ("camera.js", 1_500),
    ("manifest.json", 300),
    ("sw.js", 1_500),
    ("pwa.js", 200),
    ("icone.svg", 200),
    ("tema.js", 500),
    ("painel.html", 500),
    ("colecao.html", 500),
    ("sobre.html", 2_000),
    ("data/numeros.json", 50),
    ("colecao.js", 1_000),
    ("data/index.bin", 1_000_000),
    ("data/cards.json", 1_000_000),
    ("data/dashboard.json", 500),
]


def git(*args: str, cwd: Path | None = None) -> str:
    r = subprocess.run(["git", *args], cwd=cwd, capture_output=True, text=True)
    if r.returncode != 0:
        raise RuntimeError(f"git {' '.join(args)}:\n{r.stderr.strip()}")
    return r.stdout.strip()


def conferir(web: Path) -> None:
    """Um site publicado sem indice carrega e nao reconhece nada."""
    faltando = []
    for rel, minimo in OBRIGATORIOS:
        f = web / rel
        if not f.exists():
            faltando.append(f"{rel} (ausente)")
        elif f.stat().st_size < minimo:
            faltando.append(f"{rel} ({f.stat().st_size} bytes, esperado >= {minimo})")
    if faltando:
        print("Publicacao abortada — arquivos faltando ou truncados:", file=sys.stderr)
        for f in faltando:
            print(f"  {f}", file=sys.stderr)
        print("\nGere os dados antes:\n"
              "  python pipeline/export_web_index.py\n"
              "  python pipeline/export_dashboard.py", file=sys.stderr)
        sys.exit(1)


def main(repo: Path, dry: bool) -> None:
    web = repo / "web"
    conferir(web)

    tamanho = sum(f.stat().st_size for f in web.rglob("*") if f.is_file())
    arquivos = sum(1 for f in web.rglob("*") if f.is_file())
    print(f"site: {arquivos} arquivos, {tamanho/1024/1024:.1f} MB")

    remoto = git("remote", "get-url", "origin", cwd=repo)
    commit = git("rev-parse", "--short", "HEAD", cwd=repo)

    if dry:
        print(f"(dry-run) publicaria em {remoto} branch gh-pages, a partir de {commit}")
        return

    with tempfile.TemporaryDirectory() as tmp:
        stage = Path(tmp) / "site"
        shutil.copytree(web, stage)

        # Carimba a versao do service worker com o commit.
        #
        # Sem isso o cache serve codigo velho apos cada publicacao — e o
        # sintoma e cruel: a pagina carrega, parece atual, e roda a versao
        # anterior. Custou uma depuracao inteira perseguindo um erro que ja
        # estava corrigido no disco.
        sw = stage / "sw.js"
        if sw.exists():
            sw.write_text(
                sw.read_text(encoding="utf-8").replace('const VERSAO = "v1";',
                                                        f'const VERSAO = "{commit}";'),
                encoding="utf-8")
        # Sem .nojekyll o Pages ignora arquivos e pastas iniciados por "_".
        (stage / ".nojekyll").write_text("", encoding="utf-8")

        git("init", "-q", "-b", "gh-pages", cwd=stage)
        git("config", "user.name", git("config", "user.name", cwd=repo), cwd=stage)
        git("config", "user.email", git("config", "user.email", cwd=repo), cwd=stage)
        git("add", "-A", cwd=stage)
        git("commit", "-q", "-m", f"Publica site a partir de {commit}", cwd=stage)
        # Historico raso e forcado: o branch e um artefato, nao um diario.
        git("push", "-q", "--force", remoto, "gh-pages", cwd=stage)

    print(f"publicado no branch gh-pages a partir de {commit}")
    slug = remoto.rstrip("/").removesuffix(".git").split("github.com")[-1].strip(":/")
    user, _, nome = slug.partition("/")
    print(f"URL: https://{user}.github.io/{nome}/")
    print("\nSe for a primeira vez, habilite em Settings > Pages > branch gh-pages.")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--repo", default=Path(__file__).resolve().parent.parent, type=Path)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    main(a.repo, a.dry_run)
