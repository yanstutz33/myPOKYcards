/**
 * As etapas do processamento, enquanto ele acontece.
 *
 * Por que existe
 * --------------
 * A captura deixou de ser instantânea. Hoje ela recorta cinco escalas, compara
 * cada uma contra 31 mil cartas, e quando o hash não resolve ainda lê o nome
 * impresso e o número — o que pode passar de dois segundos. Na primeira vez o
 * motor de texto baixa ~7 MB antes de qualquer coisa.
 *
 * Sem retorno, isso não lê como "trabalhando": lê como travado. E este app já
 * levou "não está funcionando" de um usuário quando na verdade estava
 * pensando.
 *
 * O que ele NÃO faz, de propósito
 * -------------------------------
 * Não mostra lista fixa de etapas. O concorrente que motivou isto exibe quatro
 * passos sempre iguais — "Processando imagem / Analisando os detalhes e
 * núcleos / Pesquisando registros globais / Obtendo sua estimativa de valor" —
 * independentemente do que acontece por baixo. Isso é teatro: dois deles não
 * correspondem a nada que dê para verificar.
 *
 * Aqui cada etapa é anunciada quando começa de verdade e riscada quando
 * termina de verdade. Leitura de texto só aparece quando o hash falhou;
 * número só aparece quando há impressões irmãs para desempatar. Quem lê a tela
 * fica sabendo o que o aparelho está fazendo — que é a única coisa que uma
 * tela de espera honesta pode oferecer.
 *
 * Não tem barra de porcentagem. Nenhuma dessas etapas tem duração previsível:
 * depende da carta, da rede e de o motor já estar carregado. Barra que anda
 * sozinha até 90% e para é a versão visual da mesma mentira.
 */

let raiz = null;
let lista = null;
const abertas = new Map();

function garantir() {
  if (!raiz) {
    raiz = document.getElementById("etapas");
    lista = document.getElementById("etapasLista");
  }
  return Boolean(raiz && lista);
}

/** Começa uma sessão de processamento; apaga o que sobrou da anterior. */
export function iniciar() {
  if (!garantir()) return;
  abertas.clear();
  lista.innerHTML = "";
  raiz.hidden = false;
}

/**
 * Anuncia uma etapa que COMEÇOU agora.
 *
 * A chave permite concluir depois sem depender da ordem — importante porque
 * algumas etapas rodam em paralelo e a de texto pode terminar depois de uma
 * que começou mais tarde.
 */
export function comecar(chave, texto) {
  if (!garantir()) return;
  if (abertas.has(chave)) return;
  const li = document.createElement("li");
  li.className = "etapa fazendo";
  li.textContent = texto;
  lista.appendChild(li);
  abertas.set(chave, li);
}

/** Marca uma etapa como concluída. `nota` acrescenta o que foi descoberto. */
export function concluir(chave, nota = "") {
  const li = abertas.get(chave);
  if (!li) return;
  li.className = "etapa feita";
  if (nota) li.textContent += ` — ${nota}`;
}

/** Marca uma etapa que não deu certo. Falhar em silêncio seria pior. */
export function falhar(chave, motivo = "") {
  const li = abertas.get(chave);
  if (!li) return;
  li.className = "etapa falhou";
  if (motivo) li.textContent += ` — ${motivo}`;
}

/**
 * Fecha a sessão.
 *
 * O atraso existe para a última etapa não sumir no mesmo quadro em que é
 * marcada: sem ele a pessoa vê a lista piscar e não consegue ler nada. Meio
 * segundo é o suficiente para registrar e curto o bastante para não atrasar a
 * leitura do resultado, que é o que ela quer.
 */
export function terminar(ms = 500) {
  if (!garantir()) return;
  setTimeout(() => {
    raiz.hidden = true;
    lista.innerHTML = "";
    abertas.clear();
  }, ms);
}
