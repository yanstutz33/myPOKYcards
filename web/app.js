/**
 * YAMI-TCG — tela de leitura.
 *
 * Fluxo: câmera -> recorte da moldura -> três reduções (32x32, 9x8, 8x8) ->
 * worker calcula os hashes e busca no índice -> top-3 com confiança.
 *
 * A redução acontece aqui, não no worker, porque só a thread principal tem
 * canvas garantido em todos os navegadores móveis.
 */

import { capture } from "./capture.js";
import * as colecao from "./colecao.js";
import { corDaCarta, energiasHtml, eFoil } from "./tema.js";

const els = {
  video: document.getElementById("video"),
  stage: document.getElementById("stage"),
  frame: document.getElementById("frame"),
  hint: document.getElementById("hint"),
  results: document.getElementById("results"),
  timing: document.getElementById("timing"),
  dot: document.getElementById("dot"),
  statusText: document.getElementById("statusText"),
  toggle: document.getElementById("toggle"),
  freeze: document.getElementById("freeze"),
};

const CARD_RATIO = 0.716;   // 63mm / 88mm — igual ao CSS
const INTERVAL_MS = 450;    // ritmo de leitura; abaixo disso só aquece o celular
const CONF_ALTA = 0.88;     // acima disso o top-1 é destacado como provável
// Trava sozinho quando o MESMO candidato vem no topo em N leituras seguidas
// com confiança alta. Uma leitura só não basta: um frame borrado durante o
// movimento pode acertar por acaso e travar na carta errada.
const TRAVA_CONF = 0.90;
const TRAVA_FRAMES = 3;

let worker = null;
let catalog = null;
let prices = {};
let fx = null;
let stream = null;
let running = false;
let frozen = false;
let seq = 0;
let ultimoTopo = null;
let repeticoes = 0;

function setStatus(text, state) {
  els.statusText.textContent = text;
  els.dot.className = "dot" + (state ? " " + state : "");
}

// ------------------------------------------------------------- carregamento

async function boot() {
  try {
    worker = new Worker("matcher.worker.js");
    worker.onmessage = onWorkerMessage;
    worker.onerror = (e) => fatal("Falha no worker: " + e.message);

    const [binRes, jsonRes] = await Promise.all([
      fetch("data/index.bin"),
      fetch("data/cards.json"),
    ]);
    if (!binRes.ok || !jsonRes.ok) {
      throw new Error("índice não encontrado — rode export_web_index.py");
    }
    const buffer = await binRes.arrayBuffer();
    catalog = await jsonRes.json();
    // Preço é opcional por desenho: o leitor tem que funcionar sem ele, e
    // dizer que não tem, em vez de quebrar ou mostrar zero.
    prices = await fetch("data/prices.json").then((r) => (r.ok ? r.json() : {})).catch(() => ({}));
    fx = await fetch("data/fx.json").then((r) => (r.ok ? r.json() : null)).catch(() => null);
    worker.postMessage({ type: "load", buffer }, [buffer]);
  } catch (err) {
    fatal(err.message);
  }
}

function onWorkerMessage(ev) {
  const msg = ev.data;
  if (msg.type === "ready") {
    setStatus(`${msg.count.toLocaleString("pt-BR")} cartas`, "on");
    els.toggle.disabled = false;
    const q = new URLSearchParams(location.search);
    if (q.has("demo")) demo(q.get("demo") || undefined);
    return;
  }
  if (msg.type === "error") return fatal(msg.message);
  if (msg.type === "result") {
    if (msg.seq !== seq) return;           // resultado de frame vencido
    els.timing.textContent = `${msg.ms.toFixed(0)} ms`;
    render(msg.results);
    avaliarTrava(msg.results);
  }
}

function fatal(message) {
  setStatus("erro", "err");
  els.results.innerHTML =
    `<div class="nodata"><b>Não foi possível iniciar.</b><br>${escapeHtml(message)}</div>`;
  els.toggle.disabled = true;
}

// ------------------------------------------------------------------ câmera

