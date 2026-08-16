/**
 * myPOKYcards — tela de leitura.
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
import { detectarCarta, regiaoDeBusca } from "./detectar.js";
import { RESTRICOES_VIDEO, temLanterna, definirLanterna, focarEm, condicaoDeLuz,
         manterTelaAcesa, liberarTela, telaPresa, vibrar } from "./camera.js";
import * as som from "./som.js";
import * as ficha from "./ficha.js";

const els = {
  video: document.getElementById("video"),
  stage: document.getElementById("stage"),
  frame: document.getElementById("frame"),
  hint: document.getElementById("hint"),
  results: document.getElementById("results"),
  dot: document.getElementById("dot"),
  statusText: document.getElementById("statusText"),
  toggle: document.getElementById("toggle"),
  barra: document.getElementById("barra"),
  capturar: document.getElementById("capturar"),
  retomar: document.getElementById("retomar"),
  achado: document.getElementById("achado"),
  diag: document.getElementById("diag"),
  lanterna: document.getElementById("lanterna"),
  audio: document.getElementById("audio"),
};

let trilha = null;        // MediaStreamTrack de vídeo
let lanternaLigada = false;
let ultimaLuz = null;

const DIAG = new URLSearchParams(location.search).has("diag");
els.barra.hidden = true;

const CARD_RATIO = 0.716;   // 63mm / 88mm — igual ao CSS
const INTERVAL_MS = 450;    // ritmo de leitura; abaixo disso só aquece o celular
const CONF_ALTA = 0.88;     // acima disso o top-1 é destacado como provável
// Limiares do travamento automático.
//
// Os valores anteriores (90% de confiança, 3 quadros) vinham de imagem
// sintética e não disparavam com carta real na mão: foto de celular tem
// borrão de movimento, reflexo e branco desbalanceado que a degradação
// simulada não reproduz. Com detecção de borda o recorte melhorou muito,
// mas a confiança real continua abaixo do que a imagem perfeita produz.
//
// Independentemente disso, o automático NUNCA é o único caminho: o botão
// de captura sempre trava o que estiver na tela.
const TRAVA_CONF = 0.82;
const TRAVA_FRAMES = 2;
// Margem entre o 1o e o 2o candidato, em bits ponderados.
//
// A confianca sozinha NAO distingue "achei a carta" de "a carta nao esta no
// indice e esta e a mais parecida". Medido: com a carta ausente do indice, a
// confianca do palpite errado fica entre 71% e 89% — faixa que se sobrepoe
// inteiramente a de um acerto legitimo em foto degradada (83% a 99%).
//
// A margem separa melhor: mediana 22,6 quando a carta esta presente contra
// 4,2 quando esta ausente. Em 12 bits, mantem 79% dos acertos e corta o
// falso-positivo de ~100% para 25%. Nao resolve — 11.411 cartas do catalogo
// nao tem hash, quase todas japonesas, e para elas nao existe resposta certa
// possivel. Mas impede que o leitor TRAVE numa carta errada com ar de certeza.
const MARGEM_MIN = 8;

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
    ficha.configurar({
      get catalog() { return catalog; },
      get prices() { return prices; },
      get fx() { return fx; },
      converter, corDaCarta, energiasHtml,
    });
    ficha.ligarControles();
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
    render(msg.results);
    if (!frozen) orientar(msg.results);
    if (DIAG) mostrarDiag(msg);
    if (pendenteTravar) {
      pendenteTravar = false;
      if (msg.results[0]) travar(catalog.ids[msg.results[0].i], true);
    } else {
      avaliarTrava(msg.results);
    }
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
      video: RESTRICOES_VIDEO, audio: false,
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

  // A lanterna só aparece se o aparelho declarar o recurso. iPhone não
  // implementa `torch`, e um botão que não faz nada é pior que nenhum.
  trilha = stream.getVideoTracks()[0] || null;
  els.lanterna.hidden = !temLanterna(trilha);
  lanternaLigada = false;
  els.lanterna.classList.remove("ligada");
  return true;
}

function stopCamera() {
  if (lanternaLigada && trilha) definirLanterna(trilha, false);
  if (stream) stream.getTracks().forEach((t) => t.stop());
  stream = null;
  trilha = null;
  lanternaLigada = false;
  els.lanterna.hidden = true;
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

let ultimoRecorte = null;
let ultimaDeteccao = null;

/**
 * Recorte de uma leitura.
 *
 * A moldura vira sugestão: procura-se a borda da carta numa região mais
 * larga que ela. Enquadramento errado em 10–15% destruía o match antes,
 * porque o hash é da carta inteira e sobra de fundo entra como se fosse
 * arte. Sem detecção confiável, cai de volta na moldura.
 */
