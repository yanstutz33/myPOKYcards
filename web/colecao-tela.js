/**
 * Tela da coleção: o que foi guardado, quanto vale e o que não dá para saber.
 *
 * A regra de ouro aqui é não somar o que não se sabe. Cartas sem cotação
 * aparecem contadas à parte, nunca como zero — 4 cartas sem preço não valem
 * R$ 0,00, valem "não sei".
 */

import * as colecao from "./colecao.js";
import * as grafico from "./grafico.js";
import * as pwa from "./pwa.js";
import { variantePreco } from "./colecao.js";
import { urlArte } from "./jogos.js";
import * as leituras from "./leituras.js";

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
/**
 * Janela do gráfico. 30 dias é o padrão porque é o trecho com ponto
 * DIÁRIO — antes disso o histórico é semanal (ver export_historico.py).
 * A escolha fica no aparelho só por conveniência.
 */
const PERIODOS = [[7, "7 d"], [30, "30 d"], [90, "90 d"], [0, "Tudo"]];
let periodo = (() => {
  try {
    // Sem escolha salva, `Number(null)` daria 0 — que é o código de "Tudo".
    const bruto = localStorage.getItem("mypokycards:periodo");
    const v = bruto === null ? NaN : Number(bruto);
    return PERIODOS.some(([n]) => n === v) ? v : 30;
  } catch { return 30; }
})();

function periodosHtml() {
  return `<div class="periodos" role="group" aria-label="Período do gráfico">${
    PERIODOS.map(([n, rot]) => `<button type="button" data-periodo="${n}"
      aria-pressed="${n === periodo}" class="${n === periodo ? "ativo" : ""}">${rot}</button>`)
      .join("")}</div>`;
}

