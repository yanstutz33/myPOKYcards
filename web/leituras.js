/**
 * Histórico de leituras: o que passou pela câmera, guardado ou não.
 *
 * Quem abre um lote lê trinta cartas e guarda cinco. As outras vinte e
 * cinco sumiam no "Ler outra" — e a pergunta "qual era aquela de US$ 40 que
 * eu li antes?" não tinha resposta sem ler de novo.
 *
 * Mesma carta lida em sequência vira UMA linha com contador, em vez de
 * cinco linhas iguais: quem tem quatro cópias na mão lê as quatro, e a
 * lista tem que mostrar "×4", não esconder o resto embaixo de repetição.
 * "Em sequência" é dentro de 10 minutos — depois disso é outra sessão, e
 * juntar mentiria sobre quando foi lida.
 *
 * Fica no aparelho, como a coleção. Teto de 300 entradas: é histórico de
 * conveniência, não registro permanente, e localStorage tem cota.
 */

const CHAVE = "mypokycards:leituras:v1";
const TETO = 300;
const JANELA_MS = 10 * 60 * 1000;

export function ler() {
  try {
    const v = JSON.parse(localStorage.getItem(CHAVE) || "[]");
    return Array.isArray(v) ? v : [];
  } catch { return []; }
}

function gravar(lista) {
  try { localStorage.setItem(CHAVE, JSON.stringify(lista.slice(0, TETO))); return true; }
  catch { return false; }
}

/** Registra uma leitura travada. Nunca lança: histórico não pode derrubar o leitor. */
export function registrar(cardId, manual = false) {
  if (!cardId) return;
  const lista = ler();
  const agora = Date.now();
  const topo = lista[0];
  if (topo && topo.card_id === cardId && agora - Date.parse(topo.em) < JANELA_MS) {
    topo.n += 1;
    topo.em = new Date(agora).toISOString();
  } else {
    lista.unshift({ card_id: cardId, n: 1, em: new Date(agora).toISOString(),
                    ...(manual ? { manual: true } : {}) });
  }
  gravar(lista);
}

export function limpar() {
  try { localStorage.removeItem(CHAVE); } catch { /* nada a fazer */ }
}

/** "há 3 min", "há 2 h", "ontem", "12/10" — o que a pessoa lê de relance. */
export function quando(iso) {
  const ms = Date.now() - Date.parse(iso);
  const min = Math.round(ms / 60000);
  if (min < 1) return "agora";
  if (min < 60) return `há ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `há ${h} h`;
  if (h < 48) return "ontem";
  return iso.slice(0, 10).split("-").reverse().slice(0, 2).join("/");
}
