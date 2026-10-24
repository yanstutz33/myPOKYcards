/**
 * Os números do hero saem do banco, não do HTML.
 *
 * Número cravado em landing page envelhece calado e vira mentira na
 * primeira atualização — e esta página existe justamente para dizer que o
 * projeto mede o que afirma.
 */
const N = (v) => Number(v || 0).toLocaleString("pt-BR");

const CAMPOS = [
  ["cartas", "Cartas Pokémon no catálogo", "EN · JA · KO · ZH · PT"],
  ["hashes", "Pokémon reconhecíveis", "índice local, sem rede"],
  ["cartas_preco", "Com preço", "por variante e mercado"],
  ["cotacoes", "Cotações", "cada uma com fonte e data"],
];

// Um número por jogo, e não um total: os quatro catálogos têm fontes e
// coberturas diferentes, e somar faria parecer um catálogo só.
const JOGOS = [
  ["onepiece", "One Piece reconhecíveis"],
  ["lorcana", "Lorcana reconhecíveis"],
  ["riftbound", "Riftbound reconhecíveis"],
];

(async () => {
  const alvo = document.getElementById("numeros");
  let d;
  try {
    d = await fetch("data/numeros.json").then((r) => r.json());
  } catch {
    alvo.closest("section").remove();   // sem dado, sem seção: nada de zeros
    return;
  }
  alvo.innerHTML = CAMPOS.map(([chave, rotulo, nota]) =>
    `<div class="kpi"><small>${rotulo}</small><b>${N(d[chave])}</b>
      <em>${nota}</em></div>`).join("") +
    JOGOS.filter(([chave]) => d.jogos?.[chave])
      .map(([chave, rotulo]) => `<div class="kpi"><small>${rotulo}</small>
        <b>${N(d.jogos[chave])}</b><em>imagem e preço do TCGplayer</em></div>`).join("");
})();
