# YAMI-TCG

Leitor de cartas Pokémon pela câmera, com preço. Reconhece 41.694 cartas em
14 ms no próprio aparelho, sem enviar foto para servidor nenhum, e funciona
offline depois do primeiro carregamento.

**No ar:** https://yanstutz33.github.io/yami-tcg/sobre.html

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
`swsh12-054` ↔ `S11-038`). Arte idêntica, hash idêntico.

**Duas tentativas de resolver isso por imagem foram medidas e falharam:**
hash de região específica (nome, tarja do número) melhorou a separação de
14% para só 20% dos bits nos pares difíceis; e a imagem em alta resolução
não mudou nada (51→50, 43→46, 71→72 bits) porque quem limita é a grade do
hash, não a fonte.

A ambiguidade não é ruído a filtrar — é informação real: a mesma arte
**existe** em várias impressões, com preços diferentes. Então o sistema
para de adivinhar e apresenta o grupo. `pipeline/build_art_groups.py`
pré-calcula 4.867 grupos cobrindo 10.737 cartas, e a tela lista as irmãs
com seus preços para o usuário escolher pelo número impresso.

Distância de hash sozinha não agrupa: ela fundia 72 cartas distintas num
grupo só. A regra que funciona é **chave semântica forte permite distância
folgada, chave fraca exige distância apertada** — ilustrador + número da
Pokédex com limiar 40, só ilustrador com limiar 8.

Cuidado ao medir: amostre **aleatoriamente**. Ordenar por `card_id` põe o
TCG Pocket (`A1-*`) primeiro, um set inteiro de arte reimpressa, e a
acurácia aparente cai para 75% — número que descreve aquele cluster, não o
catálogo.

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

**Fase 4 (camada de preço) — funcional para o mercado internacional.**

Fonte: TCGdex, que reempacota Cardmarket (EUR) e TCGplayer (USD) e usa os
mesmos `card_id` do catálogo — join nativo, sem tabela de correspondência.

| | |
|---|---|
| cotações | 353.040 |
| cartas com preço | 20.333 |
| internacionais consultadas | 23.639 de 23.639 (100%) |

A cobertura por região foi medida, não estimada:

| região | com preço na fonte |
|---|---|
| internacional | **~86%** |
| ásia (JA) | **2,2%** |

Cardmarket e TCGplayer são mercados ocidentais; carta japonesa não está
neles. **Não existe fonte aberta que cote em BRL ou em JPY** — a interface
diz isso em vez de converter e fingir precisão.

Cada preço é uma linha com `kind`: `listing` (pedido de anúncio), `sold`
(derivado de venda concluída) ou `derived` (tendência da fonte). Somar os
três num "valor de mercado" é o erro clássico de agregador. E há duas datas
por linha: quando a fonte diz que o dado é, e quando nós buscamos.

**Não filtre quem consultar por `tcgplayer_id`/`cardmarket_id`.** Esses ids
vêm do repo estático e existem em 57% do catálogo; a API de preço não
depende deles. Numa amostra de 20 cartas internacionais sem esses ids, 12
tinham preço — o filtro excluía 10.677 cartas que nunca eram perguntadas.

Ausência de preço tem causas distintas, e a interface diz qual: TCG Pocket
é jogo digital e não tem mercado físico; carta japonesa não está nos
mercados ocidentais; o resto foi consultado e não tinha cotação.

**Conversão para real, não preço brasileiro.** A tela mostra `≈ R$` ao lado
do valor nativo, pela PTAX oficial do Banco Central, com data visível. Isso
responde "é carta de dez reais ou de mil?" sem afirmar que sabe o preço no
Brasil — o mercado nacional tem liquidez, imposto e frete próprios, e a
diferença para o americano não é a taxa de câmbio.

```bash
python pipeline/fetch_fx.py
```

```bash
python pipeline/fetch_prices.py --region intl --workers 10
```

```bash
python pipeline/price_model.py swsh3-136
```

## Rodar

Num clone novo — inclusive numa sessão pela nuvem ou pelo celular:

```bash
python pipeline/bootstrap.py
```

Isso monta o catálogo em ~2 min e busca as taxas de câmbio. Suficiente para
mexer em código, consultar cartas e rodar testes. Os estágios caros ficam
explícitos porque têm custo muito diferente:

| estágio | tempo | comando |
|---|---|---|
| catálogo | ~2 min | `bootstrap.py` (padrão) |
| preços | ~25 min | `bootstrap.py --precos` |
| índice de imagens | **~2 h** | `bootstrap.py --tudo` |

