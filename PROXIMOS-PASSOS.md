# Onde parei, e por onde continuar

Escrito em 18/08/2026, no fim de uma sessão. Serve para retomar sem
reconstruir contexto: o histórico do `git log` tem o porquê de cada decisão,
este arquivo tem só o que ainda não foi feito.

## A descoberta que muda a prioridade

O leitor compara **hash de imagem** contra um banco de imagens. Isso é
estruturalmente incapaz de reconhecer as **11.411 cartas (27,4%)** que não
têm imagem em fonte nenhuma — conferido idioma por idioma, `low` e `high`.

Um concorrente (FoilSnap) reconheceu uma dessas cartas: `mep-047`, Cyndaquil
do Mega Evolution Promo, em português. Pelo relatório de classificação que
ele gera — prosa com hedge ("aparentam", "leve indício") — ele manda a foto
para um servidor e **um modelo multimodal lê a carta**. Não compara com
banco de imagens: lê o nome impresso.

**Conclusão: existe um segundo caminho de identificação que este projeto
nunca usou — ler o texto da carta.**

## Etapa 6: OCR na captura — FEITA (19/08/2026)

Implementada e medida. `web/ocr.js` le o nome impresso quando o hash nao
resolve; `pipeline/export_ocr_names.py` gera o vocabulario de todos os
idiomas. Bancada em `web/teste-ocr.html`.

CORRECAO ao que este documento dizia: OCR latino NAO alcanca as 11.411
cartas sem imagem. Delas, 9.383 sao asiaticas e exigiriam traineddata
japonesa sobre fonte estilizada. Sobram 1.278 internacionais — 3,1% do
catalogo, nao 27%.

Medido: 68% numa amostra de 19 pela bancada, 4/5 no modulo integrado.

EM ABERTO, e vale mais que o nome: ler o NUMERO impresso resolveria os
4.867 grupos de impressoes irmas, que sao 10.737 cartas. Tentado e medido:
0 de 15. O numero esta la e e legivel a olho ("136/189" no rodape), mas o
motor nao extrai nada util nesta resolucao. Nao foi investigado a fundo.

## Etapa 6 (texto original, mantido para contexto)

A carta tem nome e número impressos, grandes e em alto contraste. O catálogo
já tem nome, número e set das 41.694 cartas, incluindo as 11.411 sem imagem.
Ler "Cyndaquil" e "047" e casar com `mep-047` identifica sem imagem nenhuma.

Onde encaixa:

- **Não** no laço ao vivo (450 ms por quadro; OCR leva 1–3 s).
- **Sim** no botão de captura, que já é caminho de análise pesada
  (`capturarAgora` em `web/app.js` testa 5 recortes hoje).
- **Sim** no caminho da foto (`lerDeFoto`), onde já há tempo de sobra.

Como validar antes de investir: pegar 20 cartas COM hash, rodar OCR no
recorte já desentortado e medir quantas o texto identifica sozinho. Se o OCR
acerta onde o hash também acerta, ele vai acertar onde o hash não alcança.

Ferramenta provável: Tesseract em WebAssembly (~2 MB, roda offline, mantém a
promessa de não enviar foto para servidor). O recorte que alimenta o OCR deve
ser a faixa superior da carta desentortada, onde fica o nome — não a carta
inteira.

Combinado: hash resolve rápido as 31.033 com imagem, OCR cobre o resto.

## Cobertura por ano — medido em 21/08/2026

Pergunta do teste real: "ele está atualizado com as cartas de TODOS OS ANOS E
TODAS AS COLEÇÕES?"

**Catálogo: sim.** 41.694 cartas, 563 coleções, 1996 a 2026.

**Imagem para reconhecer: depende da região, e essa é a única divisão que
importa.**

| região | com imagem | % |
|---|---|---|
| internacional | 22.361 / 23.639 | **94,6%** |
| ásia (JA/ZH/KO) | 8.672 / 18.055 | 48,0% |
| total | 31.033 / 41.694 | 74,4% |

