// Service worker do painel: recebe os avisos (push) e guarda o "esqueleto" do painel (página, manifesto, ícones)
// só como reserva: busca na rede primeiro e, se ela falhar ou demorar mais de 2 s, abre a cópia guardada.
// Os dados (/api) nunca passam por este cache.
const SHELL = 'painel-shell-v1';
self.addEventListener('fetch', (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== 'GET' || url.origin !== self.location.origin || url.pathname.startsWith('/api/')) return;
  event.respondWith((async () => {
    const cache = await caches.open(SHELL);
    const network = fetch(event.request).then((response) => {
      if (response.ok) cache.put(event.request, response.clone()).catch(() => {});
      return response;
    });
    const cached = await cache.match(event.request);
    if (!cached) return network;
    const late = new Promise((resolve) => setTimeout(() => resolve(cached), 2000));
    return Promise.race([network.catch(() => cached), late]);
  })());
});
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (event) => event.waitUntil(self.clients.claim()));

self.addEventListener('push', (event) => {
  let data = {};
  try { data = event.data ? event.data.json() : {}; } catch { data = { body: event.data ? event.data.text() : '' }; }
  event.waitUntil(self.registration.showNotification(data.title || 'Laboratório de agentes', {
    body: data.body || '', tag: data.tag, renotify: Boolean(data.tag),
    icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { url: data.url || '/' }
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const same = windows.find((w) => w.url === url);
    if (same) return same.focus();
    return self.clients.openWindow(url);
  })());
});
