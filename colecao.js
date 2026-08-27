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

/**
 * Qual mercado responde pelo item — o MESMO que `valor()` usa.
 *
 * Isto não é detalhe. Se a carteira ao longo do tempo escolhesse outro
 * mercado, o último ponto do gráfico não bateria com o total exibido logo
 * acima dele, e a pessoa leria isso como app quebrado — corretamente, aliás.
 * A escolha mora aqui e as duas contas passam por ela.
 */
function mercadoDoItem(it, precos) {
  const mercados = precos[it.card_id];
  if (!mercados?.length) return null;
  const alvo = variantePreco(it.variante);
  const m = mercados.find((x) => x.v === alvo);
  return m ? { chave: `${m.v}|${m.f}`, moeda: m.c } : null;
}

/**
 * A coleção ao longo do tempo, por moeda.
 *
 * O robô cota todo dia desde 15/08/2026 e esse dado nunca chegou aqui: a
 * tela mostrava o valor de HOJE e a pergunta que quem coleciona faz — "está
 * subindo?" — ficava sem resposta, mesmo com a série no arquivo.
 *
 * Três decisões que definem se o gráfico é honesto
 * ------------------------------------------------
 * NÃO SOMA MOEDAS. Mesma regra de `valor()`. Um total único em real pareceria
 * valor de venda no Brasil, que é exatamente o que não sabemos.
 *
 * BURACO NÃO É QUEDA. Dia sem cotação repete o último valor conhecido, nunca
 * conta zero. Contar zero desenharia um despencar que não aconteceu — a carta
 * continua na mão da pessoa, só não foi cotada naquele dia. Medido em
 * 26/08/2026: 96,4% das séries são completas na janela e a média é de 0,26
 * dia faltando, então isto quase nunca entra em ação — mas quando entra, é a
 * diferença entre um gráfico e uma mentira.
 *
 * NÃO PREENCHE PARA TRÁS. Antes da primeira cotação a carta simplesmente não
 * entra. Repetir o primeiro valor para o começo da janela desenharia uma
 * linha reta que se lê como "não mexeu", quando o certo é "não sei".
 *
 * `cartas[i]` diz quantas entradas sustentam cada dia. Se esse número varia,
 * os extremos não são comparáveis, e quem desenha precisa poder avisar.
 */
export function valorPorDia(itensLista, precos, historico) {
  const dias = historico?.dias;
  if (!Array.isArray(dias) || dias.length < 2) return null;

  const moedas = {};
  const cartas = new Array(dias.length).fill(0);
  let comSerie = 0;

  for (const it of itensLista) {
    const escolha = mercadoDoItem(it, precos);
    if (!escolha) continue;
    const serie = historico.series?.[it.card_id]?.[escolha.chave];
    if (!serie) continue;
    comSerie++;

    if (!moedas[escolha.moeda]) moedas[escolha.moeda] = new Array(dias.length).fill(null);
    const linha = moedas[escolha.moeda];

    let ultimo = null;
    for (let i = 0; i < dias.length; i++) {
      const v = serie[i];
      if (v !== null && v !== undefined) ultimo = v;
      if (ultimo === null) continue;      // ainda não cotada: não entra
      linha[i] = (linha[i] || 0) + ultimo * it.qtd;
      cartas[i] += it.qtd;
    }
  }

  if (!comSerie) return null;
  return { dias, moedas, cartas, entradas: comSerie };
}

/**
 * Quanto mudou entre as duas pontas da janela.
 *
 * Só compara dias em que a MESMA quantidade de cartas sustenta o total. Uma
 * carta que entrou na cotação no meio da janela faria o total subir sozinha,
 * e isso apareceria como valorização — a carteira teria "subido" porque a
 * fonte passou a cotar mais coisa, não porque alguma carta ficou mais cara.
 *
 * Devolve `null` quando não dá para comparar, e a tela então não mostra
 * porcentagem nenhuma. Número errado é pior que número ausente: o primeiro
 * orienta uma decisão de venda, o segundo só deixa a pessoa sem saber.
 */
