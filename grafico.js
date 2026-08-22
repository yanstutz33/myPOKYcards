/**
 * O preço ao longo do tempo, na ficha.
 *
 * Por que existe
 * --------------
 * O robô coleta preço todo dia desde 2026-08-15 e nada disso aparecia. A
 * interface mostrava sempre o valor de HOJE, e a pergunta que qualquer pessoa
 * faz com uma carta na mão — "isso está subindo ou caindo?" — ficava sem
 * resposta.
 *
 * É o único dado deste projeto que não se copia. Catálogo e cotação do dia
 * qualquer um busca na fonte; série histórica só quem começou antes tem.
 *
 * SVG à mão, sem biblioteca
 * -------------------------
 * Uma biblioteca de gráfico custa de 50 KB a 300 KB para desenhar de cinco a
 * trinta pontos. O caminho aqui é uma string de coordenadas — o custo é uma
 * função de vinte linhas, e o app continua abrindo em segundos.
 *
 * O que ele se recusa a fazer
 * ---------------------------
 * Não desenha linha com menos de três pontos. Dois pontos viram sempre uma
 * reta ascendente ou descendente, e isso lê como tendência quando é só o
 * intervalo entre duas medições.
 *
 * Não emenda buracos. Dia sem cotação vira interrupção visível, não um
 * segmento reto passando por cima — a linha reta afirmaria que o preço andou
 * suavemente entre os dois extremos, o que ninguém mediu.
 *
 * Não mistura mercados. Cada série é uma variante de um mercado, na moeda
 * dele. Somar cardmarket em euro com tcgplayer em dólar seria o erro clássico
 * de agregador que este projeto evita desde o primeiro dia.
 */

const SIMBOLO = { USD: "US$", EUR: "€", BRL: "R$", JPY: "¥" };

let dados = null;
let carregando = null;

/** Baixa a série uma vez e guarda. Chamadas simultâneas compartilham. */
export function carregar() {
  if (dados) return Promise.resolve(dados);
  if (carregando) return carregando;
  carregando = fetch("data/historico.json")
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => { dados = d; return d; })
    .catch(() => null);
  return carregando;
}

const esc = (s) => String(s).replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

/** Quebra a série em trechos contínuos, pulando os dias sem cotação. */
function trechos(valores) {
  const saida = [];
  let atual = [];
  valores.forEach((v, i) => {
    if (v === null || v === undefined) {
      if (atual.length) saida.push(atual);
      atual = [];
    } else {
      atual.push([i, v]);
    }
  });
  if (atual.length) saida.push(atual);
  return saida;
}

function caminho(pontos, escalaX, escalaY) {
  return pontos.map(([i, v], k) =>
    `${k ? "L" : "M"}${escalaX(i).toFixed(1)} ${escalaY(v).toFixed(1)}`).join(" ");
}

/**
 * Um gráfico por série.
 *
 * `dia` no eixo horizontal é posição, não data: os pontos são igualmente
 * espaçados mesmo quando o passado está reduzido a semanal. Espaçar por tempo
 * real comprimiria os trinta dias recentes num canto e daria ao passado
 * grosseiro o espaço que ele não merece.
 */
function umGrafico(chave, valores, dias, moeda) {
  const L = 240, A = 64, pad = 4;
  const presentes = valores.filter((v) => v !== null && v !== undefined);
  if (presentes.length < 2) return "";

  const min = Math.min(...presentes);
  const max = Math.max(...presentes);
  const faixa = max - min || Math.max(max * 0.1, 0.01);
  const escalaX = (i) => pad + (i / Math.max(1, valores.length - 1)) * (L - pad * 2);
  const escalaY = (v) => A - pad - ((v - min) / faixa) * (A - pad * 2);

  const partes = trechos(valores);
  const linhas = partes
    .filter((p) => p.length >= 2)
    .map((p) => `<path d="${caminho(p, escalaX, escalaY)}" fill="none"
        stroke="var(--tipo, #2C6FC9)" stroke-width="2"
        stroke-linejoin="round" stroke-linecap="round"/>`).join("");

  // Ponto solto — trecho de um dia só entre buracos — vira círculo. Sem isso
  // ele simplesmente não apareceria, e o dia medido some da tela.
  const soltos = partes
    .filter((p) => p.length === 1)
    .map(([[i, v]]) => `<circle cx="${escalaX(i).toFixed(1)}" cy="${escalaY(v).toFixed(1)}"
        r="2.5" fill="var(--tipo, #2C6FC9)"/>`).join("");

  const ultimo = valores.findLast?.((v) => v !== null && v !== undefined)
    ?? presentes[presentes.length - 1];
  const primeiro = presentes[0];
  const varia = primeiro ? ((ultimo - primeiro) / primeiro) * 100 : 0;
  const s = SIMBOLO[moeda] || moeda;
  const [variante, fonte] = chave.split("|");

  return `<figure class="gr">
    <figcaption class="gr-topo">
      <span class="gr-quem">${esc(variante)} · ${esc(fonte)}</span>
      <span class="gr-var ${varia >= 0 ? "sobe" : "cai"}">${
        varia >= 0 ? "+" : ""}${varia.toFixed(1)}%</span>
    </figcaption>
    <svg viewBox="0 0 ${L} ${A}" class="gr-svg" role="img"
         aria-label="Preço de ${esc(variante)} em ${esc(fonte)} ao longo de ${dias.length} dias">
      ${linhas}${soltos}
    </svg>
    <figcaption class="gr-pe">
      <span>${s} ${min.toFixed(2)}</span>
      <span class="gr-dias">${dias.length} dias</span>
      <span>${s} ${max.toFixed(2)}</span>
    </figcaption>
  </figure>`;
}

/**
 * Bloco pronto para a ficha, ou string vazia.
 *
 * Vazio quando não há série: carta nova no catálogo, carta sem cotação, ou
 * simplesmente um dia só de coleta. Bloco vazio com título "Preço ao longo do
 * tempo" seria pior que bloco nenhum — anuncia informação que não existe.
 */
export function blocoHtml(cardId) {
  if (!dados?.series) return "";
  const series = dados.series[cardId];
  if (!series) return "";

  const graficos = Object.entries(series)
    .map(([chave, valores]) => umGrafico(chave, valores, dados.dias, dados.moedas?.[chave] || ""))
    .filter(Boolean)
    .join("");
  if (!graficos) return "";

  const n = dados.dias.length;
  return `<section class="ficha-bloco">
    <h3>Preço ao longo do tempo</h3>
    ${graficos}
    <p class="ficha-nota">${n < 14
      ? `São só <strong>${n} dias</strong> de coleta — dá para ver o que mudou
         de ontem para hoje, não tendência. A série cresce sozinha a cada dia.`
      : `Coleta diária desde ${esc(dados.dias[0])}. Antes dos últimos 30 dias
         os pontos são semanais.`}
      Valores de venda concluída, na moeda de cada mercado.</p>
  </section>`;
}
