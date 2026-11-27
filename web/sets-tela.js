/**
 * Navegar por set, e quanto de cada um a pessoa já tem.
 *
 * A pergunta de quem coleciona por set não é "quanto vale" — é "quanto
 * falta". A lista mostra a completude de cada set; o set aberto mostra a
 * grade com o que tem e o que falta, e quanto custaria completar.
 *
 * O que conta como "tenho"
 * ------------------------
 * Carta DIFERENTE, em qualquer variante e qualquer coleção. Três cópias da
 * mesma carta não completam três posições, e um reverse holo completa a
 * posição tanto quanto o normal — é assim que fichário de set funciona.
 *
 * O denominador
 * -------------
 * As cartas do set que estão no índice (cards.json). Para Pokémon isso é o
 * que tem imagem em alguma fonte: 96,9% das internacionais, bem menos das
 * asiáticas. Usar o total impresso ("/198") deixaria fora as secretas, que
 * existem e se colecionam; usar o catálogo inteiro exigiria baixar 41 mil
 * cartas para mostrar uma porcentagem. Fica o índice, e o total impresso
 * aparece ao lado quando é conhecido, para a diferença ficar visível.
 */

import * as colecao from "./colecao.js";
import * as ficha from "./ficha.js";
import { corDaCarta, energiasHtml } from "./tema.js";
import { JOGOS, jogoDaRegiao, selo, urlArte, nomeRegiao } from "./jogos.js";

