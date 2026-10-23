/**
 * TechTranslate 内容脚本。
 *
 * 职责：
 * 1. 找出 GitHub / 文档页里的「正文块」（p、li、标题、引用、表格单元…），跳过代码块；
 * 2. 逐块向后台请求流式译文，译文插在原文下方，形成双语对照；
 * 3. 跟随 GitHub 的 Turbo 局部刷新（MutationObserver + URL 变化）增量翻译新内容；
 * 4. 右键「翻译选中文字」时在选区旁弹出译文小卡片。
 */
(() => {
  'use strict';
  if (window.__techTranslate && window.__techTranslate.version) return;

  const VERSION = '1.0.0';
  const BLOCK_SELECTOR = 'p, li, h1, h2, h3, h4, h5, h6, blockquote, dt, dd, figcaption, summary, td, th';
  const SKIP_CLOSEST =
    '.dshtr-block, pre, code, kbd, samp, script, style, textarea, svg, math, ' +
    '[contenteditable="true"], .highlight, .blob-code, .js-file-line, [data-dshtr-skip]';

  const FALLBACK_SETTINGS = {
    enabled: false,
    auto: true,
    mode: 'bilingual',
    apiKey: '',
    sites: ['github.com', 'gist.github.com', 'gitlab.com', 'developer.mozilla.org'],
    concurrency: 3,
    maxBatchChars: 1600
  };

  const state = {
    settings: null,
    mode: 'bilingual',
    active: false,
    running: false,
    rescan: false,
    blocks: new Map(),
    byText: new Map(),
    seq: 0,
    reqSeq: 0,
    port: null,
    pending: new Map(),
    doneCount: 0,
    failedCount: 0,
    errorShown: false,
    scanTimer: 0,
    lastHref: location.href,
    card: null,
    cardText: '',
    cardReqId: '',
    lastError: ''
  };

  /* ------------------------------ 设置 ------------------------------ */

  async function loadSettings() {
    try {
      const { settings } = await chrome.storage.local.get('settings');
      return { ...FALLBACK_SETTINGS, ...(settings || {}) };
    } catch {
      return { ...FALLBACK_SETTINGS };
    }
  }

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const next = { ...FALLBACK_SETTINGS, ...(changes.settings.newValue || {}) };
    const modeChanged = next.mode !== state.mode;
    state.settings = next;
    state.mode = next.mode || 'bilingual';
    if (modeChanged) applyMode();
    if (!next.enabled && state.active) {
      restore();
      return;
    }
    if (next.enabled && !state.active && next.auto && isAutoSite()) {
      setTimeout(() => {
        if (!state.active) autoStart();
      }, 500);
    }
  });

  function hostMatches(url, sites) {
    let host = '';
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return false;
    }
    return (sites || []).some((raw) => {
      const pattern = String(raw || '')
        .trim()
        .toLowerCase()
        .replace(/^https?:\/\//, '')
        .replace(/\/.*$/, '');
      if (!pattern) return false;
      if (pattern.startsWith('*.')) {
        const base = pattern.slice(2);
        return host === base || host.endsWith(`.${base}`);
      }
      return host === pattern || host.endsWith(`.${pattern}`);
    });
  }

  function isAutoSite() {
    return !!state.settings && hostMatches(location.href, state.settings.sites);
  }

  /* ---------------------------- 文本与块识别 ---------------------------- */

  function normalizeText(text) {
    return String(text || '')
      .replace(/\u00a0/g, ' ')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .replace(/[ \t]{2,}/g, ' ')
      .trim();
  }

  function mostlyChinese(text) {
    const cjk = (text.match(/[\u3400-\u9fff\uf900-\ufaff]/g) || []).length;
    if (!cjk) return false;
    const latin = (text.match(/[A-Za-z]/g) || []).length;
    return cjk / (cjk + latin) > 0.12;
  }

  function shouldTranslate(text) {
    if (!text || text.length < 2 || text.length > 6000) return false;
    if (!/[A-Za-z]{2}/.test(text)) return false;
    if (!/\s/.test(text) && text.length < 4) return false;
    if (mostlyChinese(text)) return false;
    if (/^(https?:\/\/|www\.)\S+$/i.test(text)) return false;
    return true;
  }

  function directText(el, excludeTags = ['UL', 'OL']) {
    let out = '';
    for (const node of el.childNodes) {
      if (node.nodeType === 1 && excludeTags.includes(node.tagName)) continue;
      out += node.textContent || '';
    }
    return normalizeText(out);
  }

  /**
   * li 里带子列表时仍然可以翻直属文本；但带 <p>/<div> 等块级子节点的交给子节点处理。
   */
  function isLeafBlock(el) {
    const hasBlocks = !!el.querySelector('p, div, ul, ol, table, blockquote, pre, section, details');
    if (!hasBlocks) return true;
    if (el.matches('li, dd, dt')) {
      return !el.querySelector('p, div, table, blockquote, pre, section, details');
    }
    return false;
  }

  function findRoots() {
    const roots = [];
    const seen = new Set();
    const add = (el) => {
      if (!el || seen.has(el)) return;
      seen.add(el);
      roots.push(el);
    };

    // GitHub：README、issue 正文、评论、wiki 都在 .markdown-body 里
    const md = document.querySelectorAll('.markdown-body, .comment-body');
    if (md.length) md.forEach(add);
    if (!roots.length) {
      document.querySelectorAll('article, main, [role="main"]').forEach(add);
    }
    if (!roots.length) add(document.body);
    return roots;
  }

  function collectBlocks() {
    cleanup();
    const roots = findRoots();
    const seen = new Set();
    const out = [];
    for (const root of roots) {
      let nodes;
      try {
        nodes = root.querySelectorAll(BLOCK_SELECTOR);
      } catch {
        continue;
      }
      for (const el of nodes) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (out.length >= 500) break;
        if (!isLeafBlock(el)) continue;
        const info = register(el);
        if (info) out.push(info);
      }
    }
    return out;
  }

  function register(el) {
    if (el.__dshtr) return null;
    if (el.closest(SKIP_CLOSEST)) return null;
    if (el.closest('#dshtr-card')) return null;

    const inlineTarget = el.matches('li, dd, dt, td, th, figcaption');
    const text = inlineTarget ? directText(el) : normalizeText(el.innerText);
    if (!shouldTranslate(text)) return null;

    const id = `s${++state.seq}`;
    const node = document.createElement('div');
    node.className = 'dshtr-block';
    node.dataset.dshtrId = id;
    node.lang = 'zh-CN';
    node.setAttribute('translate', 'no');
    node.setAttribute('aria-label', '中文译文');

    let wrap = null;
    let hideTarget = el;

    if (inlineTarget) {
      node.classList.add('dshtr-inline');
      wrap = wrapInline(el);
      if (wrap) {
        hideTarget = wrap;
        wrap.insertAdjacentElement('afterend', node);
      } else {
        el.appendChild(node);
      }
    } else {
      if (/^H[1-6]$/.test(el.tagName)) {
        node.classList.add('dshtr-heading');
        try {
          const size = parseFloat(getComputedStyle(el).fontSize) || 24;
          node.style.fontSize = `${Math.max(13, Math.round(size * 0.55))}px`;
        } catch {
          /* 忽略 */
        }
      }
      el.insertAdjacentElement('afterend', node);
    }

    const info = {
      id,
      el,
      node,
      wrap,
      hideTarget,
      text,
      status: 'pending',
      shown: false,
      pendingText: '',
      raf: 0
    };
    el.__dshtr = info;
    state.blocks.set(id, info);

    const reused = state.byText.get(text);
    if (reused) applyTranslation(info, reused, true);
    return info;
  }

  /**
   * 把元素里的行内内容包进一个 span，供「仅中文」模式只隐藏原文、不破坏列表/表格结构。
   */
  function wrapInline(el) {
    if (el.querySelector(':scope > .dshtr-src-wrap')) return el.querySelector(':scope > .dshtr-src-wrap');
    const wrap = document.createElement('span');
    wrap.className = 'dshtr-src-wrap';
    const move = [];
    for (const node of [...el.childNodes]) {
      if (node.nodeType === 1 && (node.tagName === 'UL' || node.tagName === 'OL')) continue;
      move.push(node);
    }
    if (!move.length) return null;
    el.insertBefore(wrap, move[0]);
    for (const node of move) wrap.appendChild(node);
    return wrap;
  }

  function unwrapInline(info) {
    if (!info.wrap || !info.wrap.parentNode) return;
    const wrap = info.wrap;
    const parent = wrap.parentNode;
    while (wrap.firstChild) parent.insertBefore(wrap.firstChild, wrap);
    wrap.remove();
  }

  function applyTranslation(info, text, immediate) {
    if (!text) return;
    info.pendingText = text;
    if (immediate) {
      info.raf = 0;
      flush(info);
    } else if (!info.raf) {
      info.raf = requestAnimationFrame(() => {
        info.raf = 0;
        flush(info);
      });
    }
  }

  function flush(info) {
    const text = info.pendingText;
    if (!text || !info.node.isConnected) return;
    info.node.textContent = text;
    const same = text.trim() === info.text.trim();
    info.node.classList.toggle('dshtr-same', same);
    if (!info.shown) {
      info.shown = true;
      info.status = 'done';
      state.doneCount += 1;
      state.byText.set(info.text, text);
      if (state.mode === 'zh' && !same) info.hideTarget.classList.add('dshtr-src-hidden');
    }
  }

  function markFailed(ids, message) {
    let marked = 0;
    for (const id of ids) {
      const info = state.blocks.get(id);
      if (!info || info.shown) continue;
      info.status = 'failed';
      state.failedCount += 1;
      info.node.textContent = marked === 0 ? `⚠ 翻译失败：${message}` : '⚠ 翻译失败';
      info.node.classList.add('dshtr-failed');
      marked += 1;
    }
    if (marked) {
      state.lastError = message;
      showErrorBar(message);
    }
  }

  /* ---------------------------- 批次与后台通信 ---------------------------- */

  function getPort() {
    if (state.port) return state.port;
    const port = chrome.runtime.connect({ name: 'tt' });
    port.onMessage.addListener(onPortMessage);
    port.onDisconnect.addListener(() => {
      state.port = null;
      failAllPending('后台连接已断开，请刷新页面重试');
    });
    state.port = port;
    return port;
  }

  function failAllPending(message) {
    for (const entry of state.pending.values()) {
      clearTimeout(entry.timer);
      markFailed(entry.ids, message);
      entry.resolve();
    }
    state.pending.clear();
  }

  function onPortMessage(msg) {
    if (!msg || typeof msg !== 'object') return;

    if (msg.type === 'part') {
      if (msg.id === 'sel') {
        updateCard(msg.text, false);
        return;
      }
      const info = state.blocks.get(msg.id);
      if (info) applyTranslation(info, msg.text, !!msg.cached);
      return;
    }

    if (msg.type === 'done') {
      const entry = state.pending.get(msg.reqId);
      if (entry) {
        clearTimeout(entry.timer);
        state.pending.delete(msg.reqId);
        entry.resolve();
      }
      if (msg.reqId === state.cardReqId) {
        finishCard();
        state.cardReqId = '';
      }
      return;
    }

    if (msg.type === 'error') {
      const entry = state.pending.get(msg.reqId);
      if (entry) {
        clearTimeout(entry.timer);
        state.pending.delete(msg.reqId);
        markFailed(entry.ids, msg.message || '翻译失败');
        entry.resolve();
      }
      if (msg.reqId === state.cardReqId) {
        updateCard(`⚠ ${msg.message || '翻译失败'}`, true);
        state.cardReqId = '';
      }
    }
  }

  function makeBatches(items) {
    const maxChars = state.settings?.maxBatchChars || 1600;
    const batches = [];
    let cur = [];
    let chars = 0;
    for (const item of items) {
      if (cur.length >= 8 || (cur.length && chars + item.text.length > maxChars)) {
        batches.push(cur);
        cur = [];
        chars = 0;
      }
      cur.push(item);
      chars += item.text.length;
    }
    if (cur.length) batches.push(cur);
    return batches;
  }

  async function runQueue(items) {
    const batches = makeBatches(items);
    if (!batches.length) return;
    let cursor = 0;
    const concurrency = Math.min(state.settings?.concurrency || 3, batches.length);
    await Promise.all(
      Array.from({ length: concurrency }, async () => {
        while (cursor < batches.length) {
          if (!state.active) return;
          const batch = batches[cursor++];
          await translateBatch(batch);
        }
      })
    );
  }

  function translateBatch(batch) {
    if (!batch.length || !state.active) return Promise.resolve();
    const reqId = `r${++state.reqSeq}`;
    ensureKeepAlive();
    return new Promise((resolve) => {
      const entry = { ids: batch.map((b) => b.id), resolve, timer: 0 };
      entry.timer = setTimeout(() => {
        state.pending.delete(reqId);
        markFailed(entry.ids, '请求超时');
        resolve();
      }, 240_000);
      state.pending.set(reqId, entry);

      try {
        getPort().postMessage({
          type: 'translate',
          reqId,
          segments: batch.map((b) => ({ id: b.id, text: b.text })),
          url: location.href,
          title: document.title
        });
      } catch {
        clearTimeout(entry.timer);
        state.pending.delete(reqId);
        markFailed(entry.ids, '扩展后台不可用，请刷新页面');
        resolve();
      }
    });
  }

  /* ---------------------------- 主流程 ---------------------------- */

  let keepAliveTimer = 0;

  /** 请求首字慢时给 Service Worker 发心跳，避免 30 秒空闲被回收 */
  function ensureKeepAlive() {
    if (keepAliveTimer) return;
    keepAliveTimer = setInterval(() => {
      if (!state.pending.size) {
        clearInterval(keepAliveTimer);
        keepAliveTimer = 0;
        return;
      }
      try {
        state.port?.postMessage({ type: 'ping' });
      } catch {
        /* ignore */
      }
    }, 20_000);
  }

  async function translatePage(options = {}) {
    const silent = !!options.silent;
    if (!state.settings) return;
    if (state.running) {
      state.rescan = true;
      return;
    }
    if (!state.settings.enabled) {
      if (!silent) toast('扩展已关闭，请先在弹窗里打开总开关', 'warn', true);
      return;
    }
    if (!state.settings.apiKey) {
      if (!silent) toast('还没有配置 DeepSeek API Key，请点扩展图标 → 设置', 'error', true);
      return;
    }

    state.running = true;
    state.active = true;
    state.errorShown = false;
    state.lastError = '';
    hideErrorBar();
    document.documentElement.classList.toggle('dshtr-zh', state.mode === 'zh');
    try {
      do {
        state.rescan = false;
        const fresh = collectBlocks();
        const retry = [...state.blocks.values()].filter(
          (b) => !b.shown && (b.status === 'failed' || b.status === 'pending') && !fresh.includes(b)
        );
        for (const info of retry) {
          info.status = 'pending';
          info.node.textContent = '';
          info.node.classList.remove('dshtr-failed');
        }
        const items = [...fresh, ...retry];
        if (!items.length) break;
        // 单次扫描最多 500 块，长页面（awesome list 之类）需要继续下一轮
        if (fresh.length >= 500) state.rescan = true;
        await runQueue(items);
        if (!state.active) break;
      } while (state.rescan);

      if (state.active) {
        if (state.failedCount) {
          // 具体原因已经由常驻错误条展示，不再用 toast 覆盖
        } else {
          hideErrorBar();
          if (state.doneCount && !silent) toast(`已翻译 ${state.doneCount} 段`, 'ok');
        }
      }
    } finally {
      state.running = false;
    }
  }

  function restore() {
    for (const [reqId, entry] of state.pending) {
      try {
        state.port?.postMessage({ type: 'cancel', reqId });
      } catch {
        /* ignore */
      }
      clearTimeout(entry.timer);
      entry.resolve();
    }
    state.pending.clear();

    for (const info of state.blocks.values()) {
      info.node.remove();
      info.hideTarget?.classList.remove('dshtr-src-hidden');
      if (info.wrap) unwrapInline(info);
      if (info.el) delete info.el.__dshtr;
    }
    state.blocks.clear();
    state.byText.clear();
    state.seq = 0;
    state.doneCount = 0;
    state.failedCount = 0;
    state.active = false;
    state.running = false;
    state.rescan = false;
    document.documentElement.classList.remove('dshtr-zh');
    hideErrorBar();
    closeCard();
  }

  function cleanup() {
    for (const [id, info] of state.blocks) {
      if (!info.el.isConnected) {
        info.node.remove();
        state.blocks.delete(id);
        if (info.wrap) unwrapInline(info);
        if (info.el) delete info.el.__dshtr;
      }
    }
  }

  function applyMode() {
    document.documentElement.classList.toggle('dshtr-zh', state.mode === 'zh');
    for (const info of state.blocks.values()) {
      const same = info.node.classList.contains('dshtr-same');
      if (state.mode === 'zh' && info.shown && !same) info.hideTarget.classList.add('dshtr-src-hidden');
      else info.hideTarget.classList.remove('dshtr-src-hidden');
    }
  }

  function scheduleScan(delay = 600) {
    clearTimeout(state.scanTimer);
    state.scanTimer = setTimeout(() => {
      if (state.active && !state.running) translatePage({ silent: true });
      else if (state.active) state.rescan = true;
    }, delay);
  }

  function autoStart() {
    if (!state.settings?.apiKey) return;
    if (!state.settings.enabled) return;
    if (state.active) return;
    translatePage({ silent: true });
  }

  function onUrlChange() {
    if (state.active) restore();
    if (state.settings?.enabled && state.settings.auto && isAutoSite()) {
      setTimeout(() => {
        if (!state.active) autoStart();
      }, 900);
    }
  }

  function installObserver() {
    const observer = new MutationObserver((mutations) => {
      if (location.href !== state.lastHref) {
        state.lastHref = location.href;
        onUrlChange();
        return;
      }
      if (!state.active) return;
      let dirty = false;
      for (const mutation of mutations) {
        for (const node of mutation.addedNodes) {
          if (node.nodeType !== 1) continue;
          if (node.classList?.contains('dshtr-block') || node.classList?.contains('dshtr-src-wrap')) continue;
          if (node.closest?.('.dshtr-block, .dshtr-src-wrap')) continue;
          dirty = true;
          break;
        }
        if (dirty) break;
      }
      if (dirty) scheduleScan();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    window.addEventListener('popstate', onUrlChange);
    document.addEventListener('turbo:load', onUrlChange);
  }

  /* ---------------------------- 提示与选中翻译 ---------------------------- */

  function toast(message, kind = 'info', once = false) {
    if (once && state.errorShown) return;
    if (once) state.errorShown = true;
    document.querySelectorAll('.dshtr-toast').forEach((el) => el.remove());
    const el = document.createElement('div');
    el.className = `dshtr-toast dshtr-toast-${kind}`;
    el.setAttribute('role', 'status');
    el.textContent = message;
    document.body.appendChild(el);
    requestAnimationFrame(() => el.classList.add('dshtr-toast-in'));
    setTimeout(() => {
      el.classList.remove('dshtr-toast-in');
      setTimeout(() => el.remove(), 300);
    }, 3600);
  }

  function hideErrorBar() {
    document.querySelectorAll('.dshtr-errorbar').forEach((el) => el.remove());
  }

  /** 常驻错误条：把「翻译失败」的具体原因、重试和设置入口固定显示在页面底部 */
  function showErrorBar(message) {
    const existing = document.querySelector('.dshtr-errorbar');
    if (existing) {
      existing.querySelector('.dshtr-errorbar-msg').textContent = message;
      return;
    }
    const bar = document.createElement('div');
    bar.className = 'dshtr-errorbar';
    bar.setAttribute('role', 'alert');
    bar.innerHTML = `
      <div class="dshtr-errorbar-msg"></div>
      <div class="dshtr-errorbar-actions">
        <button type="button" data-act="retry">重试</button>
        <button type="button" data-act="settings">设置</button>
        <button type="button" data-act="close" aria-label="关闭">×</button>
      </div>
    `;
    bar.querySelector('.dshtr-errorbar-msg').textContent = message;
    document.body.appendChild(bar);
    bar.addEventListener('click', (event) => {
      const btn = event.target.closest('button[data-act]');
      if (!btn) return;
      if (btn.dataset.act === 'retry') {
        hideErrorBar();
        translatePage();
      } else if (btn.dataset.act === 'settings') {
        hideErrorBar();
        try {
          chrome.runtime.sendMessage({ type: 'tt:open-options' });
        } catch {
          /* ignore */
        }
      } else {
        hideErrorBar();
      }
    });
  }

  function isDarkPage() {
    try {
      const bg = getComputedStyle(document.body).backgroundColor;
      const m = bg.match(/rgba?\(([^)]+)\)/);
      if (!m) return false;
      const [r, g, b] = m[1].split(',').map((n) => parseFloat(n));
      return 0.299 * r + 0.587 * g + 0.114 * b < 120;
    } catch {
      return false;
    }
  }

  function closeCard(cancel = true) {
    if (!state.card) return;
    if (cancel && state.cardReqId && state.port) {
      try {
        state.port.postMessage({ type: 'cancel', reqId: state.cardReqId });
      } catch {
        /* ignore */
      }
    }
    state.card.remove();
    state.card = null;
    state.cardText = '';
    state.cardReqId = '';
  }

  function updateCard(text, final) {
    if (!state.card) return;
    const body = state.card.querySelector('.dshtr-card-body');
    body.textContent = text;
    body.classList.toggle('is-final', !!final);
    state.cardText = text;
    const copy = state.card.querySelector('.dshtr-copy');
    if (copy) copy.disabled = !final;
  }

  function finishCard() {
    if (!state.card) return;
    state.card.querySelector('.dshtr-card-body')?.classList.add('is-final');
    const copy = state.card.querySelector('.dshtr-copy');
    if (copy) copy.disabled = !state.cardText;
  }

  function showSelectionCard(text) {
    const selected = String(text || '').trim();
    if (!selected) return;
    closeCard();
    const settings = state.settings || FALLBACK_SETTINGS;
    if (!settings.apiKey) {
      toast('还没有配置 DeepSeek API Key，请点扩展图标 → 设置', 'error', true);
      return;
    }

    let rect = null;
    const selection = window.getSelection();
    if (selection && selection.rangeCount) {
      try {
        rect = selection.getRangeAt(0).getBoundingClientRect();
      } catch {
        rect = null;
      }
    }

    const card = document.createElement('div');
    card.id = 'dshtr-card';
    card.className = `dshtr-card${isDarkPage() ? ' dshtr-dark' : ''}`;
    card.innerHTML = `
      <div class="dshtr-card-head">
        <span class="dshtr-card-title">TechTranslate</span>
        <button class="dshtr-card-close" type="button" title="关闭">×</button>
      </div>
      <div class="dshtr-card-src"></div>
      <div class="dshtr-card-body"><span class="dshtr-dots"><i></i><i></i><i></i></span></div>
      <div class="dshtr-card-foot"><button class="dshtr-copy" type="button" disabled>复制译文</button></div>
    `;
    card.querySelector('.dshtr-card-src').textContent = selected.length > 300 ? `${selected.slice(0, 300)}…` : selected;

    const width = Math.min(440, window.innerWidth - 24);
    let left = rect ? rect.left : 24;
    let top = rect ? rect.bottom + 10 : 80;
    left = Math.max(12, Math.min(left, window.innerWidth - width - 12));
    card.style.width = `${width}px`;
    card.style.left = `${left}px`;
    card.style.top = `${top}px`;
    document.body.appendChild(card);

    const height = card.getBoundingClientRect().height;
    if (top + height > window.innerHeight - 12 && rect) {
      card.style.top = `${Math.max(12, rect.top - height - 10)}px`;
    }

    state.card = card;
    card.querySelector('.dshtr-card-close').addEventListener('click', () => closeCard());
    card.querySelector('.dshtr-copy').addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(state.cardText);
        const btn = card.querySelector('.dshtr-copy');
        btn.textContent = '已复制';
        setTimeout(() => (btn.textContent = '复制译文'), 1200);
      } catch {
        toast('复制失败，请手动选择译文', 'warn');
      }
    });

    const reqId = `sel${++state.reqSeq}`;
    state.cardReqId = reqId;
    const truncated = selected.length > 4000 ? selected.slice(0, 4000) : selected;
    try {
      getPort().postMessage({
        type: 'translate',
        reqId,
        segments: [{ id: 'sel', text: truncated }],
        url: location.href,
        title: document.title
      });
    } catch {
      updateCard('⚠ 扩展后台不可用，请刷新页面', true);
    }
  }

  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key === 'Escape') closeCard();
    },
    true
  );

  /* ---------------------------- 对外接口 ---------------------------- */

  chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'tt:getState':
        sendResponse(getState());
        break;
      case 'tt:toggle':
        if (state.active) restore();
        else translatePage();
        sendResponse({ ok: true, active: state.active });
        break;
      case 'tt:translate':
        translatePage();
        sendResponse({ ok: true });
        break;
      case 'tt:restore':
        restore();
        sendResponse({ ok: true });
        break;
      case 'tt:selection':
        showSelectionCard(msg.text);
        sendResponse({ ok: true });
        break;
      default:
        break;
    }
  });

  function getState() {
    return {
      ok: true,
      version: VERSION,
      host: location.hostname,
      enabled: !!state.settings?.enabled,
      auto: !!state.settings?.auto,
      siteMatched: isAutoSite(),
      mode: state.mode,
      active: state.active,
      running: state.running,
      total: state.blocks.size,
      done: state.doneCount,
      failed: state.failedCount
    };
  }

  // 供调试 / 自动化测试使用
  window.__techTranslate = {
    version: VERSION,
    translate: translatePage,
    restore,
    toggle: () => (state.active ? restore() : translatePage()),
    showSelection: showSelectionCard,
    getState,
    state
  };

  async function init() {
    state.settings = await loadSettings();
    state.mode = state.settings.mode || 'bilingual';
    if (state.mode === 'zh') document.documentElement.classList.add('dshtr-zh');
    installObserver();
    if (state.settings.enabled && state.settings.auto && isAutoSite()) {
      setTimeout(() => {
        if (!state.active) autoStart();
      }, 800);
    }
  }

  init();
})();
