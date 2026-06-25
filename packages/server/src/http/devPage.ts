// DEV TEST PAGE — replaced by the real SPA in F4
export const DEV_PAGE_HTML: string = `<!doctype html>
<!-- DEV TEST PAGE — replaced by the real SPA in F4 -->
<html lang="en" data-theme="light">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>zuse — DEV TEST PAGE</title>
<script>(function () { try { var t = localStorage.getItem('zuse-theme'); document.documentElement.setAttribute('data-theme', t === 'dark' ? 'dark' : 'light'); } catch (e) {} }());</script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --sans: -apple-system, "Segoe UI", system-ui, Roboto, Helvetica, Arial, sans-serif;
    --mono: "Cascadia Code", "Cascadia Mono", ui-monospace, Consolas, "SF Mono", Menlo, monospace;
    --col: 720px;
  }
  /* Warm, paper-like light theme (Claude-ish). */
  :root[data-theme="light"] {
    --ground: #E8E3D8; --surface: #FFFFFF; --surface-2: #F3F1EA; --user-bubble: #EEEBE3;
    --line: #E0DBD0; --text: #2A2824; --muted: #6E6A61; --faint: #A29D90;
    --accent: #6B57E0; --accent-2: #8B7BF0;
    --accent-soft: rgba(107, 87, 224, 0.10); --accent-border: rgba(107, 87, 224, 0.28); --accent-glow: rgba(107, 87, 224, 0.28);
    --on-accent: #FFFFFF; --shadow: rgba(40, 38, 34, 0.10); --header-bg: rgba(255, 255, 255, 0.82);
    --good: #1F9D63; --warn: #B0791C; --bad: #D8453B;
  }
  /* Warm dark theme (ChatGPT-ish), not blue. */
  :root[data-theme="dark"] {
    --ground: #161513; --surface: #232220; --surface-2: #2D2B27; --user-bubble: #343230;
    --line: #393631; --text: #ECEAE4; --muted: #A39E94; --faint: #6E6A61;
    --accent: #9A8CFF; --accent-2: #B7A0FF;
    --accent-soft: rgba(154, 140, 255, 0.14); --accent-border: rgba(154, 140, 255, 0.34); --accent-glow: rgba(154, 140, 255, 0.38);
    --on-accent: #1A1726; --shadow: rgba(0, 0, 0, 0.40); --header-bg: rgba(35, 34, 32, 0.82);
    --good: #5BD0A0; --warn: #E5B567; --bad: #F0827A;
  }

  html, body { height: 100%; }
  body {
    font-family: var(--sans); color: var(--text); background: var(--ground);
    -webkit-font-smoothing: antialiased; text-rendering: optimizeLegibility;
    transition: background-color 0.2s, color 0.2s;
  }

  /* ── framed app shell ────────────────────────────────────── */
  .shell {
    height: 100vh; display: flex;
    background: var(--surface); overflow: hidden;
  }

  .sidebar {
    width: 256px; flex: none; display: flex; flex-direction: column; gap: 14px;
    padding: 18px 14px; border-right: 1px solid var(--line); background: var(--ground);
  }
  .brand { display: flex; align-items: center; gap: 10px; font-size: 17px; font-weight: 650; letter-spacing: 0.01em; }
  .mark { width: 14px; height: 14px; border-radius: 4px; rotate: 45deg; background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 0 14px var(--accent-glow); }
  .eyebrow { font: 600 9px/1 var(--mono); letter-spacing: 0.22em; color: var(--faint); text-transform: uppercase; padding: 4px 7px; border: 1px solid var(--line); border-radius: 6px; }
  .side-btn { display: flex; align-items: center; gap: 9px; width: 100%; justify-content: flex-start; background: transparent; border: 1px solid var(--line); color: var(--text); font-weight: 600; font-size: 13.5px; padding: 10px 13px; border-radius: 12px; }
  .side-btn:hover { background: var(--surface-2); filter: none; }
  .side-note { font-size: 12px; color: var(--faint); line-height: 1.55; padding: 0 2px; }
  .side-foot { margin-top: auto; display: flex; flex-direction: column; gap: 10px; align-items: flex-start; }

  .main { flex: 1; min-width: 0; display: flex; flex-direction: column; }
  .main-header {
    display: flex; align-items: center; justify-content: space-between; gap: 12px;
    padding: 11px 18px; border-bottom: 1px solid var(--line);
    background: var(--header-bg); backdrop-filter: blur(8px);
  }
  .mh-left { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; min-width: 0; }
  .mh-brand { display: none; }

  .stats { display: flex; align-items: center; gap: 7px; flex-wrap: wrap; }
  .chip { display: inline-flex; align-items: center; font: 500 11px/1 var(--mono); color: var(--muted); background: var(--surface); border: 1px solid var(--line); border-radius: 999px; padding: 5px 9px; white-space: nowrap; }
  .chip .dot { width: 6px; height: 6px; border-radius: 50%; margin-right: 6px; background: var(--faint); }
  .chip.live .dot { background: var(--good); box-shadow: 0 0 7px var(--good); }
  .chip.warn .dot { background: var(--warn); }
  .chip.down .dot { background: var(--bad); }
  .chip[hidden] { display: none; }
  .icon-btn { background: transparent; border: 1px solid var(--line); color: var(--muted); border-radius: 999px; width: 30px; height: 30px; padding: 0; font-size: 14px; line-height: 1; cursor: pointer; display: grid; place-items: center; }
  .icon-btn:hover { background: var(--surface-2); color: var(--text); filter: none; }
  .menu-btn { display: none; }
  .backdrop { display: none; }

  /* ── auth card ───────────────────────────────────────────── */
  .auth-card { max-width: 372px; width: 100%; margin: auto; background: var(--surface); border: 1px solid var(--line); border-radius: 18px; padding: 28px; box-shadow: 0 12px 40px var(--shadow); }
  .auth-card h2 { font-size: 18px; margin-bottom: 7px; letter-spacing: -0.01em; }
  .auth-card p { color: var(--muted); font-size: 13.5px; line-height: 1.55; margin-bottom: 18px; }
  .field { display: flex; gap: 8px; }

  input[type=password], input[type=text], textarea {
    width: 100%; background: var(--surface); border: 1px solid var(--line); color: var(--text);
    font-family: var(--sans); font-size: 14px; padding: 11px 13px; border-radius: 11px; outline: none;
    transition: border-color 0.12s, box-shadow 0.12s;
  }
  input:focus { border-color: var(--accent); box-shadow: 0 0 0 3px var(--accent-soft); }

  button { font-family: var(--sans); font-size: 14px; font-weight: 600; cursor: pointer; border: 1px solid transparent; border-radius: 11px; padding: 11px 17px; background: var(--accent); color: var(--on-accent); transition: filter 0.12s, opacity 0.12s; }
  button:hover { filter: brightness(1.06); }
  button:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
  button.ghost { background: transparent; border-color: var(--line); color: var(--muted); font-weight: 500; }
  button.ghost:hover { background: var(--surface-2); color: var(--text); filter: none; }
  button:disabled { opacity: 0.45; cursor: not-allowed; filter: none; }
  .msg-error { color: var(--bad); font-size: 12.5px; margin-top: 12px; min-height: 1em; }
  .msg-ok { color: var(--good); font-size: 12.5px; margin-top: 12px; }

  /* ── chat ────────────────────────────────────────────────── */
  .chat { flex: 1; display: flex; flex-direction: column; min-height: 0; min-width: 0; }
  .stream { flex: 1; min-width: 0; overflow-y: auto; overflow-x: hidden; display: flex; flex-direction: column; gap: 26px; width: 100%; max-width: var(--col); margin: 0 auto; padding: 30px 20px 26px; }
  .empty { margin: auto; color: var(--faint); font-size: 14.5px; }

  /* assistant: avatar + plain prose */
  .msg.agent { flex-direction: row; align-items: flex-start; gap: 13px; align-self: stretch; max-width: 100%; }
  .av { width: 28px; height: 28px; border-radius: 8px; flex: none; background: linear-gradient(135deg, var(--accent), var(--accent-2)); box-shadow: 0 2px 8px var(--accent-glow); }
  .msg.agent .body { display: flex; flex-direction: column; gap: 3px; min-width: 0; padding-top: 3px; }
  .msg.agent .name { font-size: 13px; font-weight: 650; color: var(--text); }
  .msg.agent .text { font-size: 15px; line-height: 1.72; white-space: pre-wrap; word-break: break-word; color: var(--text); }

  /* user: soft neutral bubble, right */
  .msg.you { align-self: flex-end; max-width: 80%; }
  .msg.you .bubble { background: var(--user-bubble); border-radius: 20px; padding: 10px 16px; font-size: 15px; line-height: 1.6; color: var(--text); white-space: pre-wrap; word-break: break-word; }

  .caret { display: inline-block; width: 7px; height: 1.05em; vertical-align: -2px; margin-left: 1px; border-radius: 1px; background: var(--accent); animation: blink 1s steps(2, start) infinite; }
  @keyframes blink { 50% { opacity: 0; } }

  .tool { align-self: stretch; margin-left: 41px; max-width: calc(100% - 41px); background: var(--surface-2); border: 1px solid var(--line); border-radius: 12px; padding: 11px 13px; font-family: var(--mono); font-size: 12.5px; }
  .tool .head { color: var(--accent); font-weight: 600; }
  .tool .args { color: var(--muted); margin-top: 4px; white-space: pre-wrap; word-break: break-word; }
  .tool .result { margin-top: 9px; padding-top: 9px; border-top: 1px solid var(--line); color: var(--text); white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto; }
  .tool .result.err { color: var(--bad); }

  .note { align-self: center; font: 500 12px/1.45 var(--mono); color: var(--faint); text-align: center; }
  .note.warn { color: var(--warn); }
  .note.bad { color: var(--bad); }
  .note.live { color: var(--accent); }

  .perm { align-self: stretch; margin-left: 41px; max-width: calc(100% - 41px); background: var(--surface); border: 1px solid var(--accent-border); border-radius: 14px; padding: 14px; box-shadow: 0 0 0 3px var(--accent-soft); }
  .perm .q { font-size: 14px; font-weight: 650; margin-bottom: 5px; }
  .perm .spec { font-family: var(--mono); font-size: 12px; color: var(--muted); word-break: break-word; margin-bottom: 13px; }
  .perm .actions { display: flex; gap: 8px; flex-wrap: wrap; }
  .perm .actions button { padding: 8px 16px; font-size: 13px; }
  .perm .resolved { font-family: var(--mono); font-size: 12px; color: var(--muted); }

  .thinking { flex-direction: row; align-items: center; gap: 13px; align-self: stretch; }
  .thinking .dots { display: flex; gap: 5px; align-items: center; height: 28px; }
  .thinking .dots i { width: 7px; height: 7px; border-radius: 50%; background: var(--faint); animation: bob 1.3s infinite ease-in-out; }
  .thinking .dots i:nth-child(2) { animation-delay: 0.16s; }
  .thinking .dots i:nth-child(3) { animation-delay: 0.32s; }
  @keyframes bob { 0%, 80%, 100% { transform: translateY(0); opacity: 0.45; } 40% { transform: translateY(-4px); opacity: 1; } }

  .composer-wrap { width: 100%; max-width: var(--col); margin: 0 auto; padding: 0 20px 18px; }
  .composer { display: flex; align-items: flex-end; gap: 8px; background: var(--surface); border: 1px solid var(--line); border-radius: 24px; padding: 7px 7px 7px 17px; box-shadow: 0 2px 14px var(--shadow); transition: border-color 0.12s, box-shadow 0.12s; }
  .composer:focus-within { border-color: var(--accent-border); box-shadow: 0 2px 14px var(--shadow), 0 0 0 3px var(--accent-soft); }
  .composer textarea { flex: 1; resize: none; border: none; background: transparent; padding: 9px 0; min-height: 24px; max-height: 168px; line-height: 1.5; font-size: 15px; }
  .composer textarea:focus { box-shadow: none; }
  .send-btn { width: 36px; height: 36px; border-radius: 50%; padding: 0; font-size: 17px; display: flex; align-items: center; justify-content: center; flex: none; }
  .composer .ghost { align-self: center; padding: 8px 13px; border-radius: 16px; }
  .statusline { display: flex; align-items: center; gap: 8px; padding: 9px 6px 0; color: var(--faint); font: 500 12px/1 var(--mono); min-height: 1em; }
  .statusline .dot { width: 6px; height: 6px; border-radius: 50%; background: var(--faint); }
  .statusline.live .dot { background: var(--good); box-shadow: 0 0 7px var(--good); }
  .statusline.warn .dot { background: var(--warn); }

  .stream::-webkit-scrollbar, .tool .result::-webkit-scrollbar { width: 10px; }
  .stream::-webkit-scrollbar-thumb, .tool .result::-webkit-scrollbar-thumb { background: var(--line); border-radius: 8px; border: 3px solid transparent; background-clip: content-box; }

  [hidden] { display: none !important; }
  @media (prefers-reduced-motion: reduce) { * { animation: none !important; } }
  @media (max-width: 820px) {
    .menu-btn { display: grid; }
    .mh-brand { display: flex; }
    .sidebar {
      position: fixed; top: 0; left: 0; bottom: 0; width: 264px; z-index: 30;
      transform: translateX(-100%); transition: transform 0.22s ease; box-shadow: 0 0 50px var(--shadow);
    }
    .shell.menu-open .sidebar { transform: translateX(0); }
    .backdrop { display: block; position: fixed; inset: 0; background: rgba(0, 0, 0, 0.42); z-index: 20; opacity: 0; pointer-events: none; transition: opacity 0.2s; }
    .shell.menu-open .backdrop { opacity: 1; pointer-events: auto; }
  }
  @media (max-width: 560px) { .msg.you { max-width: 90%; } .tool, .perm { margin-left: 0; max-width: 100%; } }
</style>
</head>
<body>
<div class="shell" id="shell">
  <div class="backdrop" id="backdrop"></div>
  <aside class="sidebar" id="sidebar" hidden>
    <div class="brand"><span class="mark"></span> zuse</div>
    <button class="side-btn" id="clear-btn">＋&nbsp; New chat</button>
    <div class="side-note">One in-memory dev session. History isn't persisted here yet — “New chat” just clears the view.</div>
    <div class="side-foot">
      <span class="chip" id="chip-health">health…</span>
      <span class="eyebrow">DEV TEST PAGE</span>
    </div>
  </aside>

  <div class="main">
    <div class="main-header">
      <div class="mh-left">
        <button class="icon-btn menu-btn" id="menu-btn" title="Menu" aria-label="Open sidebar">☰</button>
        <div class="brand mh-brand"><span class="mark"></span> zuse</div>
        <span class="chip" id="chip-model" hidden></span>
        <span class="chip" id="chip-ctx" hidden></span>
        <span class="chip" id="chip-conn" hidden></span>
      </div>
      <button class="icon-btn" id="theme-btn" title="Toggle light / dark" aria-label="Toggle light or dark theme">☾</button>
    </div>

    <section class="auth-card" id="auth-view"><p>checking…</p></section>

    <main class="chat" id="chat-view" hidden>
      <div class="stream" id="stream">
        <div class="empty" id="empty">Ask zuse anything to get started.</div>
      </div>
      <div class="composer-wrap">
        <div class="composer">
          <textarea id="input" rows="1" placeholder="Message zuse…"></textarea>
          <button id="stop" class="ghost" hidden>Stop</button>
          <button id="send" class="send-btn" aria-label="Send message">↑</button>
        </div>
        <div class="statusline" id="statusline"></div>
      </div>
    </main>
  </div>
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

  var stream, input, sendBtn, stopBtn, statusline;
  var ws = null, conn = 'down', thinking = false;
  var currentText = null, currentCaret = null, thinkingEl = null;
  var lastCtx, lastUsage;
  var toolCards = {}, permCards = {};

  // ── theme toggle (always available) ──────────────────────────
  function themeGlyph() { return document.documentElement.getAttribute('data-theme') === 'light' ? '☾' : '☀'; }
  (function () {
    var tb = el('theme-btn'); if (!tb) return;
    tb.textContent = themeGlyph();
    tb.addEventListener('click', function () {
      var next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('zuse-theme', next); } catch (e) {}
      tb.textContent = themeGlyph();
    });
  }());

  // ── mobile sidebar drawer (open via ☰, close on backdrop / Esc) ──
  function closeMenu() { var sh = el('shell'); if (sh) sh.classList.remove('menu-open'); }
  (function () {
    var mb = el('menu-btn'), bd = el('backdrop'), sh = el('shell');
    if (mb && sh) mb.addEventListener('click', function () { sh.classList.toggle('menu-open'); });
    if (bd) bd.addEventListener('click', closeMenu);
    document.addEventListener('keydown', function (ev) { if (ev.key === 'Escape') closeMenu(); });
  }());

  // ── health ────────────────────────────────────────────────
  fetch('/healthz').then(function (r) { return r.json(); }).then(function (d) {
    el('chip-health').textContent = 'health ' + d.status + ' · v' + d.version;
  }).catch(function () { el('chip-health').textContent = 'health unreachable'; });

  // ── stream helpers ───────────────────────────────────────────
  function scroll() { if (stream) stream.scrollTop = stream.scrollHeight; }
  function clearEmpty() { var e = el('empty'); if (e) e.remove(); }
  function clearStream() {
    if (!stream) return;
    stream.textContent = '';
    var e = make('div', 'empty'); e.id = 'empty'; e.textContent = 'Ask zuse anything to get started.';
    stream.appendChild(e);
    toolCards = {}; permCards = {}; currentText = null; currentCaret = null; thinkingEl = null;
  }

  function addUser(text) {
    clearEmpty();
    var m = make('div', 'msg you');
    var b = make('div', 'bubble'); b.textContent = text; m.appendChild(b);
    stream.appendChild(m); scroll(); return m;
  }
  function startAgent() {
    clearEmpty(); removeThinking();
    var m = make('div', 'msg agent');
    m.appendChild(make('div', 'av'));
    var body = make('div', 'body');
    var nm = make('div', 'name'); nm.textContent = 'zuse'; body.appendChild(nm);
    var tx = make('div', 'text');
    currentText = make('span'); tx.appendChild(currentText);
    currentCaret = make('span', 'caret'); tx.appendChild(currentCaret);
    body.appendChild(tx); m.appendChild(body);
    stream.appendChild(m); scroll();
  }
  function appendDelta(s) { if (!currentText) startAgent(); currentText.textContent += s; scroll(); }
  function endAgent() { if (currentCaret) { currentCaret.remove(); currentCaret = null; } currentText = null; }

  function showThinking() {
    if (!thinking) return;
    removeThinking();
    thinkingEl = make('div', 'msg agent thinking');
    thinkingEl.appendChild(make('div', 'av'));
    var d = make('div', 'dots'); d.appendChild(make('i')); d.appendChild(make('i')); d.appendChild(make('i'));
    thinkingEl.appendChild(d);
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
    c.appendChild(make('span', 'dot'));
    var t = make('span'); t.textContent = state === 'live' ? 'connected' : state === 'connecting' ? 'connecting' : 'offline';
    c.appendChild(t);
    renderStatus();
  }
  function renderStatus() {
    if (!statusline) return;
    statusline.textContent = '';
    statusline.className = 'statusline' + (thinking ? ' warn' : conn === 'live' ? ' live' : '');
    statusline.appendChild(make('span', 'dot'));
    var t = make('span');
    t.textContent = conn !== 'live' ? 'disconnected' : thinking ? 'zuse is working…' : 'ready';
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
      default: break;
    }
  }

  // ── composer ─────────────────────────────────────────────────
  function doSend() {
    var v = input.value.trim();
    if (!v || !ws || ws.readyState !== 1 || thinking) return;
    addUser(v);
    wsSend({ type: 'send', text: v });
    input.value = ''; input.style.height = 'auto';
  }
  function bindChrome() {
    sendBtn.addEventListener('click', doSend);
    stopBtn.addEventListener('click', function () { wsSend({ type: 'interrupt' }); });
    input.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter' && !ev.shiftKey) { ev.preventDefault(); doSend(); }
    });
    input.addEventListener('input', function () {
      input.style.height = 'auto';
      input.style.height = Math.min(input.scrollHeight, 168) + 'px';
    });
    var cb = el('clear-btn'); if (cb) cb.addEventListener('click', function () { clearStream(); closeMenu(); });
  }

  function showChat() {
    el('auth-view').hidden = true;
    el('sidebar').hidden = false;
    el('chat-view').hidden = false;
    stream = el('stream'); input = el('input'); sendBtn = el('send'); stopBtn = el('stop'); statusline = el('statusline');
    bindChrome(); renderStatus(); openWs();
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
