/**
 * Camada temática: traduz dado da carta em decisão visual.
 *
 * Nada aqui é escolha estética solta — a cor vem do tipo de energia da
 * carta, o brilho vem da raridade ser de fato holográfica. Carta comum sai
 * sóbria, e é isso que faz o brilho significar alguma coisa quando aparece.
 */

const COR_TIPO = {
  Grass: "--t-grass", Fire: "--t-fire", Water: "--t-water",
  Lightning: "--t-lightning", Psychic: "--t-psychic", Fighting: "--t-fighting",
  Darkness: "--t-darkness", Metal: "--t-metal", Dragon: "--t-dragon",
  Fairy: "--t-fairy", Colorless: "--t-colorless",
  // Os outros jogos têm a mesma ideia com outro nome — tinta no Lorcana, cor
  // no One Piece, domínio no Riftbound — e cada uma já é, no próprio jogo,
  // um vermelho, um verde, um azul. Usa a mesma paleta em vez de inventar
  // uma segunda: seis cores a mais na tela não diriam nada a mais.
  // One Piece
  Red: "--t-fire", Green: "--t-grass", Blue: "--t-water",
  Purple: "--t-psychic", Black: "--t-darkness", Yellow: "--t-lightning",
  // Lorcana
  Amber: "--t-lightning", Amethyst: "--t-psychic", Emerald: "--t-grass",
  Ruby: "--t-fire", Sapphire: "--t-water", Steel: "--t-metal",
  // Riftbound
  Fury: "--t-fire", Calm: "--t-grass", Mind: "--t-water",
  Body: "--t-fighting", Chaos: "--t-psychic", Order: "--t-lightning",
};

/** Cor da carta = seu primeiro tipo. Sem tipo (treinador, energia): ciano. */
export function corDaCarta(tipos) {
  const v = COR_TIPO[(tipos || [])[0]];
  return v ? `var(${v})` : "var(--scan)";
}

export function energiasHtml(tipos) {
  if (!tipos?.length) return "";
  const pastilhas = tipos.map((t) => {
    const v = COR_TIPO[t];
    return `<span class="energia" title="${t}"
      style="--cor:${v ? `var(${v})` : "var(--ink-soft)"}"></span>`;
  }).join("");
  return `<span class="tipos">${pastilhas}</span>`;
}

/**
 * A raridade é holográfica?
 *
 * Testado contra as raridades reais do catálogo. A lista é por substring
 * porque o campo tem dezenas de variações ("Holo Rare V", "Ultra Rare",
 * "Rare Secret", "Illustration Rare"…) e enumerar todas envelheceria mal.
 */
//
// Os outros jogos entram pelos nomes que o TCGplayer usa: Enchanted e
// Epic/Iconic (Lorcana), SEC/SP/Manga/TR (One Piece), Showcase e Overnumbered
// (Riftbound). "SR" e "SEC" vão com borda de palavra: sem ela, qualquer
// raridade com "sr" no meio brilharia.
const FOIL = /holo|ultra|secret|rainbow|shiny|illustration|hyper|amazing|radiant|prism|gold|star|full art|alt|enchanted|epic|iconic|showcase|overnumbered|manga|\bsec\b|\bsp\b|\btr\b|\bsr\b|treasure/i;
export const eFoil = (raridade) => FOIL.test(raridade || "");
