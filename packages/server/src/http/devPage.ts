// DEV TEST PAGE — replaced by the real SPA in F4
export const DEV_PAGE_HTML: string = `<!doctype html>
<!-- DEV TEST PAGE — replaced by the real SPA in F4 -->
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>zuse — DEV TEST PAGE</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: monospace; background: #0d1117; color: #c9d1d9; padding: 16px; }
  h1 { font-size: 1rem; color: #58a6ff; margin-bottom: 12px; }
  h2 { font-size: 0.85rem; color: #8b949e; margin: 12px 0 6px; text-transform: uppercase; letter-spacing: 0.05em; }
  section { border: 1px solid #30363d; border-radius: 6px; padding: 12px; margin-bottom: 12px; }
  label { display: block; font-size: 0.8rem; color: #8b949e; margin-bottom: 4px; }
  input[type=password], input[type=text] {
    background: #161b22; border: 1px solid #30363d; color: #c9d1d9;
    padding: 6px 8px; border-radius: 4px; width: 240px; font-family: monospace; font-size: 0.85rem;
  }
  button {
    background: #21262d; border: 1px solid #30363d; color: #c9d1d9;
    padding: 6px 12px; border-radius: 4px; cursor: pointer; font-family: monospace; font-size: 0.85rem;
    margin-left: 6px;
  }
  button:hover { background: #30363d; }
  .error { color: #f85149; font-size: 0.8rem; margin-top: 6px; }
  .ok { color: #3fb950; font-size: 0.8rem; margin-top: 6px; }
  #health-status { font-size: 0.8rem; color: #8b949e; }
  #conn-state { font-size: 0.8rem; margin-bottom: 8px; }
  #msg-list { list-style: none; max-height: 240px; overflow-y: auto; border: 1px solid #30363d; border-radius: 4px; padding: 6px; background: #161b22; }
  #msg-list li { font-size: 0.78rem; padding: 2px 0; border-bottom: 1px solid #21262d; white-space: pre-wrap; word-break: break-all; }
  #msg-list li:last-child { border-bottom: none; }
  .sent { color: #58a6ff; }
  .recv { color: #3fb950; }
  .sys  { color: #8b949e; font-style: italic; }
  .ws-input { display: flex; gap: 6px; margin-top: 8px; }
  .ws-input input { flex: 1; }
</style>
</head>
<body>
<h1>zuse — DEV TEST PAGE</h1>

<section id="health-section">
  <h2>Health</h2>
  <div id="health-status">checking…</div>
</section>

<section id="auth-section">
  <h2>Auth</h2>
  <div id="auth-content">checking…</div>
</section>

<section id="ws-section" style="display:none">
  <h2>WebSocket echo console</h2>
  <div id="conn-state">disconnected</div>
  <ul id="msg-list"></ul>
  <div class="ws-input">
    <input type="text" id="ws-input" placeholder="message to send…">
    <button id="ws-send">Send</button>
  </div>
</section>

<script>
(function () {
  'use strict';

  // ── helpers ───────────────────────────────────────────────────────────────

  function el(id) { return document.getElementById(id); }

  function appendMsg(cls, text) {
    var li = document.createElement('li');
    li.className = cls;
    li.textContent = text;
    var list = el('msg-list');
    list.appendChild(li);
    list.scrollTop = list.scrollHeight;
  }

  function postJson(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
  }

  // ── health ────────────────────────────────────────────────────────────────

  fetch('/healthz')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      el('health-status').textContent = 'status: ' + d.status + '  version: ' + d.version;
    })
    .catch(function (e) {
      el('health-status').textContent = 'error: ' + e.message;
    });

  // ── ws console ───────────────────────────────────────────────────────────

  var ws = null;

  function openWs() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(proto + '://' + location.host + '/ws');
    el('conn-state').textContent = 'connecting…';

    ws.addEventListener('open', function () {
      el('conn-state').textContent = 'connected';
      appendMsg('sys', '[connected]');
    });
    ws.addEventListener('message', function (ev) {
      appendMsg('recv', '← ' + ev.data);
    });
    ws.addEventListener('close', function () {
      el('conn-state').textContent = 'disconnected';
      appendMsg('sys', '[disconnected]');
      ws = null;
    });
    ws.addEventListener('error', function () {
      appendMsg('sys', '[ws error]');
    });
  }

  el('ws-send').addEventListener('click', function () {
    var inp = el('ws-input');
    var val = inp.value.trim();
    if (!val || !ws || ws.readyState !== 1) return;
    ws.send(val);
    appendMsg('sent', '→ ' + val);
    inp.value = '';
  });

  el('ws-input').addEventListener('keydown', function (ev) {
    if (ev.key === 'Enter') el('ws-send').click();
  });

  // ── auth flow ─────────────────────────────────────────────────────────────

  function showWs() {
    el('ws-section').style.display = '';
    openWs();
  }

  function renderSetup(msg) {
    var html =
      '<label>No password set — create one:</label>' +
      '<div style="display:flex;align-items:center;gap:6px;margin-top:4px">' +
      '<input type="password" id="setup-pw" placeholder="new password">' +
      '<button id="setup-btn">Set password</button>' +
      '</div>' +
      '<div id="setup-msg" class="error">' + (msg || '') + '</div>';
    el('auth-content').innerHTML = html;

    el('setup-btn').addEventListener('click', function () {
      var pw = el('setup-pw').value;
      if (!pw) return;
      postJson('/api/auth/setup', { password: pw })
        .then(function (r) {
          if (r.ok) {
            el('setup-msg').className = 'ok';
            el('setup-msg').textContent = 'password set — reloading…';
            setTimeout(function () { location.reload(); }, 800);
          } else {
            return r.json().then(function (d) {
              el('setup-msg').className = 'error';
              el('setup-msg').textContent = (d.error && d.error.message) || ('error ' + r.status);
            });
          }
        })
        .catch(function (e) {
          el('setup-msg').className = 'error';
          el('setup-msg').textContent = e.message;
        });
    });
  }

  function renderLogin(msg) {
    var html =
      '<label>Password required:</label>' +
      '<div style="display:flex;align-items:center;gap:6px;margin-top:4px">' +
      '<input type="password" id="login-pw" placeholder="password">' +
      '<button id="login-btn">Login</button>' +
      '</div>' +
      '<div id="login-msg" class="error">' + (msg || '') + '</div>';
    el('auth-content').innerHTML = html;

    el('login-btn').addEventListener('click', function () {
      var pw = el('login-pw').value;
      if (!pw) return;
      postJson('/api/auth/login', { password: pw })
        .then(function (r) {
          if (r.ok) {
            el('auth-content').innerHTML = '<span class="ok">authenticated ✓</span>';
            showWs();
          } else {
            el('login-msg').className = 'error';
            el('login-msg').textContent = r.status === 401 ? 'invalid password' : ('error ' + r.status);
          }
        })
        .catch(function (e) {
          el('login-msg').className = 'error';
          el('login-msg').textContent = e.message;
        });
    });

    el('login-pw').addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') el('login-btn').click();
    });
  }

  fetch('/api/auth/status')
    .then(function (r) { return r.json(); })
    .then(function (d) {
      if (!d.configured) {
        renderSetup('');
      } else if (!d.authenticated) {
        renderLogin('');
      } else {
        el('auth-content').innerHTML = '<span class="ok">authenticated ✓</span>';
        showWs();
      }
    })
    .catch(function (e) {
      el('auth-content').innerHTML = '<span class="error">could not reach /api/auth/status: ' + e.message + '</span>';
    });
}());
</script>
</body>
</html>
`
