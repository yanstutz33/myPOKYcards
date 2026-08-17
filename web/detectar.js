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

/* ------------------------------------------------------------- inclinação
 *
 * Projetar em X e Y só acha carta reta. Carta na mão nunca está reta, e o
 * custo não é estético: o recorte alinhado aos eixos de uma carta torta
 * inclui triângulos de fundo nos quatro cantos, e esse fundo entra no hash
 * como se fosse arte. O autoteste já media a perda — 2,5° de rotação derruba
 * a confiança média de ~99% para 89,7%, a pior das sete degradações junto
 * com recorte.
 *
 * A busca é sobre o MESMO mecanismo, só que em eixos girados: para cada
 * ângulo candidato, projeta a energia de gradiente nos eixos daquele ângulo
 * e mede o quanto a proporção encontrada bate com a de uma carta.
 *
 * O objetivo é só o erro de proporção, sem termo de nitidez somado por
 * intuição, porque isso é ajustável sem medir e vira número mágico. O
 * ângulo certo é o que enxerga um retângulo 63×88; num ângulo errado a
 * caixa envolvente de uma carta girada é puxada na direção do quadrado.
 *
 * Grosso e depois fino, para não pagar 40 passadas: ~2,9° cobrindo ±17°,
 * depois ~0,7° em volta do melhor.
 */
const ANGULO_MAX = 0.30;        // ±17°; além disso a pessoa está virando o celular
const PASSO_GROSSO = 0.05;      // ~2,9°
const PASSO_FINO = 0.012;       // ~0,7°

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

/**
 * Componentes do gradiente, calculadas UMA vez.
 *
 * A busca de ângulo reprojeta esta mesma gradiente dezenas de vezes; refazer
 * a diferença central a cada ângulo multiplicaria o custo sem mudar nada.
 */
function gradientes(dados, w, h) {
  const cinza = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    cinza[i] = (dados[o] * 19595 + dados[o + 1] * 38470 + dados[o + 2] * 7471) >>> 16;
  }
  const gx = new Float32Array(w * h);
  const gy = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      gx[i] = cinza[i + 1] - cinza[i - 1];
      gy[i] = cinza[i + w] - cinza[i - w];
    }
  }
  return { gx, gy };
}

/**
 * Projeta a gradiente nos eixos girados de `ang`.
 *
 * Só a COMPONENTE perpendicular a cada eixo entra no seu perfil. Somar o
 * módulo inteiro faria a borda de cima aparecer no perfil das laterais e
 * borraria justamente o pico que se quer achar.
 */
function perfisEm(gx, gy, w, h, ang) {
  const c = Math.cos(ang), s = Math.sin(ang);
  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  for (const [x, y] of [[0, 0], [w, 0], [0, h], [w, h]]) {
    const u = x * c + y * s, v = -x * s + y * c;
    if (u < uMin) uMin = u; if (u > uMax) uMax = u;
    if (v < vMin) vMin = v; if (v > vMax) vMax = v;
  }
  const pu = new Float32Array(Math.ceil(uMax - uMin) + 2);
  const pv = new Float32Array(Math.ceil(vMax - vMin) + 2);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = gx[i], b = gy[i];
      pu[(x * c + y * s - uMin) | 0] += Math.abs(a * c + b * s);
      pv[(-x * s + y * c - vMin) | 0] += Math.abs(-a * s + b * c);
    }
  }
  return { pu, pv, uMin, vMin };
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
/**
 * Nitidez do pico de borda, em múltiplos da média do perfil.
 *
 * É o desempate físico entre ângulos, e existe por medição: com o erro de
 * proporção como único objetivo, a busca ia parar no LIMITE do intervalo
 * (16°–18° com limite de 17°) em 8 de 30 cenas de teste, inclusive para
 * cartas desenhadas retas. Proporção tem mínimos falsos — girar a caixa
 * envolvente muda largura e altura juntas, e algumas combinações erradas
 * caem por acaso em 0,716.
 *
 * A nitidez não tem esse problema porque não é um número ajustável: no
 * ângulo certo a borda da carta cai toda dentro de uma faixa e vira um
 * espeto; em qualquer outro ângulo ela se espalha por dezenas de faixas e o
 * pico achata. É a assinatura de uma reta estar alinhada com o eixo.
 */
function nitidez(perfil, b) {
  let soma = 0;
  for (let i = 0; i < perfil.length; i++) soma += perfil[i];
  const media = soma / perfil.length;
  if (media <= 0) return 0;
  return (perfil[b[0]] + perfil[b[1]]) / (2 * media);
}

