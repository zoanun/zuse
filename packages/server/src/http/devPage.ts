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

  :root {
    --ground: #0E1626;
    --surface: #152034;
    --surface-2: #1B2942;
    --line: #243349;
    --text: #DCE3F0;
    --muted: #8492AD;
    --faint: #5C6883;
    --accent: #8B9CFF;
    --accent-2: #B7A0FF;
    --accent-soft: rgba(139, 156, 255, 0.13);
    --good: #5BD0A0;
    --warn: #E5B567;
    --bad: #F0827A;
    --sans: -apple-system, "Segoe UI", system-ui, Roboto, Helvetica, Arial, sans-serif;
    --mono: "Cascadia Code", "Cascadia Mono", ui-monospace, Consolas, "Courier New", monospace;
    --radius: 14px;
  }

  html, body { height: 100%; }
  body {
    font-family: var(--sans);
    color: var(--text);
    background:
      radial-gradient(1100px 560px at 82% -12%, rgba(139, 156, 255, 0.10), transparent 60%),
      radial-gradient(900px 520px at -5% 112%, rgba(183, 160, 255, 0.06), transparent 55%),
      var(--ground);
    background-attachment: fixed;
    min-height: 100%;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }

  .app { max-width: 920px; margin: 0 auto; min-height: 100vh; display: flex; flex-direction: column; padding: 0 20px; }

  /* ── top bar ─────────────────────────────────────────────── */
  .topbar {
    display: flex; align-items: center; justify-content: space-between; gap: 16px;
    padding: 16px 4px; position: sticky; top: 0; z-index: 5;
    border-bottom: 1px solid var(--line);
    background: linear-gradient(var(--ground) 60%, rgba(14, 22, 38, 0.82));
    backdrop-filter: blur(8px);
  }
  .brand { display: flex; align-items: center; gap: 11px; font-size: 18px; font-weight: 600; letter-spacing: 0.01em; }
  .mark {
    width: 13px; height: 13px; border-radius: 3px; rotate: 45deg;
    background: linear-gradient(135deg, var(--accent), var(--accent-2));
    box-shadow: 0 0 16px rgba(139, 156, 255, 0.5);
  }
  .eyebrow {
    font: 600 10px/1 var(--mono); letter-spacing: 0.22em; color: var(--faint);
    text-transform: uppercase; padding: 4px 7px; border: 1px solid var(--line); border-radius: 6px;
  }
  .stats { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; justify-content: flex-end; }
  .chip {
    display: inline-flex; align-items: center;
    font: 500 12px/1 var(--mono); color: var(--muted);
    background: var(--surface); border: 1px solid var(--line); border-radius: 999px;
    padding: 6px 11px; white-space: nowrap;
  }
  .chip .dot { width: 7px; height: 7px; border-radius: 50%; margin-right: 7px; background: var(--faint); }
  .chip.live .dot { background: var(--good); box-shadow: 0 0 8px var(--good); }
  .chip.warn .dot { background: var(--warn); }
  .chip.down .dot { background: var(--bad); }
  .chip[hidden] { display: none; }

  /* ── auth card ───────────────────────────────────────────── */
  .auth-card {
    max-width: 384px; width: 100%; margin: 13vh auto 0;
    background: var(--surface); border: 1px solid var(--line); border-radius: 18px;
    padding: 28px; box-shadow: 0 24px 60px rgba(0, 0, 0, 0.38);
  }
  .auth-card h2 { font-size: 17px; margin-bottom: 7px; }
  .auth-card p { color: var(--muted); font-size: 13px; line-height: 1.55; margin-bottom: 18px; }
  .field { display: flex; gap: 8px; }

  input[type=password], input[type=text], textarea {
    width: 100%; background: var(--ground); border: 1px solid var(--line); color: var(--text);
    font-family: var(--sans); font-size: 14px; padding: 11px 13px; border-radius: 10px; outline: none;
    transition: border-color 0.12s, box-shadow 0.12s;
  }
  input:focus, textarea:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }

  button {
    font-family: var(--sans); font-size: 14px; font-weight: 600; cursor: pointer;
    border: 1px solid transparent; border-radius: 10px; padding: 11px 17px;
    background: var(--accent); color: #0B1020; transition: filter 0.12s, opacity 0.12s;
  }
  button:hover { filter: brightness(1.08); }
  button:focus-visible { outline: 2px solid var(--accent-2); outline-offset: 2px; }
  button.ghost { background: transparent; border-color: var(--line); color: var(--text); }
  button.ghost:hover { background: var(--surface-2); filter: none; }
  button:disabled { opacity: 0.4; cursor: not-allowed; filter: none; }

  .msg-error { color: var(--bad); font-size: 12.5px; margin-top: 12px; min-height: 1em; }
  .msg-ok { color: var(--good); font-size: 12.5px; margin-top: 12px; }

  /* ── chat ────────────────────────────────────────────────── */
  .chat { flex: 1; display: flex; flex-direction: column; min-height: 0; min-width: 0; padding-top: 16px; }
  .stream { flex: 1; min-width: 0; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; gap: 14px; padding: 6px 2px 18px; }
  .empty { margin: auto; color: var(--faint); font-size: 14px; }

  .msg { display: flex; flex-direction: column; gap: 5px; max-width: 82%; }
  .msg .role { font: 600 10px/1 var(--mono); letter-spacing: 0.16em; text-transform: uppercase; color: var(--faint); padding: 0 4px; }
  .bubble { padding: 11px 14px; border-radius: var(--radius); font-size: 14.5px; line-height: 1.62; white-space: pre-wrap; word-break: break-word; }
  .msg.agent { align-self: flex-start; }
  .msg.agent .bubble { background: var(--surface); border: 1px solid var(--line); border-top-left-radius: 4px; }
  .msg.you { align-self: flex-end; align-items: flex-end; }
  .msg.you .role { color: var(--accent); }
  .msg.you .bubble { background: var(--accent-soft); border: 1px solid rgba(139, 156, 255, 0.35); border-top-right-radius: 4px; }

  .caret { display: inline-block; width: 7px; height: 1.05em; vertical-align: -2px; margin-left: 2px; border-radius: 1px; background: var(--accent); animation: blink 1s steps(2, start) infinite; }
  @keyframes blink { 50% { opacity: 0; } }

  /* tool call */
  .tool { align-self: flex-start; max-width: 82%; background: var(--surface-2); border: 1px solid var(--line); border-radius: 12px; padding: 10px 13px; font-family: var(--mono); font-size: 12.5px; }
  .tool .head { color: var(--accent-2); font-weight: 600; }
  .tool .args { color: var(--muted); margin-top: 4px; white-space: pre-wrap; word-break: break-word; }
  .tool .result { margin-top: 9px; padding-top: 9px; border-top: 1px dashed var(--line); color: var(--text); white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto; }
  .tool .result.err { color: var(--bad); }

  /* system note */
  .note { align-self: center; font: 500 12px/1.45 var(--mono); color: var(--muted); text-align: center; padding: 1px 0; }
  .note.warn { color: var(--warn); }
  .note.bad { color: var(--bad); }
  .note.live { color: var(--accent); }

  /* permission request */
  .perm { align-self: stretch; background: var(--surface); border: 1px solid var(--accent); border-radius: 12px; padding: 14px; box-shadow: 0 0 0 3px var(--accent-soft); }
  .perm .q { font-size: 13.5px; font-weight: 600; margin-bottom: 5px; }
  .perm .spec { font-family: var(--mono); font-size: 12px; color: var(--muted); word-break: break-word; margin-bottom: 12px; }
  .perm .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .perm .actions button { padding: 8px 15px; font-size: 13px; }
  .perm .resolved { font-family: var(--mono); font-size: 12px; color: var(--muted); }

  /* thinking indicator */
  .thinking { align-self: flex-start; display: flex; align-items: center; gap: 8px; color: var(--muted); font-size: 13px; padding: 4px 4px; }
  .thinking i { width: 6px; height: 6px; border-radius: 50%; background: var(--accent); animation: bob 1.2s infinite ease-in-out; }
  .thinking i:nth-child(2) { animation-delay: 0.15s; }
  .thinking i:nth-child(3) { animation-delay: 0.3s; }
  @keyframes bob { 0%, 80%, 100% { transform: translateY(0); opacity: 0.4; } 40% { transform: translateY(-4px); opacity: 1; } }

  /* composer */
  .composer { display: flex; gap: 10px; align-items: flex-end; padding: 14px 0 6px; border-top: 1px solid var(--line); }
  .composer textarea { resize: none; min-height: 46px; max-height: 140px; line-height: 1.5; }
  .composer button { flex: none; height: 46px; }
  .statusline { display: flex; align-items: center; gap: 8px; padding: 0 2px 16px; color: var(--faint); font: 500 12px/1 var(--mono); min-height: 1em; }
  .statusline .dot { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); }
  .statusline.live .dot { background: var(--good); box-shadow: 0 0 8px var(--good); }
  .statusline.warn .dot { background: var(--warn); }

  /* scrollbars */
  .stream::-webkit-scrollbar, .tool .result::-webkit-scrollbar { width: 10px; }
  .stream::-webkit-scrollbar-thumb, .tool .result::-webkit-scrollbar-thumb { background: var(--line); border-radius: 8px; border: 3px solid transparent; background-clip: content-box; }

  [hidden] { display: none !important; }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
  @media (max-width: 560px) { .msg, .tool { max-width: 92%; } .eyebrow { display: none; } }
