/**
 * Worker de reconhecimento: recebe recortes da câmera, calcula os cinco
 * hashes perceptuais e busca no índice por distância de Hamming ponderada.
 *
 * Precisa ser bit-a-bit idêntico ao pipeline/build_hash_index.py — se a
 * conversão para cinza ou a ordem dos bits divergir, o índice inteiro vira
 * ruído. Os pontos sensíveis estão marcados abaixo.
 */

// Layout do index.bin que este leitor sabe ler. Precisa acompanhar
// VERSION em pipeline/export_web_index.py e FORMATO_DADOS em sw.js — os
// três são checados juntos por um teste de invariante.
const FORMATO = 1;

const FIELDS = 6; // phash, dhash, ahash, dhash_r, dhash_g, dhash_b
const WEIGHTS = [1.0, 1.0, 0.4, 0.4, 0.4, 0.4];
const MAX_DIST = WEIGHTS.reduce((a, b) => a + b, 0) * 64;

let index = null; // Uint32Array, 2 palavras por hash (little-endian)
let count = 0;

/** Popcount de 32 bits (Hacker's Delight). */
function popcount32(v) {
  v = v - ((v >>> 1) & 0x55555555);
  v = (v & 0x33333333) + ((v >>> 2) & 0x33333333);
  v = (v + (v >>> 4)) & 0x0f0f0f0f;
  return (v * 0x01010101) >>> 24;
}

/**
 * Cinza idêntico ao `Image.convert("L")` do Pillow: ITU-R 601-2 em ponto
 * fixo de 16 bits, com arredondamento (o `+ 0x8000` antes do shift).
 *
 *     L = (R*19595 + G*38470 + B*7471 + 32768) >> 16
 *
 * Usar /1000 e truncar parece equivalente e não é — a diferença de meio
 * nível chega a virar bits no dHash, que compara pixels vizinhos.
 */
function gray1(r, g, b) {
  return (r * 19595 + g * 38470 + b * 7471 + 32768) >>> 16;
}

function toGray(data, n) {
  const g = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    g[i] = gray1(data[o], data[o + 1], data[o + 2]);
  }
  return g;
}

/** DCT-II 2D por multiplicação de matriz, igual ao _dct2 do Python. */
function dct2(a, n) {
  const m = new Float64Array(n * n);
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++)
      m[i * n + j] = Math.cos((Math.PI * (2 * i + 1) * j) / (2 * n));

  const t = new Float64Array(n * n); // t = mᵀ · a
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += m[k * n + i] * a[k * n + j];
      t[i * n + j] = s;
    }
  const out = new Float64Array(n * n); // out = t · m
  for (let i = 0; i < n; i++)
    for (let j = 0; j < n; j++) {
      let s = 0;
      for (let k = 0; k < n; k++) s += t[i * n + k] * m[k * n + j];
      out[i * n + j] = s;
    }
  return out;
}

/**
 * Bits -> par [baixo, alto] de 32 bits, replicando `out = (out << 1) | b`
 * do Python: o primeiro bit acaba como o mais significativo e o valor fica
 * alinhado à direita. Vale para qualquer n <= 64 — o phash tem 63 bits
 * porque o termo DC é descartado.
 */
function bitsToWords(bits) {
  let hi = 0, lo = 0;
  for (let i = 0; i < bits.length; i++) {
    hi = ((hi << 1) | (lo >>> 31)) >>> 0;
    lo = ((lo << 1) | (bits[i] ? 1 : 0)) >>> 0;
  }
  return [lo, hi];
}

