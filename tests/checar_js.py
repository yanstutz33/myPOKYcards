"""
Detecta strings de JavaScript cortadas por quebra de linha.

Por que isto existe
-------------------
Em JavaScript, `'` e `"` não podem conter quebra de linha literal — só a
crase pode. Este erro apareceu CINCO vezes numa única sessão, sempre pelo
mesmo caminho: um `\\n` dentro de um heredoc de shell vira quebra de linha
de verdade quando o arquivo é escrito.

O sintoma é cruel. O módulo não carrega, o navegador registra o erro uma vez
no console, e a página continua rodando a versão anterior que ficou em
cache. Você depura um arquivo que o navegador nem está executando — e o
código no disco está certo, o que faz duvidar de tudo menos da causa real.

A quinta ocorrência foi dentro da primeira versão deste próprio arquivo,
escrita por heredoc. Por isso ele existe como arquivo separado: escrito por
ferramenta de arquivo, nunca colado em shell.

O que ele precisa entender
--------------------------
Não é um parser de JavaScript, mas precisa de três coisas para não gritar à
toa:

  * **expressão regular** — `/[&<>"']/g` tem aspas dentro e não é string;
  * **template com interpolação** — `` `a ${f("x")} b` `` tem string dentro
    de crase dentro de template, e pode aninhar;
  * **comentário** — aspas em comentário não contam.
"""

from __future__ import annotations

from pathlib import Path

# Um `/` depois destes caracteres começa uma expressão regular, não uma
# divisão. É a heurística padrão, e resolve todos os casos reais deste
# projeto (a ambiguidade só aparece em código deliberadamente obscuro).
ANTES_DE_REGEX = set("(,=:[!&|?{};+-*%~^<>") | {"\n"}


def strings_quebradas(src: str) -> list[int]:
    """Linhas em que uma string de aspas simples ou duplas foi cortada."""
    ruins: list[int] = []
    i, linha, n = 0, 1, len(src)

    estado: str | None = None      # None | ' | " | // | /* | regex
    # Pilha de templates: cada crase aberta empilha; cada `${` empilha um
    # nível de expressão, onde crases e aspas voltam a valer normalmente.
    templates: list[int] = []      # profundidade de chaves dentro de cada ${}
    anterior = "\n"                # último caractere significativo

    while i < n:
        c = src[i]
        prox = src[i + 1] if i + 1 < n else ""

        # ---- dentro de string simples/dupla ----------------------------
        if estado in ("'", '"'):
            if c == "\\":
                i += 2
                continue
            if c == "\n":
                ruins.append(linha)
                estado = None
                linha += 1
            elif c == estado:
                estado = None
            i += 1
            continue

        # ---- dentro de expressão regular -------------------------------
        if estado == "regex":
            if c == "\\":
                i += 2
                continue
            if c == "\n":          # regex não atravessa linha: era divisão
                estado = None
                linha += 1
            elif c == "/":
                estado = None
            i += 1
            continue

        # ---- comentários ------------------------------------------------
        if estado == "//":
            if c == "\n":
                estado = None
                linha += 1
            i += 1
            continue
        if estado == "/*":
            if c == "\n":
                linha += 1
            elif c == "*" and prox == "/":
                estado = None
                i += 2
                continue
            i += 1
            continue

        # ---- dentro de template (crase) ---------------------------------
        if templates and templates[-1] < 0:      # -1 marca "texto do template"
            if c == "\\":
                i += 2
                continue
            if c == "\n":
                linha += 1
            elif c == "`":
                templates.pop()
            elif c == "$" and prox == "{":
                templates.append(0)              # entrou numa interpolação
                i += 2
                continue
            i += 1
            continue

        # ---- código normal (inclui dentro de ${...}) ---------------------
        if c == "\n":
            linha += 1
        elif c in ("'", '"'):
            estado = c
        elif c == "`":
            templates.append(-1)
        elif c == "/" and prox == "/":
            estado = "//"
            i += 2
            continue
        elif c == "/" and prox == "*":
            estado = "/*"
            i += 2
            continue
        elif c == "/" and anterior in ANTES_DE_REGEX:
            estado = "regex"
        elif c == "{" and templates:
            templates[-1] += 1
        elif c == "}" and templates:
            if templates[-1] == 0:
                templates.pop()                  # fecha a interpolação
            else:
                templates[-1] -= 1

        if not c.isspace():
            anterior = c
        elif c == "\n":
            anterior = "\n"
        i += 1

    return ruins


def varrer(pasta: Path) -> list[str]:
    """Todos os problemas de `pasta`, como `arquivo:linha`."""
    achados: list[str] = []
    for arq in sorted(pasta.glob("*.js")):
        for l in strings_quebradas(arq.read_text(encoding="utf-8")):
            achados.append(f"{arq.name}:{l}")
    return achados


if __name__ == "__main__":
    import sys

    alvo = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("web")
    problemas = varrer(alvo)
    if problemas:
        print(f"{len(problemas)} string(s) cortada(s) por quebra de linha:")
        for p in problemas:
            print(f"  {p}")
        sys.exit(1)
    print(f"ok — nenhuma string quebrada em {alvo}")