</style>
</head>
<body>
<div class="app">
  <header class="topbar">
    <div class="brand"><span class="mark"></span> zuse <span class="eyebrow">DEV TEST PAGE</span></div>
    <div class="stats">
      <span class="chip" id="chip-health">health…</span>
      <span class="chip" id="chip-model" hidden></span>
      <span class="chip" id="chip-ctx" hidden></span>
      <span class="chip" id="chip-conn" hidden></span>
    </div>
  </header>

  <section class="auth-card" id="auth-view"><p>checking…</p></section>

  <main class="chat" id="chat-view" hidden>
    <div class="stream" id="stream">
      <div class="empty" id="empty">No messages yet. Say something to the agent.</div>
    </div>
    <div class="composer">
      <textarea id="input" rows="1" placeholder="Message the agent…  (Enter to send, Shift+Enter for a new line)"></textarea>
      <button id="stop" class="ghost" hidden>Stop</button>
      <button id="send">Send</button>
    </div>
    <div class="statusline" id="statusline"></div>
  </main>
</div>

<script>
(function () {
  'use strict';

  function el(id) { return document.getElementById(id); }
  function make(tag, cls) { var n = document.createElement(tag); if (cls) n.className = cls; return n; }
  function post(path, body) {
    return fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }
  function fmt(n) { if (n === null || n === undefined) return '—'; return n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n); }
  function trunc(s, n) { s = String(s); return s.length > n ? s.slice(0, n) + ' … (+' + (s.length - n) + ' chars)' : s; }
  function safeJson(o) { try { return JSON.stringify(o); } catch (e) { return String(o); } }

  // ── module state (assigned in showChat) ──────────────────────
  var stream, input, sendBtn, stopBtn, statusline;
  var ws = null, conn = 'down', thinking = false;
  var currentText = null, currentCaret = null, thinkingEl = null;
  var lastCtx, lastUsage;
  var toolCards = {}, permCards = {};

  // ── health (always available) ────────────────────────────────
  fetch('/healthz').then(function (r) { return r.json(); }).then(function (d) {
    el('chip-health').textContent = 'health ' + d.status + ' · v' + d.version;
  }).catch(function () { el('chip-health').textContent = 'health unreachable'; });

  // ── stream helpers ───────────────────────────────────────────
  function scroll() { if (stream) stream.scrollTop = stream.scrollHeight; }
  function clearEmpty() { var e = el('empty'); if (e) e.remove(); }

  function addMsg(role, text) {
    clearEmpty();
    var m = make('div', 'msg ' + (role === 'you' ? 'you' : 'agent'));
    var lbl = make('div', 'role'); lbl.textContent = role === 'you' ? 'you' : 'agent'; m.appendChild(lbl);
    var b = make('div', 'bubble'); b.textContent = text || ''; m.appendChild(b);
    stream.appendChild(m); scroll(); return b;
  }
  function startAgent() {
    clearEmpty(); removeThinking();
    var m = make('div', 'msg agent');
    var lbl = make('div', 'role'); lbl.textContent = 'agent'; m.appendChild(lbl);
    var b = make('div', 'bubble');
    currentText = make('span'); b.appendChild(currentText);
    currentCaret = make('span', 'caret'); b.appendChild(currentCaret);
    m.appendChild(b); stream.appendChild(m); scroll();
  }
  function appendDelta(s) { if (!currentText) startAgent(); currentText.textContent += s; scroll(); }
  function endAgent() { if (currentCaret) { currentCaret.remove(); currentCaret = null; } currentText = null; }

  function showThinking() {
    if (!thinking) return;
    removeThinking();
    thinkingEl = make('div', 'thinking');
    thinkingEl.appendChild(make('i')); thinkingEl.appendChild(make('i')); thinkingEl.appendChild(make('i'));
    var t = make('span'); t.textContent = 'agent is working'; thinkingEl.appendChild(t);
    stream.appendChild(thinkingEl); scroll();
  }
  function removeThinking() { if (thinkingEl) { thinkingEl.remove(); thinkingEl = null; } }

  function addTool(id, name, inp) {
    clearEmpty(); removeThinking(); endAgent();
    var c = make('div', 'tool');
    var h = make('div', 'head'); h.textContent = '⚙ ' + name; c.appendChild(h);
    var a = make('div', 'args'); a.textContent = trunc(safeJson(inp), 200); c.appendChild(a);
    stream.appendChild(c); scroll(); toolCards[id] = c;
  }
  function addToolResult(id, output, isErr) {
    var card = toolCards[id];
    var r = make('div', 'result' + (isErr ? ' err' : ''));
    r.textContent = trunc(output, 800);
    (card || stream).appendChild(r); showThinking(); scroll();
  }
  function addNote(text, kind) { clearEmpty(); var n = make('div', 'note' + (kind ? ' ' + kind : '')); n.textContent = text; stream.appendChild(n); scroll(); }

  function addPermission(id, req) {
    clearEmpty(); removeThinking();
    var c = make('div', 'perm');
    var q = make('div', 'q'); q.textContent = 'Allow this action?'; c.appendChild(q);
    var name = req && req.toolName ? req.toolName : 'tool';
    var spec = req && req.specifier ? ' · ' + trunc(String(req.specifier), 180) : '';
    var s = make('div', 'spec'); s.textContent = name + spec; c.appendChild(s);
    var acts = make('div', 'actions');
    acts.appendChild(permBtn(id, 'Allow', 'allow', ''));
    acts.appendChild(permBtn(id, 'Always', 'allow_session', 'ghost'));
    acts.appendChild(permBtn(id, 'Deny', 'deny', 'ghost'));
    c.appendChild(acts); stream.appendChild(c); scroll(); permCards[id] = c;
  }
  function permBtn(id, label, verdict, cls) {
    var b = make('button', cls); b.textContent = label;
    b.addEventListener('click', function () { wsSend({ type: 'permission-reply', id: id, verdict: verdict }); });
    return b;
  }
  function resolvePerm(id, verdict) {
    var c = permCards[id]; if (!c) return;
    c.textContent = ''; c.style.boxShadow = 'none'; c.style.borderColor = 'var(--line)';
    var r = make('div', 'resolved'); r.textContent = 'permission → ' + verdict; c.appendChild(r);
  }

  // ── header stats + status ────────────────────────────────────
  function setModel(m) { var c = el('chip-model'); if (m) { c.hidden = false; c.textContent = 'model ' + m; } }
  function setCtx() {
    var c = el('chip-ctx'); var parts = [];
    if (lastCtx !== null && lastCtx !== undefined) parts.push('ctx ' + fmt(lastCtx));
    if (lastUsage) parts.push('tok ' + fmt((lastUsage.input_tokens || 0) + (lastUsage.output_tokens || 0)));
    if (parts.length) { c.hidden = false; c.textContent = parts.join(' · '); }
  }
  function setConn(state) {
    conn = state;
    var c = el('chip-conn'); c.hidden = false;
    c.className = 'chip ' + (state === 'live' ? 'live' : state === 'connecting' ? 'warn' : 'down');
    c.textContent = '';
    var d = make('span', 'dot'); c.appendChild(d);
    var t = make('span'); t.textContent = state === 'live' ? 'connected' : state === 'connecting' ? 'connecting' : 'offline';
    c.appendChild(t);
    renderStatus();
  }
  function renderStatus() {
    if (!statusline) return;
    statusline.textContent = '';
    statusline.className = 'statusline' + (thinking ? ' warn' : conn === 'live' ? ' live' : '');
    var d = make('span', 'dot'); statusline.appendChild(d);
    var t = make('span');
    t.textContent = conn !== 'live' ? 'disconnected' : thinking ? 'agent working…' : 'ready';
    statusline.appendChild(t);
  }
  function setThinking(on) {
    thinking = on;
    sendBtn.disabled = on; input.disabled = on; stopBtn.hidden = !on;
    if (on) showThinking(); else removeThinking();
    renderStatus();
  }

  // ── websocket ────────────────────────────────────────────────
  function wsSend(obj) { if (ws && ws.readyState === 1) ws.send(JSON.stringify(obj)); }

  function openWs() {
    var proto = location.protocol === 'https:' ? 'wss' : 'ws';
    setConn('connecting');
    ws = new WebSocket(proto + '://' + location.host + '/ws');
    ws.addEventListener('open', function () { setConn('live'); });
    ws.addEventListener('close', function () { setConn('down'); ws = null; });
    ws.addEventListener('error', function () {});
    ws.addEventListener('message', onMessage);
  }

  function onMessage(ev) {
    var msg;
    try { msg = JSON.parse(ev.data); } catch (e) { addNote('non-JSON frame: ' + ev.data, 'warn'); return; }

    if (msg.type === 'snapshot') {
      var s = msg.snapshot;
      setModel(s.model); lastCtx = s.contextTokens; lastUsage = s.totalUsage; setCtx();
      if (s.cwd) el('chip-conn').title = 'cwd: ' + s.cwd;
      if (s.isThinking) setThinking(true);
      if (s.pendingPermissions) s.pendingPermissions.forEach(function (p) { addPermission(p.id, p.req); });
      return;
    }
    if (msg.type === 'error') { addNote(msg.message, 'bad'); return; }
    if (msg.type !== 'event') return;

    var e = msg.event;
    switch (e.type) {
      case 'turn-start': setThinking(true); break;
      case 'message-start': startAgent(); break;
      case 'text-delta': appendDelta(e.text); break;
      case 'tool-use': addTool(e.id, e.name, e.input); break;
      case 'tool-result': addToolResult(e.id, e.output, e.is_error); break;
      case 'message-stop': endAgent(); showThinking(); break;
      case 'usage-update': lastUsage = e.totalUsage; setCtx(); break;
      case 'context-update': lastCtx = e.contextTokens; setCtx(); break;
      case 'permission-request': addPermission(e.id, e.req); break;
      case 'permission-resolved': resolvePerm(e.id, e.verdict); break;
      case 'turn-end': setThinking(false); break;
      case 'failover': addNote('failover: ' + e.fromModel + ' → ' + e.toModel + ' (' + e.reason + ')', 'warn'); setModel(e.toModel); break;
      case 'model-select-needed': addNote('model selection needed: ' + e.reason, 'warn'); break;
      case 'compaction-start': addNote('compacting context…', 'live'); break;
      case 'compaction-done': addNote('context compacted', 'live'); break;
      case 'memory-notice': addNote(e.text, 'live'); break;
      case 'warning': addNote(e.message, 'warn'); break;
      case 'cwd-change': el('chip-conn').title = 'cwd: ' + e.cwd; addNote('cwd → ' + e.cwd); break;
      case 'aborted': addNote('stopped', 'warn'); setThinking(false); break;
      default: break; // checkpoint-recorded & other housekeeping: intentionally silent
    }
  }

  // ── composer ─────────────────────────────────────────────────
  function doSend() {
    var v = input.value.trim();
    if (!v || !ws || ws.readyState !== 1 || thinking) return;
    addMsg('you', v);
    wsSend({ type: 'send', text: v });
    input.value = ''; input.style.height = 'auto';
  }
  function bindComposer() {
    sendBtn.addEventListener('click', doSend);
    stopBtn.addEventListener('click', function () { wsSend({ type: 'interrupt' }); });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); doSend(); }
    });
    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 140) + 'px';
    });
  }

  function showChat() {
    el('auth-view').hidden = true;
    el('chat-view').hidden = false;
    stream = el('stream'); input = el('input'); sendBtn = el('send'); stopBtn = el('stop'); statusline = el('statusline');
    bindComposer(); renderStatus(); openWs();
  }

  // ── auth flow ────────────────────────────────────────────────
  function renderSetup(msg) {
    var v = el('auth-view'); v.hidden = false;
    v.innerHTML =
      '<h2>Protect this server</h2>' +
      '<p>No password is set yet. Create one to lock the web console — it is hashed and stored locally.</p>' +
      '<div class="field"><input type="password" id="setup-pw" placeholder="New password" autocomplete="new-password"></div>' +
      '<button id="setup-btn" style="margin-top:14px;width:100%">Set password</button>' +
      '<div class="msg-error" id="setup-msg">' + (msg || '') + '</div>';
    el('setup-btn').addEventListener('click', function () {
      var pw = el('setup-pw').value; if (!pw) return;
      post('/api/auth/setup', { password: pw }).then(function (r) {
        if (r.ok) {
          var m = el('setup-msg'); m.className = 'msg-ok'; m.textContent = 'Password set — reloading…';
          setTimeout(function () { location.reload(); }, 700);
        } else {
          r.json().then(function (d) {
            var m = el('setup-msg'); m.className = 'msg-error';
            m.textContent = (d.error && d.error.message) || ('error ' + r.status);
          });
        }
      }).catch(function (e) { el('setup-msg').textContent = e.message; });
    });
    el('setup-pw').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') el('setup-btn').click(); });
  }

  function renderLogin(msg) {
    var v = el('auth-view'); v.hidden = false;
    v.innerHTML =
      '<h2>Welcome back</h2>' +
      '<p>Enter your password to open the console.</p>' +
      '<div class="field"><input type="password" id="login-pw" placeholder="Password" autocomplete="current-password"></div>' +
      '<button id="login-btn" style="margin-top:14px;width:100%">Log in</button>' +
      '<div class="msg-error" id="login-msg">' + (msg || '') + '</div>';
    el('login-btn').addEventListener('click', function () {
      var pw = el('login-pw').value; if (!pw) return;
      post('/api/auth/login', { password: pw }).then(function (r) {
        if (r.ok) { showChat(); }
        else {
          var m = el('login-msg'); m.className = 'msg-error';
          m.textContent = r.status === 401 ? 'Incorrect password' : ('error ' + r.status);
        }
      }).catch(function (e) { el('login-msg').textContent = e.message; });
    });
    el('login-pw').addEventListener('keydown', function (ev) { if (ev.key === 'Enter') el('login-btn').click(); });
  }

  fetch('/api/auth/status').then(function (r) { return r.json(); }).then(function (d) {
    if (!d.configured) renderSetup('');
    else if (!d.authenticated) renderLogin('');
    else showChat();
  }).catch(function (e) {
    el('auth-view').innerHTML = '<h2>Server unreachable</h2><p class="msg-error">Could not reach /api/auth/status: ' + e.message + '</p>';
  });
}());
</script>
</body>
</html>
`
