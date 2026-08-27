/**
 * Tela da coleção: o que foi guardado, quanto vale e o que não dá para saber.
 *
 * A regra de ouro aqui é não somar o que não se sabe. Cartas sem cotação
 * aparecem contadas à parte, nunca como zero — 4 cartas sem preço não valem
 * R$ 0,00, valem "não sei".
 */

import * as colecao from "./colecao.js";
import * as grafico from "./grafico.js";
import { variantePreco } from "./colecao.js";

const alvo = document.getElementById("colecao");
const SIMBOLO = { USD: "US$", EUR: "€", BRL: "R$", JPY: "¥" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const N = (v) => Number(v || 0).toLocaleString("pt-BR");

let catalogo = null;
let precos = {};
let fx = null;
let historico = null;

function fmt(valor, moeda) {
  const s = SIMBOLO[moeda] || moeda + " ";
  return `${s} ${valor.toLocaleString("pt-BR", { minimumFractionDigits: 2,
    maximumFractionDigits: 2 })}`;
}

function emReal(valor, moeda) {
  const t = fx?.taxas?.[moeda];
  if (!t) return "";
  const v = valor * t.taxa;
  return `<span class="brl">≈ R$ ${v.toLocaleString("pt-BR",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`;
}

/**
 * A carteira ao longo do tempo.
 *
 * Ate 26/08/2026 esta tela mostrava so o valor de HOJE. O robo cotava todo
 * dia desde 15/08 e essa serie ja estava publicada — a colecao e o historico
 * eram dois modulos que se ignoravam.
 *
 * E a pergunta que quem coleciona faz nao e "quanto vale"; e "esta subindo?".
 *
 * Um grafico por moeda, nunca somados. Mesma regra do total acima, e pelo
 * mesmo motivo: um numero unico em real pareceria valor de venda no Brasil.
 *
 * A porcentagem so aparece quando a MESMA cesta sustenta as duas pontas
 * (ver `colecao.variacao`). Carta que entrou na cotacao no meio da janela
 * faria a carteira "subir" sem nenhuma carta ter ficado mais cara.
 */
function carteiraHtml(itens) {
  const porDia = colecao.valorPorDia(itens, precos, historico);
  if (!porDia) return "";

  const varia = colecao.variacao(porDia);
  const graficos = Object.entries(porDia.moedas).map(([moeda, valores]) =>
    grafico.figura({
      dias: porDia.dias,
      valores,
      moeda,
      titulo: `Sua coleção em ${moeda}`,
      // `undefined` deixaria a figura calcular da propria linha, ignorando a
      // regra da cesta. Passar explicitamente null esconde a porcentagem.
      variacao: varia?.[moeda]?.pct ?? null,
      nota: `${porDia.dias.length} dias`,
    })).filter(Boolean).join("");

  if (!graficos) return "";

  const n = porDia.dias.length;
  return `<section class="carteira">
    <h2>Sua coleção ao longo do tempo</h2>
    ${graficos}
    <p class="carteira-nota">${
      varia
        ? `Comparando o mesmo conjunto de <strong>${N(porDia.cartas[0])} cartas</strong>
           entre ${esc(porDia.dias[0])} e ${esc(porDia.dias[n - 1])}.`
        : `Sem porcentagem: o número de cartas cotadas mudou dentro da janela,
           então as duas pontas não são comparáveis.`}
      ${n < 14 ? " São poucos dias de coleta — dá para ver o que mudou, não tendência."
               : ""}
      Dia sem cotação repete o último valor conhecido; nunca conta como zero.</p>
  </section>`;
}

function desenhar() {
  const itens = colecao.itens();

  if (!itens.length) {
    alvo.innerHTML = `<p class="empty">Nenhuma carta guardada ainda.<br>
      Abra o leitor, aponte para uma carta e toque em <strong>Guardar</strong>.</p>`;
    return;
  }

  const { totais, semPreco, semVariante } = colecao.valor(itens, precos);
  const total = itens.reduce((s, i) => s + i.qtd, 0);

  const kpis = [
    `<div class="kpi"><small>Cartas</small><b>${N(total)}</b>
      <em>${N(itens.length)} entradas distintas</em></div>`,
    ...Object.entries(totais).map(([moeda, v]) =>
      `<div class="kpi"><small>Valor em ${esc(moeda)}</small><b>${fmt(v, moeda)}</b>
        <em>${emReal(v, moeda) || "&nbsp;"}</em></div>`),
    `<div class="kpi"><small>Sem cotação</small><b>${N(semPreco)}</b>
      <em>${semPreco ? "não entram em nenhum total" : "todas cotadas"}</em></div>`,
  ].join("");

  const carteira = carteiraHtml(itens);

  // Ordena por valor decrescente; o que não tem preço vai para o fim, não
  // para o começo com valor zero.
  const linhas = itens.map((it) => {
    const i = catalogo.ids.indexOf(it.card_id);
    const meta = i >= 0 ? catalogo.meta[i] : null;
    const mercados = precos[it.card_id] || [];
    // Só a cotação da variante guardada; o vocabulário do catálogo difere
    // do vocabulário dos preços e precisa ser traduzido.
    const m = mercados.find((x) => x.v === variantePreco(it.variante));
    return { it, meta, m, unit: m ? m.ref : null };
  }).sort((a, b) => {
    if (a.unit === null) return 1;
    if (b.unit === null) return -1;
    return b.unit * b.it.qtd - a.unit * a.it.qtd;
  });

  const lista = linhas.map(({ it, meta, m }) => {
    const nome = meta ? meta[0] : it.card_id;
    const set = meta ? `${meta[1]} · ${meta[2]}` : "";
    const valorTxt = m
      ? `${fmt(m.ref * it.qtd, m.c)}${it.qtd > 1 ? ` <em>(${fmt(m.ref, m.c)} cada)</em>` : ""}`
      : `<span class="sem">sem cotação para ${esc(it.variante || "esta variante")}</span>`;
    return `<div class="linha">
      <span>${esc(nome)} ${it.qtd > 1 ? `<strong>×${it.qtd}</strong>` : ""}</span>
      <span class="linha-sub">${esc(set)} · ${esc(it.variante || "variante não informada")}
        · <code>${esc(it.card_id)}</code></span>
      <span class="linha-val">${valorTxt}</span>
      <div class="linha-acoes">
        <button data-acao="menos" data-card="${esc(it.card_id)}"
                data-var="${esc(it.variante || "")}" aria-label="remover uma">−</button>
        <button data-acao="mais" data-card="${esc(it.card_id)}"
                data-var="${esc(it.variante || "")}" aria-label="adicionar uma">+</button>
      </div>
    </div>`;
  }).join("");

  alvo.innerHTML = `
    <section class="bloco">
      <h2>Resumo</h2>
      <div class="kpis">${kpis}</div>
      ${Object.keys(totais).length > 1 ? `<p class="prog-nota">
        Os totais ficam separados por moeda de propósito. Somar tudo em real
        daria a impressão de ser o valor de venda no Brasil — e é justamente
        isso que não sabemos. O <strong>≈ R$</strong> é conversão pela PTAX
        do Banco Central${fx?.taxas?.USD?.em ? ` de ${esc(fx.taxas.USD.em.slice(0, 10))}` : ""}.
      </p>` : ""}
      ${semPreco ? `<p class="prog-nota">${N(semPreco)} carta(s) sem cotação
        não entram em nenhum total. Não valem zero — o valor é desconhecido.</p>` : ""}
      ${semVariante ? `<p class="prog-nota">${N(semVariante)} carta(s) têm preço
        na fonte, mas não para a variante guardada. Usar o preço de outra
        variante seria dizer que um reverse holo vale o mesmo que o normal —
        então também ficam de fora.</p>` : ""}
    </section>
    ${carteira}

    <section class="bloco">
      <h2>Cartas</h2>
      <div class="linhas">${lista}</div>
      <div class="actions">
        <button id="exportar" class="primary">Exportar</button>
        <button id="importar">Importar</button>
        <button id="limpar">Apagar tudo</button>
      </div>
      <input id="arquivo" type="file" accept="application/json,.json" hidden>
      </div>
    </section>`;

  document.getElementById("exportar").onclick = exportar;
  document.getElementById("importar").onclick = () =>
    document.getElementById("arquivo").click();
  document.getElementById("arquivo").onchange = async (ev) => {
    const f = ev.target.files?.[0];
    if (!f) return;
    try {
      const n = colecao.importar(JSON.parse(await f.text()));
      alert(`${n} carta(s) somadas à coleção.`);
      desenhar();
    } catch (e) {
      alert("Não consegui importar: " + e.message);
    }
    ev.target.value = "";
  };
  document.getElementById("limpar").onclick = () => {
    if (confirm("Apagar a coleção inteira? Isso não pode ser desfeito.")) {
      colecao.limpar();
      desenhar();
    }
  };
}

/**
 * Exporta como download. `URL.createObjectURL` + link temporário, porque a
 * coleção nunca sai do aparelho — não há servidor para gerar o arquivo.
 */
function exportar() {
  const blob = new Blob([JSON.stringify(colecao.itens(), null, 2)],
    { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `colecao-mypokycards-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

alvo.addEventListener("click", (ev) => {
  const b = ev.target.closest("button[data-acao]");
  if (!b) return;
  colecao.adicionar(b.dataset.card, b.dataset.var || null,
    b.dataset.acao === "mais" ? 1 : -1);
  desenhar();
});

(async () => {
  try {
    [catalogo, precos, fx] = await Promise.all([
      fetch("data/cards.json").then((r) => r.json()),
      fetch("data/prices.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({})),
      fetch("data/fx.json").then((r) => (r.ok ? r.json() : null)).catch(() => null),
    ]);
    // O historico e o maior arquivo dos tres e a tela funciona sem ele.
    // Carregado DEPOIS e sem travar: quem abre a colecao quer ver as cartas,
    // e o grafico entra quando chegar.
    grafico.carregar().then((h) => { historico = h; desenhar(); });
  } catch (e) {
    alvo.innerHTML = `<div class="nodata"><b>Não foi possível carregar o catálogo.</b>
      <br>${esc(e.message)}</div>`;
    return;
  }
  desenhar();
})();
