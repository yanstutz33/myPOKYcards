"""
Copia de seguranca do indice, fora desta maquina.

O problema
----------
`data/hashes.db` esta no .gitignore e existe SO na maquina do Yan. Ele nao
vai para o repositorio (banco binario de 8 MB que mudaria a cada rodada) e
nao vai para o gh-pages (la sobe `index.bin`, que e o indice ja compilado e
nao da para voltar dele para o banco). Perder a maquina custava a
reindexacao inteira.

Por que ele nao e simplesmente refeito
--------------------------------------
Refazer leva ~2h de rede, mas o custo real nao e o tempo: e que a
reconstrucao depende de CDNs de terceiros que MUDAM. Em 21/08/2026 medi
10.661 cartas cuja arte sumiu do TCGdex — se elas ainda estivessem la, o
indice teria mais. O que esta guardado hoje pode ser melhor do que o que uma
reconstrucao amanha conseguiria montar. Um indice construido e um registro
do que existia naquele dia, nao uma funcao pura das fontes.

Por que o par, e nao so o indice
--------------------------------
`hashes.db` guarda card_id; quem sabe o que cada card_id significa e
`cards.db`. Restaurar so o indice daria um banco que nao se verifica sozinho
— o invariante de orfaos precisa dos dois para rodar. Sao 4,7 MB a mais para
a copia ser conferivel, e copia que nao se confere nao e copia.

`prices.db` fica de fora de proposito, e vale ser exato sobre o porque: ele
nao e "reconstruido a partir do CSV". Sao 76 MB que `refresh_prices.py`
refaz do zero com uma coleta nova a cada dia — o robo diario prova isso toda
manha. O que seria insubstituivel ali e a SERIE historica, e essa esta em
`data/price_history.csv.gz`, versionada no git desde 15/08/2026.

Por que uma release so, reescrita
---------------------------------
Tag fixa `indice`, sobrescrita a cada execucao. Uma release por dia encheria
a pagina do projeto de ruido e ninguem saberia qual baixar. O que se quer
aqui e "o indice atual", nao um historico de indices.

Uso:
    python pipeline/salvar_indice.py --salvar
    python pipeline/salvar_indice.py --restaurar
    python pipeline/salvar_indice.py --conferir     # compara local x guardado
"""

from __future__ import annotations

import argparse
import gzip
import hashlib
import json
import shutil
import sqlite3
import subprocess
import sys
import tempfile
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent
DADOS = RAIZ / "data"
TAG = "indice"
BANCOS = ("hashes.db", "cards.db")
MANIFESTO = "manifesto.json"


def rodar(args: list[str], **kw) -> subprocess.CompletedProcess:
    return subprocess.run(args, capture_output=True, text=True, encoding="utf-8",
                          errors="replace", **kw)


def exigir_gh() -> None:
    r = rodar(["gh", "auth", "status"])
    if r.returncode != 0:
        raise SystemExit("gh nao esta autenticado. Rode: gh auth login")


def soma(caminho: Path) -> str:
    h = hashlib.sha256()
    with open(caminho, "rb") as f:
        for bloco in iter(lambda: f.read(1 << 20), b""):
            h.update(bloco)
    return h.hexdigest()


def contar(banco: Path) -> dict:
    """Numeros que dizem se a copia esta inteira.

    Byte a byte ja e conferido pelo sha256. Isto responde outra pergunta —
    "o que tem dentro?" — que e o que alguem quer saber ao olhar a release
    sem baixar nada.
    """
    if not banco.exists():
        return {}
    c = sqlite3.connect(f"file:{banco}?mode=ro", uri=True)
    fora = {}
    for tabela in ("hashes", "failures", "cards", "sets", "art_groups"):
        try:
            fora[tabela] = c.execute(f"SELECT COUNT(*) FROM {tabela}").fetchone()[0]
        except sqlite3.OperationalError:
            pass
    c.close()
    return fora


def montar_manifesto() -> dict:
    r = rodar(["git", "rev-parse", "--short", "HEAD"], cwd=RAIZ)
    from datetime import datetime, timezone
    m = {
        "gerado_em": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "commit": r.stdout.strip() if r.returncode == 0 else "?",
        "bancos": {},
    }
    for nome in BANCOS:
        p = DADOS / nome
        if not p.exists():
            raise SystemExit(f"banco ausente: {p}")
        m["bancos"][nome] = {
            "bytes": p.stat().st_size,
            "sha256": soma(p),
            "linhas": contar(p),
        }
    return m


