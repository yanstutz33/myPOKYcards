/**
 * Ler o nome impresso na carta.
 *
 * Por que existe
 * --------------
 * O leitor identifica comparando hash de imagem contra um banco de imagens.
 * Isso é estruturalmente incapaz de reconhecer carta que não tem imagem de
 * referência — e são 1.278 internacionais, medidas. Ler o nome não depende de
 * imagem nenhuma: o catálogo já sabe o nome de todas as 41.694.
 *
 * Serve também para o problema que mais custou confiança neste app: o leitor
 * respondendo a carta errada com ar de certeza. Se o nome lido discorda do
 * palpite do hash, isso é informação — e aparece.
 *
 * Onde roda, e onde NÃO roda
 * --------------------------
 * Só no caminho da captura, que é o de análise pesada. São ~600 ms com quatro
 * passadas, contra 14 ms de uma leitura por hash. No laço ao vivo, que roda a
 * cada 450 ms enquanto a pessoa mira, seria inviável.
 *
 * O que ele NÃO faz
 * -----------------
 * Não lê japonês. Os dados de idioma são latinos, e das 11.411 cartas sem
 * imagem, 9.383 são asiáticas. Fingir que alcança essas seria pior que
 * admitir o limite.
 *
 * Não lê o número impresso. Foi tentado e medido: 0 de 15. O número está lá e
 * é legível a olho — "136/189" no rodapé — mas o motor não extrai nada útil
 * dele nesta resolução. Valeria mais que o nome em população (10.737 cartas
 * de impressões irmãs contra 1.278), e continua em aberto.
 *
 * Precisa de internet na primeira vez
 * -----------------------------------
 * O motor e os dados de idioma somam ~7 MB e vêm de CDN sob demanda. Embutir
 * isso no app quadruplicaria o tamanho de algo que hoje abre offline em
 * segundos, para um recurso que só entra quando o hash já falhou. O leitor
 * principal continua funcionando sem rede; o OCR é o que não.
 */

const CDN_TESSERACT = "https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js";

/* Duas geometrias, porque existem dois layouts.
 *
 * Medido: de 7 falhas numa amostra de 19, CINCO eram cartas Trainer. Em
 * Pokémon o nome fica no alto à esquerda, depois do selo de estágio; em
 * Trainer vem abaixo de uma faixa e ocupa a largura toda. Não dá para saber a
 * categoria antes de ler, então lê-se as duas e fica a de maior confiança.
 *
 * O recorte é APERTADO de propósito. A primeira versão pegava uma faixa larga
 * que incluía o selo "BASIC" e a linha "Evolves from"; as tiras saíam
 * perfeitamente legíveis para um humano e o motor lia uma de nove, porque
 * estava configurado para UMA linha e recebia três blocos. Apertar levou de
 * 1/9 para 6/9, e ainda ficou três vezes mais rápido.
 */
const GEOMETRIAS = [
  { rx: 0.150, ry: 0.034, rw: 0.62, rh: 0.062 },
  { rx: 0.080, ry: 0.088, rw: 0.84, rh: 0.075 },
];

const MIN_LETRAS = 4;

let motor = null;
let vocabulario = null;
let carregando = null;

export const normalizar = (s) => String(s).toLowerCase()
  .normalize("NFD").replace(/[̀-ͯ]/g, "")
  .replace(/[^a-z0-9 ]/g, " ").replace(/\s+/g, " ").trim();

function trigramas(s) {
  const t = ` ${s} `;
  const set = new Set();
  for (let i = 0; i < t.length - 2; i++) set.add(t.slice(i, i + 3));
  return set;
}

/**
 * Quanto do NOME procurado aparece no que foi lido.
 *
 * Medir igualdade entre as duas strings seria errado: o motor quase sempre
 * devolve o nome com sujeira em volta — "AerodactyIV À", "= Hoopa ON",
 * "CoalossalVr1xÃa". Dividindo pelo tamanho do nome procurado, a sujeira
 * deixa de ser penalidade e a pergunta vira a certa: está aí dentro?
 */
function contido(lido, nome) {
  if (!lido.size || !nome.size) return 0;
  let comum = 0;
  for (const g of nome) if (lido.has(g)) comum++;
  const nota = comum / nome.size;
  // Nome curto cabe em qualquer coisa; exige quase perfeição.
  return nome.size <= 6 && nota < 0.95 ? nota * 0.5 : nota;
}

function carregarScript(src) {
  return new Promise((ok, erro) => {
    const s = document.createElement("script");
    s.src = src;
    s.onload = ok;
    s.onerror = () => erro(new Error("não consegui baixar o leitor de texto"));
    document.head.appendChild(s);
  });
}

