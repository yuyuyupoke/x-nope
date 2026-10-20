// ページ本体のコンテキスト(MAIN world)で動き、X が実際に投げたリクエストを観測する。
// 「興味なし」のクリックが本当に送信につながったかを確かめるために必要。
// 観測結果は postMessage で content.js(isolated world)へ渡すだけで、外部へは一切送らない。

(() => {
  'use strict';

  // テレメトリ等のノイズ。これらは送信の証拠にならない。
  const NOISE = /\/(jot|client_event|analytics|live_pipeline|typeahead|guide\.json|onboarding)/i;
  const INTERESTING = /\/i\/api\//;

  function report(method, url, status) {
    try {
      if (!/^POST$/i.test(method)) return;
      if (!INTERESTING.test(url) || NOISE.test(url)) return;
      // /i/api/graphql/<queryId>/<OperationName> から操作名を取り出す
      const m = url.match(/\/graphql\/[^/]+\/([^/?#]+)/);
      const op = m ? m[1] : url.split('?')[0].split('/').slice(-1)[0];
      // postMessage はページ内の全スクリプトから見えるので、URL 全体は流さず操作名とステータスだけにする
      window.postMessage({ source: 'x-nope-net', op, status, t: Date.now() }, location.origin);
    } catch { /* 観測の失敗で本来の通信を壊さない */ }
  }

  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const url = typeof input === 'string' ? input
        : input instanceof URL ? input.href
        : (input && input.url) || '';
      const method = (init && init.method) || (input && input.method) || 'GET';
      const p = origFetch.apply(this, arguments);
      p.then(res => report(method, url, res.status), () => report(method, url, 0));
      return p;
    };
  }

  const origOpen = XMLHttpRequest.prototype.open;
  const origSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (method, url) {
    this.__xnope = { method: String(method), url: String(url) };
    return origOpen.apply(this, arguments);
  };
  XMLHttpRequest.prototype.send = function () {
    const meta = this.__xnope;
    if (meta) {
      this.addEventListener('loadend', () => report(meta.method, meta.url, this.status), { once: true });
    }
    return origSend.apply(this, arguments);
  };
})();
