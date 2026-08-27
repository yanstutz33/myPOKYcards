/**
 * Onde comprar e vender esta carta — com link de afiliado.
 *
 * Por que isto existe
 * -------------------
 * O app responde "que carta é" e "quanto vale lá fora". A pergunta seguinte,
 * que ele deixava sem resposta, é "e agora, onde eu compro ou vendo isso?".
 * Quem está com a carta na mão já tem a intenção; mandar essa pessoa abrir
 * outro app e digitar o nome de novo é perder a única parte do fluxo que
 * pode gerar receita.
 *
 * Por que afiliado e não anúncio
 * ------------------------------
 * Anúncio cobra atenção de todo mundo para pagar por poucos cliques, e
 * estragaria a tela que levou semanas para ficar limpa. Afiliado só aparece
 * quando já é útil, não custa nada a mais para quem compra, e o app continua
 * inteiro sem ele — se o programa mudar as regras, some um bloco e nada
 * quebra.
 *
 * Honestidade obrigatória
 * -----------------------
 * O bloco diz que é link de afiliado. Esconder isso é o que transforma
 * recomendação em propaganda disfarçada, e é justamente o que faria alguém
 * parar de confiar nos preços que este app mostra — que é o ativo real aqui.
 *
 * O preço do marketplace NÃO é buscado nem exibido: seria preciso servidor e
 * autorização de API, e um número errado ali contamina a única coisa que o
 * app promete fazer direito. O link leva à busca; o preço quem vê é a pessoa.
 */

/**
 * IDs de afiliado.
 *
 * Ficam aqui, em texto, porque não são segredo: eles viajam na URL de
 * qualquer forma. Vazios, os links continuam funcionando — só não geram
 * comissão. É de propósito: o app tem que ser útil antes de ser rentável, e
 * um link quebrado por falta de cadastro seria o pior dos dois mundos.
 */
export const AFILIADO = {
  mercadolivre: "",   // matt_XXXX — https://www.mercadolivre.com.br/afiliados
  shopee: "",         // id do Shopee Affiliate Program
};

/** Termo de busca: nome + número + expansão é o que separa uma carta de outra. */
function termo(nome, set, numero) {
  return [nome, numero, set, "pokemon", "carta"]
    .filter(Boolean).join(" ");
}

/**
 * Mercado Livre. O parâmetro de afiliado do ML é `matt_word` na querystring;
 * sem ele a URL é uma busca normal, o que é exatamente o comportamento
 * desejado quando o cadastro ainda não foi feito.
 */
function mercadoLivre(q) {
  const base = `https://lista.mercadolivre.com.br/${encodeURIComponent(q)}`;
  return AFILIADO.mercadolivre
    ? `${base}?matt_word=${encodeURIComponent(AFILIADO.mercadolivre)}`
    : base;
}

/** Shopee. Mesmo princípio: sem id, é a busca pública. */
function shopee(q) {
  const base = `https://shopee.com.br/search?keyword=${encodeURIComponent(q)}`;
  return AFILIADO.shopee
    ? `${base}&af_id=${encodeURIComponent(AFILIADO.shopee)}`
    : base;
}

/**
 * Liga Pokémon: o maior mercado brasileiro de cartas avulsas.
 *
 * Não tem programa de afiliado, e entra assim mesmo. É a fonte que a pessoa
 * de fato usa para negociar aqui, e omitir a mais útil das três porque ela
 * não paga seria exatamente o tipo de escolha que faz um app perder
 * confiança — a mesma confiança que sustenta os outros dois links.
 */
function ligaPokemon(nome) {
  return `https://www.ligapokemon.com.br/?view=cards/card&card=${encodeURIComponent(nome)}`;
}

/* `afiliado` pergunta ao ID, nao e uma constante.
 *
 * `rel="sponsored"` e uma AFIRMACAO sobre o link: diz ao navegador e aos
 * buscadores que ali existe relacao comercial. Enquanto os IDs estao vazios
 * os dois links sao busca publica, sem relacao nenhuma, e declarar
 * patrocinio seria descrever errado o proprio produto.
 *
 * Amarrando a marcacao ao ID, ela passa a acompanhar a realidade sozinha: no
 * dia em que o Yan preencher `AFILIADO`, o `sponsored` aparece junto, sem
 * ninguem precisar lembrar de mexer aqui. */
const LOJAS = [
  { nome: "Mercado Livre", monta: (q) => mercadoLivre(q),
    afiliado: () => Boolean(AFILIADO.mercadolivre) },
  { nome: "Shopee", monta: (q) => shopee(q),
    afiliado: () => Boolean(AFILIADO.shopee) },
];

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Bloco pronto para a ficha. */
export function blocoHtml(nome, set, numero) {
  const q = termo(nome, set, numero);
  const temAfiliado = Boolean(AFILIADO.mercadolivre || AFILIADO.shopee);

  const botoes = LOJAS.map((l) => `<a class="mkt-loja" target="_blank"
      rel="noopener nofollow${l.afiliado() ? " sponsored" : ""}"
      href="${esc(l.monta(q))}">${esc(l.nome)}</a>`).join("");

  return `<section class="ficha-bloco">
    <h3>Comprar ou vender</h3>
    <p class="ficha-nota">Busca por <strong>${esc(nome)} ${esc(numero)}</strong>
      no mercado brasileiro. O preço lá é em real e inclui frete e condição da
      carta — não é o mesmo que a cotação internacional acima.</p>
    <div class="mkt-lojas">
      ${botoes}
      <a class="mkt-loja mkt-liga" target="_blank" rel="noopener"
         href="${esc(ligaPokemon(nome))}">Liga Pokémon</a>
    </div>
    ${temAfiliado ? `<p class="mkt-aviso">${
      LOJAS.filter((l) => l.afiliado()).map((l) => l.nome).join(" e ")
      } ${LOJAS.filter((l) => l.afiliado()).length > 1 ? "são links" : "é link"}
      de afiliado: se você comprar por ${
        LOJAS.filter((l) => l.afiliado()).length > 1 ? "eles" : "ele"
      }, este app ganha uma comissão da loja, sem custo a mais para você.
      A Liga Pokémon entra sem comissão, porque é onde o mercado brasileiro
      de fato negocia.</p>` : ""}
  </section>`;
}
