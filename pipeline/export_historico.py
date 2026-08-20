"""
Serie historica de preco -> web/data/historico.json(.gz)

Por que este arquivo existe
---------------------------
O robo coleta preco todo dia e guarda em data/price_history.csv.gz desde
2026-08-15. Sao centenas de milhares de pontos que nunca sairam do
repositorio: a interface mostra sempre o preco de HOJE, e a pergunta que todo
mundo faz com uma carta na mao — "isso esta subindo ou caindo?" — ficava sem
resposta.

E o unico dado aqui que nao se copia. Catalogo e cotacao do dia qualquer um
busca na fonte; serie historica so quem comecou antes tem, e ela cresce
sozinha a cada execucao do robo.

Formato, e por que este
-----------------------
Os dias saem uma vez, numa lista, e cada serie e um vetor de valores na mesma
ordem. Repetir a data em cada ponto multiplicaria o arquivo por tres sem
acrescentar nada — sao os mesmos cinco dias para todas as 20 mil cartas.

Valor ausente vira `null` em vez de sumir: buraco na serie e informacao
(naquele dia a fonte nao cotou a carta), e uma linha que pula o buraco sem
marcar sugere continuidade que nao existe.

A chave de cada serie e "variante|fonte", igual ao que prices.json ja usa na
ficha. Sem isso o grafico mostraria a soma de mercados diferentes em moedas
diferentes, que e o erro classico de agregador que este projeto evita desde o
inicio.

Uso:
    python pipeline/export_historico.py
"""

from __future__ import annotations

import argparse
import csv
import gzip
import json
from pathlib import Path

# So as metricas de REFERENCIA, que sao derivadas de venda concluida. Preco
# pedido em anuncio oscila com quem esta anunciando naquele dia e faria a
# serie parecer volatil sem que nada tenha acontecido no mercado.
METRICAS = {"marketPrice", "avg30"}

# Menos que isto nao e serie, e ponto solto. Desenhar linha com dois pontos
# sugere tendencia que nao existe.
MIN_PONTOS = 2

# Quantos dias recentes ficam em resolucao diaria. Antes disso, um ponto por
# semana.
#
# Isto NAO e economia prematura, e sim aritmetica do que ja esta acontecendo:
# hoje sao 5 dias e 0,42 MB comprimido, crescendo ~0,08 MB por dia. Em um ano
# o arquivo unico passaria de 25 MB comprimido, e ele e baixado inteiro para
# mostrar a serie de UMA carta.
#
# Reduzir o passado para semanal limita o crescimento a ~82 pontos por ano em
# vez de 365, e nao custa informacao que alguem va usar: para decidir venda,
# o que importa e o movimento recente em detalhe e a tendencia longa em traco
# grosso. Preco de carta nao oscila de forma relevante dentro de uma semana
# seis meses atras.
DIAS_DETALHADOS = 30


def carregar(csv_gz: Path):
    with gzip.open(csv_gz, "rt", encoding="utf-8") as f:
        for linha in csv.DictReader(f):
            if linha["metric"] in METRICAS:
                yield linha


def amostrar(dias: list[str]) -> list[str]:
    """Diario no periodo recente, semanal antes dele.

    Mantem sempre o primeiro e o ultimo dia: o primeiro porque e o inicio da
    serie e some se cair fora do passo semanal, o ultimo porque e o preco de
    hoje e nenhuma reducao pode custar isso.
    """
    if len(dias) <= DIAS_DETALHADOS:
        return dias
    recentes = dias[-DIAS_DETALHADOS:]
    antigos = dias[:-DIAS_DETALHADOS]
    semanais = antigos[::7]
    if antigos[0] not in semanais:
        semanais.insert(0, antigos[0])
    return semanais + recentes


def montar(csv_gz: Path) -> dict:
    dias: set[str] = set()
    bruto: dict[str, dict[str, dict[str, float]]] = {}
    moedas: dict[str, str] = {}

    for r in carregar(csv_gz):
        dias.add(r["dia"])
        chave = f"{r['variant']}|{r['source']}"
        bruto.setdefault(r["card_id"], {}).setdefault(chave, {})[r["dia"]] = float(r["value"])
        moedas[chave] = r["currency"]

    ordem = amostrar(sorted(dias))
    saida: dict[str, dict[str, list]] = {}
    for card_id, series in bruto.items():
        guardar = {}
        for chave, porDia in series.items():
            if len(porDia) < MIN_PONTOS:
                continue
            guardar[chave] = [porDia.get(d) for d in ordem]
        if guardar:
            saida[card_id] = guardar

    return {"dias": ordem, "moedas": moedas, "series": saida}


def main(csv_gz: Path, out_dir: Path) -> None:
    if not csv_gz.exists():
        raise SystemExit(f"historico nao encontrado: {csv_gz}")

    dados = montar(csv_gz)
    out_dir.mkdir(parents=True, exist_ok=True)

    bruto = json.dumps(dados, separators=(",", ":"))
    (out_dir / "historico.json").write_text(bruto, encoding="utf-8")

    # mtime=0 para o arquivo ser identico entre execucoes com o mesmo dado —
    # sem isso cada publicacao vira um diff e o aparelho rebaixa por nada.
    with gzip.GzipFile(out_dir / "historico.json.gz", "wb", mtime=0) as g:
        g.write(bruto.encode("utf-8"))

    n_series = sum(len(v) for v in dados["series"].values())
    print(f"historico: {len(dados['dias'])} dias "
          f"({dados['dias'][0]} a {dados['dias'][-1]})")
    print(f"  cartas com serie : {len(dados['series'])}")
    print(f"  series           : {n_series}")
    print(f"  historico.json   : {len(bruto)/1048576:.2f} MB")
    print(f"  historico.json.gz: {(out_dir/'historico.json.gz').stat().st_size/1048576:.2f} MB")
    print(f"  -> {out_dir}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--csv", default=Path("data/price_history.csv.gz"), type=Path)
    ap.add_argument("--out", default=Path("web/data"), type=Path)
    a = ap.parse_args()
    main(a.csv, a.out)
