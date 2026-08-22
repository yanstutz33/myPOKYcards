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
const FOIL = /holo|ultra|secret|rainbow|shiny|illustration|hyper|amazing|radiant|prism|gold|star|full art|alt/i;
export const eFoil = (raridade) => FOIL.test(raridade || "");
