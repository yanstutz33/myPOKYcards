"""
Invariantes do YAMI-TCG.

Cada teste aqui existe porque um bug REAL passou por ele. Nenhum deles
quebrava nada — todos apareceram porque um número não fechava. É esse o
padrão que este arquivo automatiza: se algo silencioso voltar, falha aqui
em vez de virar preço errado na tela de alguém.

Roda sem dependência externa:
    python tests/test_invariantes.py
"""

from __future__ import annotations

import json
import re
import sqlite3
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from checar_js import varrer  # noqa: E402

RAIZ = Path(__file__).resolve().parent.parent
DADOS = RAIZ / "data"

IDIOMAS_NO_ESCOPO = {"en", "ja", "ko", "zh-tw", "zh-cn", "pt", "pt-br"}

# Vocabulários de variante das duas fontes. O catálogo (TCGdex) e os preços
# (TCGplayer) usam nomes diferentes para a mesma coisa, e o desencontro
# avaliou um reverse holo de € 4,05 a € 0,41.
# Levantados do dado real, nao supostos. O catalogo mistura variante de
# acabamento (holo, reverse) com marcador de tiragem (shadowless, unlimited)
# e com erro de impressao (text-error, missing-hp) — so os tres primeiros
# tem preco proprio.
VARIANTE_CATALOGO = ['1995-1998-copyright', '1999-2000-copyright', '1999-copyright', '2019-copyright', '2020-copyright', 'aoki-error', 'blue-border', 'd-ink-dot-error', 'energy-symbol-error', 'evolution-box-error', 'glossy', 'gold-border', 'holo', 'japanese-back', 'lenticular', 'metal', 'missing-expansion-symbol', 'missing-hp', 'missing-retreat-cost', 'nintedo-error', 'no-e-reader', 'no-holo-error', 'no-rarity', 'normal', 'peelable-ditto', 'phanphy-error', 'rarity-error', 'reverse', 'shadowless', 'shadowless-red-cheek', 'shifted-energy-cost', 'text-error', 'unlimited']
VARIANTE_PRECO = ['1st-edition', '1st-edition-holofoil', 'holofoil', 'normal', 'reverse-holofoil', 'unlimited', 'unlimited-holofoil']

# So o que a fonte de preco realmente cota. `1st-edition` e `unlimited` sao
# tiragens da era WotC e tem preco separado no TCGplayer.
TRADUCAO = {
    "normal": "normal",
    "holo": "holofoil",
    "reverse": "reverse-holofoil",
    "unlimited": "unlimited",
    "1st-edition": "1st-edition",
}

falhas: list[str] = []
checagens = 0


def checar(condicao: bool, descricao: str, detalhe: str = "") -> None:
    global checagens
    checagens += 1
    if condicao:
        print(f"  ok    {descricao}")
    else:
        print(f"  FALHA {descricao}" + (f"\n          {detalhe}" if detalhe else ""))
        falhas.append(descricao)


def abrir(nome: str) -> sqlite3.Connection | None:
    p = DADOS / nome
    if not p.exists():
        print(f"  (pulando: {nome} não existe)")
        return None
    return sqlite3.connect(f"file:{p}?mode=ro", uri=True)


# ---------------------------------------------------------------- catálogo

def testar_catalogo() -> None:
    print("\nCATÁLOGO")
    c = abrir("cards.db")
    if not c:
        return
    q = lambda s: c.execute(s).fetchone()[0]  # noqa: E731

    cartas = q("SELECT COUNT(*) FROM cards")
    checar(cartas > 40000, f"catálogo com {cartas} cartas (esperado > 40.000)")

    # Regressão: séries eram classificadas como sets, e os sets delas viravam
    # cartas. A contagem inflava sem nenhum erro.
    dup = q("SELECT COUNT(*) FROM (SELECT card_id FROM cards GROUP BY card_id HAVING COUNT(*)>1)")
    checar(dup == 0, "nenhum card_id duplicado", f"{dup} duplicados")

    orfas = q("SELECT COUNT(*) FROM cards c LEFT JOIN sets s USING(set_id) WHERE s.set_id IS NULL")
    checar(orfas == 0, "nenhuma carta órfã de set", f"{orfas} órfãs")

    nomes_orfaos = q("""SELECT COUNT(*) FROM card_names n
                        LEFT JOIN cards c USING(card_id) WHERE c.card_id IS NULL""")
    checar(nomes_orfaos == 0, "nenhum nome órfão", f"{nomes_orfaos} órfãos")

    fora = [r[0] for r in c.execute("SELECT DISTINCT lang FROM card_names")
            if r[0] not in IDIOMAS_NO_ESCOPO]
    checar(not fora, "só idiomas no escopo do produto", f"fora: {fora}")

    # Regressão: `id` é o código do indonésio dentro de blocos `name`, e a
    # série "Sword & Shield" foi gravada como "Pedang & Perisai".
    suspeitos = [r[0] for r in c.execute(
        "SELECT DISTINCT serie FROM sets WHERE serie LIKE '% %' OR serie LIKE '%&%'")]
    checar(not suspeitos, "nenhuma série com nome traduzido no lugar do id",
           f"suspeitos: {suspeitos}")

    # Regressão: um arquivo de carta tem vários blocos `name:` — o da carta e
    # um por ataque. Sem "primeira ocorrência vence", a carta herdava o nome
    # do último ataque.
    #
    # Comprimento NÃO serve de sinal: "Arceus & Dialga & Palkia GX" e
    # "Archie's Ace in the Hole" são nomes reais. O sintoma específico é
    # nome começando com verbo de ataque.
    verbos = ("Attack", "Slash", "Strike", "Blast", "Punch", "Kick", "Beam")
    cond = " OR ".join(f"name LIKE '{v} %'" for v in verbos)
    frases = q(f"SELECT COUNT(*) FROM card_names WHERE lang='en' AND ({cond})")
    checar(frases == 0, "nenhum nome de carta parece nome de ataque",
           f"{frases} suspeitos")

    c.close()


