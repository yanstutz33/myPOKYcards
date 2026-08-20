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

/* As duas versões são SEPARADAS de propósito — e essa é a correção mais
 * importante deste arquivo.
 *
 * `VERSAO` é carimbada pelo deploy com o hash do commit, para que código
 * novo nunca seja servido de um cache velho. Enquanto o cache de DADOS
 * usava a mesma constante, todo deploy renomeava os dois, o `activate`
 * apagava o que não batia, e o aparelho rebaixava 2,5 MB de índice.
 *
 * O detalhe que transformava isso em custo diário: o robô de preço publica
 * TODO DIA. Ou seja, todo dia o usuário rebaixava `index.bin` (1,39 MB) e
 * `cards.json` — arquivos que praticamente nunca mudam — para receber a
 * atualização de `prices.json`. Exatamente o oposto do que o comentário
 * lá em cima diz que a estratégia faz.
 *
 * `FORMATO_DADOS` muda na mão, só quando o LAYOUT dos arquivos muda, e é
 * amarrado ao `VERSION` de `export_web_index.py` por um teste de
 * invariante — cache velho com formato novo é bug silencioso, o tipo caro.
 *
 * A frescura do dado não depende dessa versão: o `fetch` abaixo responde do
 * cache e revalida pela rede, então preço novo entra na abertura seguinte. */
const VERSAO = "v1";
const FORMATO_DADOS = "1";

const CACHE_APP = `poky-app-${VERSAO}`;
const CACHE_DADOS = `poky-dados-${FORMATO_DADOS}`;

const ESSENCIAIS = [
  "./", "./index.html", "./style.css", "./tema.css", "./scan.css",
  "./app.js", "./capture.js", "./detectar.js", "./camera.js",
  "./tema.js", "./colecao.js", "./som.js", "./ficha.js", "./mercado.js", "./ocr.js", "./etapas.js",
  "./matcher.worker.js",
  "./colecao.html", "./colecao-tela.js",
  "./buscar.html", "./buscar.js", "./busca-tela.js",
  "./painel.html", "./painel.js", "./painel.css",
  "./sobre.html", "./sobre.js", "./sobre.css",
  "./pokedex.css", "./pwa.js",
  // O ícone maskable é o que o Android usa na tela de início. Faltava aqui:
  // instalar o app sem sinal deixava o atalho sem ícone próprio.
  "./manifest.json", "./icone.svg", "./icone-maskable.svg",
];

/**
 * Instalação: uma GERAÇÃO inteira, buscada da rede, ou nenhuma.
 *
 * O defeito que isto conserta apareceu no aparelho do usuário como painel
 * quebrado — conteúdo empurrado para fora da caixa, metade da tela vazia. Não
 * era CSS errado: era CSS de uma versão desenhando o HTML de outra.
 *
 * Como acontecia: `cache.add()` usa o cache HTTP do navegador. O GitHub Pages
 * serve os arquivos com `max-age=600`, então logo depois de publicar o
 * navegador ainda tem a versão anterior guardada. O service worker novo
 * instalava, montava um cache com nome novo (o hash do commit) e o enchia com
 * uma MISTURA: os arquivos que já tinham expirado vinham novos, os que não,
 * vinham velhos. Nome de geração nova, conteúdo de duas gerações.
 *
 * `cache: "reload"` obriga cada busca a ignorar o cache HTTP. E se qualquer
 * arquivo essencial falhar, a instalação inteira falha: o service worker
 * antigo continua no ar, coerente consigo mesmo. Meia atualização é pior que
 * atualização nenhuma, porque nenhum dos dois lados funciona.
 */
self.addEventListener("install", (ev) => {
  ev.waitUntil((async () => {
    const c = await caches.open(CACHE_APP);
    await Promise.all(ESSENCIAIS.map(async (u) => {
      const r = await fetch(new Request(u, { cache: "reload" }));
      if (!r.ok) throw new Error(`essencial faltando: ${u} (${r.status})`);
      // A chave é a URL limpa, para o `match` do fetch encontrar.
      await c.put(u, r);
    }));
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

  // Código do app: SÓ do cache desta geração, sem revalidar por arquivo.
  //
  // A estratégia anterior era stale-while-revalidate: respondia do cache e
  // atualizava por baixo, arquivo a arquivo. Para código isso é errado, e foi
  // a segunda metade do mesmo bug: cada arquivo se atualizava no seu próprio
  // ritmo, então uma abertura qualquer podia pegar app.js novo com
  // pokedex.css velho. Não existe "meio atualizado" que funcione — HTML, CSS
  // e JS mudam juntos ou não mudam.
  //
  // Como CACHE_APP carrega o hash do commit e nasce completo na instalação,
  // responder só dele garante que tudo na tela veio da mesma geração. A
  // troca acontece de uma vez, quando o service worker novo assume.
  ev.respondWith((async () => {
    const cache = await caches.open(CACHE_APP);
    const salvo = await cache.match(req, { ignoreSearch: true });
    if (salvo) return salvo;
    const rede = await fetch(req).catch(() => null);
    if (rede?.ok) cache.put(req, rede.clone());
    return rede || new Response("", { status: 504 });
  })());
});