O 74,4% que eu vinha citando é enganoso para quem usa o app no Brasil: ele
mistura 18 mil cartas japonesas, chinesas e coreanas que ninguém aqui escaneia.

Por ano, só as internacionais: **todo ano de 1999 a 2026 fica entre 85% e
100%.** Nenhum ano é fraco. Base Set (`base1`) está 102/102.

Os 361 cartões de 1996–1998 que apareciam com 0% são os sets japoneses
originais (PMCG1–5: 拡張パック, ポケモンジャングル, 化石の秘密, ロケット団,
リーダーズスタジアム). O Base Set internacional é de 1999 e está completo.

Faltam **1.278 cartas internacionais**, concentradas em promos e sets
paralelos: `B2a` (131), `swsh4.5sv` (122), `sm7.5` (78), `swsh12.5gg` (70),
`smp` (67), `mep` (49), coleções francesas de 2018–2019 (81).

**Consequência para o diagnóstico de erro:** quando o app erra uma carta
internacional comum, quase nunca é falta de dado. É a imagem capturada. No
teste real de 21/08 ele respondeu `me05-107` (*Energy Switch*, um Trainer)
para um Charmander — e 53 dos 59 Charmander do catálogo têm imagem. O
diagnóstico mostrava `dist 54.8` (acerto limpo fica entre 10 e 30) e
`nitidez 7.9` (carta nítida fica ≥10), com a carta atrás de um case com
reflexo.

## Segunda fonte de arte — FEITA (21/08/2026)

Pedido: "EU QUERO TODAS AS CARTAS REGISTRADAS ATE O DIA DE HOJE."

**Catalogo atualizado.** Reconstruido do TCGdex no commit do proprio dia
21/08. 41.694 -> **41.856 cartas**, 563 -> 564 colecoes. As 162 novas sao
todas japonesas: M6 (ストームエメラルダ) e promos Mega. Nenhuma carta
internacional nova — aquele lado ja estava completo. Nenhuma carta sumiu.

**Arte.** O TCGdex chegou ao teto: 10.661 cartas dao 404 em todos os idiomas.
Conferido por dois caminhos independentes — sonda HEAD em 120 cartas por
regiao (0 acertos) e a tabela `failures`, que ja registrava as mesmas 10.661.
As URLs estao bem formadas; comparei com as que funcionam.

Isso e teto de UMA fonte. `pipeline/complementar_arte.py` usa pokemontcg.io
(gratuita, 174 colecoes em ingles) para o que ficou de fora.

**+554 cartas internacionais recuperadas**, justamente as que mais aparecem
no uso real: Shining Fates Shiny Vault (122), Dragon Majesty (78), Crown
Zenith Galarian Gallery (70), Trainer Galleries (120), promos, McDonalds.

| regiao | antes | depois |
|---|---|---|
| internacional | 94,6% | **96,9%** |
| asia | 48,0% | 47,6% * |

\* cai porque entraram 162 cartas japonesas novas sem arte publicada ainda.

**As duas fontes sao compativeis** — medido, nao suposto: mesma carta pelas
duas CDNs da **0,6 bits** de diferenca somando pHash+dHash+aHash (cartas
diferentes ficam perto de 96). Testado em 9 cartas de 3 colecoes.

Invariante novo (33 no total): `lang` tem que bater com o host de `src_url`.
Testado por mutacao — apagar a marca de uma linha faz a checagem falhar.

### O que ainda falta, e por que

- **699 cartas internacionais** (3,0%) sem arte em fonte nenhuma. As maiores:
  `B2a` Paldean Wonders (131), `mep` (49), promos franceses 2018-19 (81),
  `mfb` My First Battle (34), Trainer Kits HS (60), `exu` (28).
- **9.545 cartas asiaticas** (52%). pokemontcg.io e so em ingles, entao nao
  ajuda aqui. Precisaria de uma terceira fonte japonesa — nao investigado.
