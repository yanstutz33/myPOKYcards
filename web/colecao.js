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

/**
 * Coleções nomeadas ("Fichário", "Para vender", "Deck"...).
 *
 * A coleção que já existia vira "Principal", e as entradas dela CONTINUAM
 * com a chave antiga, sem o campo `col`. Isso não é economia: é o que faz
 * a mudança não precisar de migração — quem atualiza o app abre a coleção
 * exatamente como estava, e um backup exportado antes desta versão importa
 * igual. Só entrada de outra coleção ganha `col` e chave com três partes.
 */
export const PADRAO = "Principal";
const CHAVE_COLECOES = "mypokycards:colecoes:v1";
const CHAVE_ATIVA = "mypokycards:colecao-ativa:v1";

const colDe = (it) => it?.col || PADRAO;

/** Chave de item: mesma carta em variante OU coleção diferente é outro item. */
const chaveItem = (cardId, variante, col = PADRAO) =>
  col === PADRAO ? `${cardId}|${variante || "-"}` : `${cardId}|${variante || "-"}|${col}`;

/** Nomes das coleções: as que têm cartas e as criadas ainda vazias. */
export function colecoes() {
  let criadas = [];
  try { criadas = JSON.parse(localStorage.getItem(CHAVE_COLECOES) || "[]"); } catch { /* vazio */ }
  const nomes = new Set([PADRAO, ...criadas, ...Object.values(ler()).map(colDe)]);
  return [...nomes];
}

function gravarNomes(nomes) {
  try {
    localStorage.setItem(CHAVE_COLECOES, JSON.stringify(nomes.filter((n) => n !== PADRAO)));
    return true;
  } catch { return false; }
}

/** Cria uma coleção vazia. Nome repetido não duplica; nome vazio não cria. */
export function criarColecao(nome) {
  const n = String(nome || "").trim().slice(0, 40);
  if (!n) return null;
  const nomes = colecoes();
  if (!nomes.includes(n)) nomes.push(n);
  return gravarNomes(nomes) ? n : null;
}

/**
 * Apaga uma coleção SEM apagar carta: o que estava nela volta para a
 * Principal, somando quantidades. Excluir a pasta e perder trinta cartas
 * de uma vez seria o erro que este módulo inteiro tenta evitar.
 */
export function excluirColecao(nome) {
  if (!nome || nome === PADRAO) return false;
  const dados = ler();
  for (const [k, it] of Object.entries(dados)) {
    if (colDe(it) !== nome) continue;
    delete dados[k];
    juntar(dados, { ...it, col: undefined });
  }
  if (!gravar(dados)) return false;
  gravarNomes(colecoes().filter((n) => n !== nome));
  if (ativa() === nome) definirAtiva(PADRAO);
  return true;
}

/** Para onde vão as cartas guardadas pelo leitor e pela ficha. */
export function ativa() {
  try {
    const n = localStorage.getItem(CHAVE_ATIVA);
    return n && colecoes().includes(n) ? n : PADRAO;
  } catch { return PADRAO; }
}

export function definirAtiva(nome) {
  try { localStorage.setItem(CHAVE_ATIVA, nome); } catch { /* só conveniência */ }
}

/** Soma `it` em `dados`, juntando com a entrada igual se já existir. */
function juntar(dados, it) {
  const col = colDe(it);
  const k = chaveItem(it.card_id, it.variante, col);
  const atual = dados[k];
  if (!atual) {
    const novo = { ...it };
    if (col === PADRAO) delete novo.col; else novo.col = col;
    dados[k] = novo;
    return;
  }
  atual.qtd += it.qtd;
  atual.pago ||= it.pago;
  atual.compradoEm ||= it.compradoEm;
}

/** Move uma entrada inteira para outra coleção. */
export function mover(cardId, variante, de, para) {
  if (de === para) return true;
  const dados = ler();
  const k = chaveItem(cardId, variante, de);
  const it = dados[k];
  if (!it) return false;
  delete dados[k];
  juntar(dados, { ...it, col: para });
  return gravar(dados);
}

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
  // One Piece, Lorcana e Riftbound: catálogo e preço vêm da MESMA fonte
  // (TCGCSV), então o vocabulário já coincide. Listados mesmo assim para que
  // a tradução seja explícita e o invariante enxergue os três.
  foil: "foil",
  "cold-foil": "cold-foil",
};

