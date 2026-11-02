/**
 * Tela de busca. Toca no resultado e abre a mesma ficha do leitor —
 * uma ficha só, um lugar só para manter.
 */
import * as busca from "./buscar.js";
import * as ficha from "./ficha.js";
import { corDaCarta, energiasHtml } from "./tema.js";

const $ = (id) => document.getElementById(id);
const els = {
  q: $("q"), lista: $("lista"),
  jogo: $("fJogo"), raridade: $("fRaridade"), min: $("fMin"), max: $("fMax"),
  ordem: $("fOrdem"), limpar: $("fLimpar"),
};

let catalogo = null, precos = {}, fx = null;

function converter(valor, moeda) {
  const t = fx?.taxas?.[moeda];
  if (!t) return "";
  const v = valor * t.taxa;
  return `<span class="brl">≈ R$ ${v >= 100 ? v.toFixed(0) : v.toFixed(2)}</span>`;
}

/** Número do campo, ou null. Vazio não é zero: "sem mínimo" ≠ "mínimo R$ 0". */
const numero = (el) => {
  const v = String(el.value || "").replace(",", ".").trim();
  return v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
};

function filtros() {
  return {
    jogo: els.jogo.value || null,
    raridade: els.raridade.value || null,
    min: numero(els.min),
    max: numero(els.max),
    ordem: els.ordem.value,
  };
}

/** As raridades mudam com o jogo: "SEC" não existe em Pokémon. */
function preencherRaridades() {
  const atual = els.raridade.value;
  const lista = busca.raridades(els.jogo.value || null).slice(0, 60);
  els.raridade.innerHTML = `<option value="">Qualquer raridade</option>` +
    lista.map(([r, n]) => `<option value="${r.replace(/"/g, "&quot;")}">${
      r.replace(/</g, "&lt;")} (${n.toLocaleString("pt-BR")})</option>`).join("");
  els.raridade.value = lista.some(([r]) => r === atual) ? atual : "";
}

let tempo = null;
function aoDigitar() {
  // Espera curta: buscar a cada tecla em 44 mil itens trava a digitação em
  // aparelho modesto, e 120 ms é imperceptível para quem digita.
  clearTimeout(tempo);
  tempo = setTimeout(() => {
    const f = filtros();
    const temFiltro = Boolean(f.jogo || f.raridade || f.min != null || f.max != null);
    els.limpar.hidden = !temFiltro && f.ordem === "relevancia";
    if (els.q.value.trim().length < 2 && !temFiltro) {
      els.lista.innerHTML = `<p class="busca-vazio">Digite pelo menos duas letras,
        ou escolha um filtro.<br>
        Busca em ${catalogo.count.toLocaleString("pt-BR")} cartas, no próprio aparelho.</p>`;
      return;
    }
    const achados = busca.buscar(els.q.value, 60, f);
    const faixa = f.min != null || f.max != null;
    els.lista.innerHTML = achados.length
      ? achados.map(busca.linhaHtml).join("") + (faixa ? `<p class="busca-vazio">Faixa de
          preço em real pela PTAX${fx?.taxas?.USD?.em ? ` de ${fx.taxas.USD.em.slice(0, 10)}` : ""};
          cartas sem cotação ficam fora.</p>` : "")
      : `<p class="busca-vazio">Nada encontrado${els.q.value.trim()
          ? ` para “${els.q.value.replace(/[<>&]/g, "")}”` : ""} com estes filtros.<br>
         Carta japonesa costuma estar cadastrada com o nome em japonês.</p>`;
  }, 120);
}

els.q.addEventListener("input", aoDigitar);
for (const el of [els.raridade, els.min, els.max, els.ordem]) {
  el.addEventListener("input", aoDigitar);
}
els.jogo.addEventListener("input", () => { preencherRaridades(); aoDigitar(); });
els.limpar.addEventListener("click", () => {
  // A raridade também: "Enchanted" existe no catálogo inteiro, então
  // `preencherRaridades` a manteria — e "Limpar" deixaria um filtro ativo
  // escondendo todo Charizard (achado no teste).
  els.jogo.value = ""; els.raridade.value = ""; els.min.value = ""; els.max.value = "";
  els.ordem.value = "relevancia";
  preencherRaridades();
  aoDigitar();
});
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
  busca.configurarCambio(fx);
  // Sem taxa de câmbio a faixa em real não tem como ser aplicada: os campos
  // somem em vez de filtrar errado.
  if (!fx?.taxas) { els.min.hidden = true; els.max.hidden = true; }
  preencherRaridades();
  ficha.configurar({
    get catalog() { return catalogo; },
    get prices() { return precos; },
    get fx() { return fx; },
    converter, corDaCarta, energiasHtml,
  });
  ficha.ligarControles();
  els.q.focus();
})();
