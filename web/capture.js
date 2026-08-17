/**
 * Redução de imagem compatível com o pipeline Python.
 *
 * Compartilhado entre a tela de scan e o autoteste — se as duas reduzissem
 * de formas diferentes, o autoteste passaria e o app falharia.
 *
 * Por que reamostrar à mão em vez de usar `drawImage`:
 *
 *   O índice foi gerado com `Image.resize(..., LANCZOS)` do Pillow. O
 *   `drawImage` do canvas usa um filtro próprio, não especificado, e para
 *   reduções extremas amostra pouquíssimos pixels. Medido: o dHash, que
 *   compara pixels VIZINHOS numa grade 9x8, divergia ~10 bits de 64 —
 *   ruído gratuito exatamente no hash mais sensível. Reduzir pela metade
 *   em etapas melhorava pouco.
 *
 *   Este módulo replica o reamostrador do Pillow: filtro separável, suporte
 *   escalado pela razão de redução, pesos normalizados, arredondamento e
 *   clamp em 8 bits. Com isso a divergência cai para ruído de ponto
 *   flutuante.
 *
 * Também compõe sobre branco antes de reduzir: o Pillow achata PNG com alfa
 * sobre branco, e o canvas deixaria transparente virar preto na leitura.
 */

const SUPPORT = 3.0; // LANCZOS a=3, igual ao Pillow

function lanczos(x) {
  if (x === 0) return 1;
  const a = Math.abs(x);
  if (a >= SUPPORT) return 0;
  const px = Math.PI * x;
  return (SUPPORT * Math.sin(px) * Math.sin(px / SUPPORT)) / (px * px);
}

/**
 * Coeficientes de uma dimensão, no mesmo esquema do Pillow:
 * centro em (i + 0.5) * escala, suporte alargado quando há redução.
 */
function coeffs(inSize, outSize) {
  const scale = inSize / outSize;
  const filterScale = Math.max(1, scale);
  const support = SUPPORT * filterScale;
  const rows = [];

  for (let i = 0; i < outSize; i++) {
    const center = (i + 0.5) * scale;
    let xmin = Math.max(0, Math.floor(center - support));
    let xmax = Math.min(inSize, Math.ceil(center + support));
    const w = new Float64Array(xmax - xmin);
    let sum = 0;
    for (let x = xmin; x < xmax; x++) {
      const v = lanczos((x + 0.5 - center) / filterScale);
      w[x - xmin] = v;
      sum += v;
    }
    if (sum !== 0) for (let k = 0; k < w.length; k++) w[k] /= sum;
    rows.push({ xmin, w });
  }
  return rows;
}

/** Passo horizontal: (inW x inH) RGBA -> (outW x inH) float RGB. */
function horizontal(src, inW, inH, outW) {
  const cs = coeffs(inW, outW);
  const out = new Float64Array(outW * inH * 3);
  for (let y = 0; y < inH; y++) {
    const rowIn = y * inW * 4;
    const rowOut = y * outW * 3;
    for (let i = 0; i < outW; i++) {
      const { xmin, w } = cs[i];
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < w.length; k++) {
        const o = rowIn + (xmin + k) * 4;
        const c = w[k];
        r += src[o] * c;
        g += src[o + 1] * c;
        b += src[o + 2] * c;
      }
      const o = rowOut + i * 3;
      out[o] = r; out[o + 1] = g; out[o + 2] = b;
    }
  }
  return out;
}

/** Passo vertical + empacotamento em RGBA de 8 bits. */
function vertical(src, w, inH, outH) {
  const cs = coeffs(inH, outH);
  const out = new Uint8ClampedArray(w * outH * 4);
  for (let j = 0; j < outH; j++) {
    const { xmin, w: coef } = cs[j];
    for (let x = 0; x < w; x++) {
      let r = 0, g = 0, b = 0;
      for (let k = 0; k < coef.length; k++) {
        const o = ((xmin + k) * w + x) * 3;
        const c = coef[k];
        r += src[o] * c;
        g += src[o + 1] * c;
        b += src[o + 2] * c;
      }
      const o = (j * w + x) * 4;
      // Pillow arredonda e satura em 8 bits antes de qualquer hash.
      out[o] = Math.round(r);
      out[o + 1] = Math.round(g);
      out[o + 2] = Math.round(b);
      out[o + 3] = 255;
    }
  }
  return out;
}

let _srcCtx = null;

function contextoDe(sw, sh) {
  if (!_srcCtx) {
    _srcCtx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  }
  if (_srcCtx.canvas.width !== sw || _srcCtx.canvas.height !== sh) {
    _srcCtx.canvas.width = sw;
    _srcCtx.canvas.height = sh;
  }
  // Fundo branco: sobra de borda vira papel, não buraco preto, que seria uma
  // aresta forte inventada bem onde o dHash compara vizinhos.
  _srcCtx.fillStyle = "#fff";
  _srcCtx.fillRect(0, 0, sw, sh);
  return _srcCtx;
}

/**
 * Recorta a carta DESENTORTADA quando o detector devolveu ângulo.
 *
 * Sem isto, carta inclinada é recortada numa caixa alinhada aos eixos e os
 * quatro cantos da caixa são fundo — mesa, mão, outra carta. Esse fundo entra
 * no hash como se fosse arte, e o hash é da carta INTEIRA: não há como o
 * matcher separar "arte" de "sobra". É a mesma perda que o autoteste já media
 * na degradação de rotação.
 *
 * A rotação é feita pelo próprio canvas, com a transformação inversa: leva o
 * centro da carta à origem, desgira, e desenha. O resultado é a carta reta e
 * sozinha no quadro.
 */
function sourcePixels(source, rect) {
  if (rect && typeof rect.ang === "number" && Math.abs(rect.ang) > 0.004) {
    const sw = Math.max(2, Math.round(rect.cw));
    const sh = Math.max(2, Math.round(rect.ch));
    const ctx = contextoDe(sw, sh);
    ctx.save();
    ctx.translate(sw / 2, sh / 2);
    ctx.rotate(-rect.ang);
    ctx.translate(-rect.cx, -rect.cy);
    ctx.drawImage(source, 0, 0);
    ctx.restore();
    return { data: ctx.getImageData(0, 0, sw, sh).data, w: sw, h: sh };
  }

  const sx = rect ? rect.x : 0;
  const sy = rect ? rect.y : 0;
  const sw = rect ? rect.w : (source.videoWidth || source.naturalWidth || source.width);
  const sh = rect ? rect.h : (source.videoHeight || source.naturalHeight || source.height);
  const ctx = contextoDe(sw, sh);
  ctx.drawImage(source, sx, sy, sw, sh, 0, 0, sw, sh);
  return { data: ctx.getImageData(0, 0, sw, sh).data, w: sw, h: sh };
}

/** Reduz para w x h com LANCZOS e devolve RGBA de 8 bits. */
export function reduce(px, w, h) {
  return vertical(horizontal(px.data, px.w, px.h, w), w, px.h, h);
}

/** As três escalas que o matcher consome, na ordem esperada pelo worker. */
export function capture(source, rect) {
  const px = sourcePixels(source, rect);
  return {
    p32: reduce(px, 32, 32),
    p98: reduce(px, 9, 8),
    p8: reduce(px, 8, 8),
  };
}
