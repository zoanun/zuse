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
  // 第 N 轮 eval。超时归因只对**最新**一轮负责，否则连改两次代码会误报上一轮。
  var EVAL_SEQ = 0;
  var MODULE_START_TIMEOUT_MS = 3000;
  // 「模块跑完了但页面还是空的」的判定延迟。要比 MODULE_START 长：模块体先执行、
  // 之后 React 才提交渲染，而 createRoot 的提交是异步的。
  var EMPTY_RENDER_TIMEOUT_MS = 4000;
  // 本轮 eval 产生过多少条控制台输出。**这是「空白」提示的抑制条件**：
  // 「写个快排打印一下」是完全合法的用法 —— 页面本来就该是空的，结果在控制台面板里。
  // 只按「#app 为空」判定会对这类代码误报（实测会），反倒把一条正确的提示变成噪音。
  var OUTPUT_SINCE_EVAL = 0;

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
      OUTPUT_SINCE_EVAL++;
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
        var runId = ++EVAL_SEQ;
        OUTPUT_SINCE_EVAL = 0;
        var script = document.createElement('script');
        script.type = 'module';
        script.setAttribute('data-preview-injected', '');
        // type=module 里抛的错不可靠地触发该元素的 onerror，所以 window.onerror 那头也挂着。
        script.onerror = function () { post({ type: 'error', message: '模块加载失败' }); };
        // **模块级 import 失败是完全静默的**（实测：window.onerror 不触发、
        // unhandledrejection 不触发、script.onerror 也不可靠）——最典型的场景是
        // /preview-vendor/* 取不到，现象是「预览一片空白 + 控制台零输出」，无从下手。
        // 所以让模块自己报到：模块体只在**所有 import 都解析成功**后才执行，
        // 超时还没报到就说明卡在 import 上，给一条能定位的错误。
        script.textContent = 'window.__zuseRan = ' + runId + ';\\n' + data.js;
        document.body.appendChild(script);
        setTimeout(function () {
          if (runId !== EVAL_SEQ) return;          // 已经有下一轮了，这一轮不用管
          if (window.__zuseRan === runId) return;  // 跑起来了
          post({
            type: 'error',
            message: '预览没能启动：模块体一直没有执行，说明某个 import 没解析成功。'
              + '最常见的原因是 import map 指向的 /preview-vendor/* 取不到'
              + '（vendor 产物由 packages/web/scripts/build-preview-vendor.mjs 生成到 public/preview-vendor/）。',
          });
        }, MODULE_START_TIMEOUT_MS);
        // **模块跑完了、也没报错，但页面还是空的** —— 这是另一种完全静默的失败，
        // 上面那个 import 探针抓不到（它只管模块体有没有开始执行）。
        // 最常见的成因：Vue 的 SFC 编译产物会自动 createApp().mount('#app')，
        // 而 React/JSX 不会 —— 模型只写 "export default function App()" 就到此为止，
        // （注意：本注释在模板字符串内部，**不能用反引号** —— 会把模板字符串提前终止。）
        // 现象是「iframe 在、里面永久空白、控制台零输出」，和真 bug 长得一模一样。
        // 与其猜测组件名去自动挂载（改写 export default 遇到字符串里含该字面量就出错），
        // 不如把静默失败换成一条能照着做的提示。
        setTimeout(function () {
          if (runId !== EVAL_SEQ) return;
          if (window.__zuseRan !== runId) return;  // 压根没跑起来，上面那条已经报过了
          if (OUTPUT_SINCE_EVAL > 0) return;       // 有控制台输出 = 这段代码本来就不渲染，别误报
          var app = document.getElementById('app');
          if (!app || app.firstChild) return;      // 渲染出东西了
          // 用户自己往 body 里塞了内容（不经过 #app）也算跑通了，别误报。
          if (document.body.querySelector('[data-preview-injected]') !== document.body.lastElementChild) return;
          post({
            type: 'error',
            message: '代码跑完了，但页面上什么都没有。React / JSX 需要你自己挂载，例如：\\n'
              + "  import { createRoot } from 'react-dom/client'\\n"
              + "  createRoot(document.getElementById('app')).render(<App />)\\n"
              + '（Vue 单文件组件会自动挂载，不用写这句。）',
          });
        }, EMPTY_RENDER_TIMEOUT_MS);
      }
      reportHeight();
    }
  });

  post({ type: 'ready' });
})();`
}
