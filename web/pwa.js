/**
 * Registra o service worker.
 *
 * Silencioso de propósito: falhar em registrar não pode atrapalhar o uso,
 * e em `file://` ou HTTP puro o navegador nem permite. O app funciona sem
 * ele — só perde o modo offline.
 */
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}
