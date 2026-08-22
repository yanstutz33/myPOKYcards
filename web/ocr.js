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
export const GEOMETRIAS = [
  { rx: 0.150, ry: 0.034, rw: 0.62, rh: 0.062 },
  { rx: 0.080, ry: 0.088, rw: 0.84, rh: 0.075 },
];

/* O número impresso, no rodapé.
 *
 * Vale mais que o nome em população: resolve os 5.158 grupos de impressões
 * irmãs, que cobrem 11.423 cartas — onde o app hoje diz "confira o número
 * você mesmo" porque nenhum algoritmo de imagem separa arte idêntica.
 *
 * A primeira tentativa deu 0 de 15 e eu quase descartei o caminho. O erro foi
 * o mesmo do nome: não olhei o que estava entregando ao motor. Ao renderizar
 * a tira, "136/189" e "125/197" estavam nítidos — o problema era como a
 * leitura era pedida.
 *
 * Duas mudanças levaram de 0/15 para 4/5:
 *
 *   LISTA BRANCA de dígitos e barra. Sem ela o motor lê "1" como "|" ou "l",
 *   e o padrão numérico nunca casa.
 *
 *   MODO 11 (texto esparso) em vez de 7 (uma linha). A faixa do rodapé tem
 *   símbolo de energia, marca de regulação, o número, um losango de raridade
 *   e o copyright. Forçar tudo numa linha produzia "2020" — o ano do
 *   copyright — em vez do número.
 *
 * E DUAS GEOMETRIAS, porque existem dois rodapés
 * ----------------------------------------------
 * Aqueles 4/5 eram todos de cartas modernas, e foi por isso que o resultado
 * pareceu bom. A Pokémon mudou o rodapé em Sun & Moon (2017): antes o número
 * fica na ponta DIREITA, de SM em diante na ESQUERDA. Eu tinha só a
 * geometria da esquerda — o recorte não continha o número nas eras antigas.
 * O motor estava certo, a mira estava errada.
 *
 * Ambas foram conferidas OLHANDO o recorte, não deduzidas: 13 cartas de
 * base1 a xy1 na direita e 11 de sm1 a sv08 na esquerda, Pokémon e Trainer,
 * números de uma a três casas. 24 de 24 legíveis dentro da caixa.
 *
 * A caixa da direita é mais alta (0,092 contra 0,055) porque a altura do
 * número varia entre eras — em ecard e ex ele sobe, em dp, pl e hgss desce.
 * Uma faixa estreita bem centrada numa era corta o número da vizinha: foi o
 * que vi na primeira tentativa, com dp, pl e hgss cortados pela metade.
 *
 * Ordem: esquerda primeiro. O que as pessoas escaneiam é em maioria moderno,
 * e a primeira tentativa que acerta encerra a busca.
 */
export const GEOMETRIAS_NUMERO = [
  { rx: 0.04, ry: 0.925, rw: 0.42, rh: 0.055 },   // Sun & Moon -> hoje
  { rx: 0.68, ry: 0.898, rw: 0.32, rh: 0.092 },   // Base Set -> XY
];

// Exige a barra. É ela que separa o número da carta de qualquer outro dígito
// no rodapé — ano de copyright, dano de ataque, custo de recuo. Nenhum deles
// tem barra, e por isso o padrão sozinho já filtra quase todo falso positivo.
const PADRAO_NUMERO = /(\d{1,3})\s*\/\s*(\d{1,3})/;

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

/* GEOMETRIAS, GEOMETRIAS_NUMERO e `tira` sao exportados para a bancada
 * (web/teste-ocr.html), nao para o app.
 *
 * A bancada tinha COPIAS destas constantes, com valores diferentes dos do
 * modulo — a caixa da direita la era `rh: 0.052`, a faixa estreita que eu
 * medi cortando o numero de dp, pl e hgss pela metade. Bancada que
 * reimplementa o que deveria medir nao produz evidencia sobre o app: ela
 * mede a copia. Importando daqui, as duas nao tem como divergir.
 */
/**
 * Recorta a faixa do nome, amplia e normaliza contraste.
 *
 * O contraste é esticado entre o percentil 5 e 95 porque o brilho do holo
 * come as duas pontas da escala e deixa o texto sem separação do fundo. A
 * inversão existe porque metade das cartas tem nome claro sobre arte escura,
 * e OCR de documento espera o contrário.
 */
export function tira(fonte, geo, inverter, escala = 4) {
  const w = fonte.width || fonte.naturalWidth;
  const h = fonte.height || fonte.naturalHeight;
  const ESCALA = escala;
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
 * Lê o número impresso, ou null.
 *
 * Devolve `{ numero, total }` — "136" e "189" de "136/189".
 *
 * Antes eu devolvia só o numerador, argumentando que exigir o denominador
 * transformaria um erro de leitura num descarte. O argumento estava certo
 * sobre EXIGIR e errado sobre devolver: quem chama pode usar o total como
 * desempate adicional sem nunca torná-lo obrigatório. O denominador é o
 * tamanho impresso do set, e `card_count` do catálogo é exatamente esse
 * número — conferido em base1=102, xy1=146, sm1=149, sv01=198. Entre duas
 * impressões irmãs de sets diferentes, ele diz qual é sem ambiguidade.
 *
 * `fonte` deve ser a carta JÁ DESENTORTADA e recortada.
 */
export async function lerNumero(fonte) {
  if (!pronto()) await preparar();
  await motor.setParameters({
    tessedit_pageseg_mode: "11",
    tessedit_char_whitelist: "0123456789/",
  });
  let achado = null;
  try {
    // Duas geometrias x duas polaridades.
    //
    // A inversão entrou depois de renderizar o que o motor recebe. Em
    // swsh1-200 o número sai BRANCO sobre fundo escuro, ao contrário de
    // base1 e xy1, onde é preto sobre claro. `lerNome` já tentava as duas
    // desde sempre; `lerNumero` não, e essa era metade das cartas modernas
    // holo saindo sem leitura.
    //
    // Custa até quatro passadas, mas para na primeira que casa — e a ordem
    // (esquerda normal primeiro) é a que resolve a maioria do que se escaneia.
    for (const geo of GEOMETRIAS_NUMERO) {
      for (const inverter of [false, true]) {
        const cv = tira(fonte, geo, inverter, 6);
        const t = (await motor.recognize(cv)).data.text.replace(/\s+/g, " ").trim();
        const m = t.match(PADRAO_NUMERO);
        if (!m) continue;

        // "032" e "32" sao o mesmo numero; o catalogo guarda com zeros.
        const numero = m[1].replace(/^0+(?=\d)/, "");
        const total = m[2].replace(/^0+(?=\d)/, "");

        // Numero muito maior que o total e leitura corrompida, nao carta
        // secreta: secreta imprime "199/198", so um pouco acima. Aceito ate
        // o dobro para nao derrubar as secretas de verdade, e recuso o resto
        // — "1/102" lido como "71/102" ainda passa, mas "802/102" nao.
        if (!Number(total) || Number(numero) > Number(total) * 2) continue;

        achado = { numero, total };
        break;
      }
      if (achado) break;
    }
  } catch { /* segue sem numero */ }
  // Devolve o motor ao modo do nome: parametros sao globais no worker, e
  // deixar a lista branca ligada faria a proxima leitura de nome so ver
  // digitos.
  await motor.setParameters({ tessedit_pageseg_mode: "7", tessedit_char_whitelist: "" });
  return achado;
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