def salvar() -> None:
    exigir_gh()
    m = montar_manifesto()

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        envios = []
        for nome in BANCOS:
            destino = tmp / f"{nome}.gz"
            # mtime=0 para o .gz nao mudar quando o conteudo nao mudou —
            # sem isso toda execucao subiria bytes diferentes por nada.
            with open(DADOS / nome, "rb") as e, gzip.GzipFile(destino, "wb", mtime=0) as s:
                shutil.copyfileobj(e, s)
            envios.append(destino)
            print(f"  {nome:12} {(DADOS/nome).stat().st_size/1048576:6.1f} MB"
                  f" -> {destino.stat().st_size/1048576:5.1f} MB comprimido")

        (tmp / MANIFESTO).write_text(json.dumps(m, indent=2), encoding="utf-8")
        envios.append(tmp / MANIFESTO)

        existe = rodar(["gh", "release", "view", TAG]).returncode == 0
        if not existe:
            r = rodar(["gh", "release", "create", TAG,
                       "--title", "Indice de reconhecimento",
                       "--notes", NOTAS.strip()])
            if r.returncode != 0:
                raise SystemExit(f"nao consegui criar a release:\n{r.stderr}")
            print(f"  release '{TAG}' criada")

        r = rodar(["gh", "release", "upload", TAG, *map(str, envios), "--clobber"])
        if r.returncode != 0:
            raise SystemExit(f"nao consegui enviar:\n{r.stderr}")

    print(f"\nguardado na release '{TAG}' (commit {m['commit']})")
    for nome, d in m["bancos"].items():
        print(f"  {nome:12} {d['linhas']}")


def restaurar(forcar: bool) -> None:
    exigir_gh()
    presentes = [n for n in BANCOS if (DADOS / n).exists()]
    if presentes and not forcar:
        raise SystemExit(
            f"ja existem aqui: {', '.join(presentes)}\n"
            "Restaurar os sobrescreve. Use --forcar se e isso mesmo que voce quer.")

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        r = rodar(["gh", "release", "download", TAG, "--dir", str(tmp)])
        if r.returncode != 0:
            raise SystemExit(f"nao consegui baixar:\n{r.stderr}")
        m = json.loads((tmp / MANIFESTO).read_text(encoding="utf-8"))
        print(f"copia de {m['gerado_em']} (commit {m['commit']})")

        DADOS.mkdir(parents=True, exist_ok=True)
        for nome in BANCOS:
            origem = tmp / f"{nome}.gz"
            destino = DADOS / nome
            with gzip.open(origem, "rb") as e, open(destino, "wb") as s:
                shutil.copyfileobj(e, s)

            # Conferir DEPOIS de escrever, e reclamar alto se nao bater.
            # Restauracao silenciosamente corrompida e pior que nenhuma:
            # o indice continuaria carregando e devolvendo lixo.
            obtido = soma(destino)
            esperado = m["bancos"][nome]["sha256"]
            if obtido != esperado:
                raise SystemExit(
                    f"ARQUIVO CORROMPIDO: {nome}\n"
                    f"  esperado {esperado}\n  obtido   {obtido}\n"
                    "Nao use este arquivo. Baixe de novo.")
            print(f"  {nome:12} {destino.stat().st_size/1048576:6.1f} MB  sha256 confere")

    print("\nrestaurado. Rode `python tests/test_invariantes.py` para conferir o conjunto.")


def conferir() -> None:
    """O que esta guardado ainda e o que esta aqui?"""
    exigir_gh()
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        r = rodar(["gh", "release", "download", TAG, "--dir", str(tmp),
                   "--pattern", MANIFESTO])
        if r.returncode != 0:
            raise SystemExit(f"nao ha copia guardada ainda ({TAG}).")
        guardado = json.loads((tmp / MANIFESTO).read_text(encoding="utf-8"))

    print(f"guardado : {guardado['gerado_em']}  commit {guardado['commit']}")
    igual = True
    for nome in BANCOS:
        p = DADOS / nome
        if not p.exists():
            print(f"  {nome:12} AUSENTE aqui")
            igual = False
            continue
        aqui, la = soma(p), guardado["bancos"][nome]["sha256"]
        if aqui == la:
            print(f"  {nome:12} identico")
        else:
            igual = False
            print(f"  {nome:12} DIFERENTE")
            print(f"    guardado: {guardado['bancos'][nome]['linhas']}")
            print(f"    aqui    : {contar(p)}")
    print("\nem dia." if igual else "\nDesatualizado — rode --salvar.")


NOTAS = """
Indice de reconhecimento do myPOKYcards: os bancos que o leitor usa para
identificar uma carta pela foto.

Esta release e **sobrescrita** a cada atualizacao. Ela nao e um historico —
e sempre "o indice atual".

- `hashes.db.gz` — pHash/dHash/aHash de cada carta, com a fonte da arte
- `cards.db.gz`  — o catalogo que da sentido aos card_id do indice
- `manifesto.json` — sha256, tamanhos e contagem de linhas

Para restaurar numa maquina limpa:

    git clone https://github.com/yanstutz33/myPOKYcards.git
    cd myPOKYcards
    python pipeline/salvar_indice.py --restaurar
    python tests/test_invariantes.py

Os invariantes de preco vao ficar de fora nessa conferencia (26 checagens em
vez de 33) porque `prices.db` nao esta nesta copia. Isso e de proposito: o
robo diario o refaz do zero com uma coleta nova. A serie historica, que
seria insubstituivel, esta versionada no repositorio em
`data/price_history.csv.gz`.
"""


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    g = ap.add_mutually_exclusive_group(required=True)
    g.add_argument("--salvar", action="store_true")
    g.add_argument("--restaurar", action="store_true")
    g.add_argument("--conferir", action="store_true")
    ap.add_argument("--forcar", action="store_true",
                    help="sobrescreve bancos que ja existem aqui")
    a = ap.parse_args()
    if a.salvar:
        salvar()
    elif a.restaurar:
        restaurar(a.forcar)
    else:
        conferir()
