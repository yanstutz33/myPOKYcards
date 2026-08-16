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