/** Prepara motor e vocabulário. Idempotente: chamadas simultâneas compartilham. */
export function preparar() {
  if (carregando) return carregando;
  carregando = (async () => {
    if (!window.Tesseract) await carregarScript(CDN_TESSERACT);
    const [m, v] = await Promise.all([
      window.Tesseract.createWorker("por", 1, { logger: () => {} }),
      fetch("data/nomes.json").then((r) => r.json()),
    ]);
    await m.setParameters({ tessedit_pageseg_mode: "7" });
    motor = m;
    vocabulario = new Map();
    for (const nome of Object.keys(v)) {
      if (nome.length >= MIN_LETRAS) vocabulario.set(nome, { tri: trigramas(nome), ids: v[nome] });
    }
    return true;
  })().catch((e) => { carregando = null; throw e; });
  return carregando;
}

export const pronto = () => Boolean(motor && vocabulario);

/**
 * Recorta a faixa do nome, amplia e normaliza contraste.
 *
 * O contraste é esticado entre o percentil 5 e 95 porque o brilho do holo
 * come as duas pontas da escala e deixa o texto sem separação do fundo. A
 * inversão existe porque metade das cartas tem nome claro sobre arte escura,
 * e OCR de documento espera o contrário.
 */
function tira(fonte, geo, inverter) {
  const w = fonte.width || fonte.naturalWidth;
  const h = fonte.height || fonte.naturalHeight;
  const ESCALA = 4;
  const cv = document.createElement("canvas");
  cv.width = Math.max(8, Math.round(w * geo.rw * ESCALA));
  cv.height = Math.max(8, Math.round(h * geo.rh * ESCALA));
  const g = cv.getContext("2d", { willReadFrequently: true });
  g.imageSmoothingQuality = "high";
  g.drawImage(fonte, w * geo.rx, h * geo.ry, w * geo.rw, h * geo.rh, 0, 0, cv.width, cv.height);

  const d = g.getImageData(0, 0, cv.width, cv.height);
  const p = d.data;
  const hist = new Uint32Array(256);
  for (let i = 0; i < p.length; i += 4) {
    const v = (p[i] * 299 + p[i + 1] * 587 + p[i + 2] * 114) / 1000 | 0;
    p[i] = p[i + 1] = p[i + 2] = v;
    hist[v]++;
  }
  const total = p.length / 4;
  let acc = 0, lo = 0, hi = 255;
  for (let v = 0; v < 256; v++) { acc += hist[v]; if (acc > total * 0.05) { lo = v; break; } }
  acc = 0;
  for (let v = 255; v >= 0; v--) { acc += hist[v]; if (acc > total * 0.05) { hi = v; break; } }
  const faixa = Math.max(1, hi - lo);
  for (let i = 0; i < p.length; i += 4) {
    let v = Math.max(0, Math.min(255, Math.round((p[i] - lo) * 255 / faixa)));
    if (inverter) v = 255 - v;
    p[i] = p[i + 1] = p[i + 2] = v;
  }
  g.putImageData(d, 0, 0);
  return cv;
}

/**
 * Lê o nome e devolve os card_id compatíveis, do mais provável ao menos.
 *
 * `fonte` deve ser a carta JÁ DESENTORTADA e recortada — a mesma imagem que
 * alimenta o hash. Passar o quadro inteiro daria ao motor a mesa, a mão e o
 * texto de ataque para competir com as duas palavras que interessam.
 */
export async function lerNome(fonte) {
  if (!pronto()) await preparar();

  let texto = "";
  let confianca = -1;
  for (const geo of GEOMETRIAS) {
    for (const inverter of [false, true]) {
      const r = await motor.recognize(tira(fonte, geo, inverter));
      const t = (r.data.text || "").trim();
      if (t.length >= 3 && r.data.confidence > confianca) {
        confianca = r.data.confidence;
        texto = t;
      }
    }
  }

  const lido = normalizar(texto);
  if (lido.length < 3) return { texto, candidatos: [], nota: 0 };

  // Entre nomes igualmente contidos, vence o MAIS LONGO.
  //
  // Contencao satura: "charizard" cabe inteiro dentro de "Charizardex" e tira
  // nota 1,0, enquanto "charizard ex" precisa tambem dos trigramas do sufixo
  // e tira menos. Medido — "Charizard ex" foi lido certo e casou com o
  // Charizard comum, que e outra carta e outro preco.
  //
  // O nome mais longo que ainda cabe e o mais especifico, e especificidade e
  // exatamente o que distingue "Charizard" de "Charizard ex".
  const tl = trigramas(lido);
  let melhorNota = 0;
  let melhorIds = [];
  let melhorNome = "";
  for (const [nome, v] of vocabulario) {
    const nota = contido(tl, v.tri);
    if (nota < melhorNota - 0.08) continue;
    const ganha = nota > melhorNota + 0.08
      || (Math.abs(nota - melhorNota) <= 0.08 && nome.length > melhorNome.length);
    if (ganha) { melhorNota = Math.max(nota, melhorNota); melhorIds = v.ids; melhorNome = nome; }
  }

  // Abaixo disto a leitura não sustenta nenhuma afirmação. O valor vem da
  // bancada: acertos legítimos ficaram acima de 0,7 e o ruído, abaixo.
  if (melhorNota < 0.7) return { texto, candidatos: [], nota: melhorNota };
  return { texto, nome: melhorNome, nota: melhorNota, candidatos: melhorIds };
}
