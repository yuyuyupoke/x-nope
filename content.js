// x-nope — X のタイムラインで、カーソルを乗せて x キーを押すだけで「興味なし」を送る。
//
// 設計方針:
//   - メニュー項目は data-testid ではなくテキストで照合する（X 側の testid は不安定なため）。
//   - 確信が持てない項目は絶対にクリックしない。ブロックや報告の誤爆は最悪の失敗なので、
//     見つからなければ何もせずメニューを閉じ、実際の項目一覧をコンソールに出して調整可能にする。
//   - 送信は直列キュー。連打してもメニューの開閉が重ならない。

(() => {
  'use strict';

  const SEND_INTERVAL = 300;   // 連続送信の間隔(ms)
  const MENU_TIMEOUT  = 3000;  // メニュー出現の待ち上限(ms)
  const TOAST_MS      = 3200;
  const VERIFY_TIMEOUT = 4000; // 送信リクエストの観測を待つ上限(ms)
  const LOG_LIMIT     = 300;   // 送信ログの保持件数
  const KILL_LIMIT    = 2000;  // 記憶する非表示ツイートの上限
  const UNDO_LIMIT    = 50;    // ⌘Z で戻せる件数
  const UNDO_KEY = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent) ? '⌘Z' : 'Ctrl+Z';

  // 「興味なし」の送信を示す操作名。2026-10 の実測では /i/api/2/timeline/feedback.json への POST。
  // 同じ時間帯にタイムライン更新（timeline.json）やログ（log.json）も飛ぶので、操作名で絞らないと誤判定する。
  const NOT_INTERESTED_OP = /feedback/i;

  // 「興味なし」として採用してよいラベル
  const TARGET_LABELS = [
    '興味がない',
    '興味なし',
    'not interested',
  ];

  // ひとつでも含まれていたら絶対に押さない語（誤爆防止の最終防衛線）
  const DANGER_LABELS = [
    'ブロック', 'ミュート', '報告', '通報', 'フォロー', '削除', 'ピン', '固定',
    '埋め込', 'コピー', 'リスト', 'アナリティクス', 'コミュニティ', 'ブックマーク',
    'block', 'mute', 'report', 'follow', 'delete', 'remove', 'pin', 'embed',
    'copy', 'list', 'analytics', 'communit', 'bookmark',
  ];

  // ---------------------------------------------------------------- 設定

  // X 純正のショートカット（b=ブロック、u=ミュート、l=いいね など）と重なるキーには変えさせない。
  // 重なると、押した瞬間の状況によっては X 側の操作が動いてしまう。
  const RESERVED_KEYS = new Set([...'bgijklmnorstu']);

  const conf = {
    key: () => {
      const k = (localStorage.getItem('xnope.key') || 'x').toLowerCase();
      return /^[a-z0-9]$/.test(k) && !RESERVED_KEYS.has(k) ? k : 'x';
    },
    debug:  () => localStorage.getItem('xnope.debug') === '1',
    labels: () => {
      try {
        const v = JSON.parse(localStorage.getItem('xnope.labels') || '[]');
        // 1文字のような短すぎる文言は、関係ない項目にまで当たるので受け付けない
        return Array.isArray(v) ? v.filter(s => typeof s === 'string' && s.trim().length >= 2) : [];
      } catch { return []; }
    },
  };

  const log = (...a) => conf.debug() && console.log('%c[x-nope]', 'color:#1d9bf0', ...a);

  // ---------------------------------------------------------------- 汎用

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  async function waitFor(fn, timeout = MENU_TIMEOUT, interval = 25) {
    const t0 = performance.now();
    for (;;) {
      let v;
      try { v = fn(); } catch { v = null; }
      if (v) return v;
      if (performance.now() - t0 >= timeout) return null;
      await sleep(interval);
    }
  }

  // React は pointer 系イベントを見ていることがあるので一連を投げる
  function realClick(el) {
    const r = el.getBoundingClientRect();
    const base = {
      bubbles: true, cancelable: true, composed: true, view: window,
      clientX: r.left + r.width / 2, clientY: r.top + r.height / 2,
      button: 0, buttons: 1, isPrimary: true, pointerId: 1, pointerType: 'mouse',
    };
    for (const type of ['pointerover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup', 'click']) {
      const Ctor = type.startsWith('pointer') && typeof PointerEvent === 'function' ? PointerEvent : MouseEvent;
      try { el.dispatchEvent(new Ctor(type, base)); } catch { /* 個々の失敗は無視 */ }
    }
  }

  // その要素が画面上の自分の位置に実際に表示され、クリックが当たる状態か。
  // X は当たり判定のとれない要素へのクリックを無視する（2026-10 実測）。
  function isHittable(el) {
    if (!el.isConnected) return false;
    const r = el.getBoundingClientRect();
    if (!r.width || !r.height) return false;
    const x = r.left + r.width / 2, y = r.top + r.height / 2;
    if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) return false;
    const hit = document.elementFromPoint(x, y);
    return !!hit && (hit === el || el.contains(hit));
  }

  // 当たり判定がとれ、位置が止まるまで待つ（メニューは出た直後しばらく動いている）
  function waitClickable(el, timeout) {
    let prev = null;
    return waitFor(() => {
      if (!isHittable(el)) { prev = null; return false; }
      const r = el.getBoundingClientRect();
      const pos = Math.round(r.left) + ',' + Math.round(r.top);
      const settled = pos === prev;
      prev = pos;
      return settled;
    }, timeout, 40);
  }

  function isTyping() {
    const el = document.activeElement;
    if (!el) return false;
    if (el.isContentEditable) return true;
    const tag = el.tagName;
    if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
    return el.getAttribute?.('role') === 'textbox';
  }

  const norm = s => (s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  function isNotInterested(text) {
    const t = norm(text);
    if (!t) return false;
    if (DANGER_LABELS.some(d => t.includes(d.toLowerCase()))) return false;
    return [...TARGET_LABELS, ...conf.labels()].some(x => t.includes(norm(x)));
  }

  // ---------------------------------------------------------------- 送信の観測

  // net.js(MAIN world) が観測した X へのリクエストを受け取る。
  // これが「本当に送信できたか」の唯一の客観的な証拠になる。
  const netEvents = [];
  addEventListener('message', e => {
    if (e.source !== window) return;
    const d = e.data;
    if (!d || d.source !== 'x-nope-net') return;
    // ページ内の他のスクリプトも同じ形のメッセージを送れるので、型を確かめてから使う
    if (typeof d.op !== 'string' || d.op.length > 100) return;
    if (typeof d.status !== 'number' || !Number.isInteger(d.status)) return;
    if (typeof d.t !== 'number') return;
    netEvents.push({ op: d.op, status: d.status, t: d.t });
    if (netEvents.length > 100) netEvents.shift();
  });

  function writeLog(entry) {
    try {
      const arr = JSON.parse(localStorage.getItem('xnope.log') || '[]');
      arr.push(entry);
      while (arr.length > LOG_LIMIT) arr.shift();
      localStorage.setItem('xnope.log', JSON.stringify(arr));
    } catch { /* 容量超過は無視 */ }
  }

  function readLog() {
    try {
      const v = JSON.parse(localStorage.getItem('xnope.log') || '[]');
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }

  const escapeHtml = s => String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // ---------------------------------------------------------------- DOM 取得

  const articleAt = (x, y) => {
    const el = document.elementFromPoint(x, y);
    return el ? el.closest('article[data-testid="tweet"], article[role="article"]') : null;
  };

  const cellOf = a => a.closest('div[data-testid="cellInnerDiv"]') || a.parentElement;

  function tweetIdOf(article) {
    for (const a of article.querySelectorAll('a[href*="/status/"]')) {
      const m = (a.getAttribute('href') || '').match(/\/status\/(\d+)/);
      if (m) return m[1];
    }
    return null;
  }

  // ---------------------------------------------------------------- 非表示の記憶

  const killed = new Set(load());

  function load() {
    try {
      const v = JSON.parse(localStorage.getItem('xnope.killed') || '[]');
      return Array.isArray(v) ? v : [];
    } catch { return []; }
  }

  function persist() {
    let arr = [...killed];
    if (arr.length > KILL_LIMIT) {
      arr = arr.slice(-KILL_LIMIT);
      killed.clear();
      arr.forEach(id => killed.add(id));
    }
    try { localStorage.setItem('xnope.killed', JSON.stringify(arr)); } catch { /* 容量超過は無視 */ }
  }

  function bumpCounter() {
    const key = 'xnope.count.' + new Date().toISOString().slice(0, 10);
    const n = (parseInt(localStorage.getItem(key) || '0', 10) || 0) + 1;
    try { localStorage.setItem(key, String(n)); } catch { /* noop */ }
    return n;
  }

  // 高さを潰す。ビューポート上端より上だった場合だけスクロールを補正する。
  function hideCell(cell, { compensate = true } = {}) {
    if (!cell || cell.classList.contains('xnope-gone')) return;
    const rect = cell.getBoundingClientRect();
    cell.classList.add('xnope-gone');
    if (compensate && rect.top < 0) {
      const se = document.scrollingElement || document.documentElement;
      se.scrollTop = Math.max(0, se.scrollTop - rect.height);
    }
  }

  // 仮想スクロールで再描画されたときに、消した投稿を消し直す
  new MutationObserver(muts => {
    if (!killed.size) return;
    for (const m of muts) {
      for (const n of m.addedNodes) {
        if (!(n instanceof HTMLElement)) continue;
        const arts = n.matches?.('article') ? [n] : n.querySelectorAll?.('article') ?? [];
        for (const a of arts) {
          const id = tweetIdOf(a);
          if (id && killed.has(id)) hideCell(cellOf(a), { compensate: false });
        }
      }
    }
  }).observe(document.body, { childList: true, subtree: true });

  // ---------------------------------------------------------------- トースト

  function toastRoot() {
    let root = document.getElementById('xnope-toasts');
    if (!root) {
      root = document.createElement('div');
      root.id = 'xnope-toasts';
      document.body.appendChild(root);
    }
    return root;
  }

  function toast(html, { warn = false, ms = TOAST_MS } = {}) {
    const el = document.createElement('div');
    el.className = 'xnope-toast' + (warn ? ' xnope-warn' : '');
    el.innerHTML = html;
    toastRoot().appendChild(el);
    if (ms > 0) setTimeout(() => el.remove(), ms);
    return el;
  }

  // ---------------------------------------------------------------- 送信

  const MENU_SELECTOR = '[role="menu"], [data-testid="Dropdown"]';
  const isSending = () => document.documentElement.classList.contains('xnope-sending');

  // 送信中のメニューは透明なだけで、当たり判定は残っている（消すと X がクリックを受け付けない）。
  // ユーザーの実クリック（isTrusted）が見えない項目（フォローやミュート）に当たらないよう、
  // 送信中はメニュー内への実操作を止める。拡張からのクリックは isTrusted=false なので止まらない。
  for (const type of ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'touchstart', 'touchend']) {
    addEventListener(type, e => {
      if (!e.isTrusted || !isSending()) return;
      if (e.target instanceof Element && e.target.closest(MENU_SELECTOR)) {
        e.preventDefault();
        e.stopImmediatePropagation();
      }
    }, { capture: true });
  }

  function closeMenu() {
    for (const target of [document, document.body]) {
      target.dispatchEvent(new KeyboardEvent('keydown', {
        key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true,
      }));
    }
    const mask = document.querySelector('[data-testid="mask"]');
    if (mask) realClick(mask);
  }

  async function sendNotInterested(article) {
    if (!article.isConnected) {
      return { ok: false, reason: '送信前に投稿がタイムラインから外れた（スクロールで再描画された）' };
    }
    const caret = article.querySelector('[data-testid="caret"]');
    if (!caret) return { ok: false, reason: 'メニューボタンが見つからない' };

    // 開く前からあるメニューは対象外にする（別のポストのメニューを押さないため）
    const before = new Set(document.querySelectorAll(MENU_SELECTOR));
    let menu = null;

    document.documentElement.classList.add('xnope-sending');
    try {
      realClick(caret);

      menu = await waitFor(() =>
        [...document.querySelectorAll(MENU_SELECTOR)].find(m => !before.has(m)));
      if (!menu) return { ok: false, reason: 'メニューが開かなかった' };

      await waitFor(() => menu.querySelectorAll('[role="menuitem"]').length > 0, 800);

      let items = [...menu.querySelectorAll('[role="menuitem"]')];
      if (!items.length) {
        // role が変わった場合の保険。テキストを持つ末端要素を候補にする。
        // 危険語の除外は下の isNotInterested が担保するので、候補が広がっても誤爆はしない。
        items = [...menu.querySelectorAll('div, span, a')]
          .filter(el => (el.innerText || '').trim() && el.querySelectorAll('div, span, a').length === 0);
        log('menuitem が見つからないのでフォールバック候補を使用:', items.length);
      }
      const labels = items.map(el => (el.innerText || el.textContent || '').trim());
      log('メニュー項目:', labels);

      const idx = labels.findIndex(isNotInterested);
      if (idx < 0) {
        console.warn('[x-nope] 「興味なし」に一致する項目がなかったので何もしませんでした。\n' +
          '実際のメニュー項目: ' + JSON.stringify(labels) + '\n' +
          'この中の正しいラベルを次のように登録すると次回から動きます:\n' +
          "  localStorage.setItem('xnope.labels', JSON.stringify(['ここにラベル']))");
        return { ok: false, reason: '「興味なし」の項目が見つからない', labels };
      }

      // ここから先が「本当に送れたか」の検証。
      // 項目をクリックしても React に届いていなければリクエストは飛ばない。
      const target = items[idx];
      // メニューは出た直後の約 0.1 秒、位置が動いていてクリックが当たらない。止まってから押す
      await waitClickable(target, 1000);

      netEvents.length = 0;
      const t0 = Date.now();
      const sent = () => netEvents.find(e => e.t >= t0 - 100 && NOT_INTERESTED_OP.test(e.op));
      realClick(target);
      let clicks = 1;

      // X は押された項目を処理するとメニューを閉じる。閉じないまま送信も見えなければ、
      // クリックが無視されたとみなして同じ項目を押し直す（最大 2 回）
      for (let retry = 0; retry < 2; retry++) {
        if (await waitFor(() => sent() || !menu.isConnected, 700, 40)) break;
        if (!target.isConnected) break;
        await waitClickable(target, 500);
        log('クリックが無視されたので押し直す:', retry + 1);
        realClick(target);
        clicks++;
      }

      const ev = await waitFor(sent, VERIFY_TIMEOUT, 40);
      // 失敗の原因を後から追えるように残す（押した回数・メニューが閉じたか）
      const diag = { clicks, menuClosed: !menu.isConnected };

      if (!ev) {
        const seen = [...new Set(netEvents.filter(e => e.t >= t0 - 100).map(e => e.op))];
        if (seen.length) log('興味なし以外の送信だけ観測:', seen);
        return {
          ok: false, label: labels[idx], seen, ...diag,
          reason: 'メニュー項目は押したが、送信リクエストが観測されなかった',
        };
      }
      if (ev.status < 200 || ev.status >= 300) {
        return {
          ok: false, label: labels[idx], op: ev.op, status: ev.status, ...diag,
          reason: `送信したが X が HTTP ${ev.status} を返した`,
        };
      }
      return { ok: true, label: labels[idx], op: ev.op, status: ev.status, ...diag };
    } catch (e) {
      return { ok: false, reason: String(e && e.message || e) };
    } finally {
      // メニューがもう閉じているなら何もしない（Escape で投稿画面などを閉じてしまわないように）
      if (menu && menu.isConnected) closeMenu();
      document.documentElement.classList.remove('xnope-sending');
    }
  }

  // ---------------------------------------------------------------- キュー

  const queue = [];
  let draining = false;

  async function drain() {
    if (draining) return;
    draining = true;
    while (queue.length) {
      const job = queue.shift();
      try { await job(); } catch (e) { console.warn('[x-nope] 送信ジョブが失敗:', e); }
      if (queue.length) await sleep(SEND_INTERVAL);
    }
    draining = false;
  }

  function enqueue(job) {
    queue.push(job);
    drain();
  }

  // ---------------------------------------------------------------- 本体

  const undoStack = [];

  function nope(article) {
    const id   = tweetIdOf(article);
    const cell = cellOf(article);
    if (!cell) return;
    if (id && killed.has(id)) return;      // 二重処理を防ぐ
    if (cell.classList.contains('xnope-gone') || cell.classList.contains('xnope-pending')) return;

    // すぐ見えなくするが、送信が終わるまでは高さを潰さない。
    // 潰したり当たり判定を消したりすると、X が「…」メニューを開かなくなる（2026-10 実測）。
    cell.classList.add('xnope-pending');
    if (id) { killed.add(id); persist(); }
    const entry = { cell, id, undone: false };
    undoStack.push(entry);
    if (undoStack.length > UNDO_LIMIT) undoStack.shift();

    const n = bumpCounter();
    // 結果が確定するまで消さない（ms: 0）
    const t = toast(`興味なし <span class="xnope-hint">送信中… ・ 今日 ${n} 件</span>`, { ms: 0 });

    enqueue(async () => {
      const res = await sendNotInterested(article);
      // 送れたかどうかに関わらず、ここで初めて高さを潰す（⌘Z で戻されていなければ）
      if (!entry.undone) hideCell(cell);
      cell.classList.remove('xnope-pending');
      writeLog({
        t: Date.now(), id, ok: !!res.ok,
        op: res.op ?? null, status: res.status ?? null, reason: res.reason ?? null,
        clicks: res.clicks ?? null, menuClosed: res.menuClosed ?? null, seen: res.seen ?? null,
      });

      if (res.ok) {
        const html = `✓ 興味なし <span class="xnope-hint">送信を確認 ` +
          `(${escapeHtml(res.op)} → ${escapeHtml(res.status)}) ・ 今日 ${n} 件 ・ ${UNDO_KEY} で表示を戻す</span>`;
        if (t.isConnected) { t.innerHTML = html; setTimeout(() => t.remove(), TOAST_MS); }
        else toast(html);
        log('送信を確認:', res, id);
        return;
      }

      // 送信できていないが、表示は消したままにする（少なくともこの投稿はもう見ない）。
      t.remove();
      toast(
        `⚠️ 興味なしを送れていない<span class="xnope-hint"><br>${escapeHtml(res.reason)}<br>` +
        `表示は消したまま。詳細はコンソール</span>`,
        { warn: true, ms: 6000 }
      );
      console.warn('[x-nope] 送信失敗:', res);
    });
  }

  function undo() {
    const last = undoStack.pop();
    if (!last) return;
    last.undone = true;
    last.cell.classList.remove('xnope-gone', 'xnope-pending');
    if (last.id) { killed.delete(last.id); persist(); }
    toast('表示を戻した <span class="xnope-hint">送信済みのシグナルは取り消せない</span>');
  }

  // ---------------------------------------------------------------- 入力

  let mx = -1, my = -1;
  addEventListener('mousemove', e => { mx = e.clientX; my = e.clientY; }, { passive: true, capture: true });

  addEventListener('keydown', e => {
    if (!e.isTrusted) return;   // ページ側が合成したキー入力では動かない

    // 送信中にフォーカスが見えないメニューにあるとき、Enter / Space で項目を選ばせない
    if (isSending() && (e.key === 'Enter' || e.key === ' ') && document.activeElement?.closest?.(MENU_SELECTOR)) {
      e.preventDefault();
      e.stopImmediatePropagation();
      return;
    }
    if (isTyping()) return;

    // ⌘Z（Windows は Ctrl+Z）で直前の非表示を戻す
    if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'z') {
      if (!undoStack.length) return;
      e.preventDefault();
      e.stopPropagation();
      undo();
      return;
    }

    if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
    if (e.key.toLowerCase() !== conf.key()) return;

    // ポストの上でなくてもキーは X 側へ渡さない（X のショートカットと混ざらないように）
    e.preventDefault();
    e.stopImmediatePropagation();
    if (e.repeat) return;   // 長押しで連発しない

    const article = mx < 0 ? null : articleAt(mx, my);
    if (article) nope(article);
  }, { capture: true });

  console.log('%c[x-nope]%c 起動。ツイートにカーソルを乗せて %c' + conf.key() +
    '%c キーで「興味なし」。' + UNDO_KEY + ' で表示を戻す。',
    'color:#1d9bf0;font-weight:bold', '', 'font-weight:bold', '');

  // 初回だけ画面に案内を出す（インストールできたことをコンソールを開かずに確かめられるように）
  if (!localStorage.getItem('xnope.welcomed')) {
    toast(`x-nope が有効になりました<span class="xnope-hint"><br>` +
      `ポストにカーソルを乗せて ${escapeHtml(conf.key())} キーで「興味なし」・ ${UNDO_KEY} で表示を戻す</span>`,
      { ms: 10000 });
    try { localStorage.setItem('xnope.welcomed', '1'); } catch { /* noop */ }
  }

  {
    const l = readLog();
    if (l.length) {
      const ok = l.filter(e => e.ok).length;
      console.log(`%c[x-nope]%c 送信ログ ${l.length} 件: 送信確認 ${ok} / 失敗 ${l.length - ok}` +
        (ok < l.length ? ' ← 失敗あり' : '') +
        '\n  一覧: console.table(JSON.parse(localStorage.getItem("xnope.log")))',
        'color:#1d9bf0;font-weight:bold', '');
    }
  }
})();