- **162 cartas do M6** — set lancado essa semana, o TCGdex ainda nao subiu a
  arte. Rodar `build_hash_index.py --retry-failed` daqui a alguns dias.

### A fragilidade do indice — RESOLVIDA (21/08/2026)

`data/hashes.db` estava no `.gitignore` e existia so nesta maquina.
`pipeline/salvar_indice.py` guarda o par hashes.db + cards.db numa release
do GitHub (tag fixa `indice`, sobrescrita), com sha256 e contagem de linhas
num manifesto.

    python pipeline/salvar_indice.py --conferir    # local x guardado
    python pipeline/salvar_indice.py --salvar      # atualiza a copia
    python pipeline/salvar_indice.py --restaurar   # traz de volta

**O caminho de recuperacao foi testado de verdade**, nao suposto: clone
limpo do repositorio, `--restaurar`, invariantes. Passou 26 checagens (as 7
de preco ficam de fora porque `prices.db` nao esta na copia, de proposito).

`--restaurar` confere o sha256 DEPOIS de escrever e aborta se nao bater, e
se recusa a sobrescrever banco existente sem `--forcar`.

Nao guarda `prices.db`: 76 MB que o robo diario refaz do zero com coleta
nova. A serie historica, essa sim insubstituivel, esta versionada em
`data/price_history.csv.gz`.

`deploy_pages.py` lembra de conferir a copia ao fim de cada publicacao —
que e o unico momento em que o indice pode ter mudado.

## As 9.545 asiaticas — investigado (21/08/2026)

Pedido: pesquisar o buraco asiatico.

**Achei um defeito meu, nao um limite da fonte.** `FALLBACK_LANGS["asia"]`
tentava `ja, zh-tw, zh-cn, ko, en`. Mas "asia" no TCGdex inclui o Sudeste
Asiatico: **indonesio (`id`) e tailandes (`th`)**. Sets inteiros do catalogo
— SV3s, SV5s, SV7s, SV8s, SV9s — existem SO em indonesio, e o indexador
nunca pediu a arte no unico idioma em que ela esta publicada.

O engano ficou escondido porque o sintoma parecia teto da fonte: 404 nos
cinco idiomas tentados, registrado na tabela `failures`, somando um numero
grande e plausivel. **Eu tinha conferido esse numero por dois caminhos e
reportado como limite da fonte.** Falha registrada nao e falha entendida.

Apareceu ao comparar sets asiaticos a 100% (S10D, S11, S12, M1S, M4 — todos
japoneses) com os a 0% (toda a familia SVxs). Os nomes das cartas de SV8s
estao em `id` e `th`, nao em japones.

**+752 cartas recuperadas** numa reindexacao de 88 min.

| regiao | antes | depois |
|---|---|---|
| asia | 47,6% | **51,7%** |
| internacional | 96,9% | 96,9% |
| total | 75,5% | **77,3%** |

### O que sobra: 8.793 cartas, e por que

Depois do conserto, **9.516 cartas dao 404 nos SETE idiomas**. Verificado
carta a carta pela reindexacao completa, nao por amostra. Os maiores:

- `MC` スタートデッキ100 (774), `SV-P` promos (301), `M2a` MEGAドリームex (250)
- japonesas e chinesas recentes, quase todas

**Nao ha segunda fonte legitima para arte japonesa.** pokemontcg.io e so em
ingles. O site oficial (pokemon-card.com) tem as imagens, mas nao publica
`robots.txt` e e da Pokemon Company — raspar e redistribuir dali e outra
categoria de coisa que o TCGdex (MIT) e a pokemontcg.io (API publica) nao
sao. **Decisao do Yan, nao minha.**

**Descartado: reaproveitar arte de "gemea".** 4.747 das que faltam tem carta
do mesmo Pokemon no indice. Mas "mesmo Pokemon" nao e "mesma arte" —
Charizard tem centenas. Isso produziria resposta errada com ar de certeza,
que e o defeito que o projeto inteiro combate.

