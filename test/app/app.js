// Cenários da aplicação de teste. Cada cenário retorna um Outcome:
//   { kind: 'resolved', status } | { kind: 'rejected', name, message }
//   | { kind: 'events', events } | { kind: 'returned', value }
// A URL do sink vem de ?sink=http://127.0.0.1:PORT
const SINK = new URLSearchParams(location.search).get('sink') || '';
window.SINK = SINK;

async function outcome(promise) {
  try {
    const r = await promise;
    return { kind: 'resolved', status: r.status };
  } catch (e) {
    return { kind: 'rejected', name: e && e.name, message: e && e.message };
  }
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

// Código do worker dedicado, pré-carregado por prepareWorker (com o interceptor OFF),
// porque com ON o próprio worker.js (origem da app) também é bloqueado.
let workerUrl = null;

window.scenarios = {
  fetchGet: () => outcome(fetch(SINK + '/users?page=2&q=a%20b')),

  // ---- Task 4: requisições que só o DNR vê ----
  formSubmit: async () => {
    const frame = document.createElement('iframe');
    frame.name = 'ni-form-target';
    frame.style.display = 'none';
    document.body.appendChild(frame);
    const form = document.createElement('form');
    form.method = 'POST';
    form.action = SINK + '/form';
    form.target = 'ni-form-target';
    form.style.display = 'none';
    for (const [name, value] of [['user', 'alice'], ['password', 's3cr3t']]) {
      const input = document.createElement('input');
      input.name = name;
      input.value = value;
      form.appendChild(input);
    }
    document.body.appendChild(form);
    form.submit();
    await delay(1000);
    return { kind: 'returned', value: 'submitted' };
  },

  imgTag: () => new Promise((resolve) => {
    const img = new Image();
    const done = (type) => resolve({ kind: 'events', events: [type] });
    img.onload = () => done('load');
    img.onerror = () => done('error');
    img.src = SINK + '/img.png';
    document.body.appendChild(img);
  }),

  /** Rodar com o interceptor OFF: carrega worker.js para uso posterior com ON. */
  prepareWorker: async () => {
    const src = await (await fetch('worker.js')).text();
    workerUrl = URL.createObjectURL(new Blob([src], { type: 'text/javascript' }));
    return { kind: 'returned', value: 'prepared' };
  },

  workerFetch: () => new Promise((resolve) => {
    const w = new Worker(workerUrl || 'worker.js');
    w.onmessage = (e) => { w.terminate(); resolve(e.data); };
    w.onerror = (e) => { w.terminate(); resolve({ kind: 'rejected', name: 'WorkerError', message: e.message }); };
    w.postMessage({ sink: SINK });
  }),

  /** Rodar com o interceptor OFF: o script do SW vem da origem da app. */
  registerSw: async () => {
    const reg = await navigator.serviceWorker.register('sw.js', { scope: './' });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller) {
      await new Promise((r) => navigator.serviceWorker.addEventListener('controllerchange', r, { once: true }));
    }
    return { kind: 'returned', value: reg.active ? reg.active.state : 'none' };
  },

  serviceWorkerFetch: async () => {
    const reg = await navigator.serviceWorker.ready;
    const sw = navigator.serviceWorker.controller || reg.active;
    return new Promise((resolve) => {
      const ch = new MessageChannel();
      ch.port1.onmessage = (e) => resolve(e.data);
      sw.postMessage({ sink: SINK }, [ch.port2]);
    });
  },

  iframeSrc: () => new Promise((resolve) => {
    const frame = document.createElement('iframe');
    frame.onload = () => resolve({ kind: 'events', events: ['load'] });
    frame.src = SINK + '/frame';
    document.body.appendChild(frame);
  }),

  topNavigation: () => {
    window.open(SINK + '/top');
    return { kind: 'returned', value: 'opened' };
  },
};

// UI manual: um botão por cenário.
document.getElementById('sink').textContent = SINK || '(defina ?sink=)';
const buttons = document.getElementById('buttons');
const out = document.getElementById('out');
for (const name of Object.keys(window.scenarios)) {
  const b = document.createElement('button');
  b.textContent = name;
  b.onclick = async () => {
    out.textContent = name + ': ...';
    const r = await window.scenarios[name]();
    out.textContent = name + ': ' + JSON.stringify(r, null, 2);
  };
  buttons.appendChild(b);
}
