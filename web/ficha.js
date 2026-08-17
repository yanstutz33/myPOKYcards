/**
 * Ficha da carta: toque no resultado e vem tudo que se sabe sobre ela.
 *
 * Por que separada da tela de leitura
 * -----------------------------------
 * O painel de leitura precisa responder duas perguntas de relance — que
 * carta é, quanto vale — e qualquer coisa além disso competia com elas.
 * Empilhar tudo lá foi o que deixou a tela difícil de usar (1.405 px de
 * conteúdo em 338 px de espaço). Aqui há espaço para o resto, e só quem
 * pediu paga o custo de ler.
 *
 * A arte grande vem do CDN de origem, nunca daqui.
 */

import * as colecao from "./colecao.js";

const SIMBOLO = { USD: "US$", EUR: "€", BRL: "R$", JPY: "¥" };

const NOME_IDIOMA = {
  en: "inglês", pt: "português", "pt-br": "português (BR)", ja: "japonês",
  ko: "coreano", "zh-tw": "chinês tradicional", "zh-cn": "chinês simplificado",
  es: "espanhol", fr: "francês", de: "alemão", it: "italiano",
};

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

let ctx = null;   // { catalog, prices, fx, converter, corDaCarta, energiasHtml }
let fichaAberta = null;

export function configurar(dependencias) {
  ctx = dependencias;
}

function linha(rotulo, valor) {
  if (valor === null || valor === undefined || valor === "") return "";
  return `<div class="fx-linha"><dt>${esc(rotulo)}</dt><dd>${valor}</dd></div>`;
}

function mercadosHtml(cardId) {
  const mercados = ctx.prices[cardId] || [];
  if (!mercados.length) return `<p class="ficha-vazio">Sem cotação para esta carta.</p>`;

  return `<table class="tabela-precos">
    <thead><tr><th>Variante</th><th>Mercado</th><th class="num">Referência</th><th class="num">Faixa</th></tr></thead>
    <tbody>${mercados.map((m) => {
      const s = SIMBOLO[m.c] || m.c;
      const velho = m.idade != null && m.idade > 7;
      return `<tr${velho ? ' class="velho"' : ""}>
        <td>${esc(m.v)}</td>
        <td>${esc(m.f)}<small>${m.idade == null ? "" :
          m.idade < 1 ? " · hoje" : ` · há ${Math.round(m.idade)} d`}</small></td>
        <td class="num"><strong>${s} ${m.ref.toFixed(2)}</strong>
          ${ctx.converter(m.ref, m.c)}</td>
        <td class="num">${m.faixa ? `${s} ${m.faixa[0].toFixed(2)}–${m.faixa[1].toFixed(2)}` : "—"}</td>
      </tr>`;
    }).join("")}</tbody>
  </table>`;
}

function irmasHtml(i) {
  const grupo = ctx.catalog.meta[i][8];
  if (grupo === -1) return "";
  const irmas = (ctx.catalog.grupos?.[String(grupo)] || []).filter((j) => j !== i);
  if (!irmas.length) return "";

  return `<section class="ficha-bloco">
    <h3>Impressões que o leitor não distingue</h3>
    <p class="ficha-nota">Arte igual ou quase igual, preços diferentes.
      Nenhum algoritmo de imagem separa estas — só o número impresso separa.</p>
    <div class="ficha-irmas">${irmas.slice(0, 12).map((j) => {
      const id = ctx.catalog.ids[j];
      const [nome, set, numero, , regiao, , , caminho] = ctx.catalog.meta[j];
      const p = ctx.prices[id]?.[0];
      return `<button class="ficha-irma" data-ir="${esc(id)}">
        ${caminho ? `<img alt="" loading="lazy" crossorigin="anonymous"
             src="${ctx.catalog.cdn}/${esc(caminho)}/low.png">` : ""}
        <span class="ir-nome">${esc(nome)}</span>
        <span class="ir-meta">${esc(set)} · ${esc(numero)} · ${regiao === "asia" ? "JA" : "INTL"}</span>
        <span class="ir-preco">${p ? `${SIMBOLO[p.c] || p.c} ${p.ref.toFixed(2)}` : "sem preço"}</span>
      </button>`;
    }).join("")}</div>
  </section>`;
}

