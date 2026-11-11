/**
 * Busca por nome — consultar carta sem ter ela na mão.
 *
 * Era a maior lacuna do app: sem a carta na frente da câmera, não havia
 * como saber quanto vale. "Vi um Charizard anunciado, quanto costuma valer?"
 * não tinha resposta.
 *
 * Roda inteira no aparelho, sobre o mesmo catálogo que o leitor já baixou —
 * nenhuma requisição, funciona offline.
 */

import { selo, urlArte, jogoDaRegiao, JOGOS } from "./jogos.js";

const SIMBOLO = { USD: "US$", EUR: "€", BRL: "R$", JPY: "¥" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/**
 * Normaliza para comparar: sem acento, sem caixa, sem pontuação.
 *
 * Sem isso "pokemon" não acha "Pokémon" e "mr mime" não acha "Mr. Mime" —
 * e quem digita no celular não põe acento.
 */
const normalizar = (s) => String(s)
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .toLowerCase().replace(/[^a-z0-9぀-ヿ一-鿿 ]+/g, " ")
  .replace(/\s+/g, " ").trim();

let catalogo = null;
let precos = {};
let indice = null;   // string normalizada por carta, na mesma ordem de ids

function construirIndice() {
  // Uma passada, guardada em memória. 30 mil strings custam ~2 MB de RAM e
  // evitam normalizar tudo a cada tecla digitada.
  // O nome do jogo entra no texto pesquisável: "luffy one piece" e
  // "elsa lorcana" acham o que se espera, e "ariel" sozinho continua achando
  // todas as Ariel de qualquer jogo.
  indice = catalogo.meta.map((m) =>
    normalizar(`${m[0]} ${m[1]} ${m[2]} ${JOGOS[jogoDaRegiao(m[4])].nome}`));
}

/**
 * Busca, com ordenação em três níveis.
 *
 * 1. ONDE bate: nome que começa com o termo vem antes do que só contém.
 *    Sem isso, digitar "char" traz Charmander lá embaixo, atrás de qualquer
 *    carta cujo set contenha "char".
 *
 * 2. TEM PREÇO: carta cotada vem antes de carta sem cotação. O desempate
 *    anterior era a ordem alfabética do id, e como `A1-*` (TCG Pocket) vem
 *    primeiro no alfabeto, buscar "charizard" devolvia cinco cartas de um
 *    jogo digital — que não têm mercado físico nenhum — antes de qualquer
 *    Charizard de verdade.
 *
 * 3. QUANTO VALE: mais cara primeiro. Quem procura um nome específico
 *    geralmente quer saber do exemplar que vale alguma coisa.
 */
/**
 * Filtros, todos opcionais:
 *   jogo       "pokemon" | "onepiece" | "lorcana" | "riftbound"
 *   raridade   texto exato do catálogo ("Enchanted", "SEC", "Rare Holo")
 *   min, max   faixa em REAL, pela PTAX (`fx`)
 *   ordem      "relevancia" | "maior" | "menor"
 *
 * Com algum filtro escolhido, o termo pode ficar vazio: "todas as
 * Enchanted de Lorcana acima de R$ 500" é uma pergunta legítima sem nome.
 *
 * A faixa de preço converte pela PTAX porque as cotações estão em dólar e
 * euro, e quem digita "até 100" no Brasil pensa em real. É FILTRO, não
 * valor exibido: a lista continua mostrando cada preço na moeda dele. Carta
 * sem cotação sai de qualquer busca com faixa — "não sei" não está entre
 * 10 e 100.
 */
let fx = null;
export function configurarCambio(taxas) { fx = taxas; }

function emReal(m) {
  if (!m) return null;
  if (m.c === "BRL") return m.ref;
  const t = fx?.taxas?.[m.c]?.taxa;
  return t ? m.ref * t : null;
}

export function buscar(termo, limite = 40, filtros = {}) {
  const q = normalizar(termo);
  const { jogo, raridade, min, max, ordem = "relevancia" } = filtros;
  const temFiltro = Boolean(jogo || raridade || min != null || max != null);
  if (q.length < 2 && !temFiltro) return [];
  const regioes = jogo ? new Set(JOGOS[jogo]?.regioes || []) : null;
  const comFaixa = min != null || max != null;

  const achados = [];
  for (let i = 0; i < indice.length; i++) {
    const meta = catalogo.meta[i];
    if (regioes && !regioes.has(meta[4])) continue;
    if (raridade && meta[3] !== raridade) continue;
    let onde = 0;
    if (q.length >= 2) {
      const pos = indice[i].indexOf(q);
      if (pos < 0) continue;
      onde = pos === 0 ? 0 : indice[i][pos - 1] === " " ? 1 : 2;
    }
    const m = (precos[catalogo.ids[i]] || [])[0];
    const brl = emReal(m);
    if (comFaixa) {
      if (brl === null) continue;
      if (min != null && brl < min) continue;
      if (max != null && brl > max) continue;
    }
    // Ordem por preço compara em real (mesma conversão do filtro); sem taxa,
    // cai no valor nativo, que é o comportamento de antes.
    const valor = brl ?? m?.ref ?? null;
    achados.push([ordem === "relevancia" ? onde : 0, valor === null ? 1 : 0,
      valor === null ? 0 : (ordem === "menor" ? valor : -valor), i]);
    if (!comFaixa && !temFiltro && achados.length > 4000) break;   // termo muito curto
  }
  achados.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
  return achados.slice(0, limite).map((a) => a[3]);
}

/** Raridades que existem no índice para um jogo, das mais comuns às raras. */
export function raridades(jogo) {
  const regioes = jogo ? new Set(JOGOS[jogo]?.regioes || []) : null;
  const conta = new Map();
  for (const m of catalogo.meta) {
    if (!m[3] || (regioes && !regioes.has(m[4]))) continue;
    conta.set(m[3], (conta.get(m[3]) || 0) + 1);
  }
  return [...conta.entries()].sort((a, b) => b[1] - a[1]);
}

function precoResumo(cardId) {
  const m = (precos[cardId] || [])[0];
  if (!m) return `<span class="b-sem">sem preço</span>`;
  // pt-BR como o resto do app: "13.000,00", não "13000.00".
  return `<span class="b-preco">${SIMBOLO[m.c] || m.c} ${m.ref.toLocaleString("pt-BR",
    { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>`;
}

export function linhaHtml(i) {
  const id = catalogo.ids[i];
  const [nome, set, numero, raridade, regiao, , , caminho] = catalogo.meta[i];
  return `<button class="b-item" data-card="${esc(id)}">
    ${caminho ? `<img alt="" loading="lazy" decoding="async"
         src="${esc(urlArte(catalogo, caminho))}">` : `<span class="b-semarte"></span>`}
    <span class="b-nome">${esc(nome)}</span>
    <span class="b-meta">${esc(set)} · ${esc(numero)}${
      raridade ? ` · ${esc(raridade)}` : ""} · ${selo(regiao)}</span>
    ${precoResumo(id)}
  </button>`;
}

export function configurar(cat, prc) {
  catalogo = cat;
  precos = prc;
  construirIndice();
}

/**
 * Troca a tabela de precos sem refazer o indice.
 *
 * Necessario porque na tela de leitura o preco chega DEPOIS: o leitor libera
 * assim que o indice carrega e busca a cotacao em segundo plano. `configurar`
 * guarda a referencia recebida, entao sem isto a busca ficava com o objeto
 * vazio do inicio — e o desempate por preco, que existe justamente para nao
 * jogar TCG Pocket na frente, nunca acontecia.
 *
 * Refazer o indice aqui seria 30 mil strings normalizadas de novo para uma
 * informacao que nao participa dele.
 */
export function atualizarPrecos(prc) {
  precos = prc || {};
}
