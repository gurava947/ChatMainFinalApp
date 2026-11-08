/* InChat notification worker. The server may wake this worker with a Push API payload. */
self.addEventListener('push', (event) => {
  let payload = {};
  try { payload = event.data ? event.data.json() : {}; } catch { payload = { body: event.data?.text() || 'You have a new message.' }; }
  const title = typeof payload.title === 'string' ? payload.title : 'New message';
  const options = {
    body: typeof payload.body === 'string' ? payload.body : 'You have a new message.',
    icon: '/inchat-logo.png',
    badge: '/inchat-logo.png',
    tag: typeof payload.tag === 'string' ? payload.tag : undefined,
    data: { url: typeof payload.url === 'string' ? payload.url : '/' },
    renotify: false
  };
  event.waitUntil(self.registration.showNotification(title, options));
});
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const target = new URL(event.notification.data?.url || '/', self.location.origin).href;
  event.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((clients) => {
    const existing = clients.find((client) => client.url.startsWith(self.location.origin));
    if (existing) return existing.navigate(target).then(() => existing.focus());
    return self.clients.openWindow(target);
  }));
});