export function abrir(cardId) {
  const i = ctx.catalog.ids.indexOf(cardId);
  if (i < 0) return;

  const [nome, set, numero, raridade, regiao, variantes, idiomas, caminho, ,
         tipos, ilustradorIdx, hp, dex, regulacao, categoriaIdx] = ctx.catalog.meta[i];
  fichaAberta = cardId;
  const ilustrador = ctx.catalog.ilustradores?.[ilustradorIdx] || null;
  const categoria = ctx.catalog.categorias?.[categoriaIdx] || null;
  const cor = ctx.corDaCarta(tipos);

  const alvo = document.getElementById("ficha");
  alvo.style.setProperty("--tipo", cor);
  alvo.innerHTML = `
    <div class="ficha-caixa" role="dialog" aria-modal="true" aria-label="Detalhes da carta">
      <header class="ficha-topo">
        <div>
          <h2>${esc(nome)} ${ctx.energiasHtml(tipos)}</h2>
          <p class="ficha-sub">${esc(set)} · ${esc(numero)}${
            raridade ? ` · ${esc(raridade)}` : ""}</p>
        </div>
        <button class="ficha-fechar" id="fecharFicha" aria-label="Fechar">✕</button>
      </header>

      <div class="ficha-acoes">
        ${(variantes?.length ? variantes : ["normal"])
          .filter((v) => ["normal", "holo", "reverse", "1st-edition", "unlimited"].includes(v))
          .map((v) => {
            const n = colecao.quantidade(cardId, v);
            return `<button class="fa-guardar${n ? " feito" : ""}"
              data-guardar="${esc(cardId)}" data-var="${esc(v)}">
              + ${esc(v)}${n ? ` <small>${n}</small>` : ""}</button>`;
          }).join("") || ""}
        <button class="fa-compartilhar" data-share="${esc(cardId)}">Compartilhar</button>
      </div>

      <div class="ficha-corpo">
        ${caminho ? `<figure class="ficha-arte-caixa" data-arte="${esc(caminho)}">
             <img class="ficha-arte" alt="${esc(nome)}" crossorigin="anonymous"
                  src="${ctx.catalog.cdn}/${esc(caminho)}/low.png">
           </figure>` : `<p class="ficha-sem-arte">Sem arte para esta carta.</p>`}

        <section class="ficha-bloco">
          <h3>Preço por mercado</h3>
          ${mercadosHtml(cardId)}
          <p class="ficha-nota">Referência vem de venda concluída; faixa é o que
            se pede hoje. <strong>≈ R$ é conversão pela PTAX</strong>, não o preço
            do mercado brasileiro.</p>
        </section>

        <section class="ficha-bloco">
          <h3>A carta</h3>
          <dl class="ficha-dados">
            ${linha("Identificador", `<code>${esc(cardId)}</code>`)}
            ${linha("Expansão", esc(set))}
            ${linha("Número", esc(numero))}
            ${linha("Raridade", raridade ? esc(raridade) : null)}
            ${linha("Categoria", categoria ? esc(categoria) : null)}
            ${linha("HP", hp || null)}
            ${linha("Tipos", tipos?.length ? esc(tipos.join(" · ")) : null)}
            ${linha("Pokédex", dex || null)}
            ${linha("Ilustração", ilustrador ? esc(ilustrador) : null)}
            ${linha("Marca de regulação", regulacao ? esc(regulacao) : null)}
            ${linha("Região", regiao === "asia" ? "Ásia (japonês e afins)" : "Internacional")}
            ${linha("Variantes", variantes?.length ? esc(variantes.join(" · ")) : null)}
            ${linha("Idiomas impressos", idiomas.map((l) =>
              esc(NOME_IDIOMA[l] || l)).join(" · "))}
          </dl>
        </section>

        ${irmasHtml(i)}
      </div>
    </div>`;

  alvo.hidden = false;
  document.body.classList.add("com-ficha");
  melhorarArte(alvo);
  document.getElementById("fecharFicha").focus();
}

/**
 * Mostra `low` na hora e sobe para `high` só se a `high` existir de fato.
 *
 * A ficha pedia `high.png` direto, com queda para `low` no `onerror`. Duas
 * coisas davam errado nisso, e as duas apareceram no teste com aparelho real
 * como "carta preta":
 *
 *   * `high` NAO existe para boa parte do catálogo. Medido em
 *     web/teste-arte.html, amostra espalhada pelo índice: `low` pinta em
 *     100% das cartas, `high` em 81,7% — e só 75,6% nas internacionais,
 *     porque os sets antigos (e-Card, EX, DP, HGSS, Platinum, B&W, XY) não
 *     têm versão grande.
 *   * mesmo quando existe, `high` é grande. Numa rede de celular a queda
 *     para `low` só acontece DEPOIS de o download falhar, e até lá a tela
 *     mostra um retângulo vazio — que é indistinguível de defeito.
 *
 * Invertido: `low` entra imediatamente e é o que garante os 100%. A `high`
 * é carregada em segundo plano e só substitui quando terminou de decodificar,
 * então a troca nunca deixa buraco na tela. Se não existir, ninguém percebe.
 */
