// Dedicated Worker da app de teste: faz fetch ao sink e devolve o Outcome.
self.onmessage = async (e) => {
  try {
    const r = await fetch(e.data.sink + '/worker');
    postMessage({ kind: 'resolved', status: r.status });
  } catch (err) {
    postMessage({ kind: 'rejected', name: err && err.name, message: err && err.message });
  }
};
