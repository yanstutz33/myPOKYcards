/**
 * Registra o service worker.
 *
 * NÃO registra em localhost. O cache serve código velho depois de cada
 * alteração, e o sintoma é cruel: a página carrega, parece atual, e roda a
 * versão anterior. Isso já custou três depurações perseguindo erros que já
 * estavam corrigidos no disco. Em desenvolvimento o offline não serve para
 * nada; em produção é o que faz o app funcionar dentro da loja.
 *
 * `?nosw` também desliga, para depurar o site publicado.
 */
const local = ["localhost", "127.0.0.1", "[::1]"].includes(location.hostname);
const desligado = new URLSearchParams(location.search).has("nosw");

if ("serviceWorker" in navigator && !local && !desligado) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
} else if ("serviceWorker" in navigator) {
  // Limpa o que uma sessão anterior possa ter deixado registrado.
  navigator.serviceWorker.getRegistrations()
    .then((rs) => rs.forEach((r) => r.unregister()))
    .catch(() => {});
  if (window.caches) caches.keys().then((ns) => ns.forEach((n) => caches.delete(n)));
}


/* ------------------------------------------------------------------ instalar
 *
 * Instalar deixou de ser conveniencia quando a colecao passou a viver no
 * `localStorage`: o Safari do iPhone apaga o armazenamento de sites NAO
 * INSTALADOS depois de sete dias sem uso. A tela da colecao ja dizia isso —
 * e nao oferecia botao nenhum, so a instrucao.
 *
 * `beforeinstallprompt` existe no Chrome e no Edge. O navegador dispara
 * quando julga o site instalavel, e o evento so pode ser usado UMA vez,
 * dentro de um gesto do usuario. Por isso ele e guardado, nao consumido na
 * hora.
 *
 * No iPhone o evento nao existe e nao ha API de instalacao. La a unica saida
 * e a instrucao escrita, que a caixa da colecao ja mostra. Fingir um botao
 * que nao instala nada seria pior que a instrucao.
 */
let convite = null;

window.addEventListener("beforeinstallprompt", (ev) => {
  ev.preventDefault();          // sem isso o Chrome mostra a barra dele
  convite = ev;
  document.documentElement.classList.add("pode-instalar");
});

window.addEventListener("appinstalled", () => {
  convite = null;
  document.documentElement.classList.remove("pode-instalar");
});

/** true se instalou, false se recusou, null se nao ha convite guardado. */
export async function instalar() {
  if (!convite) return null;
  convite.prompt();
  const { outcome } = await convite.userChoice;
  // O evento e de uso unico: guardar depois de usado deixaria um botao que
  // nao faz nada na segunda vez.
  convite = null;
  document.documentElement.classList.remove("pode-instalar");
  return outcome === "accepted";
}

export const podeInstalar = () => convite !== null;