export function variantePreco(v) {
  return VARIANTE_PRECO[v] || v;
}

export function adicionar(cardId, variante, quantidade = 1, col = ativa()) {
  const dados = ler();
  const k = chaveItem(cardId, variante, col);
  const atual = dados[k] || { card_id: cardId, variante: variante || null, qtd: 0,
                              ...(col === PADRAO ? {} : { col }) };
  atual.qtd += quantidade;
  atual.em = atual.em || new Date().toISOString();
  if (atual.qtd <= 0) delete dados[k];
  else dados[k] = atual;
  return gravar(dados) ? atual.qtd : null;
}

/**
 * Quanto a pessoa pagou, e quando — o que transforma coleção em carteira.
 *
 * Preço POR UNIDADE, na moeda em que foi pago. Quem está no Brasil paga em
 * real; quem importou pagou em dólar. Converter na hora de gravar
 * congelaria a taxa daquele dia num número que parece medido.
 *
 * `valor` null apaga o custo. Data é texto AAAA-MM-DD, como o `<input
 * type="date">` entrega: guardar Date viraria fuso horário trocando o dia.
 */
export const MOEDAS_CUSTO = ["BRL", "USD", "EUR"];

export function definirCompra(cardId, variante, { valor, moeda, data }, col = PADRAO) {
  const dados = ler();
  const it = dados[chaveItem(cardId, variante, col)];
  if (!it) return false;
  if (valor === null || valor === undefined || valor === "") {
    delete it.pago;
  } else {
    const v = Number(valor);
    // Negativo ou NaN não é custo: é erro de digitação, e entraria no lucro.
    if (!Number.isFinite(v) || v < 0) return false;
    it.pago = { valor: Math.round(v * 100) / 100,
                moeda: MOEDAS_CUSTO.includes(moeda) ? moeda : "BRL" };
  }
  if (data && /^\d{4}-\d{2}-\d{2}$/.test(data)) it.compradoEm = data;
  else if (data === "" || data === null) delete it.compradoEm;
  return gravar(dados);
}

/**
 * Converte entre moedas pela PTAX, que cota tudo em real.
 *
 * Devolve null quando falta taxa — e quem chama trata null como "não dá
 * para comparar", nunca como zero.
 */
function converter(valor, de, para, fx) {
  if (de === para) return valor;
  const taxa = (m) => (m === "BRL" ? 1 : fx?.taxas?.[m]?.taxa);
  const a = taxa(de), b = taxa(para);
  return a && b ? (valor * a) / b : null;
}

/**
 * Lucro ou prejuízo, por moeda de CUSTO.
 *
 * A comparação é feita na moeda em que a pessoa pagou: é a pergunta dela
 * ("paguei R$ 50, quanto vale hoje?"). Quando a cotação está em outra
 * moeda, o valor de hoje é convertido pela PTAX e a linha sai marcada
 * `aproximado` — a tela escreve "≈" e diz por quê. Comparar real pago com
 * dólar de mercado sem avisar seria afirmar um lucro que ninguém mediu.
 *
 * Três grupos que NÃO entram no resultado, contados à parte:
 *   semCusto   -> a pessoa não informou quanto pagou
 *   semCotacao -> não há preço da variante guardada (mesma regra de valor())
 *   semTaxa    -> moedas diferentes e falta a taxa para converter
 */
