const CACHE="vibereading-shell-v1";
const SHELL=["/web/index.html","/web/app.js","/web/manifest.webmanifest"];
self.addEventListener("install",e=>{e.waitUntil(caches.open(CACHE).then(c=>c.addAll(SHELL)));self.skipWaiting()});
self.addEventListener("activate",e=>{e.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k!==CACHE).map(k=>caches.delete(k)))));self.clients.claim()});
self.addEventListener("fetch",e=>{
  const u=new URL(e.request.url);
  if(e.request.method!=="GET"||u.pathname.startsWith("/api/"))return;
  e.respondWith(caches.match(e.request).then(cached=>cached||fetch(e.request).then(r=>{
    if(r.ok&&u.origin===self.location.origin)caches.open(CACHE).then(c=>c.put(e.request,r.clone()));
    return r;
  })));
});