## OCR do numero — a mira estava errada (21/08/2026)

Este era o maior ganho de precisao disponivel sem depender de decisao do
Yan: **11.423 cartas em 5.158 grupos** tem arte identica e so o numero
impresso as separa.

Estava medido em "0 de 15" nas eras antigas contra "4 de 5" nas modernas, e
eu tinha registrado isso como limite do motor. Nao era.

**A Pokemon mudou o rodape em Sun & Moon (2017).** Antes o numero fica na
ponta DIREITA; de SM em diante, na ESQUERDA. Eu tinha so a geometria da
esquerda — o recorte nao continha o numero nas cartas antigas. Aqueles 4/5
eram todos modernos, e foi por isso que o resultado pareceu bom.

Achado olhando, nao deduzindo: montei uma prancha com o terco de baixo de 13
cartas de base1 a sv08, com a caixa atual desenhada por cima. O numero
estava fora dela em todas as anteriores a sm1.

### O que mudou

- **Duas geometrias.** Esquerda `{0.04, 0.925, 0.42, 0.055}` e direita
  `{0.68, 0.898, 0.32, 0.092}`. Conferidas olhando o recorte: 13 cartas na
  direita, 11 na esquerda, Pokemon e Trainer, numeros de uma a tres casas.
  **24 de 24 legiveis dentro da caixa.**

  A da direita e mais alta (0,092 contra 0,055) porque a altura varia entre
  eras: em ecard e ex o numero sobe, em dp, pl e hgss desce. A primeira
  tentativa, com faixa estreita, cortava esses tres pela metade.

- **Inversao de polaridade.** Renderizei o que o motor REALMENTE recebe,
  reimplementando `tira()` em Python. Em swsh1-200 o numero sai BRANCO sobre
  escuro, ao contrario de base1 e xy1. `lerNome` ja tentava as duas
  polaridades desde sempre; `lerNumero` nao.

- **O denominador agora e usado.** `lerNumero` devolve `{numero, total}`. O
  total impresso identifica o SET: `card_count` do catalogo e exatamente
  aquele numero (base1=102, xy1=146, sm1=149, sv01=198, conferidos). Entre
  duas irmas na mesma posicao de sets diferentes, ele desempata.

  Filtro, nao exigencia: se o total lido nao bate com nenhuma candidata,
  segue so com o numerador. Descartar candidata boa por causa de um digito
  mal lido seria trocar acerto por nada.

- **A bancada media a copia dela, nao o app.** `teste-ocr.html` tinha suas
  proprias constantes, divergidas: a caixa da direita era `rh: 0.052`,
  justamente a faixa estreita que corta dp, pl e hgss. Agora ela importa
  `GEOMETRIAS`, `GEOMETRIAS_NUMERO` e `tira` de `ocr.js`.

- Invariante novo (36 no total): o mapa `totais` do cards.json tem que ser
  alcancavel pelo cliente, e o card_id tem que derivar o set certo nas
  32.339 cartas. Testado por mutacao tres vezes.

### O QUE NAO FOI VERIFICADO

**Nao rodei o motor.** Nao ha Tesseract nesta maquina e o navegador da
sessao nao alcanca o localhost. O que esta medido e a GEOMETRIA (24/24
legiveis) e o pre-processamento (renderizado e olhado). O que falta e a taxa
de acerto do Tesseract sobre esses recortes.

Para medir: servir o site e abrir `web/teste-ocr.html?n=40`. A bancada agora
usa o codigo do modulo, entao o numero que ela imprimir vale para o app.

## A colecao virou carteira — FEITA (26/08/2026)

A colecao e o historico de preco eram dois modulos que se ignoravam. A tela
mostrava o valor de HOJE enquanto o robo acumulava cotacao diaria desde
15/08. Quem coleciona nao pergunta "quanto vale" — pergunta "esta subindo?".

