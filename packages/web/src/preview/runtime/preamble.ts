/**
 * 注入 guest 文档最前面的脚本源码（字符串，不是模块 —— 它在另一个 document 里执行）。
 *
 * 放在这里而不是 .js + ?raw：它要被单测直接读来做特征断言，字符串模块最省事。
 *
 * 三条设计约束都落在这个文件里：
 * 1. **高度必须由 guest 自己上报**。父页读 `iframe.contentDocument.body.scrollHeight` 要求同源，
 *    那会把「要不要换成真沙箱」这个决策永久锁死。guest 内部挂 ResizeObserver 则始终可后悔。
 * 2. **每个 postMessage 都要能降级**。`console.log(组件实例)`、循环引用对象都无法结构化克隆，
 *    抛 DataCloneError；而它抛在被 patch 的 console.log 里 —— 现象是「日志面板从某行起不动了」，
 *    极难定位。所以一律 try/catch + toString 降级。
 * 3. **绝不能用 `location.origin` 做同源判断**。srcdoc 文档里它恒为字符串 "null"，
 *    即使 allow-same-origin 生效、能摸到 parent.document 时也一样（真浏览器实测）。
 */
export function preambleSource(token: string): string {
  return `(function () {
  var TOKEN = ${JSON.stringify(token)};

  // 结构化克隆的降级链。JSON.stringify 靠不住（循环引用直接抛），所以逐级退。
  function toText(v) {
    if (typeof v === 'string') return v;
    try {
      if (v instanceof Error) return v.stack || (v.name + ': ' + v.message);
      if (v === null || v === undefined || typeof v !== 'object') return String(v);
      return JSON.stringify(v);
    } catch (e) {}
    try { return Object.prototype.toString.call(v); } catch (e) {}
    return typeof v;
  }

  // 一律 targetOrigin '*'：opaque origin 下没有别的值能匹配上。
  // 安全性不靠这里 —— 父页用 event.source + token 鉴别（见 PreviewProxy）。
  function post(msg) {
    msg.token = TOKEN;
    try { parent.postMessage(msg, '*'); }
    catch (e) {
      // 兜底：把 args 全压成字符串再发一次。压不动就彻底放弃这一条，
      // 绝不能让日志桥因为一条日志而永久哑掉。
      try {
        if (msg.args) { msg.args = msg.args.map(toText); parent.postMessage(msg, '*'); }
      } catch (e2) {}
    }
  }

  var LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
  LEVELS.forEach(function (level) {
    var orig = console[level];
    console[level] = function () {
      var args = Array.prototype.slice.call(arguments);
      try { orig.apply(console, args); } catch (e) {}
      post({ type: 'log', level: level, args: args.map(toText) });
    };
  });

  window.onerror = function (message, source, lineno, colno, error) {
    post({ type: 'error', message: toText(message), stack: error && error.stack ? String(error.stack) : undefined });
  };
  window.addEventListener('unhandledrejection', function (ev) {
    post({ type: 'error', message: 'Unhandled rejection: ' + toText(ev.reason) });
  });

  // 高度上报：约束 1。首帧也发一次，否则内容为空时父页拿不到初值。
  var lastH = -1;
  function reportHeight() {
    var h = Math.ceil(document.documentElement.scrollHeight || document.body.scrollHeight || 0);
    if (h !== lastH) { lastH = h; post({ type: 'resize', height: h }); }
  }
  if (typeof ResizeObserver !== 'undefined') {
    new ResizeObserver(reportHeight).observe(document.documentElement);
  }
  window.addEventListener('load', reportHeight);

  window.addEventListener('message', function (ev) {
    // 只收父页的消息。srcdoc 下 ev.origin 恒为 "null"，校验它没有意义（约束 3）。
    if (ev.source !== parent) return;
    var data = ev.data || {};
    if (data.type === 'theme') {
      document.documentElement.setAttribute('data-theme', data.theme);
      return;
    }
    if (data.type === 'eval') {
      // 清掉上一轮的产物再注入新的。iframe 本身不重建（那会销毁整个 document，
      // 而流式吐 token 会触发几百次重建），所以这里要自己收拾干净。
      var prev = document.querySelectorAll('[data-preview-injected]');
      for (var i = 0; i < prev.length; i++) prev[i].remove();
      var root = document.getElementById('app');
      if (root) root.innerHTML = '';

      (data.styles || []).forEach(function (s) {
        var el = document.createElement('style');
        el.setAttribute('data-preview-injected', '');
        el.textContent = s.code;
        document.head.appendChild(el);
      });

      if (data.js) {
        var script = document.createElement('script');
        script.type = 'module';
        script.setAttribute('data-preview-injected', '');
        // type=module 里抛的错不可靠地触发该元素的 onerror，所以 window.onerror 那头也挂着。
        script.onerror = function () { post({ type: 'error', message: '模块加载失败' }); };
        script.textContent = data.js;
        document.body.appendChild(script);
      }
      reportHeight();
    }
  });

  post({ type: 'ready' });
})();`
}
