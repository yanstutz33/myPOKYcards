/**
 * Sons do aparelho — sintetizados, não gravados.
 *
 * Por que sintetizar
 * ------------------
 * Os sons da Pokédex de jogo ou anime são obra protegida. O vocabulário
 * sonoro de aparelho eletrônico dos anos 90 — onda quadrada, bipe curto,
 * varredura de frequência confirmando ação — não é de ninguém. Sintetizar
 * dá o mesmo efeito, é honesto e custa zero byte de download.
 *
 * Regras que vêm de uso real
 * --------------------------
 * Quem usa isso vai ler dezenas de cartas seguidas numa loja. Então:
 *
 *   - Nada toca sem transição de estado. Bipe a cada 450 ms de leitura
 *     seria insuportável em dois minutos.
 *   - Tudo é curto (< 250 ms) e discreto.
 *   - O usuário desliga com um toque, e a escolha é lembrada.
 *   - Nada toca antes do primeiro gesto: além de ser política do navegador,
 *     som inesperado ao abrir um site é agressivo.
 */

const CHAVE = "yami-tcg:som:v1";

let ctx = null;
let ligado = localStorage.getItem(CHAVE) !== "0";

/** O contexto só nasce no primeiro gesto — antes disso o navegador barra. */
function contexto() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
  }
  if (ctx.state === "suspended") ctx.resume();
  return ctx;
}

export function estaLigado() {
  return ligado;
}

export function alternar() {
  ligado = !ligado;
  localStorage.setItem(CHAVE, ligado ? "1" : "0");
  if (ligado) toque([[660, 0.05], [990, 0.07]]);
  return ligado;
}

/**
 * Uma nota.
 *
 * Envelope com ataque de 4 ms e decaimento exponencial: sem ele o corte
 * seco do oscilador estala. `square` para o timbre de aparelho; `sine` para
 * o que precisa soar macio.
 */
function nota(freq, dur, { tipo = "square", vol = 0.06, atraso = 0, deslize = 0 } = {}) {
  const c = contexto();
  if (!c) return;
  const t0 = c.currentTime + atraso;

  const osc = c.createOscillator();
  const g = c.createGain();
  osc.type = tipo;
  osc.frequency.setValueAtTime(freq, t0);
  if (deslize) osc.frequency.exponentialRampToValueAtTime(Math.max(40, deslize), t0 + dur);

  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);

  osc.connect(g).connect(c.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.02);
}

/** Sequência de [frequência, duração], tocada em cadeia. */
function toque(notas, opcoes = {}) {
  if (!ligado) return;
  let t = 0;
  for (const [f, d] of notas) {
    nota(f, d, { ...opcoes, atraso: t });
    t += d * 0.85;
  }
}

// ---------------------------------------------------------------- eventos

/** Borda encontrada: bipe único e baixo. Só na transição. */
export const somDetectou = () => toque([[1180, 0.045]], { vol: 0.035 });

/** Reconhecida: duas notas subindo — o gesto sonoro universal de "achei". */
export const somReconheceu = () => toque([[784, 0.07], [1175, 0.11]], { vol: 0.07 });

/** Captura manual: clique seco mais varredura curta, como obturador. */
export function somCapturou() {
  if (!ligado) return;
  nota(2200, 0.03, { tipo: "square", vol: 0.05 });
  nota(880, 0.12, { tipo: "sine", vol: 0.06, atraso: 0.03, deslize: 440 });
}

/** Guardada na coleção: três notas subindo, confirmação clara. */
export const somGuardou = () => toque([[659, 0.06], [880, 0.06], [1319, 0.12]], { vol: 0.06 });

/** Problema: duas notas descendo, grave. Não é alarme, é ressalva. */
export const somAlerta = () => toque([[392, 0.09], [294, 0.13]], { tipo: "sine", vol: 0.05 });

/** Ligar: varredura subindo, como aparelho acordando. */
export function somLigou() {
  if (!ligado) return;
  nota(220, 0.28, { tipo: "square", vol: 0.045, deslize: 1320 });
  nota(1319, 0.1, { tipo: "sine", vol: 0.05, atraso: 0.26 });
}

/** Desligar: o mesmo ao contrário. */
export const somDesligou = () => {
  if (!ligado) return;
  nota(1100, 0.26, { tipo: "square", vol: 0.04, deslize: 180 });
};

/** Toque em botão físico. */
export const somClique = () => toque([[1500, 0.022]], { vol: 0.03 });