`colecao.valorPorDia()` + `colecao.variacao()` respondem isso, e
`grafico.figura()` desenha. Hoje sao 11 dias e a serie cresce sozinha.

### As tres decisoes que definem se o grafico e honesto

**Nao soma moedas.** Mesma regra do total. Um numero unico em real pareceria
valor de venda no Brasil, que e o que nao sabemos.

**Buraco nao e queda.** Dia sem cotacao repete o ultimo valor conhecido,
nunca conta zero. Medido: 96,4% das series sao completas na janela, media de
0,26 dia faltando — quase nunca entra em acao, mas quando entra e a
diferenca entre um grafico e uma mentira.

**Nao preenche para tras.** Antes da primeira cotacao a carta nao entra.
Repetir o primeiro valor desenharia uma reta que se le como "nao mexeu"
quando o certo e "nao sei".

**A porcentagem so aparece com a MESMA cesta nas duas pontas.** Carta que
entrou na cotacao no meio da janela faria a carteira "subir" sem nenhuma
carta ter ficado mais cara. Testado: cesta que muda devolve `null`, e a tela
diz por que nao ha porcentagem.

### A consistencia que ninguem perdoa

O ultimo ponto do grafico tem que ser o total exibido logo acima. Dois
numeros diferentes para a mesma coisa na mesma tela se leem como app
quebrado — com razao.

`mercadoDoItem()` centraliza a escolha de mercado para as duas contas
passarem por ela. Verificado no navegador com 12 cartas reais: diferenca
**zero**, 11 dias, cesta de 24 cartas, +1,60%.

Isso depende de `prices.json` e `historico.json` sairem da mesma execucao do
robo. Era suposicao ate eu medir: **10.118 de 10.118 mercados** batendo em
producao. Virou invariante (38 no total), testado por mutacao.

### O que foi verificado, e como

No navegador de verdade, com o app rodando: render, estilo do titulo,
ausencia de rolagem horizontal, largura em 375px, e a conferencia
grafico-x-total. A ficha tambem, porque `grafico.js` e compartilhado.

Um achado do teste em 375px: o grafico escrevia "US$ 239.37" com ponto e o
total logo acima "US$ 243,20" com virgula, na mesma tela. Unificado em
pt-BR — menos as coordenadas do SVG, onde o ponto e sintaxe.

## Nao perder a colecao — FEITA (26/08/2026)

O dado mais valioso do app nao e o indice de 32 mil cartas: esse eu
reconstruo. E a colecao, montada carta por carta, que nao existe em lugar
nenhum alem do `localStorage` — que o navegador pode apagar.

Nao e risco remoto. **O Safari do iPhone apaga o armazenamento de sites NAO
INSTALADOS depois de sete dias sem uso.** Quem escaneia um lote, guarda
trinta cartas e so volta no mes seguinte perde tudo, sem aviso e sem erro.

### Tres camadas, em ordem de quanto se pode confiar nelas

**1. Pedir persistencia.** `navigator.storage.persist()`, chamado quando a
pessoa guarda a primeira carta — na abertura seria pedir por nada, e o
navegador pondera engajamento ao conceder.

MEDIDO: num navegador real, o pedido voltou **negado**. O navegador decide
por heuristica. Por isso o resultado dele nao vira promessa na tela: so muda
a frase que ela mostra.

**2. Instalar o app.** E o que mais muda no iPhone — site na tela de inicio
nao sofre o despejo. A tela sugere isso quando detecta que nao esta
instalado.

**3. Exportar.** A unica que nao depende do navegador.

### A caixa diz a verdade, inclusive quando a verdade e "nao sei"

`persistente` tem TRES estados e a diferenca aparece no texto: `true` (o
navegador prometeu), `false` (pode apagar) e `null` (este navegador nao
informa). Afirmar "sua colecao esta segura" com base num `persist()`
concedido por heuristica seria promessa que nao posso cumprir — e a pessoa
so descobriria no dia em que a colecao sumisse.