async function startCamera() {
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 } },
      audio: false,
    });
  } catch (err) {
    const motivo = err.name === "NotAllowedError"
      ? "Permissão de câmera negada. Libere nas configurações do navegador e recarregue."
      : err.name === "NotFoundError"
      ? "Nenhuma câmera encontrada neste aparelho."
      : err.message;
    els.results.innerHTML =
      `<div class="nodata"><b>Câmera indisponível.</b><br>${escapeHtml(motivo)}</div>`;
    return false;
  }
  els.video.srcObject = stream;
  await els.video.play();
  return true;
}

function stopCamera() {
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  els.video.srcObject = null;
}

// ------------------------------------------------------------------ captura

/**
 * Recorta a região da moldura no vídeo.
 *
 * O vídeo usa object-fit:cover, então o quadro exibido é um recorte do quadro
 * real: é preciso desfazer essa escala antes de mapear a moldura, ou o recorte
 * sai deslocado e o match despenca sem nenhum erro aparente.
 */
function cropRect() {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  if (!vw || !vh) return null;

  const stageBox = els.stage.getBoundingClientRect();
  const frameBox = els.frame.getBoundingClientRect();

  const scale = Math.max(stageBox.width / vw, stageBox.height / vh);
  const shownW = vw * scale;
  const shownH = vh * scale;
  const offsetX = (stageBox.width - shownW) / 2;
  const offsetY = (stageBox.height - shownH) / 2;

  const x = (frameBox.left - stageBox.left - offsetX) / scale;
  const y = (frameBox.top - stageBox.top - offsetY) / scale;
  const w = frameBox.width / scale;
  const h = frameBox.height / scale;

  return {
    x: Math.max(0, Math.round(x)),
    y: Math.max(0, Math.round(y)),
    w: Math.min(vw, Math.round(w)),
    h: Math.min(vh, Math.round(h)),
  };
}

function tick() {
  if (!running || frozen) return;
  const rect = cropRect();
  if (rect && rect.w > 8 && rect.h > 8) {
    seq++;
    worker.postMessage({ type: "match", seq, k: 3, ...capture(els.video, rect) });
  }
  setTimeout(tick, INTERVAL_MS);
}

/**
 * Trava a leitura quando o resultado se estabiliza.
 *
 * Sem isso o usuário precisa segurar a carta na frente da câmera enquanto
 * lê o preço — e qualquer tremida troca o resultado embaixo dos olhos dele.
 * Exigir N leituras iguais evita travar num frame borrado que acertou por
 * sorte durante o movimento.
 */
function avaliarTrava(results) {
  const topo = results[0];
  if (!topo || topo.confidence < TRAVA_CONF) {
    ultimoTopo = null;
    repeticoes = 0;
    return;
  }
  const id = catalog.ids[topo.i];
  repeticoes = id === ultimoTopo ? repeticoes + 1 : 1;
  ultimoTopo = id;

  if (repeticoes >= TRAVA_FRAMES) travar(id);
}

function travar(cardId) {
  frozen = true;
  repeticoes = 0;
  els.freeze.textContent = "Ler outra";
  els.stage.classList.add("paused", "travado");

  const meta = catalog.meta[catalog.ids.indexOf(cardId)];
  const nome = meta?.[0] || cardId;
  // `--tipo` é definido no cartão do resultado, que fica em outra subárvore;
  // o visor precisa da própria cópia ou a moldura e o selo saem no ciano
  // padrão em vez da cor do tipo da carta.
  els.stage.style.setProperty("--tipo", corDaCarta(meta?.[9]));
  els.hint.textContent = "Toque em “Ler outra” para escanear a próxima";
  const selo = document.createElement("div");
  selo.className = "travado-selo";
  selo.textContent = `✓ ${nome}`;
  els.stage.querySelector(".travado-selo")?.remove();
  els.stage.appendChild(selo);
}