export function variacao(porDia) {
  if (!porDia) return null;
  const { cartas } = porDia;
  let a = 0;
  while (a < cartas.length && cartas[a] === 0) a++;
  const b = cartas.length - 1;
  if (a >= b || cartas[a] !== cartas[b]) return null;

  const fora = {};
  for (const [moeda, linha] of Object.entries(porDia.moedas)) {
    const de = linha[a];
    const para = linha[b];
    if (de === null || para === null || !de) continue;
    fora[moeda] = { de, para, pct: ((para - de) / de) * 100,
                    dias: b - a + 1 };
  }
  return Object.keys(fora).length ? fora : null;
}

/* ==========================================================================
   Não perder a coleção

   O dado mais valioso deste app não é o índice de 32 mil cartas — esse eu
   reconstruo. É a coleção, que a pessoa montou carta por carta e não existe
   em nenhum outro lugar. E ela mora no `localStorage`, que o navegador pode
   apagar.

   Não é hipótese remota. O Safari do iPhone apaga o armazenamento de sites
   NÃO INSTALADOS depois de sete dias sem uso. Quem escaneia um lote, guarda
   trinta cartas e só volta no mês seguinte perde tudo, sem aviso e sem erro.

   Três camadas, em ordem de quanto se pode confiar nelas
   ------------------------------------------------------
   1. PEDIR PERSISTÊNCIA. `navigator.storage.persist()` existe exatamente
      para isto. Mas o navegador decide por heurística — engajamento, site
      instalado, favorito — e MEDI: em 26/08/2026, num navegador real, o
      pedido voltou negado. Vale pedir porque é grátis e num aparelho com uso
      real costuma ser concedido; não vale prometer nada em cima disso.

   2. INSTALAR O APP. É o que mais muda no iPhone: site instalado na tela de
      início não sofre o despejo de sete dias.

   3. EXPORTAR. A única que não depende de decisão do navegador. Por isso o
      app precisa saber se há mudança desde a última exportação — lembrete
      genérico vira ruído e a pessoa para de ler.
   ========================================================================== */

const CHAVE_BACKUP = "mypokycards:backup:v1";

/**
 * Impressão digital da coleção.
 *
 * Comparar só a contagem de cartas deixaria passar troca de mesma soma —
 * vender duas e comprar duas apareceria como "nada mudou". FNV-1a sobre as
 * entradas ordenadas custa quase nada e não erra.
 */
function digital(dados) {
  const partes = Object.keys(dados).sort()
    .map((k) => `${k}:${dados[k].qtd}`).join(";");
  let h = 0x811c9dc5;
  for (let i = 0; i < partes.length; i++) {
    h ^= partes.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `${partes.length}:${h.toString(16)}`;
}

/** Pede ao navegador para não despejar o armazenamento. Nunca lança. */
export async function pedirPersistencia() {
  try {
    if (!navigator.storage?.persist) return null;
    if (await navigator.storage.persisted()) return true;
    return await navigator.storage.persist();
  } catch {
    return null;   // modo privado, contexto inseguro: segue sem
  }
}

/**
 * O que dá para dizer com honestidade sobre onde a coleção está.
 *
 * `persistente` tem TRÊS estados e a diferença importa na tela:
 *   true  -> o navegador prometeu não apagar
 *   false -> pode apagar a qualquer momento
 *   null  -> este navegador não sabe responder; não afirmar nem uma coisa
 *            nem outra é mais honesto que chutar
 */
export async function ondeEstamos() {
  const dados = ler();
  const backup = (() => {
    try { return JSON.parse(localStorage.getItem(CHAVE_BACKUP) || "null"); }
    catch { return null; }
  })();

  let persistente = null;
  try {
    if (navigator.storage?.persisted) persistente = await navigator.storage.persisted();
  } catch { /* segue como desconhecido */ }

  const agora = digital(dados);
  return {
    persistente,
    instalado: matchMedia("(display-mode: standalone)").matches
      || navigator.standalone === true,
    entradas: Object.keys(dados).length,
    exportadoEm: backup?.em || null,
    // `null` quando nunca exportou: "nunca" e "mudou desde então" pedem
    // frases diferentes na tela.
    mudouDesdeExportacao: backup ? backup.digital !== agora : null,
  };
}

/** Registra que a coleção foi exportada agora, com a digital do momento. */
export function marcarExportado() {
  try {
    localStorage.setItem(CHAVE_BACKUP, JSON.stringify({
      em: new Date().toISOString(),
      digital: digital(ler()),
    }));
  } catch { /* sem espaço: a exportação em si já aconteceu */ }
}