function median(arr) {
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function phash(px32) {
  const g = toGray(px32, 32 * 32);
  const d = dct2(g, 32);
  const flat = [];
  for (let i = 0; i < 8; i++)
    for (let j = 0; j < 8; j++) flat.push(d[i * 32 + j]);
  flat.shift(); // fora o termo DC: carrega brilho médio e domina a mediana
  const med = median(flat);
  return bitsToWords(flat.map((v) => v > med));
}

/** Gradiente horizontal sobre uma grade 9x8. `pick` escolhe o canal. */
function dhashFrom(px9x8, pick) {
  const bits = [];
  for (let y = 0; y < 8; y++)
    for (let x = 0; x < 8; x++) {
      const a = pick(px9x8, y * 9 + x);
      const b = pick(px9x8, y * 9 + x + 1);
      bits.push(b > a);
    }
  return bitsToWords(bits);
}

function ahash(px8) {
  const g = toGray(px8, 64);
  let sum = 0;
  for (let i = 0; i < 64; i++) sum += g[i];
  const mean = sum / 64;
  const bits = [];
  for (let i = 0; i < 64; i++) bits.push(g[i] > mean);
  return bitsToWords(bits);
}

const grayAt = (d, i) => gray1(d[i * 4], d[i * 4 + 1], d[i * 4 + 2]);

function computeHashes({ p32, p98, p8 }) {
  const gray = dhashFrom(p98, grayAt);
  return [
    phash(p32),
    gray,
    ahash(p8),
    dhashFrom(p98, (d, i) => d[i * 4]),
    dhashFrom(p98, (d, i) => d[i * 4 + 1]),
    dhashFrom(p98, (d, i) => d[i * 4 + 2]),
  ];
}

function search(query, k) {
  const best = [];
  for (let c = 0; c < count; c++) {
    const base = c * FIELDS * 2;
    let score = 0;
    for (let f = 0; f < FIELDS; f++) {
      const lo = index[base + f * 2] ^ query[f][0];
      const hi = index[base + f * 2 + 1] ^ query[f][1];
      score += (popcount32(lo) + popcount32(hi)) * WEIGHTS[f];
    }
    // Lista curta ordenada: mais barato que ordenar 30k candidatos por frame.
    if (best.length < k || score < best[best.length - 1].score) {
      const item = { i: c, score };
      let pos = best.length;
      while (pos > 0 && best[pos - 1].score > score) pos--;
      best.splice(pos, 0, item);
      if (best.length > k) best.pop();
    }
  }
  return best.map((b) => ({
    i: b.i,
    score: b.score,
    confidence: 1 - b.score / MAX_DIST,
  }));
}

self.onmessage = (ev) => {
  const msg = ev.data;
  if (msg.type === "load") {
    const view = new DataView(msg.buffer);
    const magic = String.fromCharCode(
      view.getUint8(0), view.getUint8(1), view.getUint8(2), view.getUint8(3)
    );
    if (magic !== "YTCG") {
      self.postMessage({ type: "error", message: "index.bin inválido" });
      return;
    }
    // A assinatura já era conferida; a VERSÃO não era, e é ela que pega o
    // caso perigoso. Assinatura certa com layout diferente não dá erro:
    // dá reconhecimento errado, silencioso, que parece "o leitor piorou".
    // Acontece de verdade quando o arquivo vem do cache offline e o código
    // já é novo. Melhor recusar e pedir recarga do que responder besteira.
    const versao = view.getUint16(4, true);
    if (versao !== FORMATO) {
      self.postMessage({
        type: "error",
        message: `índice em formato v${versao}, este leitor espera v${FORMATO} — recarregue a página`,
      });
      return;
    }
    count = view.getUint32(6, true);
    // Header de 16 bytes por alinhamento: Uint32Array exige byteOffset
    // múltiplo de 4, e os dados úteis começam logo depois.
    index = new Uint32Array(msg.buffer, 16, count * FIELDS * 2);
    self.postMessage({ type: "ready", count });
    return;
  }
  // Diagnóstico: quantos bits cada hash diverge do que está no índice.
  // Um número agregado de confiança não diz QUAL etapa do porte quebrou.
  if (msg.type === "diag") {
    const q = computeHashes(msg);
    const base = msg.row * FIELDS * 2;
    self.postMessage({
      type: "diag",
      perField: q.map((h, f) => {
        const lo = index[base + f * 2] ^ h[0];
        const hi = index[base + f * 2 + 1] ^ h[1];
        return popcount32(lo) + popcount32(hi);
      }),
    });
    return;
  }
  if (msg.type === "match") {
    if (!index) return;
    const t0 = performance.now();
    const results = search(computeHashes(msg), msg.k || 3);
    self.postMessage({
      type: "result",
      results,
      ms: performance.now() - t0,
      seq: msg.seq,
    });
  }
};