O amarelo so entra quando o risco e real: nao persistido E nao instalado.
Caixa de alerta permanente vira parte do cenario, e a pessoa para de ler
justamente antes do dia em que ela importaria.

### A digital, e por que nao contagem

O lembrete de exportar precisa saber se algo mudou desde a ultima
exportacao. Contar cartas deixaria passar troca de mesma soma — vender duas
e comprar duas apareceria como "nada mudou". FNV-1a sobre as entradas
ordenadas nao erra.

Verificado no navegador, cinco transicoes: nunca exportada -> exportada ->
carta nova (mudou) -> desfeita (voltou a nao-mudou) -> **troca de mesma
quantidade total (mudou)**. O quinto caso e o que uma contagem perderia.

### Um defeito achado no caminho

Os botoes +/- da tela da colecao ignoravam o retorno de `adicionar()`. Com o
navegador recusando gravar (modo privado, cota cheia), a tela redesenhava
como se tivesse dado certo e o numero voltava ao anterior sem explicacao. O
leitor ja avisava; esta tela, nao.

## O que está pendente e é decisão sua, não técnica

1. **ID de afiliado** (Mercado Livre e Shopee, cadastro gratuito). O bloco
   "Comprar ou vender" já está no ar e funciona; sem o ID ele não gera
   comissão. Duas linhas em `web/mercado.js`, constante `AFILIADO`.

2. **Servidor ou não.** O índice de preço brasileiro e a assinatura de loja
   precisam de backend, o que contraria o "não quero assinar nada" que
   orientou o projeto inteiro. Sem decisão, essas duas ficam paradas.

3. **Teste com carta física que ESTEJA no índice.** As duas tentativas até
   agora usaram a mesma carta impossível. Use uma carta de set comum e o
   botão "copiar diagnóstico" (`?diag`) — o texto colado vale mais que
   vídeo, porque traz `nitidez`, `margem`, `separacao` e `janela`.

## Etapas que ficaram para depois do OCR

- **3. Tela de processamento** — compra os 2–3 s da análise pesada e diz o
  que está acontecendo. Vira necessária quando o OCR entrar, porque ele
  aumenta o tempo de resposta.
- **4. Gráfico de histórico — FEITA (19/08/2026).** `export_historico.py`
  exporta a série e `web/grafico.js` desenha na ficha, um gráfico por
  variante × mercado. 333 mil pontos, 5 dias, 0,42 MB comprimido, baixado sob
  demanda ao abrir a ficha.

  O passado é reduzido a semanal depois de 30 dias. Isso não é economia
  prematura: cresce ~0,08 MB por dia, e em um ano o arquivo único passaria de
  25 MB comprimido para mostrar a série de UMA carta.

## Estado do scanner, sem enfeite

Funciona: detecção de borda com inclinação, recorte desentortado, captura
com análise pesada de 5 recortes, leitura por foto da câmera nativa (3/3 a
99% contra 2/4 pelo vídeo), busca por nome como saída, comparação lado a
lado da sua foto com a resposta.

Não funciona bem: o travamento automático em condição ruim. Ele identifica
certo e não fecha. Os limiares estão na fronteira e a bancada dá resultado
diferente a cada execução — tentei calibrar três vezes contra cena sintética
e isso é ajustar contra ruído. Precisa de número de aparelho real.

## As bancadas

Abrir no navegador, com o site servido:

- `selftest.html` — o hash em JS bate com o do Python
- `teste-arte.html` — quantas cartas mostram foto de verdade
- `teste-rotacao.html` — ângulo recuperado e ganho do desentortamento
- `teste-camera.html` — o app inteiro num iframe, com câmera falsa em sete
  cenas. É a única que exercita o laço real, e foi ela que achou o defeito
  que fazia tudo parecer quebrado.

Antes de qualquer publicação: `python tests/test_invariantes.py` (29
checagens) e `python tests/checar_js.py`.