export function resultado(itensLista, precos, fx) {
  const porMoeda = {};
  let semCusto = 0, semCotacao = 0, semTaxa = 0;
  const linhas = new Map();

  for (const it of itensLista) {
    if (!it.pago) { semCusto += it.qtd; continue; }
    const m = (precos[it.card_id] || []).find((x) => x.v === variantePreco(it.variante));
    if (!m) { semCotacao += it.qtd; continue; }
    const hojeUnit = converter(m.ref, m.c, it.pago.moeda, fx);
    if (hojeUnit === null) { semTaxa += it.qtd; continue; }

    const custo = it.pago.valor * it.qtd;
    const hoje = hojeUnit * it.qtd;
    const aproximado = m.c !== it.pago.moeda;
    const g = porMoeda[it.pago.moeda] ||= { custo: 0, hoje: 0, aproximado: false, cartas: 0 };
    g.custo += custo;
    g.hoje += hoje;
    g.cartas += it.qtd;
    g.aproximado ||= aproximado;
    linhas.set(chaveItem(it.card_id, it.variante, colDe(it)),
      { custo, hoje, lucro: hoje - custo, moeda: it.pago.moeda, aproximado,
        pct: custo > 0 ? ((hoje - custo) / custo) * 100 : null });
  }
  for (const g of Object.values(porMoeda)) {
    g.lucro = g.hoje - g.custo;
    g.pct = g.custo > 0 ? (g.lucro / g.custo) * 100 : null;
  }
  return { porMoeda, linhas, semCusto, semCotacao, semTaxa };
}

/** Resultado de um item, pela mesma conta do total. */
export const chaveDoItem = (it) => chaveItem(it.card_id, it.variante, colDe(it));
export const colecaoDoItem = colDe;

/**
 * As cartas que mais valem, somando a quantidade.
 *
 * Moedas diferentes não se comparam direto: a ORDEM usa a conversão pela
 * PTAX, mas a tela mostra cada uma na moeda dela. Converter só para
 * ordenar não afirma valor nenhum; converter para exibir afirmaria.
 */
export function maisValiosas(itensLista, precos, fx, n = 3) {
  return itensLista
    .map((it) => {
      const m = (precos[it.card_id] || []).find((x) => x.v === variantePreco(it.variante));
      if (!m) return null;
      const total = m.ref * it.qtd;
      return { it, m, total, ordem: converter(total, m.c, "BRL", fx) ?? total };
    })
    .filter(Boolean)
    .sort((a, b) => b.ordem - a.ordem)
    .slice(0, n);
}

/**
 * A coleção como planilha.
 *
 * Ponto e vírgula e vírgula decimal: é o que o Excel em português abre com
 * duplo clique, sem assistente de importação. Com vírgula como separador,
 * "1.142,80" viraria duas colunas. O BOM no começo faz o Excel ler acento
 * como UTF-8 em vez de "Ã©".
 *
 * Valor de hoje e lucro saem só quando existem — célula vazia é "não sei",
 * e um 0 numa planilha entra em soma como se fosse medido.
 */
export function csv(itensLista, catalogo, precos, fx) {
  const n = (v) => (v === null || v === undefined || !Number.isFinite(v))
    ? "" : v.toFixed(2).replace(".", ",");
  // Aspas e quebras por CÓDIGO de caractere, sem regex nem escape. Duas
  // tentativas anteriores quebraram: o detector de string cortada
  // (tests/checar_js.py) lia a aspa dentro do regex como string aberta, e a
  // versão com escape unicode virou aspa literal no caminho até o disco.
  const ASPA = String.fromCharCode(34);
  const ESPECIAIS = [";", ASPA, String.fromCharCode(10), String.fromCharCode(13)];
  const cel = (v) => {
    const s = String(v ?? "");
    return ESPECIAIS.some((c) => s.includes(c))
      ? ASPA + s.split(ASPA).join(ASPA + ASPA) + ASPA : s;
  };
  const res = resultado(itensLista, precos, fx);
  const cab = ["colecao", "card_id", "nome", "expansao", "numero", "variante", "qtd",
    "preco_unit", "moeda_preco", "valor_total", "pago_unit", "moeda_pago",
    "comprado_em", "lucro", "lucro_aproximado", "adicionada_em"];
  const linhas = itensLista.map((it) => {
    const i = catalogo?.ids?.indexOf(it.card_id) ?? -1;
    const meta = i >= 0 ? catalogo.meta[i] : null;
    const m = (precos[it.card_id] || []).find((x) => x.v === variantePreco(it.variante));
    const r = res.linhas.get(chaveItem(it.card_id, it.variante, colDe(it)));
    return [colDe(it), it.card_id, meta?.[0] ?? "", meta?.[1] ?? "", meta?.[2] ?? "",
      it.variante ?? "", it.qtd, n(m?.ref), m?.c ?? "", n(m ? m.ref * it.qtd : null),
      n(it.pago?.valor), it.pago?.moeda ?? "", it.compradoEm ?? "",
      n(r?.lucro), r ? (r.aproximado ? "sim" : "não") : "",
      (it.em || "").slice(0, 10)].map(cel).join(";");
  });
  // BOM por código, não literal: invisível no fonte, sumiria numa edição.
  return String.fromCharCode(0xFEFF) + [cab.join(";"), ...linhas].join("\r\n");
}