function melhorarArte(raiz) {
  const caixa = raiz.querySelector(".ficha-arte-caixa");
  const img = caixa?.querySelector(".ficha-arte");
  if (!caixa || !img) return;

  // `naturalWidth` é o teste honesto de "pintou": `onload` pode disparar para
  // resposta de erro decodificável, e uma imagem de largura zero é exatamente
  // o retângulo vazio que apareceu no aparelho.
  const pintou = () => caixa.classList.toggle("vazia", !img.naturalWidth);
  img.addEventListener("load", pintou);
  img.addEventListener("error", () => caixa.classList.add("vazia"));
  if (img.complete) pintou();

  const grande = new Image();
  grande.crossOrigin = "anonymous";
  grande.onload = () => {
    if (grande.naturalWidth > img.naturalWidth) img.src = grande.src;
  };
  grande.src = `${ctx.catalog.cdn}/${caixa.dataset.arte}/high.png`;
}

export function fechar() {
  const alvo = document.getElementById("ficha");
  alvo.hidden = true;
  alvo.innerHTML = "";
  document.body.classList.remove("com-ficha");
}

/** Fecha ao tocar fora, no X, ou com Esc. */
export function ligarControles() {
  const alvo = document.getElementById("ficha");
  alvo.addEventListener("click", (ev) => {
    if (ev.target === alvo || ev.target.closest(".ficha-fechar")) return fechar();
    const irma = ev.target.closest(".ficha-irma");
    if (irma) return abrir(irma.dataset.ir);   // navega entre impressões sem sair

    // Guardar aqui e não só na tela de leitura: quem abriu a ficha para
    // conferir os dados é exatamente quem acabou de decidir que quer a carta.
    const g = ev.target.closest("[data-guardar]");
    if (g) {
      const n = colecao.adicionar(g.dataset.guardar, g.dataset.var);
      if (n === null) { g.textContent = "sem espaço"; return; }
      g.classList.add("feito");
      g.innerHTML = `✓ ${g.dataset.var} <small>${n}</small>`;
      return;
    }

    const sh = ev.target.closest("[data-share]");
    if (sh) return compartilhar(sh.dataset.share);
  });
  document.addEventListener("keydown", (ev) => {
    if (ev.key === "Escape" && !alvo.hidden) fechar();
  });
}


/**
 * Compartilhar a carta.
 *
 * Usa a folha nativa do sistema quando existe (Android e iOS moderno) e cai
 * para copiar o texto quando não. Nunca envia nada por conta própria: a
 * folha nativa é o usuário escolhendo para quem vai.
 *
 * O texto leva a fonte e a data junto do preço — mandar "R$ 500" solto para
 * alguém é o mesmo problema de exibir preço sem proveniência.
 */
async function compartilhar(cardId) {
  const i = ctx.catalog.ids.indexOf(cardId);
  if (i < 0) return;
  const [nome, set, numero] = ctx.catalog.meta[i];
  const m = (ctx.prices[cardId] || [])[0];

  const linhas = [`${nome} — ${set} · ${numero}`];
  if (m) {
    const s = SIMBOLO[m.c] || m.c;
    linhas.push(`${s} ${m.ref.toFixed(2)} (${m.v}, ${m.f}${
      m.idade != null ? m.idade < 1 ? ", hoje" : `, há ${Math.round(m.idade)} d` : ""})`);
  } else {
    linhas.push("sem cotação nas fontes consultadas");
  }
  linhas.push(location.origin + location.pathname.replace(/[^/]*$/, "") + "buscar.html");
  const texto = linhas.join("\n");

  try {
    if (navigator.share) {
      await navigator.share({ title: nome, text: texto });
      return;
    }
    await navigator.clipboard.writeText(texto);
    const btn = document.querySelector("[data-share]");
    if (btn) { btn.textContent = "Copiado!"; setTimeout(() => { btn.textContent = "Compartilhar"; }, 1600); }
  } catch { /* usuário cancelou a folha: nada a fazer */ }
}
