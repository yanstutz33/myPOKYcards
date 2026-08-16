"""
Servidor de desenvolvimento, sem cache.

Por que nao `python -m http.server`
-----------------------------------
Ele manda `Last-Modified` e o navegador guarda os modulos em cache de
memoria. O sintoma e cruel e ja custou tres depuracoes nesta sessao: o
arquivo em disco esta correto, o servidor entrega o correto quando pedido
com `cache: "reload"`, mas a pagina continua executando a versao anterior.
Voce depura um erro que nao existe mais.

Aqui todo recurso sai com `Cache-Control: no-store`. Em producao o cache e
desejado — o GitHub Pages e o service worker cuidam disso, e o service
worker e carimbado com o commit a cada publicacao.

Uso:
    python pipeline/servir.py            # porta 8137, pasta web/
    python pipeline/servir.py --porta 9000
"""

from __future__ import annotations

import argparse
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

RAIZ = Path(__file__).resolve().parent.parent


class SemCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, max-age=0")
        self.send_header("Pragma", "no-cache")
        super().end_headers()

    def log_message(self, formato, *args):
        # Silencia 200 e 304; erro continua aparecendo.
        if args and str(args[1]).startswith(("4", "5")):
            super().log_message(formato, *args)


def main(porta: int, pasta: Path) -> None:
    handler = partial(SemCache, directory=str(pasta))
    with ThreadingHTTPServer(("", porta), handler) as srv:
        print(f"servindo {pasta} em http://localhost:{porta}  (sem cache)")
        try:
            srv.serve_forever()
        except KeyboardInterrupt:
            print("\nencerrado")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--porta", default=8137, type=int)
    ap.add_argument("--pasta", default=RAIZ / "web", type=Path)
    main(*vars(ap.parse_args()).values())