# ---------------------------------------------------------------- índice

def testar_indice() -> None:
    print("\nÍNDICE DE RECONHECIMENTO")
    h = abrir("hashes.db")
    if not h:
        return
    h.execute("ATTACH DATABASE ? AS cat", (str(DADOS / "cards.db"),))
    q = lambda s: h.execute(s).fetchone()[0]  # noqa: E731

    total = q("SELECT COUNT(*) FROM hashes")
    checar(total > 25000, f"{total} cartas com hash (esperado > 25.000)")

    # Renomear um set deixa hash órfão apontando para card_id que não existe
    # mais. O leitor devolveria um id que a interface não sabe resolver.
    orfaos = q("""SELECT COUNT(*) FROM hashes h
                  LEFT JOIN cat.cards c USING(card_id) WHERE c.card_id IS NULL""")
    checar(orfaos == 0, "nenhum hash apontando para carta inexistente",
           f"{orfaos} órfãos — rode a purga antes de exportar")

    tamanho_errado = q("SELECT COUNT(*) FROM hashes WHERE LENGTH(phash) != 16 OR LENGTH(dhash) != 16")
    checar(tamanho_errado == 0, "todos os hashes com 16 dígitos hex",
           f"{tamanho_errado} malformados")

    try:
        grupos = q("SELECT COUNT(DISTINCT group_id) FROM art_groups")
        # Distância de hash sozinha fundia 72 cartas distintas num grupo só.
        maior = q("SELECT MAX(tamanho) FROM art_groups")
        checar(maior <= 20, f"maior grupo de impressões tem {maior} cartas (limite 20)",
               "grupos gigantes indicam limiar frouxo — ver build_art_groups.py")
        print(f"  info  {grupos} grupos de impressões indistinguíveis")
    except sqlite3.OperationalError:
        print("  (art_groups ainda não construído)")

    h.close()


# ---------------------------------------------------------------- preços

def testar_precos() -> None:
    print("\nPREÇOS")
    p = abrir("prices.db")
    if not p:
        return
    q = lambda s: p.execute(s).fetchone()[0]  # noqa: E731

    linhas = q("SELECT COUNT(*) FROM prices")
    checar(linhas > 100000, f"{linhas} cotações (esperado > 100.000)")

    # Preço sem proveniência é pior que preço nenhum: parece confiável.
    sem_moeda = q("SELECT COUNT(*) FROM prices WHERE currency IS NULL OR currency=''")
    checar(sem_moeda == 0, "toda cotação tem moeda", f"{sem_moeda} sem moeda")

    sem_data = q("SELECT COUNT(*) FROM prices WHERE fetched_at IS NULL")
    checar(sem_data == 0, "toda cotação tem data de coleta", f"{sem_data} sem data")

    kinds = {r[0] for r in p.execute("SELECT DISTINCT kind FROM prices")}
    checar(kinds <= {"listing", "sold", "derived"},
           "todo kind é listing, sold ou derived", f"inesperados: {kinds}")

    negativos = q("SELECT COUNT(*) FROM prices WHERE value <= 0")
    checar(negativos == 0, "nenhuma cotação zerada ou negativa", f"{negativos} inválidas")

    variantes = {r[0] for r in p.execute("SELECT DISTINCT variant FROM prices")}
    checar(variantes <= set(VARIANTE_PRECO),
           "variantes de preço no vocabulário esperado",
           f"inesperadas: {variantes - set(VARIANTE_PRECO)}")

    try:
        hist = q("SELECT COUNT(*) FROM price_history")
        dias = q("SELECT COUNT(DISTINCT dia) FROM price_history")
        checar(hist > 0, f"histórico com {hist} pontos em {dias} dia(s)")
    except sqlite3.OperationalError:
        checar(False, "tabela price_history existe",
               "sem ela cada coleta apaga a anterior e tendência nunca existe")

    p.close()


