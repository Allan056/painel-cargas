// Painel de Cargas: o app instalável foi aposentado.
// Este service worker limpa o cache antigo, se desinstala e recarrega as telas abertas no aviso com o link do site novo.
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => {
  e.waitUntil((async () => {
    const ks = await caches.keys();
    await Promise.all(ks.map((k) => caches.delete(k)));
    await self.registration.unregister();
    const cs = await self.clients.matchAll({ type: "window" });
    cs.forEach((c) => c.navigate(c.url));
  })());
});