Passo a passo, se preferir controlar cada etapa:

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

**Fase 5 (coleção e histórico) — funcional.**

O leitor deixou de responder uma carta por vez. A tela de coleção guarda o
que foi escaneado **no aparelho** (localStorage) — coleção revela
patrimônio, então nada vai para servidor e a exportação em JSON é a saída.

Duas regras que o valor da coleção respeita:

- **Moedas não se somam.** USD e EUR ficam em totais separados. Um total
  único em real daria a impressão de ser o valor de venda no Brasil, que é
  exatamente o que não sabemos.
- **Sem cotação não é zero.** Cartas sem preço, e cartas cuja variante
  guardada não tem cotação, são contadas à parte. Quatro cartas sem preço
  não valem R$ 0,00, valem "não sei".

Armadilha que custou um erro de quase 10×: o catálogo chama a variante de
`reverse`, os preços chamam de `reverse-holofoil`. Sem traduzir os dois
vocabulários, a busca não casava, caía no primeiro mercado, e um reverse
holo de € 4,05 era avaliado a € 0,41 — o preço da versão normal.

E `price_history` passou a acumular série temporal: a tabela `prices` é
sobrescrita a cada coleta, então sem ela nenhuma tendência existiria. Já são
67.856 pontos em 20.331 cartas.

**Fase 6 (tema e travamento) — funcional.**

O tema Pokémon é **dirigido por dado**, não decoração: a cor de cada
resultado vem do tipo de energia da própria carta (11 tipos, 34.589
atribuições no catálogo), e o brilho holográfico só aparece em raridade que
de fato é foil. Carta comum sai sóbria — é isso que faz o brilho significar
algo quando aparece. Nada de marca, logo ou arte oficial.

**Não é mais preciso segurar a câmera apontada.** Quando o mesmo candidato
aparece no topo em 3 leituras seguidas com confiança acima de 90%, o leitor
trava sozinho: moldura e selo assumem a cor do tipo, e o resultado fica na
tela até você tocar em "Ler outra". Três leituras, não uma — um frame
borrado durante o movimento pode acertar por acaso e travaria na carta
errada.

**Graduação (PSA 10, GBA).** Nenhuma fonte pública cota carta graduada:
PSA existe só em serviço pago (~US$ 10/mês) e GBA, MGS e Capy são
graduadoras brasileiras novas demais para ter índice — verificado, não
suposto. Os campos ficam visivelmente vazios em vez de preenchidos com
multiplicador estimado.

O que dá para dizer com o dado que temos é **se vale graduar**: abaixo de
~US$ 50 raw, o custo da graduação e do frete costuma comer o ganho. É
orientação de decisão, rotulada como tal, não preço inventado.

**Fase 7 (automação e landing) — funcional.**

`.github/workflows/precos.yml` atualiza os preços todo dia às 09:00 UTC e
republica o site. Preço coletado uma vez fica velho no dia seguinte, e app
de preço com preço velho é pior que app nenhum.

O que persiste entre execuções é só o histórico: `cards.db` se reconstrói em
2 min, `prices.db` tem 77 MB e não cabe no repositório, e o índice de
reconhecimento não muda quando o preço muda. Comprimido, o histórico dá
0,32 MB e é versionado de propósito — um dia não coletado é perdido para
sempre. A lista de cartas exibíveis vem do `cards.json` **já publicado**, e
é isso que dispensa o `hashes.db` no runner.

O job falha de forma visível se a coleta trouxer menos de 5.000 cartas:
silêncio não pode parecer sucesso.

## Estrutura

```
pipeline/bootstrap.py         prepara um clone novo (nuvem, celular)
pipeline/ingest_tcgdex.py     catálogo TCGdex (MIT) -> SQLite
pipeline/build_hash_index.py  imagens -> hashes perceptuais
pipeline/match.py             busca + autoteste de acurácia
pipeline/build_art_groups.py  impressões que o leitor não distingue
pipeline/fetch_prices.py      preços com proveniência (TCGdex -> prices.db)
pipeline/price_model.py       faixa, referência e idade exibíveis
pipeline/fetch_fx.py          taxas PTAX oficiais (Banco Central)
pipeline/export_web_index.py  bancos -> índice binário do navegador
pipeline/export_dashboard.py  estado do sistema -> dashboard.json
pipeline/deploy_pages.py      publica web/ no GitHub Pages (branch gh-pages)
web/                          landing, leitor, coleção e painel (tema.css/tema.js = camada temática)
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