export function quantidade(cardId, variante, col = ativa()) {
  return ler()[chaveItem(cardId, variante, col)]?.qtd || 0;
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
    // Nome de coleção vem de arquivo: texto livre, cortado no mesmo limite
    // de quem cria pela tela.
    const col = typeof it.col === "string" && it.col.trim()
      ? it.col.trim().slice(0, 40) : PADRAO;
    const k = chaveItem(it.card_id, it.variante, col);
    const atual = dados[k] || { card_id: it.card_id, variante: it.variante || null, qtd: 0,
                                ...(col === PADRAO ? {} : { col }) };
    atual.qtd += it.qtd;
    atual.em = atual.em || it.em || new Date().toISOString();
    // Custo e data vêm junto, mas não pisam no que já existe aqui: o
    // aparelho onde a pessoa está mexendo é o mais recente.
    if (!atual.pago && it.pago && Number.isFinite(it.pago.valor) && it.pago.valor >= 0) {
      atual.pago = { valor: it.pago.valor,
                     moeda: MOEDAS_CUSTO.includes(it.pago.moeda) ? it.pago.moeda : "BRL" };
    }
    if (!atual.compradoEm && /^\d{4}-\d{2}-\d{2}$/.test(it.compradoEm || "")) {
      atual.compradoEm = it.compradoEm;
    }
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
 * A série cortada aos últimos `nDias` dias de CALENDÁRIO.
 *
 * Por data, não por número de pontos: depois de 30 dias o histórico é
 * semanal, e "últimos 90 pontos" seria quase um ano. `null` ou 0 devolve a
 * série inteira. Com menos de dois dias na janela devolve null, e a tela
 * diz que o período ainda não tem dado — dois pontos já são o mínimo de
 * figura(), um só não desenha nada.
 */
export function recortar(porDia, nDias) {
  if (!porDia || !nDias) return porDia;
  const ultimo = new Date(`${porDia.dias[porDia.dias.length - 1]}T00:00:00Z`);
  const corte = new Date(ultimo.getTime() - (nDias - 1) * 86400000)
    .toISOString().slice(0, 10);
  const a = porDia.dias.findIndex((d) => d >= corte);
  if (a < 0 || porDia.dias.length - a < 2) return null;
  const moedas = {};
  for (const [m, linha] of Object.entries(porDia.moedas)) moedas[m] = linha.slice(a);
  return { ...porDia, dias: porDia.dias.slice(a), moedas, cartas: porDia.cartas.slice(a) };
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
  // Custo e data entram: informar quanto pagou em trinta cartas é trabalho
  // que se perde com o navegador, e o lembrete de exportar tem que ver isso.
  // Só quando existem: sem custo, a digital fica igual à de antes desta
  // versão, e quem exportou ontem não vê "mudou desde então" sem ter mudado.
  const partes = Object.keys(dados).sort().map((k) => {
    const d = dados[k];
    const extra = d.pago || d.compradoEm
      ? `:${d.pago?.valor ?? ""}${d.pago?.moeda ?? ""}:${d.compradoEm ?? ""}` : "";
    return `${k}:${d.qtd}${extra}`;
  }).join(";");
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
