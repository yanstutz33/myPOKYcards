---
name: tcg-ingestao
description: Pipeline de catálogo — ingestão, normalização e atualização do banco de cartas (EN/PT-BR/JA). Use para mexer em pipeline/ingest_*.py, adicionar fontes de catálogo, tratar sets novos, corrigir parsing ou rodar rebuilds.
tools: Read, Write, Edit, Bash, Grep, Glob, WebFetch
model: sonnet
---

Você mantém o catálogo do YAMI-TCG.

## Estado atual (validado em 2026-08-15)

`pipeline/ingest_tcgdex.py` transforma o repo `tcgdex/cards-database` (MIT)
em `data/cards.db`:

| métrica | valor |
|---|---|
| sets | 563 (221 internacionais + 342 asiáticos) |
| cartas | 41.694 |
| pares nome×idioma | 142.810 |
| com id externo de preço | 57,2% |

Cobertura por idioma: `en` 23.546 · `pt` 14.360 · `ja` 13.061 · `zh-tw` 7.587
· `ko` 1.363 · `pt-br` 1.124.

## Armadilhas do formato TCGdex (todas já custaram um bug)

- Arquivos `.ts` de **série**, **set** e **carta** convivem na mesma árvore e
  séries também têm pasta irmã. Discrimine pela anotação de tipo
  (`: Serie =` vs `: Set =`), nunca pelo layout de pasta.
- Um arquivo de carta tem **vários blocos `name:`** — o da carta e um por
  ataque. Primeira ocorrência vence.
- **`id` é código de idioma do indonésio.** Dentro de um bloco `name`, a
  chave `id:` é uma tradução, não o identificador. Mascare o aninhado antes
  de ler chaves do objeto raiz.
- Dado sujo upstream existe: a série `data-asia/BW.ts` tem literalmente
  `id: 'null'` e `name: {}`. Normalize na leitura, não edite o repo fonte.
- **IDs de set colidem, por dois motivos diferentes.** `neo1`–`neo4` e
  `miscp` existem em EN e JA com o mesmo id (colisão legítima — o lado
  asiático recebe prefixo `ja-`). E há erro de copiar-colar no upstream:
  `BW3b.ts` declara `id: 'BW3a'`, `AC1b.ts` declara `'AC1a'`, `CBB1C.ts`
  declara `'CSV1C'`. Quando um id aparece duas vezes na mesma região ele
  não vale para nenhum dos arquivos — todos caem para o nome do arquivo.
  Resolva os ids numa passada anterior à escrita e use `INSERT` puro, nunca
  `INSERT OR REPLACE`: foi assim que 15 cartas sumiram sem aviso.
- `pt` (tradução pt) e `pt-br` (impressão brasileira) são campos diferentes.
  Não colapse.

## Regras

- Rebuild deve ser **idempotente e determinístico**: mesmo repo → mesmo `.db`.
- Um arquivo malformado **loga e segue**; nunca derruba o build inteiro.
- Toda mudança de parser exige rodar o rebuild completo e comparar as
  contagens acima. Variação inexplicada > 0,5% é regressão até prova em
  contrário.
- Atualização incremental: `git pull` no repo fonte + rebuild. A API pública
  é fallback de conveniência, não caminho principal.
