/**
 * Controle de câmera: foco, lanterna e leitura de condição de luz.
 *
 * Por que isto existe
 * -------------------
 * Carta holográfica espelha. Sob luz de teto, o reflexo apaga parte da arte
 * e nenhum ajuste de limiar no matcher resolve — o dado que chega já está
 * destruído. Antes de mexer em algoritmo, vale mexer na luz.
 *
 * O que dá para controlar varia MUITO por aparelho e navegador. Tudo aqui é
 * "tenta e segue": um recurso ausente nunca pode quebrar a leitura.
 */

/** Constraints de foco pedidas na abertura. Ignoradas se não suportadas. */
export const RESTRICOES_VIDEO = {
  facingMode: { ideal: "environment" },
  // Resolução alta ajuda o recorte, mas pedir 4K faz o navegador entregar
  // quadros lentos. 1920 é o meio-termo em que o texto da carta ainda
  // sobrevive à redução.
  width: { ideal: 1920 },
  height: { ideal: 1080 },
  // Carta fica a ~15 cm: foco contínuo evita a imagem "respirando".
  focusMode: { ideal: "continuous" },
};

export function faixa(track, nome) {
  const cap = track?.getCapabilities?.();
  return cap && nome in cap ? cap[nome] : null;
}

export function temLanterna(track) {
  return Boolean(faixa(track, "torch"));
}

/**
 * Liga/desliga a lanterna.
 *
 * `advanced` porque é assim que a especificação expõe recursos opcionais.
 * Funciona no Chrome Android; o Safari do iPhone não implementa `torch`,
 * então a interface só mostra o botão quando o aparelho declara o recurso.
 */
export async function definirLanterna(track, ligada) {
  try {
    await track.applyConstraints({ advanced: [{ torch: ligada }] });
    return true;
  } catch {
    return false;
  }
}

/** Toque para focar, quando o aparelho permite ponto de interesse. */
export async function focarEm(track, xRel, yRel) {
  try {
    await track.applyConstraints({
      advanced: [{
        focusMode: "single-shot",
        pointsOfInterest: [{ x: xRel, y: yRel }],
      }],
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Diagnóstico de luz a partir dos pixels já reduzidos.
 *
 * Reaproveita a redução 32x32 que o matcher faz de qualquer jeito — medir
 * luz num quadro cheio custaria mais que a própria leitura.
 *
 * `estourado` conta pixels perto do branco puro: é assim que o reflexo de
 * foil aparece. `escuro` é o oposto. Os dois destroem o hash, e por motivos
 * diferentes, então a mensagem para o usuário precisa ser diferente.
 */
export function condicaoDeLuz(px32) {
  const n = px32.length / 4;
  let soma = 0, claros = 0, escuros = 0;
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    const l = (px32[o] * 19595 + px32[o + 1] * 38470 + px32[o + 2] * 7471) >>> 16;
    soma += l;
    if (l >= 250) claros++;
    else if (l <= 12) escuros++;
  }
  const media = soma / n;
  return {
    media,
    fracaoEstourada: claros / n,
    fracaoEscura: escuros / n,
    // Limiares folgados de propósito: o objetivo é avisar quando está
    // claramente ruim, não reclamar de toda foto imperfeita.
    estourado: claros / n > 0.12,
    escuro: media < 45,
  };
}
