"""
Taxas de cambio oficiais (PTAX do Banco Central) -> web/data/fx.json.

O que isto NAO e
----------------
Nao e preco em real. Nenhuma fonte aberta cota carta Pokemon em BRL, e
converter dolar nao produz esse preco: o mercado brasileiro tem liquidez,
imposto, frete e cultura de precificacao proprios, e a diferenca em relacao
ao mercado americano nao e a taxa de cambio.

O que isto E
------------
Uma ordem de grandeza, rotulada como conversao, com a taxa e a data
visiveis. Serve para responder "isso e carta de dez reais ou de mil?" sem
mentir que sabe o preco no Brasil.

Fonte: PTAX/Olinda do Banco Central. Oficial, gratuita, sem chave.
Publicada em dias uteis — em fim de semana e feriado a ultima cotacao
disponivel e de dias antes, e a idade vai junto no arquivo para a interface
poder dizer isso.

Uso:
    python fetch_fx.py
"""

from __future__ import annotations

import argparse
import json
import urllib.request
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

BASE = ("https://olinda.bcb.gov.br/olinda/servico/PTAX/versao/v1/odata/"
        "CotacaoMoedaPeriodo(moeda=@moeda,dataInicial=@dataInicial,"
        "dataFinalCotacao=@dataFinalCotacao)")
MOEDAS = ("USD", "EUR", "JPY")


def cotacao(moeda: str, dias: int = 10) -> dict | None:
    """Ultima cotacao de venda publicada para a moeda.

    A janela de 10 dias existe porque o BCB nao publica em fim de semana
    nem feriado; pedir so o dia corrente devolveria vazio com frequencia.
    """
    hoje = date.today()
    ini = (hoje - timedelta(days=dias)).strftime("%m-%d-%Y")
    fim = hoje.strftime("%m-%d-%Y")
    url = (f"{BASE}?@moeda=%27{moeda}%27&@dataInicial=%27{ini}%27"
           f"&@dataFinalCotacao=%27{fim}%27&$format=json")
    with urllib.request.urlopen(url, timeout=30) as r:
        linhas = json.load(r)["value"]
    if not linhas:
        return None

    ultima = linhas[-1]
    # A PTAX cota por UMA unidade da moeda, inclusive o iene: o registro
    # traz cotacaoVenda 0,03281 para JPY (1.000 JPY = R$ 32,81). Supor que
    # o iene vinha por centena e dividir por 100 produzia R$ 0,0003 — um
    # real valendo 3.300 ienes.
    carimbo = ultima.get("dataHoraCotacao", "")
    return {
        "taxa": round(float(ultima["cotacaoVenda"]), 6),
        "em": carimbo[:19] or None,
        "unidade": f"1 {moeda}",
    }


def build(out: Path) -> None:
    payload = {
        "fonte": "PTAX / Banco Central do Brasil",
        "aviso": ("Conversão, não preço do mercado brasileiro. O mercado "
                  "nacional tem liquidez, imposto e frete próprios."),
        "buscado_em": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "taxas": {},
    }
    for moeda in MOEDAS:
        try:
            c = cotacao(moeda)
        except Exception as exc:  # noqa: BLE001
            print(f"  ! {moeda}: {type(exc).__name__} {str(exc)[:60]}")
            continue
        if c:
            payload["taxas"][moeda] = c
            print(f"  1 {moeda} = R$ {c['taxa']:.4f}   ({c['em']})")
        else:
            print(f"  ! {moeda}: sem cotação na janela")

    if not payload["taxas"]:
        # Sem taxa, a interface simplesmente nao mostra conversao. Melhor
        # isso do que gravar um arquivo vazio que parece valido.
        print("nenhuma taxa obtida — arquivo não gravado")
        return

    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"-> {out}")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", default=Path("web/data/fx.json"), type=Path)
    build(ap.parse_args().out)
