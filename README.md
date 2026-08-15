# YAMI-TCG

Scanner de cartas Pokémon por câmera + radar de preços 24/7 + dashboard.

## Estado atual

**Fase 1 (fundação de dados) — concluída e validada.**

O catálogo roda offline, sem depender de API de terceiro:

| métrica | valor |
|---|---|
| sets | 563 (221 internacionais + 342 asiáticos) |
| cartas | 41.694 |
| pares nome × idioma | 61.918 |
| colisões de `set_id` tratadas | 21 |

Escopo de idiomas: **EN, JA, KO, ZH, PT**. Espanhol, francês, alemão,
italiano, tailandês e indonésio ficam fora por decisão de produto.

| idioma | cartas |
|---|---|
| `en` | 23.546 |
| `pt` | 14.360 |
| `ja` | 13.061 |
| `zh-tw` | 7.587 |
| `ko` | 1.363 |
| `pt-br` | 1.124 |
| `zh-cn` | 877 |

**Fase 2 (índice de reconhecimento) — concluída.**

Cinco hashes perceptuais de 64 bits por carta (pHash DCT, dHash, aHash, e
dHash por canal R/G/B). As imagens são baixadas, hasheadas e descartadas —
o índice inteiro são alguns MB e roda offline.

| | |
|---|---|
| cartas com hash | 30.283 |
| sem imagem no CDN | 11.411 |

Autoteste contra o índice completo, amostra aleatória de 60 cartas × 7
degradações que simulam foto de celular:

| degradação | acerto top-1 | confiança média |
|---|---|---|
| resolução ÷4 | 100% | 99,3% |
| compressão JPEG | 98,3% | 99,0% |
| luz amarelada | 98,3% | 98,3% |
| rotação 2,5° | 96,7% | 89,7% |
| subexposta | 95,0% | 98,8% |
| superexposta | 93,3% | 89,7% |
| recorte 3,5% | 93,3% | 86,8% |

**Recall em top-3: 99,8%** (1 erro fora do top-3 em 420 tentativas).

Quase todo erro de top-1 é a *mesma carta em outra impressão* — a versão
japonesa sendo confundida com a inglesa (`sv09-119` ↔ `SV9-077`,
`swsh12-054` ↔ `S11-038`). Arte idêntica, hash idêntico: nenhum algoritmo
de imagem separa isso. O desempate é OCR do número e do símbolo de set.

Cuidado ao medir: amostre **aleatoriamente**. Ordenar por `card_id` põe o
TCG Pocket (`A1-*`) primeiro, um set inteiro de arte reimpressa, e a
acurácia aparente cai para 75% — número que descreve aquele cluster, não o
catálogo.

## Rodar

```bash
git clone --depth 1 https://github.com/tcgdex/cards-database.git /tmp/tcgdex
```

```bash
python pipeline/ingest_tcgdex.py --repo /tmp/tcgdex --out data/cards.db
```

Use `--langs all` para manter todos os idiomas, ou uma lista própria.

```bash
python pipeline/build_hash_index.py --workers 16
```

```bash
python pipeline/match.py --selftest --sample 40
```

Para a tela de leitura, exporte o índice para o navegador e sirva `web/`:

```bash
python pipeline/export_web_index.py
```

```bash
python -m http.server 8137 --directory web
```

`index.bin` são 1,39 MB (48 bytes por carta) e `cards.json.gz` 0,35 MB — o
leitor roda offline depois do primeiro carregamento. Abra
`/selftest.html` para conferir o porte do hash, ou `/index.html?demo` para
ver a interface sem câmera.

Ambos os builds são resumíveis e idempotentes: o mesmo repo de entrada
produz o mesmo banco, e rodar de novo só pega o que falta.

## Consultar

```bash
sqlite3 data/cards.db "SELECT c.card_id, c.rarity FROM card_names n JOIN cards c USING(card_id) WHERE n.lang='pt' AND n.name LIKE '%Charizard%' LIMIT 10"
```

**Fase 3 (tela de leitura) — funcional.**

Busca em 30.283 cartas em **14 ms**, num Web Worker, sem rede. A tela mostra
os três candidatos com confiança — nunca um resultado único, porque o dado
não sustenta essa certeza.

O ponto delicado foi portar o hash de Python para JavaScript. Uma imagem
idêntica à indexada voltava com 84% de confiança em vez de ~100%: o
`drawImage` do canvas não reamostra como o LANCZOS do Pillow, e o `dHash`,
que compara pixels vizinhos numa grade 9×8, divergia 10 bits de 64.
`web/capture.js` replica o reamostrador do Pillow; a divergência caiu para
0,0 bit e a confiança para 99,5–100%. `selftest.html` guarda essa
verificação — é a diferença entre "reconhecimento meia-boca" e um bug
invisível.

## Estrutura

```
pipeline/ingest_tcgdex.py     catálogo TCGdex (MIT) -> SQLite
pipeline/build_hash_index.py  imagens -> hashes perceptuais
pipeline/match.py             busca + autoteste de acurácia
pipeline/export_web_index.py  bancos -> índice binário do navegador
web/                          tela de leitura (câmera, worker, HUD)
data/                         bancos gerados (não versionado)
.claude/agents/               equipe de 12 agentes de domínio
```

## Equipe de agentes

| agente | domínio |
|---|---|
| `tcg-arquiteto` | fundação, ADRs, contratos entre serviços |
| `tcg-ingestao` | pipeline de catálogo EN/PT-BR/JA |
| `tcg-precos` | preço de cartas nos três mercados |
| `tcg-vision` | reconhecimento pela câmera |
| `tcg-radar-promo` | bot de promoções de selados 24/7 |
| `tcg-cupons` | cupons e ofertas: Shopee, AliExpress, ML, TikTok Shop, Temu |
| `tcg-geo` | onde vender perto (km / mesmo estado) |
| `tcg-demanda` | liquidez e sinal de interesse |
| `tcg-especialista-cartas` | raridade, variante, EN×PT-BR×JA, falsificação |
| `tcg-frontend` | LP, dashboard/HUD, tela de scan |
| `tcg-compliance` | licença, ToS, privacidade, PI |
| `tcg-qa` | qualidade de dados e testes |

## Licença dos dados

Catálogo derivado de [`tcgdex/cards-database`](https://github.com/tcgdex/cards-database) — MIT.
Arte e marca Pokémon pertencem à The Pokémon Company; este projeto é de
terceiro e não é afiliado nem endossado.
