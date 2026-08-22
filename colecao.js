/**
 * Coleção — o que o usuário guardou, e quanto vale.
 *
 * Fica em localStorage, no aparelho. A coleção de alguém revela patrimônio:
 * é dado sensível, e sincronizar por padrão seria decidir isso pela pessoa.
 * Exportar em JSON é a saída — o dono leva embora quando quiser.
 *
 * Guarda o mínimo: id da carta, variante, quantidade e quando foi
 * adicionada. Nome, preço e set são resolvidos na hora, a partir do
 * catálogo, para o valor nunca ficar congelado num número velho.
 */

const CHAVE = "mypokycards:colecao:v1";
const CHAVE_ANTIGA = "yami-tcg:colecao:v1";

/**
 * Migração da chave antiga.
 *
 * O app mudou de nome. Trocar a chave sem migrar apagaria a coleção de quem
 * já usava — e coleção é justamente o dado que a pessoa construiu à mão,
 * carta por carta. A antiga é lida uma vez, copiada, e só então removida.
 */
(function migrar() {
  try {
    const velho = localStorage.getItem(CHAVE_ANTIGA);
    if (velho && !localStorage.getItem(CHAVE)) {
      localStorage.setItem(CHAVE, velho);
    }
    if (velho) localStorage.removeItem(CHAVE_ANTIGA);
  } catch { /* storage bloqueado: segue sem migrar */ }
})();

function ler() {
  try {
    const raw = localStorage.getItem(CHAVE);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {}; // storage bloqueado ou corrompido: some sem derrubar a tela
  }
}

function gravar(dados) {
  try {
    localStorage.setItem(CHAVE, JSON.stringify(dados));
    return true;
  } catch {
    return false; // modo privado, cota cheia — o chamador avisa o usuário
  }
}

/** Chave de item: a mesma carta em variantes diferentes são itens distintos. */
const chaveItem = (cardId, variante) => `${cardId}|${variante || "-"}`;

/**
 * Duas fontes, dois vocabulários para a mesma coisa.
 *
 * O catálogo (TCGdex) chama de `normal`, `holo`, `reverse`; os preços
 * (TCGplayer) chamam de `normal`, `holofoil`, `reverse-holofoil`. Sem
 * traduzir, a busca pela variante nunca casa e cai no primeiro mercado da
 * lista — o que avaliava um reverse holo de € 4,05 a € 0,41, o preço da
 * versão normal. Erro silencioso e de quase 10×.
 */
const VARIANTE_PRECO = {
  normal: "normal",
  holo: "holofoil",
  holofoil: "holofoil",
  reverse: "reverse-holofoil",
  "reverse-holofoil": "reverse-holofoil",
  // Tiragens da era WotC (Base Set e contemporâneos). O TCGplayer cota cada
  // uma separado, e a diferença entre 1st edition e unlimited da mesma carta
  // chega a ordens de grandeza.
  unlimited: "unlimited",
  "unlimited-holofoil": "unlimited-holofoil",
  "1st-edition": "1st-edition",
  "1st-edition-holofoil": "1st-edition-holofoil",
};

export function variantePreco(v) {
  return VARIANTE_PRECO[v] || v;
}

export function adicionar(cardId, variante, quantidade = 1) {
  const dados = ler();
  const k = chaveItem(cardId, variante);
  const atual = dados[k] || { card_id: cardId, variante: variante || null, qtd: 0 };
  atual.qtd += quantidade;
  atual.em = atual.em || new Date().toISOString();
  if (atual.qtd <= 0) delete dados[k];
  else dados[k] = atual;
  return gravar(dados) ? atual.qtd : null;
}

export function quantidade(cardId, variante) {
  return ler()[chaveItem(cardId, variante)]?.qtd || 0;
}

export function itens() {
  return Object.values(ler());
}

/**
 * Importa um arquivo exportado.
 *
 * Havia exportar sem importar — um backup que não se restaura não é backup.
 * SOMA às quantidades existentes em vez de substituir: quem importa
 * normalmente está juntando o que tinha em dois aparelhos, e substituir
 * apagaria metade sem avisar.
 */
export function importar(itens) {
  if (!Array.isArray(itens)) throw new Error("arquivo não parece uma coleção");
  const dados = ler();
  let somadas = 0;
  for (const it of itens) {
    if (!it?.card_id || typeof it.qtd !== "number" || it.qtd <= 0) continue;
    const k = chaveItem(it.card_id, it.variante);
    const atual = dados[k] || { card_id: it.card_id, variante: it.variante || null, qtd: 0 };
    atual.qtd += it.qtd;
    atual.em = atual.em || it.em || new Date().toISOString();
    dados[k] = atual;
    somadas += it.qtd;
  }
  if (!gravar(dados)) throw new Error("sem espaço no navegador");
  return somadas;
}

export function limpar() {
  try { localStorage.removeItem(CHAVE); } catch { /* nada a fazer */ }
}

/**
 * Valor da coleção, por moeda.
 *
 * Deliberadamente NÃO soma moedas diferentes num total único, mesmo tendo a
 * taxa de câmbio à mão. Um total em real daria a impressão de ser o valor de
 * venda no Brasil, que é justamente o que não sabemos. Cada moeda soma
 * separado, e a conversão aparece rotulada ao lado.
 *
 * Também separa o que não tem preço em vez de contar como zero: 4 cartas
 * sem cotação não valem R$ 0,00, valem "não sei".
 */
export function valor(itensLista, precos) {
  const totais = {};
  let semPreco = 0;
  let comPreco = 0;

  let semVariante = 0;

  for (const it of itensLista) {
    const mercados = precos[it.card_id];
    if (!mercados?.length) { semPreco += it.qtd; continue; }

    const alvo = variantePreco(it.variante);
    const daVariante = mercados.filter((x) => x.v === alvo);
    // Sem cotação da variante guardada, usar outra seria dizer que um
    // reverse holo vale o preço do normal. Conta à parte.
    if (!daVariante.length) { semVariante += it.qtd; continue; }

    const m = daVariante[0];
    totais[m.c] = (totais[m.c] || 0) + m.ref * it.qtd;
    comPreco += it.qtd;
  }
  return { totais, semPreco, comPreco, semVariante };
}
