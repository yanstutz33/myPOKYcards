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
  indice = catalogo.meta.map((m) => normalizar(`${m[0]} ${m[1]} ${m[2]}`));
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
export function buscar(termo, limite = 40) {
  const q = normalizar(termo);
  if (q.length < 2) return [];

  const achados = [];
  for (let i = 0; i < indice.length; i++) {
    const pos = indice[i].indexOf(q);
    if (pos < 0) continue;
    const onde = pos === 0 ? 0 : indice[i][pos - 1] === " " ? 1 : 2;
    const m = (precos[catalogo.ids[i]] || [])[0];
    achados.push([onde, m ? 0 : 1, m ? -m.ref : 0, i]);
    if (achados.length > 4000) break;   // teto para termo muito curto
  }
  achados.sort((a, b) => a[0] - b[0] || a[1] - b[1] || a[2] - b[2] || a[3] - b[3]);
  return achados.slice(0, limite).map((a) => a[3]);
}

function precoResumo(cardId) {
  const m = (precos[cardId] || [])[0];
  if (!m) return `<span class="b-sem">sem preço</span>`;
  return `<span class="b-preco">${SIMBOLO[m.c] || m.c} ${m.ref.toFixed(2)}</span>`;
}

export function linhaHtml(i) {
  const id = catalogo.ids[i];
  const [nome, set, numero, raridade, regiao, , , caminho] = catalogo.meta[i];
  return `<button class="b-item" data-card="${esc(id)}">
    ${caminho ? `<img alt="" loading="lazy" decoding="async"
         src="${catalogo.cdn}/${esc(caminho)}/low.png">` : `<span class="b-semarte"></span>`}
    <span class="b-nome">${esc(nome)}</span>
    <span class="b-meta">${esc(set)} · ${esc(numero)}${
      raridade ? ` · ${esc(raridade)}` : ""} · ${regiao === "asia" ? "JA" : "INTL"}</span>
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