function recorteAtual() {
  const guia = cropRect();
  if (!guia) return null;
  const achado = detectarCarta(els.video, regiaoDeBusca(guia, els.video));
  ultimaDeteccao = achado;
  desenharAchado(achado);
  return achado || guia;
}

/** Desenha na tela a borda que está sendo recortada de fato. */
let tinhaBorda = false;
function desenharAchado(a) {
  // Só na transição: bipe a cada 450 ms de leitura seria insuportável em
  // dois minutos de uso na loja.
  if (Boolean(a) !== tinhaBorda) {
    tinhaBorda = Boolean(a);
    if (tinhaBorda) som.somDetectou();
  }
  if (!a) {
    els.achado.hidden = true;
    els.stage.classList.remove("detectado");
    return;
  }
  const vw = els.video.videoWidth, vh = els.video.videoHeight;
  const box = els.stage.getBoundingClientRect();
  const escala = Math.max(box.width / vw, box.height / vh);
  const offX = (box.width - vw * escala) / 2;
  const offY = (box.height - vh * escala) / 2;
  Object.assign(els.achado.style, {
    left: `${a.x * escala + offX}px`,
    top: `${a.y * escala + offY}px`,
    width: `${a.w * escala}px`,
    height: `${a.h * escala}px`,
  });
  els.achado.hidden = false;
  els.stage.classList.add("detectado");
}

/**
 * Diz ao usuário o que está atrapalhando.
 *
 * O app tinha toda essa informação e mostrava "Aponte para a carta" para
 * sempre — inclusive quando sabia que a borda não fora encontrada ou que o
 * quadro estava estourado. Cada causa tem uma ação diferente, e sem dizer
 * qual é a pessoa só pode tentar de novo no escuro.
 *
 * A dica só muda quando o motivo muda: texto piscando a cada 450 ms é
 * ilegível e passa sensação de instabilidade.
 */
let motivoAtual = "";
function orientar(results) {
  let msg = "Aponte para a carta";
  let classe = "";

  if (ultimaLuz?.estourado) {
    msg = "Reflexo forte — incline a carta ou desligue a lanterna";
    classe = "alerta";
  } else if (ultimaLuz?.escuro) {
    msg = temLanterna(trilha)
      ? "Escuro — toque na lanterna"
      : "Escuro demais para ler";
    classe = "alerta";
  } else if (!ultimaDeteccao) {
    msg = "Não achei a borda — aproxime e use fundo liso";
    classe = "alerta";
  } else if (results?.length) {
    const m = margem(results);
    const c = results[0].confidence;
    if (c < TRAVA_CONF) {
      msg = "Quase lá — segure firme e aproxime";
    } else if (m < MARGEM_MIN) {
      msg = "Reconhecimento incerto — toque no botão para capturar";
      classe = "alerta";
    } else {
      msg = "Lendo…";
    }
  }

  if (msg === motivoAtual) return;
  // Toca só ao ENTRAR em estado de alerta, não a cada leitura ruim.
  if (classe === "alerta" && !els.hint.classList.contains("alerta")) som.somAlerta();
  motivoAtual = msg;
  els.hint.textContent = msg;
  els.hint.className = "hint" + (classe ? " " + classe : "");
}

function tick() {
  if (!running || frozen) return;
  const rect = recorteAtual();
  if (rect && rect.w > 8 && rect.h > 8) {
    ultimoRecorte = rect;
    const quadro = capture(els.video, rect);
    // Aproveita a redução 32x32 que o matcher já exige: medir luz num quadro
    // cheio custaria mais que a própria leitura.
    ultimaLuz = condicaoDeLuz(quadro.p32);
    seq++;
    worker.postMessage({ type: "match", seq, k: 3, ...quadro });
  } else {
    ultimaLuz = null;
    orientar(null);
  }
  setTimeout(tick, INTERVAL_MS);
}

