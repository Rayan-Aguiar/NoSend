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

window.scenarios = {
  fetchGet: () => outcome(fetch(SINK + '/users?page=2&q=a%20b')),
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
