"""
Modelo de valor: transforma linhas cruas de preco numa leitura exibivel.

A regra central e que nao existe "o preco da carta". Existe uma faixa, numa
moeda, numa variante, num mercado, com uma data. Esta camada monta isso e se
recusa a inventar o que falta.

Decisoes que vem das regras do agente tcg-precos:

* **Referencia = venda concluida.** `marketPrice` (TCGplayer) e `avg30`
  (Cardmarket) sao `kind='sold'`. Anuncio (`listing`) so entra como faixa,
  porque pedido nao e pagamento.
* **Faixa, nao ponto.** O `low` de anuncio e o piso realista; o `high` puro
  e lixo (um anuncio de 40 USD numa carta de 5 USD nao e o mercado). Usamos
  `mid` como teto da faixa exibida e guardamos o `high` a parte.
* **Nunca converter moeda para unificar.** USD e EUR saem lado a lado. A
  conversao para BRL, quando existir, sera exibicao com taxa e data visiveis.
* **Idade e parte do valor.** Preco sem idade nao pode ser exibido.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

# Metrica preferida para o valor de referencia, por fonte, em ordem.
REFERENCIA = {
    "tcgplayer": ["marketPrice"],
    "cardmarket": ["avg30", "avg7", "avg", "trend"],
}
PISO = {"tcgplayer": ["lowPrice", "directLowPrice"], "cardmarket": ["low"]}
TETO = {"tcgplayer": ["midPrice"], "cardmarket": ["avg7", "avg"]}


def _idade_dias(iso: str | None) -> float | None:
    if not iso:
        return None
    try:
        d = datetime.fromisoformat(iso.replace("Z", "+00:00"))
        if d.tzinfo is None:
            d = d.replace(tzinfo=timezone.utc)
        return (datetime.now(timezone.utc) - d).total_seconds() / 86400
    except ValueError:
        return None


def _primeiro(mapa: dict, chaves: list[str]):
    for k in chaves:
        if k in mapa:
            return mapa[k]
    return None


def leitura(conn: sqlite3.Connection, card_id: str) -> dict:
    """Devolve a leitura de preco de uma carta, por variante e mercado.

    A ausencia de preco e um resultado legitimo, com motivo — nunca zero.
    """
    linhas = conn.execute(
        """SELECT variant, source, metric, kind, currency, value, source_date
           FROM prices WHERE card_id = ?""",
        (card_id,),
    ).fetchall()

    if not linhas:
        return {"card_id": card_id, "tem_preco": False,
                "motivo": "sem cotacao nesta fonte", "mercados": []}

    # (variante, fonte) -> {metrica: valor}
    agrupado: dict[tuple[str, str], dict] = {}
    datas: dict[tuple[str, str], str] = {}
    moedas: dict[tuple[str, str], str] = {}
    for variant, source, metric, _kind, currency, value, source_date in linhas:
        chave = (variant, source)
        agrupado.setdefault(chave, {})[metric] = value
        datas[chave] = source_date
        moedas[chave] = currency

    mercados = []
    for (variant, source), metricas in sorted(agrupado.items()):
        ref = _primeiro(metricas, REFERENCIA.get(source, []))
        piso = _primeiro(metricas, PISO.get(source, []))
        teto = _primeiro(metricas, TETO.get(source, []))
        idade = _idade_dias(datas[(variant, source)])

        # A faixa tem que CONTER a referencia. Elas vem de metricas
        # diferentes (avg30 como referencia, avg7 como teto), entao um
        # mercado em queda produzia "R$ 0,18 (faixa 0,02-0,17)" — parece
        # bug na tela e derruba a confianca no numero inteiro.
        if piso is not None and teto is not None:
            if piso > teto:
                piso, teto = teto, piso
            if ref is not None:
                piso, teto = min(piso, ref), max(teto, ref)

        mercados.append({
            "variante": variant,
            "fonte": source,
            "moeda": moedas[(variant, source)],
            # `referencia` e derivada de venda; `faixa` e o que se pede hoje.
            "referencia": ref,
            "faixa": [piso, teto] if piso is not None and teto is not None else None,
            "maximo_anunciado": metricas.get("highPrice"),
            "atualizado_em": datas[(variant, source)],
            "idade_dias": round(idade, 1) if idade is not None else None,
            # Acima de 7 dias a interface tem que rotular como defasado em
            # vez de mostrar o numero puro.
            "defasado": idade is not None and idade > 7,
        })

    return {"card_id": card_id, "tem_preco": True, "mercados": mercados}


def resumo(leitura_dict: dict, variante_preferida: str | None = None) -> str | None:
    """Uma linha legivel para o topo do card, ou None se nao houver base.

    Escolhe o mercado com valor de referencia e menor idade. Nao mistura
    moedas nem faz media entre fontes.
    """
    if not leitura_dict.get("tem_preco"):
        return None
    candidatos = [m for m in leitura_dict["mercados"] if m["referencia"] is not None]
    if variante_preferida:
        preferidos = [m for m in candidatos if m["variante"] == variante_preferida]
        candidatos = preferidos or candidatos
    if not candidatos:
        return None
    m = min(candidatos, key=lambda x: (x["idade_dias"] is None, x["idade_dias"] or 0))
    simbolo = {"USD": "US$", "EUR": "€"}.get(m["moeda"], m["moeda"] + " ")
    txt = f"{simbolo} {m['referencia']:.2f}"
    if m["faixa"]:
        txt += f"  (faixa {simbolo} {m['faixa'][0]:.2f}–{m['faixa'][1]:.2f})"
    return f"{txt} · {m['variante']} · {m['fonte']}"


if __name__ == "__main__":
    import argparse
    import json
    from pathlib import Path

    ap = argparse.ArgumentParser()
    ap.add_argument("card_id")
    ap.add_argument("--db", default=Path("data/prices.db"), type=Path)
    a = ap.parse_args()

    conn = sqlite3.connect(f"file:{a.db}?mode=ro", uri=True)
    r = leitura(conn, a.card_id)
    print(json.dumps(r, indent=2, ensure_ascii=False))
    print("\nresumo:", resumo(r) or "sem base para resumo")
