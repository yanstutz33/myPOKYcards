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

let worker = null;
let catalog = null;
let stream = null;
let running = false;
let frozen = false;
let seq = 0;

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
    if (new URLSearchParams(location.search).has("demo")) demo();
    return;
  }
  if (msg.type === "error") return fatal(msg.message);
  if (msg.type === "result") {
    if (msg.seq !== seq) return;           // resultado de frame vencido
    els.timing.textContent = `${msg.ms.toFixed(0)} ms`;
    render(msg.results);
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

// ---------------------------------------------------------------- resultados

function render(results) {
  if (!results.length) return;

  const ambiguo = results.length > 1 &&
    results[1].confidence > results[0].confidence - 0.02;

  els.results.innerHTML = results.map((r, i) => {
    const id = catalog.ids[r.i];
    const [nome, set, numero, raridade, regiao, variantes, idiomas] = catalog.meta[r.i];
    const destaque = i === 0 && r.confidence >= CONF_ALTA && !ambiguo;

    const tags = [];
    if (raridade) tags.push(`<span class="tag">${escapeHtml(raridade)}</span>`);
    for (const v of variantes) tags.push(`<span class="tag">${escapeHtml(v)}</span>`);
    if (idiomas.length > 1) {
      tags.push(`<span class="tag lang">${idiomas.length} idiomas</span>`);
    }

    return `<article class="hit${destaque ? " top" : ""}">
      <h3 class="hit-name">${escapeHtml(nome)}</h3>
      <div class="hit-conf"><b>${(r.confidence * 100).toFixed(0)}%</b><small>confiança</small></div>
      <div class="hit-meta">
        <span>${escapeHtml(set)} · ${escapeHtml(numero)}</span>
        <span>${regiao === "asia" ? "Ásia" : "Internacional"}</span>
        <code>${escapeHtml(id)}</code>
        ${tags.join("")}
      </div>
    </article>`;
  }).join("") + avisoDeLimite(results, ambiguo);
}

/**
 * Os avisos abaixo não são disclaimers de praxe — são as duas limitações que
 * o autoteste mediu: a mesma arte aparece em impressões de idiomas
 * diferentes, e ainda não existe camada de preço.
 */
function avisoDeLimite(results, ambiguo) {
  const partes = [];
  if (ambiguo) {
    partes.push(`<b>Candidatos empatados.</b> Provavelmente a mesma arte em
      impressões diferentes — a versão japonesa e a internacional têm hash
      quase idêntico. Confira o número e o símbolo da expansão na carta.`);
  }
  partes.push(`<b>Sem dados de preço ainda.</b> O leitor identifica a carta;
    a camada de cotação em BRL, USD e JPY é a próxima etapa.`);
  return `<div class="nodata">${partes.join("<br><br>")}</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/**
 * `?demo` — roda o matcher contra uma imagem de teste local, sem câmera.
 * Serve para revisar a interface em máquina sem webcam e para depurar a
 * renderização. É um match real, não um resultado fabricado.
 */
async function demo() {
  try {
    const manifest = await fetch("test/manifest.json").then((r) => r.json());
    const img = await new Promise((res, rej) => {
      const i = new Image();
      i.onload = () => res(i);
      i.onerror = () => rej(new Error("imagem de teste ausente"));
      i.src = "test/" + manifest[0].file;
    });
    els.hint.textContent = `demo · ${manifest[0].card_id}`;
    els.stage.classList.add("paused");
    seq++;
    worker.postMessage({ type: "match", seq, k: 3, ...capture(img) });
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
  frozen = !frozen;
  els.freeze.textContent = frozen ? "Retomar" : "Congelar";
  els.stage.classList.toggle("paused", frozen);
  els.hint.textContent = frozen
    ? "Leitura pausada — resultado mantido"
    : "Encaixe a carta inteira na moldura";
  if (!frozen) tick();
});

document.addEventListener("visibilitychange", () => {
  if (document.hidden && running) {
    frozen = true;
    els.freeze.textContent = "Retomar";
  }
});

boot();