# ------------------------------------------------- vocabulário de variante

def testar_traducao_variante() -> None:
    """A tradução entre os dois vocabulários precisa cobrir o que existe.

    Sem ela a coleção avaliava um reverse holo pelo preço do normal — erro
    silencioso de quase 10x.
    """
    print("\nVOCABULÁRIO DE VARIANTE")
    c = abrir("cards.db")
    if not c:
        return
    usadas = set()
    for (j,) in c.execute("SELECT variants_json FROM cards WHERE variants_json != '[]'"):
        usadas |= set(json.loads(j))
    c.close()

    checar(usadas <= set(VARIANTE_CATALOGO),
           "variantes do catálogo no vocabulário conhecido",
           f"inesperadas: {usadas - set(VARIANTE_CATALOGO)}")

    # Toda variante do catálogo que tem correspondente de preço precisa estar
    # traduzida, ou a busca cai em silêncio no primeiro mercado da lista.
    faltando = {v for v in usadas & {"normal", "holo", "reverse"} if v not in TRADUCAO}
    checar(not faltando, "toda variante precificável tem tradução",
           f"sem tradução: {faltando}")

    js = (RAIZ / "web" / "colecao.js").read_text(encoding="utf-8")
    checar(all(f'"{alvo}"' in js or f"{alvo}:" in js or alvo in js
               for alvo in TRADUCAO.values()),
           "colecao.js conhece os nomes de variante dos preços")


def testar_javascript() -> None:
    """Strings de JS cortadas por quebra de linha.

    O detector vive em tests/checar_js.py, escrito por ferramenta de
    arquivo e nunca por heredoc — porque a primeira versao dele, colada
    num heredoc, caiu exatamente no bug que existia para detectar.
    """
    print("\nJAVASCRIPT")
    web = RAIZ / "web"
    if not web.is_dir():
        print("  (pulando: web/ nao existe)")
        return
    problemas = varrer(web)
    checar(not problemas, "nenhuma string de JS cortada por quebra de linha",
           ", ".join(problemas[:6]))


def testar_formato_do_indice() -> None:
    """A versao do index.bin declarada em tres lugares tem que bater.

    Quem escreve o arquivo (export_web_index), quem le (matcher.worker) e
    quem decide guardar ou jogar fora o cache offline (sw) carregam cada um
    o seu numero de formato. Se sairem de sincronia o sintoma nao e erro: e
    leitor devolvendo carta errada com confianca alta, porque assinatura
    certa e layout diferente passa pela unica checagem que existia.

    Numero baixo demais no sw.js tem o efeito oposto e igualmente ruim: o
    aparelho fica com um indice antigo para sempre.
    """
    print("\nFORMATO DO INDICE")

    def constante(caminho: str, padrao: str) -> int | None:
        m = re.search(padrao, (RAIZ / caminho).read_text(encoding="utf-8"),
                      re.M)   # os tres estao em inicio de linha, nao do arquivo
        return int(m.group(1)) if m else None

    achados = {
        "export_web_index.py": constante("pipeline/export_web_index.py",
                                         r"^VERSION\s*=\s*(\d+)"),
        "matcher.worker.js": constante("web/matcher.worker.js",
                                       r"^const FORMATO\s*=\s*(\d+)"),
        "sw.js": constante("web/sw.js",
                           r'^const FORMATO_DADOS\s*=\s*"(\d+)"'),
    }
    ausentes = [k for k, v in achados.items() if v is None]
    checar(not ausentes, "os tres declaram a versao do formato",
           f"nao encontrei em: {ausentes}")
    if ausentes:
        return
    checar(len(set(achados.values())) == 1,
           "escritor, leitor e cache concordam na versao do formato",
           " != ".join(f"{k}={v}" for k, v in achados.items()))

    # O cache de dados NAO pode ser versionado pelo commit: o robo de preco
    # publica diariamente, e isso obrigaria o aparelho a rebaixar o indice
    # inteiro todo dia para receber so o arquivo de preco.
    sw = (RAIZ / "web" / "sw.js").read_text(encoding="utf-8")
    m = re.search(r"const CACHE_DADOS\s*=\s*`[^`]*\$\{(\w+)\}", sw)
    checar(m is not None and m.group(1) == "FORMATO_DADOS",
           "cache de dados versionado pelo formato, nao pelo commit",
           f"usa ${{{m.group(1)}}}" if m else "expressao nao reconhecida")


