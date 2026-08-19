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
- **4. Gráfico de histórico** — `data/price_history.csv.gz` acumula desde
  15/08 e já tem 266.798 pontos em 4 dias. Nunca foi exportado nem exibido.
  É o ativo que não se copia: quem começar depois leva meses para ter série.

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
