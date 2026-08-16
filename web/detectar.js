/**
 * Encontra a borda da carta dentro do quadro.
 *
 * Por que isto existe
 * -------------------
 * A versão anterior recortava exatamente a moldura desenhada na tela e
 * exigia que a pessoa encaixasse a carta com precisão. Não funciona na mão:
 * errar o enquadramento em 10–15% já destrói o match, porque o hash é da
 * carta INTEIRA — sobra de fundo entra no hash como se fosse arte.
 *
 * Aqui a moldura vira só uma sugestão de onde olhar. O recorte real sai da
 * borda detectada.
 *
 * Como
 * ----
 * Carta sobre qualquer fundo produz uma quebra forte de luminância nas
 * quatro bordas. Projetando a energia de gradiente nos eixos X e Y, essas
 * quebras viram picos, e o par de picos mais externo que ainda respeita a
 * proporção de carta (63×88mm) é a borda.
 *
 * Projeção em vez de detecção de contorno completa porque roda a cada
 * ~450 ms num celular: é O(n) sobre uma imagem de 160px, não busca de
 * componentes conexos.
 */

const RAZAO_CARTA = 63 / 88;     // 0.716
const TOLERANCIA_RAZAO = 0.28;   // aceita de ~0,52 a ~0,92
const LARGURA_ANALISE = 160;

let _ctx = null;
function contexto(w, h) {
  if (!_ctx) {
    _ctx = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  }
  if (_ctx.canvas.width !== w || _ctx.canvas.height !== h) {
    _ctx.canvas.width = w;
    _ctx.canvas.height = h;
  }
  return _ctx;
}

/** Perfil de energia de gradiente somada por coluna e por linha. */
function perfis(dados, w, h) {
  const cinza = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    cinza[i] = (dados[o] * 19595 + dados[o + 1] * 38470 + dados[o + 2] * 7471) >>> 16;
  }
  const col = new Float32Array(w);
  const lin = new Float32Array(h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      col[x] += Math.abs(cinza[i + 1] - cinza[i - 1]);
      lin[y] += Math.abs(cinza[i + w] - cinza[i - w]);
    }
  }
  return { col, lin };
}

/**
 * Par de picos mais externo acima do limiar.
 *
 * Mais externo, e não mais alto: a borda da carta costuma ser menos
 * contrastada que detalhes internos da arte, e pegar o pico mais alto
 * recortaria dentro da ilustração.
 */
function bordas(perfil, minimoRelativo = 0.45) {
  const n = perfil.length;
  let pico = 0;
  for (let i = 0; i < n; i++) if (perfil[i] > pico) pico = perfil[i];
  if (pico <= 0) return null;
  const limiar = pico * minimoRelativo;

  let a = -1, b = -1;
  for (let i = 0; i < n; i++) if (perfil[i] >= limiar) { a = i; break; }
  for (let i = n - 1; i >= 0; i--) if (perfil[i] >= limiar) { b = i; break; }
  return a >= 0 && b > a ? [a, b] : null;
}

/**
 * Procura a carta dentro de `busca` (retângulo em coordenadas do vídeo).
 *
 * Devolve `{x, y, w, h, confianca}` ou `null`. A confiança é o quanto a
 * proporção encontrada bate com a de uma carta — é ela que decide se vale
 * usar a detecção ou cair de volta na moldura.
 */
export function detectarCarta(video, busca) {
  const escala = LARGURA_ANALISE / busca.w;
  const w = LARGURA_ANALISE;
  const h = Math.max(8, Math.round(busca.h * escala));

  const ctx = contexto(w, h);
  ctx.drawImage(video, busca.x, busca.y, busca.w, busca.h, 0, 0, w, h);
  const { col, lin } = perfis(ctx.getImageData(0, 0, w, h).data, w, h);

  const bx = bordas(col);
  const by = bordas(lin);
  if (!bx || !by) return null;

  const larg = (bx[1] - bx[0]) / escala;
  const alt = (by[1] - by[0]) / escala;
  if (larg < busca.w * 0.25 || alt < busca.h * 0.25) return null;

  const razao = larg / alt;
  const erro = Math.abs(razao - RAZAO_CARTA) / RAZAO_CARTA;
  if (erro > TOLERANCIA_RAZAO) return null;

  return {
    x: Math.round(busca.x + bx[0] / escala),
    y: Math.round(busca.y + by[0] / escala),
    w: Math.round(larg),
    h: Math.round(alt),
    confianca: 1 - erro / TOLERANCIA_RAZAO,
  };
}

/**
 * Retângulo de busca: a moldura, alargada.
 *
 * A folga existe porque a carta quase nunca cabe exata na moldura — a
 * pessoa segura mais perto ou mais longe. Sem alargar, uma carta um pouco
 * maior que a moldura teria as bordas fora da região analisada e a
 * detecção falharia justamente quando mais precisa funcionar.
 */
export function regiaoDeBusca(moldura, video, folga = 0.22) {
  const dx = moldura.w * folga;
  const dy = moldura.h * folga;
  const x = Math.max(0, Math.round(moldura.x - dx));
  const y = Math.max(0, Math.round(moldura.y - dy));
  return {
    x, y,
    w: Math.min(video.videoWidth - x, Math.round(moldura.w + dx * 2)),
    h: Math.min(video.videoHeight - y, Math.round(moldura.h + dy * 2)),
  };
}