function destravar() {
  frozen = false;
  ultimoTopo = null;
  repeticoes = 0;
  els.freeze.textContent = "Congelar";
  els.stage.classList.remove("paused", "travado");
  els.stage.style.removeProperty("--tipo");
  els.stage.querySelector(".travado-selo")?.remove();
  els.hint.textContent = "Encaixe a carta inteira na moldura";
  tick();
}

// ---------------------------------------------------------------- resultados

/**
 * Impressões que o reconhecimento por imagem não separa.
 *
 * Não é "a mesma arte": o grupo maior são Unown de letras diferentes, que
 * diferem só por um glifo. É literalmente "o leitor não distingue estas" —
 * e como elas têm preços diferentes, a escolha tem que ser do usuário.
 *
 * O agrupamento é pré-calculado (pipeline/build_art_groups.py) usando
 * ilustrador + número da Pokédex além da distância de hash. Distância
 * sozinha fundia 72 cartas distintas num grupo só.
 */
function irmasHtml(cardId) {
  const i = catalog.ids.indexOf(cardId);
  const grupo = catalog.meta[i]?.[8];
  if (grupo === undefined || grupo === -1) return "";

  const irmas = (catalog.grupos?.[String(grupo)] || []).filter((j) => j !== i);
  if (!irmas.length) return "";

  const linhas = irmas.slice(0, 8).map((j) => {
    const id = catalog.ids[j];
    const [nome, set, numero, , regiao] = catalog.meta[j];
    const p = prices[id]?.[0];
    const s = p ? `${SIMBOLO[p.c] || p.c} ${p.ref.toFixed(2)}` : "sem preço";
    return `<button class="irma" data-card="${escapeHtml(id)}">
      <span class="irma-nome">${escapeHtml(nome)}</span>
      <span class="irma-meta">${escapeHtml(set)} · ${escapeHtml(numero)} · ${
        regiao === "asia" ? "JA" : "INTL"}</span>
      <span class="irma-preco">${escapeHtml(s)}</span>
    </button>`;
  }).join("");

  return `<details class="grupo">
    <summary>${irmas.length + 1} impressões que o leitor não distingue —
      confira o número e o símbolo na carta</summary>
    <div class="irmas">${linhas}</div>
    <p class="grupo-nota">Arte igual ou quase igual, preços diferentes.
      Nenhum algoritmo de imagem separa estas; só o texto impresso separa.</p>
  </details>`;
}

/**
 * Botão de guardar. A variante vai junto porque normal e reverse holo são
 * produtos econômicos distintos — guardar "a carta" sem a variante tornaria
 * o valor da coleção um chute.
 */