/**
 * Captura manual: trava no melhor candidato do quadro atual, sem exigir
 * confiança nem repetição.
 *
 * Existe porque o automático pode simplesmente não disparar — luz ruim,
 * carta fora do índice, reflexo de foil. Ficar preso esperando o leitor
 * "decidir" foi a reclamação do primeiro teste com carta real.
 */
function capturarAgora() {
  if (!running) return;
  const rect = recorteAtual() || cropRect();
  if (!rect) return;
  frozen = true;
  seq++;
  pendenteTravar = true;
  worker.postMessage({ type: "match", seq, k: 3, ...capture(els.video, rect) });
  els.hint.textContent = "Lendo…";
}
let pendenteTravar = false;

/**
 * Trava a leitura quando o resultado se estabiliza.
 *
 * Sem isso o usuário precisa segurar a carta na frente da câmera enquanto
 * lê o preço — e qualquer tremida troca o resultado embaixo dos olhos dele.
 * Exigir N leituras iguais evita travar num frame borrado que acertou por
 * sorte durante o movimento.
 */
function margem(results) {
  return results.length > 1 ? results[1].score - results[0].score : Infinity;
}

function avaliarTrava(results) {
  const topo = results[0];
  if (!topo || topo.confidence < TRAVA_CONF || margem(results) < MARGEM_MIN) {
    ultimoTopo = null;
    repeticoes = 0;
    return;
  }
  const id = catalog.ids[topo.i];
  repeticoes = id === ultimoTopo ? repeticoes + 1 : 1;
  ultimoTopo = id;

  if (repeticoes >= TRAVA_FRAMES) travar(id);
}

function travar(cardId, manual = false) {
  escolhido = 0;
  if (manual) som.somCapturou();
  else som.somReconheceu();
  // Vibração curta: confirma no tato o que a tela e o som confirmam, e é o
  // único canal que funciona com o celular no silencioso.
  vibrar(manual ? 14 : [12, 40, 22]);
  frozen = true;
  repeticoes = 0;
  els.retomar.hidden = false;
  els.capturar.hidden = true;
  els.stage.classList.add("paused", "travado");

  const meta = catalog.meta[catalog.ids.indexOf(cardId)];
  const nome = meta?.[0] || cardId;
  // `--tipo` é definido no cartão do resultado, que fica em outra subárvore;
  // o visor precisa da própria cópia ou a moldura e o selo saem no ciano
  // padrão em vez da cor do tipo da carta.
  els.stage.style.setProperty("--tipo", corDaCarta(meta?.[9]));
  motivoAtual = "";
  els.hint.className = "hint";
  els.hint.textContent = manual
    ? "Capturado — confira se é a carta certa"
    : "Reconhecido. Toque em “Ler outra” para a próxima";
  const selo = document.createElement("div");
  selo.className = "travado-selo";
  selo.textContent = `✓ ${nome}`;
  els.stage.querySelector(".travado-selo")?.remove();
  els.stage.appendChild(selo);
}

function destravar() {
  som.somClique();
  frozen = false;
  ultimoTopo = null;
  repeticoes = 0;
  els.retomar.hidden = true;
  els.capturar.hidden = false;
  els.stage.classList.remove("paused", "travado");
  els.stage.style.removeProperty("--tipo");
  els.stage.querySelector(".travado-selo")?.remove();
  els.hint.textContent = "Aponte para a carta";
  tick();
}

/**
 * Diagnóstico na tela (`?diag`).
 *
 * Existe porque não dá para calibrar limiar sem número de aparelho real:
 * foto de celular tem borrão, reflexo e branco desbalanceado que a
 * degradação simulada não reproduz. Estes números dizem POR QUE o
 * travamento não disparou.
 */
