/**
 * Tela de busca. Toca no resultado e abre a mesma ficha do leitor —
 * uma ficha só, um lugar só para manter.
 */
import * as busca from "./buscar.js";
import * as ficha from "./ficha.js";
import { corDaCarta, energiasHtml } from "./tema.js";

const els = {
  q: document.getElementById("q"),
  lista: document.getElementById("lista"),
};

let catalogo = null, precos = {}, fx = null;

function converter(valor, moeda) {
  const t = fx?.taxas?.[moeda];
  if (!t) return "";
  const v = valor * t.taxa;
  return `<span class="brl">≈ R$ ${v >= 100 ? v.toFixed(0) : v.toFixed(2)}</span>`;
}

let tempo = null;
function aoDigitar() {
  // Espera curta: buscar a cada tecla em 30 mil itens trava a digitação em
  // aparelho modesto, e 120 ms é imperceptível para quem digita.
  clearTimeout(tempo);
  tempo = setTimeout(() => {
    const achados = busca.buscar(els.q.value);
    if (els.q.value.trim().length < 2) {
      els.lista.innerHTML = `<p class="busca-vazio">Digite pelo menos duas letras.<br>
        Busca em ${catalogo.count.toLocaleString("pt-BR")} cartas, no próprio aparelho.</p>`;
      return;
    }
    els.lista.innerHTML = achados.length
      ? achados.map(busca.linhaHtml).join("")
      : `<p class="busca-vazio">Nada encontrado para
         “${els.q.value.replace(/[<>&]/g, "")}”.<br>
         Carta japonesa costuma estar cadastrada com o nome em japonês.</p>`;
  }, 120);
}

els.q.addEventListener("input", aoDigitar);
els.lista.addEventListener("click", (ev) => {
  const item = ev.target.closest(".b-item");
  if (item) ficha.abrir(item.dataset.card);
});

(async () => {
  try {
    [catalogo, precos, fx] = await Promise.all([
      fetch("data/cards.json").then((r) => r.json()),
      fetch("data/prices.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      fetch("data/fx.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
  } catch {
    els.lista.innerHTML = `<p class="busca-vazio">Não consegui carregar o catálogo.</p>`;
    return;
  }
  busca.configurar(catalogo, precos);
  ficha.configurar({
    get catalog() { return catalogo; },
    get prices() { return precos; },
    get fx() { return fx; },
    converter, corDaCarta, energiasHtml,
  });
  ficha.ligarControles();
  els.q.focus();
})();