function guardarHtml(cardId, variantes) {
  const opcoes = (variantes && variantes.length ? variantes : ["normal"])
    .map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`).join("");
  const jaTem = colecao.itens()
    .filter((i) => i.card_id === cardId)
    .reduce((s, i) => s + i.qtd, 0);
  return `<div class="guardar">
    <select class="guardar-var" data-card="${escapeHtml(cardId)}"
            aria-label="variante">${opcoes}</select>
    <button class="guardar-btn" data-card="${escapeHtml(cardId)}">Guardar</button>
    ${jaTem ? `<span class="guardar-tem">${jaTem} na coleção</span>` : ""}
  </div>`;
}

function render(results) {
  if (!results.length) return;

  const ambiguo = results.length > 1 &&
    results[1].confidence > results[0].confidence - 0.02;

  els.results.innerHTML = results.map((r, i) => {
    const id = catalog.ids[r.i];
    const [nome, set, numero, raridade, regiao, variantes, idiomas, caminho, , tipos]
      = catalog.meta[r.i];
    const destaque = i === 0 && r.confidence >= CONF_ALTA && !ambiguo;
    const cor = corDaCarta(tipos);

    const tags = [];
    if (raridade) tags.push(`<span class="selo-raridade">${escapeHtml(raridade)}</span>`);
    for (const v of variantes) tags.push(`<span class="tag">${escapeHtml(v)}</span>`);
    if (idiomas.length > 1) {
      tags.push(`<span class="tag lang">${idiomas.length} idiomas</span>`);
    }

    // Miniatura só no candidato do topo: nas alternativas ela competiria
    // por atenção com a carta que o usuário está de fato conferindo.
    const mini = i === 0 && caminho
      ? `<img class="miniatura" alt="" loading="lazy" crossorigin="anonymous"
             src="${catalog.cdn}/${escapeHtml(caminho)}/low.png">`
      : "";

    return `<article class="hit${destaque ? " top" : ""}${
        eFoil(raridade) ? " foil" : ""}${mini ? " com-mini" : ""}"
        style="--tipo:${cor}">
      ${mini}
      <h3 class="hit-name">${escapeHtml(nome)} ${energiasHtml(tipos)}</h3>
      <div class="hit-conf"><b>${(r.confidence * 100).toFixed(0)}%</b><small>confiança</small></div>
      <div class="hit-meta">
        <span>${escapeHtml(set)} · ${escapeHtml(numero)}</span>
        <span>${regiao === "asia" ? "Ásia" : "Internacional"}</span>
        <code>${escapeHtml(id)}</code>
        ${tags.join("")}
      </div>
      ${precoHtml(id, regiao)}
      ${i === 0 ? gradedHtml(id) : ""}
      ${guardarHtml(id, variantes)}
      ${i === 0 ? irmasHtml(id) : ""}
    </article>`;
  }).join("") + avisoDeLimite(results, ambiguo);
}

const SIMBOLO = { USD: "US$", EUR: "€", BRL: "R$", JPY: "¥" };

// TCG Pocket é um jogo digital: as cartas existem só no app, não há mercado
// físico. Os sets A1–A4 e B1–B2 vieram inteiros sem cotação, e isso é
// correto, não falha de coleta.
const RE_DIGITAL = /^[AB]\d/;
const digital = (cardId) => RE_DIGITAL.test(cardId);

/**
 * Bloco de preço de um candidato.
 *
 * Nunca renderiza número sem moeda, variante, fonte e idade — preço sem
 * proveniência é pior que preço nenhum, porque parece confiável. Ausência é
 * um estado explícito com motivo, jamais zero.
 */
/**
 * Conversão para real — deliberadamente discreta e sempre rotulada.
 *
 * Não é o preço brasileiro: o mercado nacional tem liquidez, imposto e frete
 * próprios, e a diferença em relação ao americano não é a taxa de câmbio.
 * Serve para responder "isso é carta de dez reais ou de mil?".
 *
 * Taxa oficial PTAX do Banco Central, com data visível no rodapé do bloco.
 */
function converter(valor, moeda) {
  const t = fx?.taxas?.[moeda];
  if (!t) return "";
  const v = valor * t.taxa;
  const fmt = v >= 100 ? v.toFixed(0) : v.toFixed(2);
  return `<span class="brl" title="Conversão pela PTAX de ${escapeHtml(t.em || "")}. Não é o preço do mercado brasileiro.">≈ R$ ${fmt}</span>`;
}

/**
 * Bloco de graduação (PSA 10, GBA).
 *
 * Estado honesto: NENHUMA fonte pública cota carta graduada de graça.
 * PSA 10 existe em serviço pago (PokemonPriceTracker ~US$ 10/mês); GBA,
 * MGS e Capy são graduadoras brasileiras novas demais para ter índice
 * público — não há preço de GBA em lugar nenhum, verificado.
 *
 * O que dá para dizer com o dado que temos é se graduar faz sentido: a
 * regra de bolso do mercado é que abaixo de ~US$ 50 raw o custo da
 * graduação come o ganho. Isso é orientação de decisão, não preço
 * inventado — e é explicitamente rotulado como tal.
 */
const LIMIAR_GRADUACAO_USD = 50;

function gradedHtml(cardId) {
  const mercados = prices[cardId] || [];
  if (!mercados.length) return "";

  // Referência em dólar para comparar com o limiar; sem USD, converte do
  // que houver usando a PTAX, e diz que foi convertido.
  const usd = mercados.find((m) => m.c === "USD");
  let base = usd?.ref ?? null;
  let convertido = false;
  if (base === null) {
    const outro = mercados[0];
    const tOutro = fx?.taxas?.[outro.c]?.taxa;
    const tUsd = fx?.taxas?.USD?.taxa;
    if (tOutro && tUsd) { base = (outro.ref * tOutro) / tUsd; convertido = true; }
  }
  if (base === null) return "";

  const vale = base >= LIMIAR_GRADUACAO_USD;
  return `<details class="graded">
    <summary>Vale graduar? <strong>${vale ? "provavelmente sim" : "provavelmente não"}</strong></summary>
    <p class="graded-nota">
      Esta carta vale <strong>US$ ${base.toFixed(2)}</strong> sem graduação${
        convertido ? " (convertido)" : ""}. A regra de bolso do mercado é que
      abaixo de <strong>US$ ${LIMIAR_GRADUACAO_USD}</strong> o custo da
      graduação e do frete costuma comer o ganho — e só nota 9 ou 10
      multiplica o valor de verdade.
    </p>
    <div class="graded-slots">
      <div class="slot"><span class="slot-nome">PSA 10</span>
        <span class="slot-vazio">sem fonte gratuita</span></div>
      <div class="slot"><span class="slot-nome">GBA</span>
        <span class="slot-vazio">sem índice público</span></div>
    </div>
    <p class="graded-nota">
      Preço de carta graduada não tem fonte aberta: PSA existe só em serviço
      pago, e GBA, MGS e Capy são graduadoras brasileiras novas demais para
      ter índice. Preferimos deixar o espaço vazio a estimar por multiplicador.
    </p>
  </details>`;
}

function precoHtml(cardId, regiao) {
  const mercados = prices[cardId];

  if (!mercados || !mercados.length) {
    // Cada ausência tem uma causa diferente, e o usuário merece saber qual.
    // "Sem preço" sozinho parece falha do app quando muitas vezes é a
    // natureza da carta.
    const motivo = digital(cardId)
      ? "Carta do TCG Pocket, que é digital — não existe mercado físico nem cotação."
      : regiao === "asia"
      ? "Carta japonesa: Cardmarket e TCGplayer são mercados ocidentais e não a cotam. Só 2% das cartas asiáticas têm preço nessas fontes."
      : "Consultada na fonte, sem cotação registrada.";
    return `<p class="preco-vazio">Sem preço · ${escapeHtml(motivo)}</p>`;
  }

  const linhas = mercados.map((m) => {
    const s = SIMBOLO[m.c] || m.c + " ";
    const faixa = m.faixa
      ? `<span class="faixa">${s} ${m.faixa[0].toFixed(2)}–${m.faixa[1].toFixed(2)}</span>`
      : "";
    const brl = converter(m.ref, m.c);
    const velho = m.idade != null && m.idade > 7;
    const idade = m.idade == null ? "sem data"
      : m.idade < 1 ? "hoje"
      : `há ${Math.round(m.idade)} d`;
    return `<div class="preco-linha${velho ? " velho" : ""}">
      <span class="preco-val">${s} ${m.ref.toFixed(2)}</span>
      ${brl}
      ${faixa}
      <span class="preco-src">${escapeHtml(m.v)} · ${escapeHtml(m.f)} · ${idade}</span>
    </div>`;
  }).join("");

  const nota = fx
    ? `<p class="fx-nota">≈ R$ é conversão pela PTAX do Banco Central de
       ${escapeHtml((fx.taxas.USD?.em || "").slice(0, 10))}, não o preço do
       mercado brasileiro.</p>`
    : "";
  return `<div class="precos">${linhas}${nota}</div>`;
}

/**
 * Os avisos abaixo não são disclaimers de praxe — são limitações medidas:
 * a mesma arte aparece em impressões de idiomas diferentes, e nenhuma fonte
 * aberta cota carta em BRL ou JPY.
 */
function avisoDeLimite(results, ambiguo) {
  const partes = [];
  if (ambiguo) {
    partes.push(`<b>Candidatos empatados.</b> Provavelmente a mesma arte em
      impressões diferentes — a versão japonesa e a internacional têm hash
      quase idêntico. Confira o número e o símbolo da expansão na carta.`);
  }
  partes.push(`<b>Preço em moeda estrangeira, sem conversão.</b> A referência
    vem de venda concluída; a faixa é o que se pede hoje. Não existe fonte
    aberta que cote em BRL ou JPY — converter aqui seria inventar precisão.`);
  return `<div class="nodata">${partes.join("<br><br>")}</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * Carrega a arte de uma carta a partir do CDN de origem.
 *
 * O site nunca hospeda arte de carta — aponta para a fonte, que serve com
 * `Access-Control-Allow-Origin: *`. Sem `crossOrigin` o canvas seria
 * marcado como contaminado e `getImageData` lançaria erro de segurança.
 */