def testar_precache() -> None:
    """Tudo que o sw promete guardar precisa existir e ser servido.

    Arquivo listado e inexistente vira falha silenciosa: o `catch(() => {})`
    do install engole, e o app so quebra offline, no balcao da loja, que e
    exatamente onde ninguem consegue depurar.
    """
    print("\nPRECACHE OFFLINE")
    web = RAIZ / "web"
    sw = (web / "sw.js").read_text(encoding="utf-8")
    bloco = re.search(r"const ESSENCIAIS = \[(.*?)\];", sw, re.S)
    checar(bloco is not None, "sw.js declara a lista de essenciais")
    if not bloco:
        return

    listados = [x for x in re.findall(r'"\./([^"]*)"', bloco.group(1)) if x]
    sumidos = [x for x in listados if not (web / x).is_file()]
    checar(not sumidos, "todo arquivo do precache existe em web/", str(sumidos))

    repetidos = sorted({x for x in listados if listados.count(x) > 1})
    checar(not repetidos, "nenhum arquivo listado duas vezes", str(repetidos))

    # Toda tela que da para abrir tem que estar guardada. Uma pagina fora da
    # lista vira tela branca offline, sem aviso nenhum.
    # Bancadas de teste ficam de fora: existem para rodar no navegador
    # durante o desenvolvimento e nao sao tela navegavel do app.
    BANCADAS = {"selftest.html", "teste-rotacao.html", "teste-arte.html",
                "teste-camera.html", "teste-ocr.html"}
    telas = {p.name for p in web.glob("*.html")} - BANCADAS
    fora = sorted(telas - set(listados))
    checar(not fora, "toda tela navegavel esta no precache", str(fora))


def testar_publicacao_dos_dados() -> None:
    """Todo arquivo de dados que o site BUSCA precisa ser publicado.

    Este teste existe por um defeito que eu mesmo criei e quase nao vi. O
    grafico de historico foi ligado a ficha com um `fetch("data/historico.json")`,
    e o robo diario nao exportava nem publicava esse arquivo. O grafico
    funcionaria — mostrando para sempre os cinco dias que eu tinha gerado a
    mao — e ninguem receberia erro nenhum.

    E o modo de falha que este arquivo inteiro persegue: nada quebra, o
    numero so para de crescer. A checagem cruza o que o JS pede com o que o
    fluxo do robo copia para o site.
    """
    print("\nPUBLICACAO DOS DADOS")
    web = RAIZ / "web"
    fluxo = RAIZ / ".github" / "workflows" / "precos.yml"
    if not web.is_dir() or not fluxo.exists():
        print("  (pulando: web/ ou o fluxo nao existem)")
        return

    # O que o cliente busca em tempo de execucao.
    pedidos = set()
    for arq in list(web.glob("*.js")) + list(web.glob("*.html")):
        if arq.name.startswith("teste-") or arq.name == "selftest.html":
            continue   # bancadas podem pedir o que quiserem
        for m in re.finditer(r"data/([\w.-]+\.json)", arq.read_text(encoding="utf-8")):
            pedidos.add(m.group(1))

    texto = fluxo.read_text(encoding="utf-8")
    # `cards.json` e `index.bin` sao do indice de reconhecimento e vao pelo
    # deploy manual, de proposito: o robo diario nao os toca para nao
    # arriscar publicar um indice pela metade.
    DO_INDICE = {"cards.json"}

    faltando = sorted(n for n in pedidos - DO_INDICE if n not in texto)
    checar(not faltando,
           "todo dado buscado pelo site e publicado pelo robo",
           f"o site busca mas o robo nao publica: {faltando}")

    # E o inverso: exportador que gera arquivo que ninguem publica e trabalho
    # jogado fora, e costuma ser sinal de passo esquecido.
    for script, gera in (("export_historico.py", "historico.json"),
                         ("export_ocr_names.py", "nomes.json")):
        if (RAIZ / "pipeline" / script).exists():
            checar(script in texto,
                   f"o robo roda {script}",
                   f"{gera} congelaria na versao gerada a mao")


if __name__ == "__main__":
    print("Invariantes do myPOKYcards")
    print("=" * 60)
    testar_catalogo()
    testar_indice()
    testar_precos()
    testar_traducao_variante()
    testar_formato_do_indice()
    testar_precache()
    testar_publicacao_dos_dados()
    testar_javascript()

    print("\n" + "=" * 60)
    if falhas:
        print(f"{len(falhas)} de {checagens} checagens FALHARAM:")
        for f in falhas:
            print(f"  · {f}")
        sys.exit(1)
    print(f"{checagens} checagens, tudo certo.")