/** Avalia um ângulo: limites achados, erro de proporção e nitidez. */
function avaliar(gx, gy, w, h, ang) {
  const { pu, pv, uMin, vMin } = perfisEm(gx, gy, w, h, ang);
  const bu = bordas(pu), bv = bordas(pv);
  if (!bu || !bv) return null;
  const larg = bu[1] - bu[0], alt = bv[1] - bv[0];
  if (larg <= 0 || alt <= 0) return null;
  return {
    ang,
    erro: Math.abs(larg / alt - RAZAO_CARTA) / RAZAO_CARTA,
    nitidez: nitidez(pu, bu) + nitidez(pv, bv),
    u0: bu[0] + uMin, u1: bu[1] + uMin,
    v0: bv[0] + vMin, v1: bv[1] + vMin,
    larg, alt,
  };
}

/**
 * Escolhe entre dois candidatos, em dois estágios e sem peso arbitrário.
 *
 * Primeiro a proporção decide quem é carta: quem estoura a tolerância está
 * fora, e entre dois que estouram vale o menos errado. Só entre os que já
 * PARECEM carta a nitidez decide qual ângulo é o de verdade. Somar os dois
 * numa nota única exigiria inventar um peso relativo, que é ajustável sem
 * medir nada — e foi o que este projeto evitou o tempo todo.
 */
function melhorQue(cand, atual) {
  if (!atual) return true;
  const candOk = cand.erro <= TOLERANCIA_RAZAO;
  const atualOk = atual.erro <= TOLERANCIA_RAZAO;
  if (candOk !== atualOk) return candOk;
  if (!candOk) return cand.erro < atual.erro;
  return cand.nitidez > atual.nitidez;
}

export function detectarCarta(video, busca) {
  const escala = LARGURA_ANALISE / busca.w;
  const w = LARGURA_ANALISE;
  const h = Math.max(8, Math.round(busca.h * escala));

  const ctx = contexto(w, h);
  ctx.drawImage(video, busca.x, busca.y, busca.w, busca.h, 0, 0, w, h);
  const { gx, gy } = gradientes(ctx.getImageData(0, 0, w, h).data, w, h);

  let melhor = null;
  const tentar = (ang) => {
    const r = avaliar(gx, gy, w, h, ang);
    if (r && melhorQue(r, melhor)) melhor = r;
  };
  for (let a = -ANGULO_MAX; a <= ANGULO_MAX + 1e-9; a += PASSO_GROSSO) tentar(a);
  if (!melhor) return null;
  const centro = melhor.ang;
  for (let a = centro - PASSO_GROSSO; a <= centro + PASSO_GROSSO + 1e-9; a += PASSO_FINO) {
    tentar(a);
  }

  const larg = melhor.larg / escala;
  const alt = melhor.alt / escala;
  if (larg < busca.w * 0.25 || alt < busca.h * 0.25) return null;
  if (melhor.erro > TOLERANCIA_RAZAO) return null;

  // Cantos no referencial girado -> volta para coordenadas de imagem.
  // De u = x·cos + y·sen e v = −x·sen + y·cos segue x = u·cos − v·sen e
  // y = u·sen + v·cos.
  const c = Math.cos(melhor.ang), s = Math.sin(melhor.ang);
  const quad = [
    [melhor.u0, melhor.v0], [melhor.u1, melhor.v0],
    [melhor.u1, melhor.v1], [melhor.u0, melhor.v1],
  ].map(([u, v]) => [
    busca.x + (u * c - v * s) / escala,
    busca.y + (u * s + v * c) / escala,
  ]);

  const cx = (quad[0][0] + quad[2][0]) / 2;
  const cy = (quad[0][1] + quad[2][1]) / 2;

  return {
    // Caixa alinhada aos eixos: o que o código antigo espera continua valendo.
    x: Math.round(Math.min(...quad.map((p) => p[0]))),
    y: Math.round(Math.min(...quad.map((p) => p[1]))),
    w: Math.round(Math.max(...quad.map((p) => p[0])) - Math.min(...quad.map((p) => p[0]))),
    h: Math.round(Math.max(...quad.map((p) => p[1])) - Math.min(...quad.map((p) => p[1]))),
    // O retângulo REAL da carta, que é o que o recorte deve usar.
    cx, cy, cw: larg, ch: alt, ang: melhor.ang, quad,
    confianca: 1 - melhor.erro / TOLERANCIA_RAZAO,
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
