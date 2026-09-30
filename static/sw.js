// Service worker: lets Chrome install the app. Everything still comes straight from the
// server (no caching), so paintings, the timer and updates are always current. The only
// thing kept is a small page shown when there's no connection.
const OFFLINE = 'offline-v1';

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(OFFLINE).then((c) => c.put('offline', new Response(
    '<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">'
    + '<title>Offline</title><body style="font-family:system-ui,sans-serif;background:#f4f1ec;color:#22201c;'
    + 'display:grid;place-items:center;min-height:90vh;text-align:center;padding:20px">'
    + '<div><h2>You’re offline</h2><p>The Floating Frame Calculator needs a connection to your server.</p>'
    + '<button onclick="location.reload()" style="font:inherit;padding:8px 16px">Try again</button></div>',
    { headers: { 'Content-Type': 'text/html; charset=utf-8' } },
  ))));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys()
    .then((keys) => Promise.all(keys.filter((k) => k !== OFFLINE).map((k) => caches.delete(k))))
    .then(() => self.clients.claim()));
});

self.addEventListener('fetch', (event) => {
  if (event.request.mode !== 'navigate') return; // everything else: the browser as normal
  event.respondWith(fetch(event.request).catch(async () => (await caches.open(OFFLINE)).match('offline')));
});
