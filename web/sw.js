/**
 * Service worker — o leitor precisa funcionar dentro da loja, sem sinal.
 *
 * Duas estratégias, porque os dois tipos de arquivo têm exigências opostas:
 *
 *   APP (html, css, js)  — stale-while-revalidate. Abre instantâneo do
 *     cache e atualiza por baixo. Uma versão velha por alguns segundos é
 *     melhor que tela branca esperando a rede.
 *
 *   DADOS (index.bin, cards.json, prices.json) — cache-first com
 *     atualização em segundo plano. São 7 MB: baixar de novo a cada abertura
 *     torraria a franquia e a paciência. O índice de reconhecimento quase
 *     nunca muda; o preço muda todo dia, e um dia de atraso é aceitável
 *     porque a interface exibe a idade da cotação.
 *
 * Nada de cachear a arte das cartas: ela vem do CDN de origem e não é nossa
 * para guardar.
 */

const VERSAO = "v1";
const CACHE_APP = `yami-app-${VERSAO}`;
const CACHE_DADOS = `yami-dados-${VERSAO}`;

const ESSENCIAIS = [
  "./", "./index.html", "./style.css", "./tema.css", "./scan.css",
  "./app.js", "./capture.js", "./detectar.js", "./camera.js",
  "./tema.js", "./colecao.js", "./som.js", "./matcher.worker.js",
  "./colecao.html", "./colecao-tela.js",
  "./painel.html", "./painel.js", "./painel.css",
  "./sobre.html", "./sobre.js", "./sobre.css",
  "./pokedex.css", "./scan.css", "./pwa.js",
  "./manifest.json", "./icone.svg",
];

self.addEventListener("install", (ev) => {
  ev.waitUntil((async () => {
    const c = await caches.open(CACHE_APP);
    // addAll falha inteiro se um arquivo faltar; individual é mais tolerante
    // a um arquivo renomeado do que deixar a instalação toda sem cache.
    await Promise.all(ESSENCIAIS.map((u) => c.add(u).catch(() => {})));
    await self.skipWaiting();
  })());
});

self.addEventListener("activate", (ev) => {
  ev.waitUntil((async () => {
    const nomes = await caches.keys();
    await Promise.all(nomes
      .filter((n) => n !== CACHE_APP && n !== CACHE_DADOS)
      .map((n) => caches.delete(n)));
    await self.clients.claim();
  })());
});

const ehDado = (url) => url.pathname.includes("/data/");

self.addEventListener("fetch", (ev) => {
  const req = ev.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  // Só o próprio site. A arte das cartas vem do CDN de origem e fica lá.
  if (url.origin !== self.location.origin) return;

  if (ehDado(url)) {
    ev.respondWith((async () => {
      const cache = await caches.open(CACHE_DADOS);
      const salvo = await cache.match(req);
      const rede = fetch(req).then((r) => {
        if (r.ok) cache.put(req, r.clone());
        return r;
      }).catch(() => null);
      // Cache primeiro; a rede atualiza para a próxima abertura.
      return salvo || (await rede) || new Response("", { status: 504 });
    })());
    return;
  }

  ev.respondWith((async () => {
    const cache = await caches.open(CACHE_APP);
    const salvo = await cache.match(req);
    const rede = fetch(req).then((r) => {
      if (r.ok) cache.put(req, r.clone());
      return r;
    }).catch(() => null);
    return salvo || (await rede) || new Response("", { status: 504 });
  })());
});
