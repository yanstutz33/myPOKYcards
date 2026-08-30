# Para quem chega agora

Leia isto antes de mexer. São ~5 minutos e evitam refazer trabalho que já
foi medido e descartado.

`README.md` descreve o produto. `PROXIMOS-PASSOS.md` é o diário: cada
decisão com o número que a justificou. Este arquivo é o mínimo operacional.

---

## O que é

App web que reconhece carta Pokémon pela câmera, mostra o preço e guarda a
coleção. Roda inteiro no navegador — **não há servidor**, e isso é decisão
do dono, não limitação. Publicado em GitHub Pages, dados atualizados por um
robô do GitHub Actions.

```
41.856 cartas no catálogo · 32.339 reconhecíveis (77,3%)
internacional 96,9% · 11 dias de série histórica de preço, crescendo
```

## Rodar

Clone limpo, sem credencial nenhuma, **~8 segundos**:

```bash
python pipeline/bootstrap.py
```

Baixa o índice da release pública e o preço do site publicado. Depois:

```bash
python pipeline/servir.py --porta 8137
```

Não rode `--construir` sem motivo forte: são horas baixando 30 mil imagens
para chegar a um índice **pior** que o publicado (ver "Becos sem saída").

## Antes de qualquer publicação

```bash
python tests/test_invariantes.py
```

```bash
python tests/checar_js.py
```

38 checagens. Cada uma existe porque um bug real passou por ela, e **nenhum
daqueles bugs quebrava nada** — todos apareciam como número que não fecha.

---

## As regras que não se negociam

Elas não são estilo. Cada uma custou uma sessão de depuração.

**Meça antes de concluir.** Duas vezes eu afirmei "a fonte não tem essa
arte" com número na mão e estava errado — na segunda, o defeito era meu
indexador tentando 5 idiomas onde a fonte publica 7. Falha registrada não é
falha entendida.

**Olhe o que você está entregando ao motor.** O OCR do número ficou em 0/15
e eu quase descartei o caminho. Ao renderizar o recorte, o número estava
nítido: a mira é que estava no lugar errado. Antes de teorizar sobre um
algoritmo de imagem, desenhe o que ele recebe e olhe.

**Todo guarda novo é testado por mutação.** Quebre o dado de propósito e
confirme que a checagem falha. Guarda que não pega o erro é pior que
nenhum: dá confiança falsa.

**Não invente número.** Moeda diferente não soma. Dia sem cotação não vale
zero — vale "não sei". Carta sem preço não entra no total. Porcentagem só
quando as duas pontas são comparáveis. O app pode dizer "não sei"; não pode
dizer errado com ar de certeza.

**Não publique o que você não viu rodar.** Se não deu para verificar, diga
isso em vez de deixar implícito.

**Aspas em heredoc já quebraram string JS nove vezes** neste projeto — daí
`tests/checar_js.py`. Para mensagem de commit, escreva em arquivo e use
`git commit -F`; crase vira substituição de comando.

---

## Quem é dono de quê

O robô diário (`.github/workflows/precos.yml`) é dono de `prices.json`,
`fx.json`, `dashboard.json`, `numeros.json`, `historico.json` e
`nomes.json`. Ele copia arquivo a arquivo para o `gh-pages` e preserva o
resto.

`pipeline/deploy_pages.py` faz o oposto — monta a árvore e dá `push
--force`. Ele **preserva** os nove arquivos do robô justamente por isso. Não
remova essa preservação: sem ela, publicar apaga a série histórica
acumulada, e o sintoma é mudo (o gráfico só encolhe).

`data/hashes.db` não está no git. Ele vive numa release de tag fixa:

```bash
python pipeline/salvar_indice.py --conferir
```

---

## Becos sem saída — já medidos, não repita

**Arte que falta (9.517 cartas).** Dão 404 nos sete idiomas do TCGdex,
verificado carta a carta numa reindexação completa, não por amostra.
pokemontcg.io é só em inglês e já foi usada no que dava (+554 cartas). O
site oficial japonês tem as imagens, mas é da Pokémon Company e sem
`robots.txt` — **isso é decisão do dono do projeto, não do agente.**

**Reaproveitar arte de "gêmea".** 4.747 das que faltam têm carta do mesmo
Pokémon indexada. "Mesmo Pokémon" não é "mesma arte" — Charizard tem
centenas. Isso devolveria a impressão errada com ar de certeza.

**Calibrar limiar do leitor contra cena sintética.** Tentado três vezes; é
ajustar contra ruído. Precisa de diagnóstico de aparelho real (`?diag` no
app, botão "copiar diagnóstico").

**Reconstruir o índice do zero.** Leva horas e dá um resultado PIOR: 10.661
cartas já têm arte que sumiu da fonte. O índice publicado é um registro do
que existia quando foi montado.

---

## O que está aberto

Depende do dono do projeto:

- IDs de afiliado (`web/mercado.js`, constante `AFILIADO`) — o bloco de
  compra funciona e não gera comissão sem eles
- Servidor ou não — trava o índice de preço brasileiro
- Raspar o site japonês ou não

Depende de dado de aparelho real:

- **Precisão do leitor com carta física.** É o gargalo. Último teste
  conhecido: 1 acerto em 3, com `dist 54.8` e `nitidez 7.9` numa carta atrás
  de case com reflexo.

Verificável por quem tiver navegador:

- **Taxa de acerto do OCR do número.** A geometria foi corrigida e medida
  (24/24 recortes legíveis), mas o motor nunca foi rodado sobre eles. Abra
  `web/teste-ocr.html?n=40` com o site servido.

---

## Bancadas

Com o site servido, no navegador:

| página | o que mede |
|---|---|
| `selftest.html` | o hash em JS bate com o do Python |
| `teste-arte.html` | quantas cartas mostram foto de verdade |
| `teste-rotacao.html` | ângulo recuperado e ganho do desentortamento |
| `teste-camera.html` | o app inteiro num iframe, com câmera falsa |
| `teste-ocr.html` | leitura de nome e número |

`teste-ocr.html` importa as geometrias de `web/ocr.js`. Não copie constantes
para dentro de bancada: elas divergem, e uma bancada que reimplementa o que
deveria medir mede a si mesma. Já aconteceu.

---

## Idioma

Código, comentários e commits em **português**. Comentário explica *por
quê*, não *o quê* — e de preferência com o número que motivou a decisão.