const alvo = document.getElementById("sets");
const titulo = document.getElementById("titulo");
const SIMBOLO = { USD: "US$", EUR: "€", BRL: "R$", JPY: "¥" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const N = (v) => Number(v || 0).toLocaleString("pt-BR");
const fmt = (v, m) => `${SIMBOLO[m] || m + " "} ${v.toLocaleString("pt-BR",
  { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

let catalogo = null, precos = {}, fx = null;
let sets = [];             // [{ id, nome, regiao, idx: [posições no catálogo] }]
let porId = new Map();

// Mesma derivação do app e do exportador: o set é o card_id até o ÚLTIMO
// hífen ("SV-P-001" -> "SV-P", "lor17690-454233" -> "lor17690").
const setDe = (cardId) => {
  const c = cardId.lastIndexOf("-");
  return c > 0 ? cardId.slice(0, c) : cardId;
};

/** Posição para ordenar: "OP05-119" -> 119, "045/198" -> 45, "T1S 003/005" -> 1. */
function ordemDoNumero(numero) {
  // Tira o prefixo do set quando ele vem colado ("OP05-119", "ST01-003"):
  // senão o 05 do set ordenaria antes do número da carta.
  const s = String(numero || "").replace(/^[A-Z]{1,4}\d{1,3}-/i, "");
  const m = s.match(/\d+/);
  return m ? Number(m[0]) : Number.MAX_SAFE_INTEGER;
}

/**
 * Carta gigante promocional ("Hades - King of Olympus (Oversized)") tem o
 * mesmo número da carta do set e não ocupa posição no fichário. Medido em
 * 24/10/2026: 12 no índice (4 Lorcana, 1 One Piece, 7 Riftbound). Elas
 * continuam no leitor e na busca — têm preço e se colecionam —, só não
 * contam como carta do set.
 */
const GIGANTE = /\(oversized?\)/i;

function montarSets() {
  const mapa = new Map();
  catalogo.ids.forEach((id, i) => {
    if (GIGANTE.test(catalogo.meta[i][0])) return;
    const s = setDe(id);
    let x = mapa.get(s);
    if (!x) {
      x = { id: s, nome: catalogo.meta[i][1], regiao: catalogo.meta[i][4], idx: [] };
      mapa.set(s, x);
    }
    x.idx.push(i);
  });
  for (const x of mapa.values()) {
    x.idx.sort((a, b) => ordemDoNumero(catalogo.meta[a][2]) - ordemDoNumero(catalogo.meta[b][2])
      || String(catalogo.meta[a][2]).localeCompare(String(catalogo.meta[b][2])));
  }
  sets = [...mapa.values()];
  porId = mapa;
}

/** card_ids que a pessoa tem, em qualquer coleção e variante. */
function tenho() {
  return new Set(colecao.itens().map((it) => it.card_id));
}

// ----------------------------------------------------------------- lista

const filtro = { jogo: "", texto: "", so: "" };

function listaHtml() {
  const meus = tenho();
  const norm = (s) => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  const q = norm(filtro.texto.trim());

  const linhas = sets
    .filter((s) => !filtro.jogo || JOGOS[filtro.jogo]?.regioes.includes(s.regiao))
    .filter((s) => !q || norm(`${s.nome} ${s.id}`).includes(q))
    .map((s) => {
      const tem = s.idx.reduce((n, i) => n + (meus.has(catalogo.ids[i]) ? 1 : 0), 0);
      return { s, tem, pct: s.idx.length ? tem / s.idx.length : 0 };
    })
    .filter(({ tem }) => filtro.so !== "comecados" || tem > 0)
    // Os que a pessoa começou primeiro, do mais completo ao menos; depois o
    // resto por nome. Quem abre esta tela quer ver o próprio progresso antes
    // de 400 sets que nunca tocou.
    .sort((a, b) => (b.tem > 0) - (a.tem > 0) || b.pct - a.pct
      || a.s.nome.localeCompare(b.s.nome, "pt-BR"));

  const comecados = sets.filter((s) => s.idx.some((i) => meus.has(catalogo.ids[i]))).length;
  const completos = sets.filter((s) => s.idx.every((i) => meus.has(catalogo.ids[i]))).length;

  return `
    <section class="bloco">
      <div class="kpis">
        <div class="kpi"><small>Sets</small><b>${N(sets.length)}</b>
          <em>no índice do leitor</em></div>
        <div class="kpi"><small>Começados</small><b>${N(comecados)}</b>
          <em>com pelo menos uma carta sua</em></div>
        <div class="kpi"><small>Completos</small><b>${N(completos)}</b>
          <em>todas as cartas do índice</em></div>
      </div>
      <div class="filtros filtros-sets">
        <input id="fTexto" type="search" placeholder="Nome do set…" aria-label="Buscar set"
               value="${esc(filtro.texto)}">
        <select id="fJogo" aria-label="Jogo">
          <option value="">Todos os jogos</option>
          ${Object.entries(JOGOS).map(([k, j]) =>
            `<option value="${k}"${filtro.jogo === k ? " selected" : ""}>${esc(j.nome)}</option>`).join("")}
        </select>
        <select id="fSo" aria-label="Mostrar">
          <option value="">Todos os sets</option>
          <option value="comecados"${filtro.so === "comecados" ? " selected" : ""}>Só os que comecei</option>
        </select>
      </div>
    </section>
    <section class="bloco">
      <div class="lista-sets">${linhas.length ? linhas.map(({ s, tem, pct }) => `
        <a class="set-linha${tem ? " comecado" : ""}${tem && tem === s.idx.length ? " completo" : ""}"
           href="#set=${encodeURIComponent(s.id)}">
          <span class="set-nome">${esc(s.nome)}</span>
          <span class="set-meta"><span class="selo-jogo selo-${jogoDaRegiao(s.regiao)}">${
            selo(s.regiao)}</span> ${N(tem)} de ${N(s.idx.length)}${
            catalogo.totais?.[s.id] ? ` · impresso /${N(catalogo.totais[s.id])}` : ""}</span>
          <span class="set-pct">${Math.floor(pct * 100)}%</span>
          <span class="trilho"><i class="feito" style="width:${(pct * 100).toFixed(1)}%"></i></span>
        </a>`).join("") : `<p class="empty">Nenhum set com estes filtros.</p>`}
      </div>
    </section>`;
}

// --------------------------------------------------------------- um set

let mostrar = "todas";     // "todas" | "tenho" | "faltam"

/**
 * Quanto custaria comprar o que falta, por moeda.
 *
 * Pela variante mais barata cotada de cada carta: para completar a
 * posição no fichário qualquer variante serve, e a pergunta é o mínimo.
 * Moedas não se somam (mesma regra da coleção), e carta sem cotação é
 * contada à parte — o custo de completar com cinco cartas "sem preço" não
 * é o número da tela, é ele mais algo que não se sabe.
 */
function custoParaCompletar(faltam) {
  const porMoeda = {};
  let semPreco = 0;
  for (const i of faltam) {
    const ms = (precos[catalogo.ids[i]] || []).filter((m) => m.ref > 0);
    if (!ms.length) { semPreco++; continue; }
    // A mais barata na moeda do PRIMEIRO mercado da carta (o mesmo que a
    // grade exibe). Trocar de moeda para achar a mais barata exigiria
    // comparar euro com dólar, que é o que esta tela não faz.
    const m = ms.reduce((a, b) => (b.c === a.c && b.ref < a.ref ? b : a));
    porMoeda[m.c] = (porMoeda[m.c] || 0) + m.ref;
  }
  return { porMoeda, semPreco };
}

function setHtml(s) {
  const meus = tenho();
  const tem = s.idx.filter((i) => meus.has(catalogo.ids[i]));
  const faltam = s.idx.filter((i) => !meus.has(catalogo.ids[i]));
  const pct = s.idx.length ? tem.length / s.idx.length : 0;
  const custo = custoParaCompletar(faltam);
  const visiveis = mostrar === "tenho" ? tem : mostrar === "faltam" ? faltam : s.idx;

  return `
    <section class="bloco">
      <a class="voltar" href="#">← Todos os sets</a>
      <div class="kpis">
        <div class="kpi"><small>Completude</small><b>${Math.floor(pct * 100)}%</b>
          <em>${N(tem.length)} de ${N(s.idx.length)} cartas${
            catalogo.totais?.[s.id] ? ` · impresso /${N(catalogo.totais[s.id])}` : ""}</em></div>
        <div class="kpi"><small>Faltam</small><b>${N(faltam.length)}</b>
          <em>${esc(nomeRegiao(s.regiao))}</em></div>
        ${Object.entries(custo.porMoeda).map(([m, v]) => `
          <div class="kpi"><small>Para completar (${esc(m)})</small><b>${fmt(v, m)}</b>
            <em>variante mais barata de cada uma</em></div>`).join("")}
      </div>
      ${custo.semPreco ? `<p class="prog-nota">${N(custo.semPreco)} carta(s) que faltam
        não têm cotação e não entram no custo para completar.</p>` : ""}
      ${Object.keys(custo.porMoeda).length > 1 ? `<p class="prog-nota">Os custos ficam
        separados por moeda: cada carta entra na moeda do mercado que a cota.</p>` : ""}
      <span class="trilho trilho-grande"><i class="feito" style="width:${(pct * 100).toFixed(1)}%"></i></span>
      <div class="periodos" role="group" aria-label="Mostrar">
        ${[["todas", `Todas ${s.idx.length}`], ["tenho", `Tenho ${tem.length}`],
           ["faltam", `Faltam ${faltam.length}`]].map(([v, r]) =>
          `<button type="button" data-mostrar="${v}" aria-pressed="${mostrar === v}"
            class="${mostrar === v ? "ativo" : ""}">${r}</button>`).join("")}
      </div>
    </section>
    <section class="bloco">
      <div class="grade-set">${visiveis.map((i) => {
        const id = catalogo.ids[i];
        const [nome, , numero, , , , , caminho, , tipos] = catalogo.meta[i];
        const p = (precos[id] || [])[0];
        const minha = meus.has(id);
        return `<button type="button" class="gs-carta${minha ? " tenho" : ""}" data-ficha="${esc(id)}"
            style="--tipo:${corDaCarta(tipos)}" title="${esc(nome)} · ${esc(numero)}">
          ${caminho ? `<img alt="" loading="lazy" decoding="async"
               src="${esc(urlArte(catalogo, caminho))}">` : `<span class="gs-sem"></span>`}
          ${minha ? `<span class="gs-ok" aria-label="tenho">✓</span>` : ""}
          <span class="gs-num">${esc(numero)}</span>
          <span class="gs-preco">${p ? fmt(p.ref, p.c) : "—"}</span>
        </button>`;
      }).join("") || `<p class="empty">${mostrar === "tenho"
        ? "Nenhuma carta deste set na sua coleção ainda." : "Nenhuma faltando. Set completo!"}</p>`}
      </div>
    </section>`;
}

// ----------------------------------------------------------------- rota

/** `#set=<id>` abre um set; vazio volta à lista. O voltar do celular funciona. */
function desenhar() {
  const m = location.hash.match(/^#set=(.+)$/);
  const s = m ? porId.get(decodeURIComponent(m[1])) : null;
  if (s) {
    titulo.textContent = s.nome;
    document.title = `myPOKYcards · ${s.nome}`;
    alvo.innerHTML = setHtml(s);
    window.scrollTo(0, 0);
  } else {
    titulo.textContent = "Sets";
    document.title = "myPOKYcards · Sets";
    alvo.innerHTML = listaHtml();
  }
}

window.addEventListener("hashchange", () => { mostrar = "todas"; desenhar(); });

alvo.addEventListener("input", (ev) => {
  if (ev.target.id === "fTexto") filtro.texto = ev.target.value;
  else if (ev.target.id === "fJogo") filtro.jogo = ev.target.value;
  else if (ev.target.id === "fSo") filtro.so = ev.target.value;
  else return;
  // Redesenhar refaz o campo de texto: devolve o foco e o cursor ao fim, ou
  // a pessoa perderia a digitação a cada letra.
  const foco = ev.target.id;
  desenhar();
  const el = document.getElementById(foco);
  if (el) { el.focus(); if (el.setSelectionRange) el.setSelectionRange(el.value.length, el.value.length); }
});

alvo.addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-mostrar]");
  if (b) { mostrar = b.dataset.mostrar; desenhar(); return; }
  const c = ev.target.closest("[data-ficha]");
  if (c) ficha.abrir(c.dataset.ficha);
});

// A ficha guarda cartas: ao fechar, a grade precisa refletir o que mudou.
document.getElementById("ficha").addEventListener("click", (ev) => {
  if (ev.target.closest("[data-guardar], #fecharFicha")) setTimeout(desenhar, 0);
});

(async () => {
  try {
    [catalogo, precos, fx] = await Promise.all([
      fetch("data/cards.json").then((r) => r.json()),
      fetch("data/prices.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      fetch("data/fx.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
  } catch (e) {
    alvo.innerHTML = `<div class="nodata"><b>Não foi possível carregar o catálogo.</b>
      <br>${esc(e.message)}</div>`;
    return;
  }
  montarSets();
  ficha.configurar({
    get catalog() { return catalogo; },
    get prices() { return precos; },
    get fx() { return fx; },
    converter: (valor, moeda) => {
      const t = fx?.taxas?.[moeda];
      return t ? `<span class="brl">≈ R$ ${(valor * t.taxa).toFixed(2)}</span>` : "";
    },
    corDaCarta, energiasHtml,
  });
  ficha.ligarControles();
  desenhar();
})();
