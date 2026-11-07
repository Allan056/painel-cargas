// Painel de Cargas — funciona sem internet depois de instalado
const VERSAO="painel-cargas-c0368c37c0";
const ARQUIVOS=["./","./index.html","./manifest.webmanifest","./icon-192.png","./icon-512.png","./icon-maskable-512.png","./apple-touch-icon.png","./favicon.png"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(VERSAO).then(c=>c.addAll(ARQUIVOS)));});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(ks=>Promise.all(ks.filter(k=>k!==VERSAO&&k!=="painel-fontes").map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener("message",e=>{if(e.data==="atualizar")self.skipWaiting();});
self.addEventListener("fetch",e=>{
  const req=e.request; if(req.method!=="GET") return;
  const url=new URL(req.url);
  if(url.hostname==="fonts.googleapis.com"||url.hostname==="fonts.gstatic.com"){
    e.respondWith(caches.open("painel-fontes").then(async c=>{const hit=await c.match(req);const net=fetch(req).then(r=>{if(r&&(r.ok||r.type==="opaque"))c.put(req,r.clone());return r;}).catch(()=>hit);return hit||net;}));
    return;
  }
  if(url.origin!==self.location.origin) return;
  if(req.mode==="navigate"){ e.respondWith(caches.match("./index.html").then(hit=>hit||fetch(req))); return; }
  e.respondWith(caches.match(req,{ignoreSearch:true}).then(hit=>hit||fetch(req)));
});
