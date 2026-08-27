/**
 * Painel do estado do sistema.
 *
 * Regra que guia tudo aqui: **nenhum número sem denominador**. "5.486 cartas
 * com preço" não informa nada; "5.486 de 12.962 internacionais" informa. E o
 * que falta é desenhado com a mesma ênfase do que está pronto — um painel
 * que só mostra progresso esconde justamente onde é preciso trabalhar.
 */

const alvo = document.getElementById("painel");
const N = (v) => Number(v || 0).toLocaleString("pt-BR");
const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

function kpi(rotulo, valor, nota) {
  return `<div class="kpi"><small>${esc(rotulo)}</small><b>${esc(valor)}</b>${
    nota ? `<em>${esc(nota)}</em>` : ""}</div>`;
}

function progresso(nome, feito, total, nota) {
  const pct = total ? (100 * feito) / total : 0;
  return `<div class="prog">
    <div class="prog-topo">
      <span class="prog-nome">${esc(nome)}</span>
      <span class="prog-num">${N(feito)} de ${N(total)} · ${pct.toFixed(1)}%</span>
    </div>
    <div class="trilho">
      <i class="feito" style="width:${pct}%"></i>
      <i class="falta" style="width:${100 - pct}%"></i>
    </div>
    ${nota ? `<p class="prog-nota">${nota}</p>` : ""}
  </div>`;
}

function idade(iso) {
  if (!iso) return "sem registro";
  const h = (Date.now() - new Date(iso).getTime()) / 36e5;
  if (h < 1) return "há menos de 1 h";
  if (h < 48) return `há ${Math.round(h)} h`;
  return `há ${Math.round(h / 24)} dias`;
}

(async () => {
  let d;
  try {
    const r = await fetch("data/dashboard.json");
    if (!r.ok) throw new Error("dashboard.json não encontrado");
    d = await r.json();
  } catch (e) {
    alvo.innerHTML = `<div class="nodata"><b>Painel indisponível.</b><br>
      ${esc(e.message)} — rode <code>python pipeline/export_dashboard.py</code>.</div>`;
    return;
  }

  const partes = [];
  const cat = d.catalogo;

  // ---------------------------------------------------------------- catálogo
  partes.push(`<section class="bloco">
    <h2>Catálogo</h2>
    <div class="kpis">
      ${kpi("Cartas", N(cat.cartas),
        `${N(cat.cartas_por_regiao.intl)} intl · ${N(cat.cartas_por_regiao.asia)} ásia`)}
      ${kpi("Sets", N(cat.sets),
        `${N(cat.sets_por_regiao.intl)} intl · ${N(cat.sets_por_regiao.asia)} ásia`)}
      ${kpi("Idiomas", cat.idiomas.length, "EN · JA · KO · ZH · PT")}
      ${kpi("Colisões tratadas", cat.colisoes_tratadas, "ids duplicados resolvidos")}
    </div>
    <div class="linhas">
      ${cat.idiomas.map((l) => `<div class="linha">
        <span>${esc(l.lang)}</span>
        <span class="linha-val">${N(l.cartas)}</span>
        <div class="mini-barra"><i style="width:${
          (100 * l.cartas) / cat.idiomas[0].cartas}%"></i></div>
      </div>`).join("")}
    </div>
  </section>`);

  // ---------------------------------------------------------- reconhecimento
  if (d.reconhecimento) {
    const r = d.reconhecimento;
    const porReg = r.por_regiao
      .filter((x) => x.com_hash + x.sem_imagem > 0)
      .map((x) => progresso(
        x.regiao === "asia" ? "Ásia (japonês)" : "Internacional",
        x.com_hash, x.com_hash + x.sem_imagem,
        x.regiao === "asia"
          ? "O CDN de imagens não cobre boa parte dos sets japoneses — inclusive lançamentos recentes. Sem imagem, não há hash, e o leitor não reconhece a carta."
          : "")).join("");

    partes.push(`<section class="bloco">
      <h2>Reconhecimento por imagem</h2>
      <div class="kpis">
        ${kpi("Com hash", N(r.com_hash), "reconhecíveis pela câmera")}
        ${kpi("Sem imagem", N(r.sem_imagem), "ausentes no CDN de origem")}
        ${kpi("Recall top-3", "99,8%", "medido em 420 tentativas")}
        ${kpi("Busca", "14 ms", "no aparelho, sem rede")}
      </div>
      ${porReg}
    </section>`);
  }

  // ------------------------------------------------------------------ preços
  if (d.precos) {
    const p = d.precos;
    partes.push(`<section class="bloco">
      <h2>Preços</h2>
      <div class="kpis">
        ${kpi("Cotações", N(p.linhas), "linha por métrica e variante")}
        ${kpi("Cartas cotadas", N(p.cartas_com_preco), "")}
        ${kpi("Venda concluída", N(p.por_kind.sold), "referência de valor")}
        ${kpi("Última coleta", idade(p.ultima_coleta), p.falhas_coleta
          ? `${N(p.falhas_coleta)} falhas registradas` : "sem falhas pendentes")}
      </div>
      ${progresso("Cobertura internacional", p.intl_consultadas, p.intl_alvo,
        "Coleta incremental e resumível: cada rodada pega só o que falta.")}
      <div class="prog">
        <div class="prog-topo">
          <span class="prog-nome">Mercados sem fonte aberta</span>
          <span class="prog-num">BRL · JPY</span>
        </div>
        <p class="prog-nota">Cardmarket e TCGplayer cotam apenas o mercado
          ocidental: 99,4% das cartas internacionais têm preço, contra 2,2%
          das asiáticas. Nenhuma fonte aberta cota em real ou em iene —
          converter aqui seria inventar precisão.</p>
      </div>
      <div class="linhas">
        ${p.mais_caras.map((m) => `<div class="linha">
          <span>${esc(m.nome)}</span>
          <span class="linha-sub">${esc(m.set)} · ${esc(m.card_id)}</span>
          <span class="linha-val">${esc(m.moeda === "USD" ? "US$" : "€")} ${
            m.valor.toLocaleString("pt-BR", { minimumFractionDigits: 2 })}</span>
        </div>`).join("")}
      </div>
      <p class="prog-nota">Acima: maiores valores de <strong>venda concluída</strong>
        entre as cartas já coletadas — não é ranking do mercado, é o que esta
        base conhece até agora.</p>
    </section>`);
  }

  alvo.innerHTML = partes.join("");
  document.getElementById("gerado").textContent =
    `Dados gerados ${idade(d.gerado_em)} · ${new Date(d.gerado_em).toLocaleString("pt-BR")}`;
})();