function carregarCarta(cardId) {
  const caminho = catalog.meta[catalog.ids.indexOf(cardId)]?.[7];
  if (!caminho) return Promise.reject(new Error("carta sem arte conhecida"));
  return new Promise((res, rej) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => res(img);
    img.onerror = () => rej(new Error("não foi possível carregar a arte"));
    img.src = `${catalog.cdn}/${caminho}/low.png`;
  });
}

/**
 * `?demo` — roda o matcher contra a arte de uma carta conhecida, sem câmera.
 * Serve para revisar a interface em máquina sem webcam. É um match real
 * contra o índice, não um resultado fabricado.
 */
async function demo(cardId) {
  try {
    const alvo = (cardId && catalog.ids.includes(cardId) && cardId)
      || catalog.ids.find((id) => id === "ex2-85") || catalog.ids[0];
    const img = await carregarCarta(alvo);
    els.hint.textContent = `demo · ${alvo}`;
    const quadro = capture(img);
    // Repete como a câmera repetiria: é isso que exercita o travamento.
    for (let n = 0; n < TRAVA_FRAMES; n++) {
      seq++;
      worker.postMessage({ type: "match", seq, k: 3, ...quadro });
      await new Promise((r) => setTimeout(r, 120));
    }
  } catch (err) {
    els.results.innerHTML =
      `<div class="nodata"><b>Demo indisponível.</b><br>${escapeHtml(err.message)}</div>`;
  }
}

