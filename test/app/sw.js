// Service worker da app de teste: ao receber {sink}, faz fetch(sink + '/sw') e responde pela porta.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));
self.addEventListener('message', (e) => {
  const reply = (data) => (e.ports[0] ? e.ports[0].postMessage(data) : e.source && e.source.postMessage(data));
  e.waitUntil(
    fetch(e.data.sink + '/sw').then(
      (r) => reply({ kind: 'resolved', status: r.status }),
      (err) => reply({ kind: 'rejected', name: err && err.name, message: err && err.message }),
    ),
  );
});