function carteiraHtml(itens) {
  const inteira = colecao.valorPorDia(itens, precos, historico);
  if (!inteira) return "";
  const porDia = colecao.recortar(inteira, periodo);
  if (!porDia) {
    return `<section class="carteira">
      <h2>Sua coleção ao longo do tempo</h2>
      ${periodosHtml()}
      <p class="carteira-nota">Ainda não há dois dias de cotação dentro deste
        período. Escolha um período maior.</p>
    </section>`;
  }

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
      // Dias de CALENDÁRIO entre as pontas, não número de pontos: o passado
      // é semanal, e 36 pontos cobriam 71 dias.
      nota: `${Math.round((Date.parse(porDia.dias[porDia.dias.length - 1])
        - Date.parse(porDia.dias[0])) / 86400000) + 1} dias`,
    })).filter(Boolean).join("");

  if (!graficos) return "";

  const n = porDia.dias.length;
  return `<section class="carteira">
    <h2>Sua coleção ao longo do tempo</h2>
    ${periodosHtml()}
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

/**
 * Onde a coleção está guardada — dito sem enfeite.
 *
 * O índice de 32 mil cartas eu reconstruo. A coleção, não: ela foi montada
 * carta por carta e não existe em nenhum outro lugar. E mora no
 * `localStorage`, que o navegador pode apagar — o Safari do iPhone apaga o
 * de sites NÃO INSTALADOS depois de sete dias sem uso.
 *
 * Esta caixa diz a verdade sobre isso, incluindo quando a verdade é "não
 * sei". Dizer "sua coleção está segura" com base num `persist()` que o
 * navegador concede por heurística seria uma promessa que não posso cumprir
 * — e a pessoa só descobriria no dia em que a coleção sumisse.
 */
let estadoGuardado = null;

async function ondeEstamos() {
  estadoGuardado = await colecao.ondeEstamos();
  const caixa = document.getElementById("guardado");
  if (caixa) caixa.innerHTML = guardadoHtml();
}

function guardadoHtml() {
  const e = estadoGuardado;
  if (!e || !e.entradas) return "";

  const risco = e.persistente !== true && !e.instalado;

  const linhaLocal = e.persistente === true
    ? "O navegador prometeu não apagar este armazenamento."
    : e.persistente === false
      ? `Guardada <strong>só neste navegador</strong>, e ele pode apagar —
         o Safari do iPhone apaga o de sites não instalados depois de sete
         dias sem uso.`
      : `Guardada <strong>só neste navegador</strong>. Este navegador não
         informa se o armazenamento é permanente.`;

  const linhaBackup = e.exportadoEm === null
    ? `<strong>Nunca exportada.</strong> Se este navegador limpar os dados,
       não há de onde voltar.`
    : e.mudouDesdeExportacao
      ? `Exportada em ${esc(e.exportadoEm.slice(0, 10))}, e
         <strong>mudou desde então</strong>.`
      : `Exportada em ${esc(e.exportadoEm.slice(0, 10))}, sem mudanças
         depois disso.`;

  return `<div class="guardado ${risco ? "atencao" : ""}">
    <p>${linhaLocal}</p>
    <p>${linhaBackup}</p>
    ${e.instalado ? "" : pwa.podeInstalar()
      ? `<p class="guardado-dica">Instalar o app evita o apagamento
         automático.</p>
         <button id="instalar" class="primary">Instalar o app</button>`
      : `<p class="guardado-dica">Instalar o app na tela de início evita o
         apagamento automático — no iPhone, botão de compartilhar e
         <em>Adicionar à Tela de Início</em>.</p>`}
  </div>`;
}

/**
 * As três que mais valem, com a arte. É o que a pessoa mostra para alguém
 * — e o que mais pesa se o valor mudar.
 */
function topHtml(itens) {
  const top = colecao.maisValiosas(itens, precos, fx, 3);
  if (!top.length) return "";
  return `<section class="bloco">
    <h2>Mais valiosas</h2>
    <div class="top3">${top.map(({ it, m, total }, k) => {
      const i = catalogo.ids.indexOf(it.card_id);
      const meta = i >= 0 ? catalogo.meta[i] : null;
      const arte = meta?.[7] ? urlArte(catalogo, meta[7], "media") : "";
      return `<div class="top-carta">
        <span class="top-pos">${k + 1}</span>
        ${arte ? `<img alt="" decoding="async" src="${esc(arte)}">`
               : `<span class="top-sem"></span>`}
        <span class="top-nome">${esc(meta ? meta[0] : it.card_id)}</span>
        <span class="top-valor">${fmt(total, m.c)}</span>
        <span class="top-sub">${esc(it.variante || "")}${it.qtd > 1 ? ` · ×${it.qtd}` : ""}</span>
      </div>`;
    }).join("")}</div>
    ${top.some(({ m }) => m.c !== top[0].m.c) ? `<p class="prog-nota">Ordem
      pela conversão PTAX; cada valor aparece na moeda do próprio mercado.</p>` : ""}
  </section>`;
}

/**
 * Custo e resultado de uma entrada, com o formulário recolhido.
 *
 * `<details>` em vez de um modal: abre no lugar, funciona sem JS para
 * abrir e fechar, e o teclado do celular não cobre um campo que fugiu
 * para o meio da tela.
 */
function custoHtml(it, r, m) {
  const hoje = new Date().toISOString().slice(0, 10);
  const moedaPadrao = it.pago?.moeda || "BRL";
  const resumo = it.pago
    ? `Pago ${fmt(it.pago.valor, it.pago.moeda)}${it.qtd > 1 ? " cada" : ""}${
        it.compradoEm ? ` em ${esc(it.compradoEm.split("-").reverse().join("/"))}` : ""}`
    : "Custo";
  const resultadoTxt = r
    ? `<span class="custo-res ${r.lucro >= 0 ? "sobe" : "cai"}">${r.aproximado ? "≈ " : ""}${
        r.lucro >= 0 ? "+" : "−"}${fmt(Math.abs(r.lucro), r.moeda)}${
        r.pct === null ? "" : ` (${r.pct >= 0 ? "+" : ""}${r.pct.toLocaleString("pt-BR",
          { maximumFractionDigits: 1 })}%)`}</span>`
    : it.pago && !m ? `<span class="custo-res">sem cotação para comparar</span>` : "";
  return `<details class="custo">
    <summary>${resumo} ${resultadoTxt}</summary>
    <form class="custo-form" data-card="${esc(it.card_id)}" data-var="${esc(it.variante || "")}"
          data-col="${esc(colecao.colecaoDoItem(it))}">
      <label>Preço pago por unidade
        <input name="valor" type="number" inputmode="decimal" min="0" step="0.01"
               value="${it.pago ? it.pago.valor : ""}" placeholder="0,00"></label>
      <label>Moeda
        <select name="moeda">${colecao.MOEDAS_CUSTO.map((c) =>
          `<option value="${c}"${c === moedaPadrao ? " selected" : ""}>${c}</option>`).join("")}
        </select></label>
      <label>Data da compra
        <input name="data" type="date" max="${hoje}" value="${esc(it.compradoEm || "")}"></label>
      <div class="custo-botoes">
        <button type="submit" class="primary">Salvar</button>
        ${it.pago ? `<button type="button" data-limpar-custo>Remover custo</button>` : ""}
      </div>
    </form>
  </details>`;
}

/**
 * As últimas leituras, com o botão de guardar ao lado.
 *
 * Guarda na variante "normal" quando a carta tem, senão na primeira que o
 * catálogo lista — a mesma escolha padrão do leitor. Quem quer outra
 * variante abre a ficha, que mostra todas.
 */
const UTEIS = ["normal", "holo", "reverse", "foil", "holofoil", "cold-foil",
  "1st-edition", "unlimited"];

function leiturasHtml() {
  const lista = leituras.ler().slice(0, 12);
  if (!lista.length) return "";
  return `<section class="bloco">
    <h2>Lidas recentemente</h2>
    <div class="leituras">${lista.map((l) => {
      const i = catalogo.ids.indexOf(l.card_id);
      if (i < 0) return "";
      const meta = catalogo.meta[i];
      const variantes = (meta[5] || []).filter((v) => UTEIS.includes(v));
      const v = variantes.includes("normal") ? "normal" : variantes[0] || "normal";
      const m = (precos[l.card_id] || []).find((x) => x.v === variantePreco(v))
        || (precos[l.card_id] || [])[0];
      const arte = meta[7] ? urlArte(catalogo, meta[7]) : "";
      return `<div class="leitura">
        ${arte ? `<img alt="" loading="lazy" decoding="async" src="${esc(arte)}">`
               : `<span class="leitura-sem"></span>`}
        <span class="leitura-nome">${esc(meta[0])}${l.n > 1
          ? ` <span class="leitura-n" title="lida ${l.n} vezes em sequência">×${l.n}</span>` : ""}</span>
        <span class="leitura-sub">${esc(meta[1])} · ${esc(leituras.quando(l.em))}</span>
        <span class="leitura-preco">${m ? fmt(m.ref, m.c) : "sem cotação"}</span>
        <button type="button" data-guardar-leitura="${esc(l.card_id)}" data-var="${esc(v)}"
                data-n="${l.n}" aria-label="Guardar ${esc(meta[0])} na coleção">+ ${
                  l.n > 1 ? l.n : ""}</button>
      </div>`;
    }).join("")}</div>
    <div class="actions"><button type="button" data-limpar-leituras>Limpar histórico</button></div>
  </section>`;
}

/**
 * Qual coleção está na tela. "Todas" soma as coleções — a pergunta "quanto
 * vale tudo o que eu tenho" não pode exigir abrir uma por uma.
 */
const TODAS = "__todas__";
let vista = (() => {
  try { return localStorage.getItem("mypokycards:vista") || TODAS; } catch { return TODAS; }
})();

function abasHtml(todos) {
  const nomes = colecao.colecoes();
  if (vista !== TODAS && !nomes.includes(vista)) vista = TODAS;
  const conta = (nome) => todos.filter((it) => colecao.colecaoDoItem(it) === nome)
    .reduce((s, it) => s + it.qtd, 0);
  const ativa = colecao.ativa();
  const aba = (valor, rotulo, n) => `<button type="button" data-vista="${esc(valor)}"
      aria-pressed="${vista === valor}" class="${vista === valor ? "ativo" : ""}">${
      esc(rotulo)} <small>${N(n)}</small></button>`;
  return `<div class="abas-col">
    <div class="abas" role="group" aria-label="Coleções">
      ${aba(TODAS, "Todas", todos.reduce((s, it) => s + it.qtd, 0))}
      ${nomes.map((n) => aba(n, n, conta(n))).join("")}
      <button type="button" class="aba-nova" data-nova-colecao>+ Nova</button>
    </div>
    ${vista !== TODAS ? `<p class="abas-nota">${vista === ativa
      ? "O leitor guarda as cartas <strong>nesta coleção</strong>."
      : `O leitor guarda em <strong>${esc(ativa)}</strong>.
         <button type="button" class="link" data-ativar="${esc(vista)}">Guardar nesta</button>`}
      ${vista !== colecao.PADRAO ? `<button type="button" class="link perigo"
         data-excluir-colecao="${esc(vista)}">Excluir coleção</button>` : ""}</p>` : ""}
  </div>`;
}

function desenhar() {
  const todos = colecao.itens();

  if (!todos.length && colecao.colecoes().length === 1) {
    alvo.innerHTML = `<p class="empty">Nenhuma carta guardada ainda.<br>
      Abra o leitor, aponte para uma carta e toque em <strong>Guardar</strong>.</p>
      ${leiturasHtml()}`;
    return;
  }
  const abas = abasHtml(todos);
  const itens = vista === TODAS ? todos
    : todos.filter((it) => colecao.colecaoDoItem(it) === vista);
  if (!itens.length) {
    alvo.innerHTML = `${abas}<p class="empty">Esta coleção está vazia.<br>
      Use <strong>Guardar nesta</strong> e as cartas lidas virão para cá, ou mova
      cartas de outra coleção pelo menu de cada uma.</p>
      ${leiturasHtml()}`;
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

  // Investido e resultado, por moeda de CUSTO (ver colecao.resultado).
  const res = colecao.resultado(itens, precos, fx);
  const kpisResultado = Object.entries(res.porMoeda).map(([moeda, g]) =>
    `<div class="kpi"><small>Investido em ${esc(moeda)}</small><b>${fmt(g.custo, moeda)}</b>
       <em>${N(g.cartas)} carta(s) com custo informado</em></div>
     <div class="kpi resultado ${g.lucro >= 0 ? "sobe" : "cai"}">
       <small>${g.lucro >= 0 ? "Lucro" : "Prejuízo"}${g.aproximado ? " (≈)" : ""}</small>
       <b>${g.aproximado ? "≈ " : ""}${g.lucro >= 0 ? "+" : "−"}${fmt(Math.abs(g.lucro), moeda)}</b>
       <em>${g.pct === null ? "custo zero" : `${g.pct >= 0 ? "+" : ""}${g.pct.toLocaleString("pt-BR",
         { maximumFractionDigits: 1 })}% · vale ${fmt(g.hoje, moeda)} hoje`}</em></div>`).join("");

  const carteira = carteiraHtml(itens);
  const top = topHtml(itens);

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

  const nomesCol = colecao.colecoes();
  const lista = linhas.map(({ it, meta, m }) => {
    const nome = meta ? meta[0] : it.card_id;
    const set = meta ? `${meta[1]} · ${meta[2]}` : "";
    const valorTxt = m
      ? `${fmt(m.ref * it.qtd, m.c)}${it.qtd > 1 ? ` <em>(${fmt(m.ref, m.c)} cada)</em>` : ""}`
      : `<span class="sem">sem cotação para ${esc(it.variante || "esta variante")}</span>`;
    return `<div class="linha">
      <span>${esc(nome)} ${it.qtd > 1 ? `<strong>×${it.qtd}</strong>` : ""}</span>
      <span class="linha-sub">${esc(set)} · ${esc(it.variante || "variante não informada")}
        · <code>${esc(it.card_id)}</code>${vista === TODAS && nomesCol.length > 1
          ? ` · <span class="linha-col">${esc(colecao.colecaoDoItem(it))}</span>` : ""}</span>
      <span class="linha-val">${valorTxt}</span>
      ${custoHtml(it, res.linhas.get(colecao.chaveDoItem(it)), m)}
      <div class="linha-acoes">
        ${nomesCol.length > 1 ? `<select data-mover data-card="${esc(it.card_id)}"
            data-var="${esc(it.variante || "")}" data-col="${esc(colecao.colecaoDoItem(it))}"
            aria-label="Mover para outra coleção">${nomesCol.map((n) =>
              `<option value="${esc(n)}"${n === colecao.colecaoDoItem(it) ? " selected" : ""}>${
                esc(n)}</option>`).join("")}</select>` : ""}
        <button data-acao="menos" data-card="${esc(it.card_id)}"
                data-var="${esc(it.variante || "")}" data-col="${esc(colecao.colecaoDoItem(it))}"
                aria-label="remover uma">−</button>
        <button data-acao="mais" data-card="${esc(it.card_id)}"
                data-var="${esc(it.variante || "")}" data-col="${esc(colecao.colecaoDoItem(it))}"
                aria-label="adicionar uma">+</button>
      </div>
    </div>`;
  }).join("");

  alvo.innerHTML = `
    ${abas}
    <section class="bloco">
      <h2>Resumo</h2>
      <div class="kpis">${kpis}${kpisResultado}</div>
      ${Object.values(res.porMoeda).some((g) => g.aproximado) ? `<p class="prog-nota">
        <strong>≈</strong> quando você pagou numa moeda e a cotação é em outra:
        o valor de hoje foi convertido pela PTAX para comparar. É estimativa —
        o preço no Brasil tem frete, imposto e liquidez próprios.</p>` : ""}
      ${res.semCusto && Object.keys(res.porMoeda).length ? `<p class="prog-nota">
        ${N(res.semCusto)} carta(s) sem custo informado ficam fora do lucro.</p>` : ""}
      ${!Object.keys(res.porMoeda).length ? `<p class="prog-nota">Informe quanto
        pagou em cada carta (botão <strong>Custo</strong>, na lista) para ver
        lucro ou prejuízo.</p>` : ""}
      ${Object.keys(totais).length > 1 ? `<p class="prog-nota">
        Os totais ficam separados por moeda de propósito. Somar tudo em real
        daria a impressão de ser o valor de venda no Brasil — e é justamente
        isso que não sabemos. O <strong>≈ R$</strong> é conversão pela PTAX
        do Banco Central${fx?.taxas?.USD?.em ? ` de ${esc(fx.taxas.USD.em.slice(0, 10))}` : ""}.
      </p>` : ""}
      <div id="guardado">${guardadoHtml()}</div>
      ${semPreco ? `<p class="prog-nota">${N(semPreco)} carta(s) sem cotação
        não entram em nenhum total. Não valem zero — o valor é desconhecido.</p>` : ""}
      ${semVariante ? `<p class="prog-nota">${N(semVariante)} carta(s) têm preço
        na fonte, mas não para a variante guardada. Usar o preço de outra
        variante seria dizer que um reverse holo vale o mesmo que o normal —
        então também ficam de fora.</p>` : ""}
    </section>
    ${top}
    ${carteira}
    ${leiturasHtml()}

    <section class="bloco">
      <h2>Cartas</h2>
      <div class="linhas">${lista}</div>
      <div class="actions">
        <button id="exportar" class="primary">Exportar backup</button>
        <button id="exportarCsv">Planilha (CSV)</button>
        <button id="importar">Importar</button>
        <button id="limpar">Apagar tudo</button>
      </div>
      <input id="arquivo" type="file" accept="application/json,.json" hidden>
      </div>
    </section>`;

  document.getElementById("exportar").onclick = exportar;
  // A planilha sai da coleção que está na tela: "Todas" exporta tudo, com a
  // coluna `colecao` dizendo de onde é cada linha.
  document.getElementById("exportarCsv").onclick = () => baixar(
    colecao.csv(itens, catalogo, precos, fx), "text/csv;charset=utf-8",
    `colecao-mypokycards-${vista === TODAS ? "todas" : vista.replace(/[^\w-]+/g, "_")}-${
      new Date().toISOString().slice(0, 10)}.csv`);
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
function baixar(texto, tipo, nome) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([texto], { type: tipo }));
  a.download = nome;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function exportar() {
  // O backup é SEMPRE a coleção inteira, todas as pastas: é o arquivo que
  // restaura o aparelho, e um backup parcial que parece completo é o pior
  // tipo de backup.
  baixar(JSON.stringify(colecao.itens(), null, 2), "application/json",
    `colecao-mypokycards-${new Date().toISOString().slice(0, 10)}.json`);
  // Registra a digital do momento. Sem isso o aviso de "não exportada" teria
  // que ser genérico e permanente, e aviso permanente vira parte do cenário:
  // a pessoa para de ler e ele deixa de servir para o dia em que importa.
  colecao.marcarExportado();
  ondeEstamos();
}

alvo.addEventListener("click", async (ev) => {
  if (ev.target.id === "instalar") {
    // `instalar()` devolve null quando o convite ja foi consumido — o botao
    // some junto, entao isto so acontece se dois cliques correrem juntos.
    const r = await pwa.instalar();
    if (r !== null) ondeEstamos();
    return;
  }

  const guardar = ev.target.closest("button[data-guardar-leitura]");
  if (guardar) {
    // A quantidade lida em sequência é a quantidade guardada: quem leu ×4
    // tem quatro na mão. Na coleção que está na tela, ou na ativa em "Todas".
    const destino = vista === TODAS ? colecao.ativa() : vista;
    const n = colecao.adicionar(guardar.dataset.guardarLeitura, guardar.dataset.var,
      Number(guardar.dataset.n) || 1, destino);
    if (n === null) { guardar.textContent = "!"; return; }
    desenhar();
    ondeEstamos();
    return;
  }
  if (ev.target.closest("button[data-limpar-leituras]")) {
    if (confirm("Limpar o histórico de leituras? A coleção não é afetada.")) {
      leituras.limpar();
      desenhar();
    }
    return;
  }

  const aba = ev.target.closest("button[data-vista]");
  if (aba) {
    vista = aba.dataset.vista;
    try { localStorage.setItem("mypokycards:vista", vista); } catch { /* só conveniência */ }
    desenhar();
    return;
  }
  if (ev.target.closest("button[data-nova-colecao]")) {
    const nome = prompt("Nome da nova coleção (ex.: Para vender, Fichário, Deck)");
    const criada = colecao.criarColecao(nome);
    if (criada) {
      vista = criada;
      try { localStorage.setItem("mypokycards:vista", vista); } catch { /* idem */ }
      desenhar();
    }
    return;
  }
  const ativar = ev.target.closest("button[data-ativar]");
  if (ativar) {
    colecao.definirAtiva(ativar.dataset.ativar);
    desenhar();
    return;
  }
  const excluir = ev.target.closest("button[data-excluir-colecao]");
  if (excluir) {
    const nome = excluir.dataset.excluirColecao;
    if (confirm(`Excluir a coleção “${nome}”? As cartas dela voltam para a ${
      colecao.PADRAO} — nenhuma carta é apagada.`) && colecao.excluirColecao(nome)) {
      vista = TODAS;
      desenhar();
      ondeEstamos();
    }
    return;
  }

  const p = ev.target.closest("button[data-periodo]");
  if (p) {
    periodo = Number(p.dataset.periodo);
    try { localStorage.setItem("mypokycards:periodo", String(periodo)); } catch { /* só conveniência */ }
    desenhar();
    return;
  }

  const limpa = ev.target.closest("button[data-limpar-custo]");
  if (limpa) {
    const f = limpa.closest("form");
    colecao.definirCompra(f.dataset.card, f.dataset.var || null, { valor: null, data: null },
      f.dataset.col);
    desenhar();
    ondeEstamos();
    return;
  }

  const b = ev.target.closest("button[data-acao]");
  if (!b) return;
  const n = colecao.adicionar(b.dataset.card, b.dataset.var || null,
    b.dataset.acao === "mais" ? 1 : -1, b.dataset.col || colecao.PADRAO);
  // `adicionar` devolve null quando o navegador recusa gravar (modo privado,
  // cota cheia). O leitor ja avisava; esta tela redesenhava como se tivesse
  // dado certo, e o numero voltava ao anterior sem explicacao nenhuma.
  if (n === null) {
    b.textContent = "!";
    b.title = "o navegador não deixou gravar";
    return;
  }
  desenhar();
  ondeEstamos();
});

alvo.addEventListener("change", (ev) => {
  const sel = ev.target.closest("select[data-mover]");
  if (!sel) return;
  if (!colecao.mover(sel.dataset.card, sel.dataset.var || null, sel.dataset.col, sel.value)) {
    sel.value = sel.dataset.col;    // o navegador recusou gravar: volta como estava
    return;
  }
  desenhar();
  ondeEstamos();
});

alvo.addEventListener("submit", (ev) => {
  const f = ev.target.closest("form.custo-form");
  if (!f) return;
  ev.preventDefault();
  const d = new FormData(f);
  const ok = colecao.definirCompra(f.dataset.card, f.dataset.var || null, {
    valor: String(d.get("valor") || "").replace(",", "."),
    moeda: d.get("moeda"),
    data: d.get("data") || null,
  }, f.dataset.col);
  if (!ok) {
    // Valor inválido ou navegador recusando gravar: o campo diz, a tela não
    // finge que salvou.
    const campo = f.querySelector("[name=valor]");
    campo.setCustomValidity("Valor inválido, ou o navegador não deixou gravar");
    campo.reportValidity();
    setTimeout(() => campo.setCustomValidity(""), 2500);
    return;
  }
  desenhar();
  ondeEstamos();
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
  ondeEstamos();
  // Pedido feito uma vez por sessao, depois de a tela existir. O navegador
  // decide por heuristica (engajamento, app instalado) e costuma negar em
  // visita nova — por isso o resultado dele NAO vira promessa na tela, so
  // muda a frase que ela mostra.
  colecao.pedirPersistencia().then(ondeEstamos);
  // O navegador decide quando oferecer a instalacao, e costuma ser depois da
  // pagina pronta. Sem redesenhar, o botao so apareceria na proxima visita.
  window.addEventListener("beforeinstallprompt", () => setTimeout(ondeEstamos, 0));
  window.addEventListener("appinstalled", ondeEstamos);
})();