function mostrarDiag(msg) {
  const r = msg.results;
  const d = ultimaDeteccao;
  const linhas = [
    `busca      ${msg.ms.toFixed(0)} ms`,
    `borda      ${d ? `${d.w}x${d.h}  proporcao ${(d.w / d.h).toFixed(3)}  conf ${(d.confianca * 100).toFixed(0)}%` : "NAO DETECTADA (usando moldura)"}`,
    `recorte    ${ultimoRecorte ? `${ultimoRecorte.w}x${ultimoRecorte.h}` : "-"}`,
    `luz        ${ultimaLuz ? `media ${ultimaLuz.media.toFixed(0)}  estourado ${(ultimaLuz.fracaoEstourada * 100).toFixed(0)}%` + (ultimaLuz.estourado ? "  REFLEXO" : "") + (ultimaLuz.escuro ? "  ESCURO" : "") : "-"}`,
    `lanterna   ${trilha ? (temLanterna(trilha) ? (lanternaLigada ? "ligada" : "disponivel") : "nao suportada") : "-"}`,
    `video      ${els.video.videoWidth}x${els.video.videoHeight}`,
    "",
    ...r.map((x, i) =>
      `${i + 1}. ${catalog.ids[x.i].padEnd(15)} conf ${(x.confidence * 100).toFixed(1)}%  dist ${x.score.toFixed(1)}`),
    "",
    `margem     ${margem(r).toFixed(1)}  (minimo ${MARGEM_MIN})`,
    `travaria   conf>=${(TRAVA_CONF * 100).toFixed(0)}% ${r[0]?.confidence >= TRAVA_CONF ? "OK" : "NAO"}` +
      `  margem ${margem(r) >= MARGEM_MIN ? "OK" : "NAO"}  repet ${repeticoes}/${TRAVA_FRAMES}`,
  ];
  els.diag.textContent = linhas.join("\n");
  els.diag.hidden = false;
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
/**
 * Guardar: um botão por variante, grande, de um toque.
 *
 * Antes era um <select> mais um botão dentro do painel rolante, e foi
 * difícil de usar com a carta numa mão e o celular na outra. Variantes que
 * não têm preço próprio (erro de impressão, marcador de tiragem) ficam de
 * fora: guardar por elas quebraria o cálculo de valor da coleção.
 */
const VARIANTES_UTEIS = ["normal", "holo", "reverse", "1st-edition", "unlimited"];

function guardarHtml(cardId, variantes) {
  const uteis = (variantes || []).filter((v) => VARIANTES_UTEIS.includes(v));
  const lista = uteis.length ? uteis : ["normal"];
  const jaTem = colecao.itens()
    .filter((i) => i.card_id === cardId)
    .reduce((s, i) => s + i.qtd, 0);

  const botoes = lista.map((v) => {
    const n = colecao.quantidade(cardId, v);
    return `<button class="guardar-btn${n ? " feito" : ""}"
      data-card="${escapeHtml(cardId)}" data-var="${escapeHtml(v)}">
      + ${escapeHtml(v)}${n ? ` <small>${n} guardada${n > 1 ? "s" : ""}</small>` : ""}
    </button>`;
  }).join("");

  return `<div class="guardar">${botoes}
    ${jaTem ? `<span class="guardar-tem">${jaTem} desta carta na coleção</span>` : ""}
  </div>`;
}

/**
 * Um resultado em destaque, o resto sob demanda.
 *
 * A versão anterior empilhava as TRÊS cartas completas — nome, mercados,
 * graduação, grupo, botões — e dava 1.405 px de conteúdo num painel de
 * 338 px. Era o que tornava a tela difícil: tudo com o mesmo peso, nada
 * legível de relance, e o que importa (que carta é, quanto vale) enterrado
 * no meio.
 *
 * Agora: a carta provável ocupa a tela como uma carta de verdade, com UM
 * preço de referência grande. Alternativas viram uma tira compacta, e
 * detalhe abre quando é pedido.
 */

const SIMBOLO = { USD: "US$", EUR: "€", BRL: "R$", JPY: "¥" };

// TCG Pocket é um jogo digital: as cartas existem só no app, não há mercado
// físico. Os sets A1–A4 e B1–B2 vieram inteiros sem cotação, e isso é
// correto, não falha de coleta.
const RE_DIGITAL = /^[AB]\d/;
const digital = (cardId) => RE_DIGITAL.test(cardId);

/**
 * Conversão para real — discreta e sempre rotulada.
 *
 * Não é o preço brasileiro: o mercado nacional tem liquidez, imposto e frete
 * próprios, e a diferença para o americano não é a taxa de câmbio. Serve
 * para responder "isso é carta de dez reais ou de mil?".
 */
function converter(valor, moeda) {
  const t = fx?.taxas?.[moeda];
  if (!t) return "";
  const v = valor * t.taxa;
  const fmt = v >= 100 ? v.toFixed(0) : v.toFixed(2);
  return `<span class="brl" title="Conversão pela PTAX de ${escapeHtml(t.em || "")}. Não é o preço do mercado brasileiro.">≈ R$ ${fmt}</span>`;
}

/** Todos os mercados da carta, com moeda, variante, fonte e idade. */
function precoHtml(cardId, regiao) {
  const mercados = prices[cardId] || [];
  if (!mercados.length) return "";

  const linhas = mercados.map((m) => {
    const s = SIMBOLO[m.c] || m.c + " ";
    const faixa = m.faixa
      ? `<span class="faixa">${s} ${m.faixa[0].toFixed(2)}–${m.faixa[1].toFixed(2)}</span>`
      : "";
    const velho = m.idade != null && m.idade > 7;
    const idade = m.idade == null ? "sem data"
      : m.idade < 1 ? "hoje"
      : `há ${Math.round(m.idade)} d`;
    return `<div class="preco-linha${velho ? " velho" : ""}">
      <span class="preco-val">${s} ${m.ref.toFixed(2)}</span>
      ${converter(m.ref, m.c)}
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
 * Graduação (PSA 10, GBA).
 *
 * Nenhuma fonte pública cota carta graduada de graça: PSA existe só em
 * serviço pago e GBA, MGS e Capy são graduadoras brasileiras novas demais
 * para ter índice — verificado. Os campos ficam visivelmente vazios em vez
 * de estimados por multiplicador.
 *
 * O que o dado sustenta é se VALE graduar: abaixo de ~US$ 50 raw o custo da
 * graduação e do frete costuma comer o ganho.
 */
const LIMIAR_GRADUACAO_USD = 50;

function gradedHtml(cardId) {
  const mercados = prices[cardId] || [];
  if (!mercados.length) return "";

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
  return `<details class="bloco-det graded">
    <summary>Vale graduar? <strong>${vale ? "provavelmente sim" : "provavelmente não"}</strong></summary>
    <p class="graded-nota">
      Vale <strong>US$ ${base.toFixed(2)}</strong> sem graduação${convertido ? " (convertido)" : ""}.
      Abaixo de <strong>US$ ${LIMIAR_GRADUACAO_USD}</strong> o custo da graduação e do
      frete costuma comer o ganho — e só nota 9 ou 10 multiplica o valor.
    </p>
    <div class="graded-slots">
      <div class="slot"><span class="slot-nome">PSA 10</span>
        <span class="slot-vazio">sem fonte gratuita</span></div>
      <div class="slot"><span class="slot-nome">GBA</span>
        <span class="slot-vazio">sem índice público</span></div>
    </div>
  </details>`;
}

/**
 * Avisos que são limitações MEDIDAS, não disclaimer de praxe.
 */
function avisoDeLimite(results) {
  const partes = [];
  const ambiguo = results.length > 1 &&
    results[1].confidence > results[0].confidence - 0.02;
  if (margem(results) < MARGEM_MIN) {
    partes.push(`<b>Certeza baixa.</b> Isso costuma acontecer quando a carta
      não está no índice — 11.411 cartas do catálogo não têm imagem na fonte,
      quase todas japonesas. Confira o número impresso.`);
  } else if (ambiguo) {
    partes.push(`<b>Candidatos empatados.</b> Provavelmente a mesma arte em
      impressões diferentes. Confira o número e o símbolo da expansão.`);
  }
  return partes.length ? `<div class="nodata">${partes.join("<br><br>")}</div>` : "";
}

let escolhido = 0;   // índice do candidato em destaque

function precoDestaque(cardId) {
  const mercados = prices[cardId] || [];
  if (!mercados.length) return null;
  // Preferir a cotação mais recente; entre iguais, a de venda concluída.
  return mercados.slice().sort((a, b) => (a.idade ?? 99) - (b.idade ?? 99))[0];
}

function cartaHtml(r, results) {
  const id = catalog.ids[r.i];
  const [nome, set, numero, raridade, regiao, variantes, idiomas, caminho, , tipos]
    = catalog.meta[r.i];
  const cor = corDaCarta(tipos);
  const m = precoDestaque(id);

  const preco = m
    ? `<div class="valor">
         <span class="valor-num">${SIMBOLO[m.c] || m.c} ${m.ref.toFixed(2)}</span>
         ${converter(m.ref, m.c)}
         <span class="valor-src">${escapeHtml(m.v)} · ${escapeHtml(m.f)}${
           m.idade != null ? (m.idade < 1 ? " · hoje" : ` · há ${Math.round(m.idade)} d`) : ""}</span>
       </div>`
    : `<div class="valor sem">${motivoSemPreco(id, regiao)}</div>`;

  return `<article class="hit top tocavel${eFoil(raridade) ? " foil" : ""}${
        caminho ? " com-mini" : ""}" style="--tipo:${cor}" data-ficha="${escapeHtml(id)}">
    ${caminho ? `<img class="miniatura" alt="" loading="lazy" crossorigin="anonymous"
         src="${catalog.cdn}/${escapeHtml(caminho)}/low.png">` : ""}
    <h3 class="hit-name">${escapeHtml(nome)} ${energiasHtml(tipos)}</h3>
    <div class="hit-conf"><b>${(r.confidence * 100).toFixed(0)}%</b><small>certeza</small></div>
    <div class="hit-meta">
      <span>${escapeHtml(set)} · ${escapeHtml(numero)}</span>
      ${raridade ? `<span class="selo-raridade">${escapeHtml(raridade)}</span>` : ""}
      <span>${regiao === "asia" ? "JA" : "INTL"}</span>
      <span class="toque-dica">toque para ver tudo →</span>
    </div>
    ${preco}
    ${guardarHtml(id, variantes)}
    ${detalhesHtml(id, regiao, results)}
  </article>`;
}

/** Alternativas: tira compacta, tocável para trocar o destaque. */
function alternativasHtml(results) {
  const outros = results.map((r, i) => [r, i]).filter(([, i]) => i !== escolhido);
  if (!outros.length) return "";
  const itens = outros.map(([r, i]) => {
    const [nome, set, numero] = catalog.meta[r.i];
    return `<button class="alt" data-i="${i}">
      <span class="alt-nome">${escapeHtml(nome)}</span>
      <span class="alt-meta">${escapeHtml(set)} · ${escapeHtml(numero)}</span>
      <span class="alt-conf">${(r.confidence * 100).toFixed(0)}%</span>
    </button>`;
  }).join("");
  return `<div class="alts">
    <p class="alts-titulo">Não é essa? Toque na certa:</p>
    ${itens}
  </div>`;
}

function motivoSemPreco(cardId, regiao) {
  return digital(cardId)
    ? "Carta do TCG Pocket — jogo digital, sem mercado físico"
    : regiao === "asia"
    ? "Sem cotação: mercados ocidentais não cotam carta japonesa"
    : "Consultada na fonte, sem cotação registrada";
}

/** Tudo que não é "que carta é" e "quanto vale" fica fechado. */
/**
 * No painel fica só o que decide ação imediata. Todo o resto — mercados,
 * dados da carta, impressões irmãs — mora na ficha, a um toque.
 */
function detalhesHtml(cardId, regiao, results) {
  return `${gradedHtml(cardId)}${avisoDeLimite(results)}`;
}

function render(results) {
  if (!results.length) return;
  if (escolhido >= results.length) escolhido = 0;

  const ambiguo = results.length > 1 &&
    results[1].confidence > results[0].confidence - 0.02;

  els.results.innerHTML =
    cartaHtml(results[escolhido], results) + alternativasHtml(results);
  ultimosResultados = results;
  if (ambiguo) els.results.classList.add("ambiguo");
  else els.results.classList.remove("ambiguo");
}

let ultimosResultados = null;

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
    els.stage.classList.remove("detectado", "travado");
    els.achado.hidden = true;
    els.barra.hidden = true;
    els.toggle.textContent = "Ligar leitor";
    els.hint.textContent = "Câmera parada";
    som.somDesligou();
    liberarTela();
    return;
  }
  els.toggle.disabled = true;
  const ok = await startCamera();
  els.toggle.disabled = false;
  if (!ok) return;
  running = true;
  els.stage.classList.remove("paused");
  els.barra.hidden = false;
  els.capturar.hidden = false;
  els.retomar.hidden = true;
  els.toggle.textContent = "Desligar";
  els.hint.textContent = "Aponte para a carta";
  som.somLigou();
  manterTelaAcesa();
  tick();
});

els.results.addEventListener("click", (ev) => {
  const btn = ev.target.closest(".guardar-btn");
  if (!btn) return;
  const n = colecao.adicionar(btn.dataset.card, btn.dataset.var);
  if (n === null) {
    btn.textContent = "sem espaço no navegador";
    return;
  }
  // Congela ao guardar: sem isso o próximo quadro reescreve o painel e o
  // retorno visual some antes de ser lido.
  som.somGuardou();
  if (!frozen) travar(btn.dataset.card, true);
  btn.classList.add("feito");
  btn.innerHTML = `✓ ${escapeHtml(btn.dataset.var)} <small>${n} guardada${n > 1 ? "s" : ""}</small>`;
});

els.results.addEventListener("click", (ev) => {
  const carta = ev.target.closest(".tocavel");
  if (carta && !ev.target.closest("button, summary, a, details")) {
    som.somClique();
    // Congela ao abrir a ficha: sem isso o próximo quadro troca a carta
    // embaixo da leitura e a ficha fica falando de outra coisa.
    if (!frozen && running) travar(carta.dataset.ficha, true);
    ficha.abrir(carta.dataset.ficha);
    return;
  }
  const alt = ev.target.closest(".alt");
  if (!alt || !ultimosResultados) return;
  escolhido = Number(alt.dataset.i);
  render(ultimosResultados);
});

els.audio.addEventListener("click", () => {
  const on = som.alternar();
  els.audio.classList.toggle("mudo", !on);
  els.audio.setAttribute("aria-pressed", String(on));
  els.audio.setAttribute("aria-label", on ? "Desligar sons" : "Ligar sons");
});
els.audio.classList.toggle("mudo", !som.estaLigado());
els.audio.setAttribute("aria-pressed", String(som.estaLigado()));

els.capturar.addEventListener("click", capturarAgora);

els.lanterna.addEventListener("click", async () => {
  if (!trilha) return;
  const ok = await definirLanterna(trilha, !lanternaLigada);
  if (!ok) {
    els.lanterna.hidden = true;   // o aparelho mentiu sobre suportar
    return;
  }
  lanternaLigada = !lanternaLigada;
  som.somClique();
  els.lanterna.classList.toggle("ligada", lanternaLigada);
  els.lanterna.setAttribute("aria-pressed", String(lanternaLigada));
});

// Tocar no visor foca naquele ponto. Carta a ~15 cm costuma cair fora do
// foco automático, que mira no fundo.
els.stage.addEventListener("click", (ev) => {
  if (!trilha || frozen || ev.target.closest(".barra")) return;
  const b = els.stage.getBoundingClientRect();
  focarEm(trilha, (ev.clientX - b.left) / b.width, (ev.clientY - b.top) / b.height);
  els.stage.classList.add("focando");
  setTimeout(() => els.stage.classList.remove("focando"), 400);
});
els.retomar.addEventListener("click", destravar);

document.addEventListener("visibilitychange", () => {
  if (!document.hidden && running && !telaPresa()) manterTelaAcesa();
  // Sair do app pausa a leitura: a câmera continuar rodando em segundo
  // plano gasta bateria e não serve para nada.
  if (document.hidden && running && !frozen) {
    frozen = true;
    els.retomar.hidden = false;
    els.capturar.hidden = true;
    els.stage.classList.add("paused");
  }
});

boot();
