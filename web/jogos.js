/**
 * Os jogos que o leitor reconhece, e o que muda de um para outro.
 *
 * O índice é UM só: Pokémon, One Piece, Lorcana e Riftbound no mesmo
 * index.bin, porque quem aponta a câmera não diz antes qual jogo é. O que
 * separa um do outro é o campo `regiao` do cards.json, que já existia para
 * dividir carta internacional de asiática — os jogos novos entram como
 * regiões próprias, e cada tela pergunta a este módulo o que exibir.
 *
 * Um lugar só para essas decisões porque elas estavam espalhadas em seis
 * telas como `regiao === "asia" ? "JA" : "INTL"`. Com quatro jogos, seis
 * cópias dessa linha divergiriam na primeira mudança.
 */

export const JOGOS = {
  pokemon: { nome: "Pokémon", regioes: ["intl", "asia"], termo: "pokemon" },
  onepiece: { nome: "One Piece", regioes: ["onepiece"], termo: "one piece card game" },
  lorcana: { nome: "Lorcana", regioes: ["lorcana"], termo: "lorcana" },
  riftbound: { nome: "Riftbound", regioes: ["riftbound"], termo: "riftbound" },
};

const SELO = { intl: "INTL", asia: "JA", onepiece: "OP", lorcana: "LOR", riftbound: "RB" };

const NOME_REGIAO = {
  intl: "Pokémon · Internacional",
  asia: "Pokémon · Ásia (japonês e afins)",
  onepiece: "One Piece Card Game",
  lorcana: "Disney Lorcana",
  riftbound: "Riftbound (League of Legends)",
};

export const selo = (regiao) => SELO[regiao] || "INTL";
export const nomeRegiao = (regiao) => NOME_REGIAO[regiao] || NOME_REGIAO.intl;

export function jogoDaRegiao(regiao) {
  for (const [id, j] of Object.entries(JOGOS)) if (j.regioes.includes(regiao)) return id;
  return "pokemon";
}

export const ePokemon = (regiao) => jogoDaRegiao(regiao) === "pokemon";

/**
 * Endereço da arte, a partir do `caminho_arte` do cards.json.
 *
 * Pokémon: sufixo no CDN do TCGdex ("en/swsh/swsh3/136"), que serve
 * `low.png` e às vezes `high.png`.
 *
 * Outros jogos: "tcgp:<productId>", imagem do CDN do TCGplayer. O índice foi
 * montado com a de 400 px; `low` usa 200 px porque é miniatura, e `high`
 * pede a de 1000 px, que existe para todo produto com imagem — conferido
 * nas mesmas URLs que o indexador baixou.
 *
 * O site continua não hospedando arte nenhuma: aponta para a origem, que
 * nos dois casos responde com `Access-Control-Allow-Origin: *`.
 */
const TCGP = "https://tcgplayer-cdn.tcgplayer.com/product";
const TAM_TCGP = { low: "200w", media: "400w", high: "in_1000x1000" };

export function urlArte(catalog, caminho, qualidade = "low") {
  if (!caminho) return "";
  if (caminho.startsWith("tcgp:")) {
    return `${TCGP}/${caminho.slice(5)}_${TAM_TCGP[qualidade] || TAM_TCGP.low}.jpg`;
  }
  // As 554 cartas Pokémon com arte da pokemontcg.io (complementar_arte.py)
  // guardam o endereço COMPLETO — o exportador só tira o prefixo do TCGdex.
  // Antes daqui, toda tela montava "assets.tcgdex.net/https://images...",
  // e essas cartas apareciam sem arte em todo lugar (achado em 24/10/2026,
  // no top 3 da coleção). A versão grande da fonte é `_hires.png`.
  if (/^https?:\/\//.test(caminho)) {
    return qualidade === "high" && caminho.includes("images.pokemontcg.io/")
      ? caminho.replace(/\.png$/, "_hires.png")
      : caminho;
  }
  // `media` não existe no TCGdex; a `low` é a imagem que o índice usou.
  return `${catalog.cdn}/${caminho}/${qualidade === "high" ? "high" : "low"}.png`;
}

/** Página do produto no TCGplayer, que é de onde vem o preço desses jogos. */
export function urlTcgplayer(caminho) {
  return caminho?.startsWith("tcgp:")
    ? `https://www.tcgplayer.com/product/${caminho.slice(5)}`
    : null;
}

/**
 * Máscara de busca para o worker: 1 nas cartas do jogo escolhido.
 *
 * `null` quer dizer "todos" — e é o padrão. Filtrar sem a pessoa pedir faria
 * uma carta de outro jogo virar o vizinho mais parecido do jogo filtrado,
 * com ar de certeza. Quando ela PEDE, o filtro é o contrário disso: tira do
 * caminho quarenta mil cartas que nunca seriam a resposta.
 */
export function mascara(catalog, jogo) {
  if (!jogo || jogo === "todos" || !JOGOS[jogo]) return null;
  const regioes = new Set(JOGOS[jogo].regioes);
  const m = new Uint8Array(catalog.meta.length);
  catalog.meta.forEach((x, i) => { if (regioes.has(x[4])) m[i] = 1; });
  return m;
}

/** Cartas reconhecíveis por jogo, a partir do `por_regiao` do cards.json. */
export function contagem(catalog, jogo) {
  const por = catalog.por_regiao || {};
  if (!jogo || jogo === "todos") return catalog.count;
  return (JOGOS[jogo]?.regioes || []).reduce((s, r) => s + (por[r] || 0), 0);
}

// A escolha sobrevive à recarga: quem só coleciona Lorcana não deveria
// escolher de novo a cada visita. Só conveniência — se o navegador recusar
// guardar, o leitor volta a "todos", que é o comportamento seguro.
const CHAVE = "myPOKYcards:jogo";

export function lerEscolha() {
  try {
    const v = localStorage.getItem(CHAVE);
    return v && (v === "todos" || JOGOS[v]) ? v : "todos";
  } catch { return "todos"; }
}

export function gravarEscolha(jogo) {
  try { localStorage.setItem(CHAVE, jogo); } catch { /* sem armazenamento */ }
}