// ------------------------------------------------------------------ controles

els.toggle.addEventListener("click", async () => {
  if (running) {
    running = false;
    frozen = false;
    stopCamera();
    els.stage.classList.add("paused");
    els.toggle.textContent = "Iniciar câmera";
    els.freeze.disabled = true;
    els.hint.textContent = "Câmera parada";
    return;
  }
  els.toggle.disabled = true;
  const ok = await startCamera();
  els.toggle.disabled = false;
  if (!ok) return;
  running = true;
  els.stage.classList.remove("paused");
  els.toggle.textContent = "Parar";
  els.freeze.disabled = false;
  els.hint.textContent = "Encaixe a carta inteira na moldura";
  tick();
});

els.freeze.addEventListener("click", () => {
  if (frozen) return destravar();
  frozen = true;
  els.freeze.textContent = "Retomar";
  els.stage.classList.add("paused");
  els.hint.textContent = "Leitura pausada — resultado mantido";
});

els.results.addEventListener("click", (ev) => {
  const btn = ev.target.closest(".guardar-btn");
  if (!btn) return;
  const cardId = btn.dataset.card;
  const sel = btn.parentElement.querySelector(".guardar-var");
  const n = colecao.adicionar(cardId, sel?.value);
  if (n === null) {
    btn.textContent = "sem espaço";
    return;
  }
  // Congela a leitura ao guardar: sem isso o próximo frame reescreve o
  // painel e o retorno visual some antes de ser lido.
  frozen = true;
  els.freeze.textContent = "Retomar";
  els.stage.classList.add("paused");
  btn.textContent = `guardado (${n})`;
  btn.disabled = true;
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && running) {
    frozen = true;
    els.freeze.textContent = "Retomar";
  }
});

boot();
