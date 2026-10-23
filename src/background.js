/**
 * 后台 Service Worker：
 * - 承接内容脚本的翻译请求（端口流式返回），负责分批提示词、缓存、重试；
 * - 承接弹窗/设置页的管理请求（测试 Key、用量、清缓存）；
 * - 注册右键菜单与快捷键。
 */
import { getSettings } from './settings.js';
import { buildMessages, pickGlossary, PROMPT_VERSION } from './prompt.js';
import { parseMarkers } from './markers.js';
import { cacheGetMany, cacheSetMany, clearCache, cacheSize, hashKey } from './cache.js';
import { streamChat, modelsEndpointOf, isLocalEndpoint, TranslateError } from './llm.js';

const MAX_SEGMENTS_PER_REQUEST = 12;

chrome.runtime.onInstalled.addListener(() => {
  setupMenus();
});
chrome.runtime.onStartup.addListener(() => {
  setupMenus();
});

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'tt-toggle-page',
      title: '翻译 / 还原此页（TechTranslate）',
      contexts: ['page']
    });
    chrome.contextMenus.create({
      id: 'tt-translate-selection',
      title: '翻译选中文字',
      contexts: ['selection']
    });
  });
}

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab?.id) return;
  if (info.menuItemId === 'tt-toggle-page') {
    sendToTab(tab.id, { type: 'tt:toggle' });
  } else if (info.menuItemId === 'tt-translate-selection') {
    const text = String(info.selectionText || '').trim();
    if (text) sendToTab(tab.id, { type: 'tt:selection', text });
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'toggle-page') return;
  const target = tab?.id ? tab : (await chrome.tabs.query({ active: true, lastFocusedWindow: true }))[0];
  if (target?.id) sendToTab(target.id, { type: 'tt:toggle' });
});

function sendToTab(tabId, message) {
  chrome.tabs.sendMessage(tabId, message).catch(() => {
    /* 页面上没有内容脚本（chrome://、扩展页等）时忽略 */
  });
}

/* ------------------------------------------------------------------ */
/* 端口：内容脚本 -> 翻译                                              */
/* ------------------------------------------------------------------ */

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'tt') return;
  const controllers = new Map();

  port.onMessage.addListener((msg) => {
    if (!msg || typeof msg !== 'object') return;
    if (msg.type === 'translate') {
      if (!msg.reqId || controllers.has(msg.reqId)) return;
      const ctrl = new AbortController();
      controllers.set(msg.reqId, ctrl);
      handleTranslate(port, msg, ctrl.signal)
        .catch((err) => {
          post(port, {
            type: 'error',
            reqId: msg.reqId,
            code: err?.code || 'internal',
            message: err?.message || '翻译失败'
          });
        })
        .finally(() => controllers.delete(msg.reqId));
    } else if (msg.type === 'cancel') {
      controllers.get(msg.reqId)?.abort();
    }
  });

  port.onDisconnect.addListener(() => {
    for (const ctrl of controllers.values()) ctrl.abort();
    controllers.clear();
  });
});

function post(port, payload) {
  try {
    port.postMessage(payload);
  } catch {
    /* 端口已断开 */
  }
}

function normalizeSegments(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const seg of raw) {
    if (!seg || typeof seg.id !== 'string' || typeof seg.text !== 'string') continue;
    const text = seg.text.trim();
    if (!text || text.length > 8000 || seen.has(seg.id)) continue;
    seen.add(seg.id);
    out.push({ id: seg.id, text });
  }
  return out.slice(0, MAX_SEGMENTS_PER_REQUEST);
}

async function handleTranslate(port, msg, signal) {
  const reqId = msg.reqId;
  const settings = await getSettings();
  if (!settings.apiKey) {
    return post(port, {
      type: 'error',
      reqId,
      code: 'auth',
      message: '还没有配置 DeepSeek API Key，请点扩展图标 → 设置 填写。'
    });
  }

  const segments = normalizeSegments(msg.segments);
  if (!segments.length) return post(port, { type: 'done', reqId, translated: 0, cached: 0, missing: [] });

  const lang = settings.targetLang || '简体中文';
  const keys = await Promise.all(
    segments.map((s) => hashKey(`${settings.model}|${lang}|${PROMPT_VERSION}|${s.text}`))
  );
  const cachedMap = await cacheGetMany(keys);
  const done = new Map();
  const cachedIds = new Set();

  segments.forEach((seg, i) => {
    const hit = cachedMap[keys[i]];
    if (typeof hit === 'string' && hit) {
      done.set(seg.id, hit);
      cachedIds.add(seg.id);
      post(port, { type: 'part', reqId, id: seg.id, text: hit, cached: true });
    }
  });

  const cachedFresh = new Set();

  for (let attempt = 0; attempt < 2 && !signal.aborted; attempt++) {
    const queue = segments.filter((s) => !done.has(s.id));
    if (!queue.length) break;

    const messages = buildMessages({
      segments: queue,
      title: msg.title || '',
      url: msg.url || '',
      glossary: pickGlossary(queue, settings.glossaryExtra),
      targetLang: lang,
      strict: attempt > 0
    });

    const lastSent = new Map();
    const emit = (acc) => {
      for (const [id, text] of parseMarkers(acc)) {
        if (!text || done.has(id) || lastSent.get(id) === text) continue;
        lastSent.set(id, text);
        post(port, { type: 'part', reqId, id, text });
      }
    };

    let acc = '';
    try {
      acc = await requestWithRetry(settings, messages, emit, signal);
    } catch (err) {
      if (signal.aborted) return;
      const e = err instanceof TranslateError ? err : new TranslateError('internal', err?.message || '翻译失败');
      return post(port, { type: 'error', reqId, code: e.code, message: e.message });
    }
    if (signal.aborted) return;

    for (const [id, text] of parseMarkers(acc)) {
      if (text && !done.has(id)) {
        done.set(id, text);
        post(port, { type: 'part', reqId, id, text });
      }
    }

    const toCache = [];
    segments.forEach((seg, i) => {
      const text = done.get(seg.id);
      if (!text || cachedIds.has(seg.id) || cachedFresh.has(seg.id)) return;
      cachedFresh.add(seg.id);
      toCache.push({ key: keys[i], text });
    });
    if (toCache.length) await cacheSetMany(toCache).catch(() => {});
  }

  if (signal.aborted) return;

  const missing = segments.filter((s) => !done.has(s.id)).map((s) => s.id);
  const fresh = segments.filter((s) => done.has(s.id) && !cachedIds.has(s.id)).length;

  if (!done.size) {
    return post(port, {
      type: 'error',
      reqId,
      code: 'bad-output',
      message: '模型没有按约定格式返回译文，请重试。'
    });
  }

  await bumpStats({
    segments: done.size,
    chars: segments.filter((s) => done.has(s.id)).reduce((n, s) => n + s.text.length, 0)
  }).catch(() => {});

  post(port, {
    type: 'done',
    reqId,
    translated: fresh,
    cached: cachedIds.size,
    missing
  });
}

async function requestWithRetry(settings, messages, onDelta, signal) {
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (signal.aborted) throw lastErr || new TranslateError('aborted', '已取消');
    try {
      return await streamChat({ settings, messages, onDelta, signal });
    } catch (err) {
      lastErr = err;
      const retriable = err?.code === 'rate' || err?.code === 'server' || err?.code === 'network';
      if (!retriable || attempt === 2) break;
      await sleep(700 * (attempt + 1));
    }
  }
  throw lastErr;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/* ------------------------------------------------------------------ */
/* 弹窗 / 设置页 的管理请求                                            */
/* ------------------------------------------------------------------ */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg !== 'object') return false;

  if (msg.type === 'tt:test-key') {
    testKey(msg.settings || {})
      .then(sendResponse)
      .catch((err) => sendResponse({ ok: false, message: err?.message || '测试失败' }));
    return true;
  }

  if (msg.type === 'tt:stats') {
    getStats()
      .then(sendResponse)
      .catch(() => sendResponse({ segments: 0, chars: 0, requests: 0, date: '' }));
    return true;
  }

  if (msg.type === 'tt:cache-size') {
    cacheSize()
      .then((n) => sendResponse({ ok: true, size: n }))
      .catch(() => sendResponse({ ok: false, size: 0 }));
    return true;
  }

  if (msg.type === 'tt:clear-cache') {
    clearCache()
      .then((n) => sendResponse({ ok: true, removed: n }))
      .catch((err) => sendResponse({ ok: false, message: err?.message }));
    return true;
  }

  if (msg.type === 'tt:open-options') {
    try {
      chrome.runtime.openOptionsPage();
    } catch {
      /* ignore */
    }
    sendResponse({ ok: true });
    return false;
  }

  return false;
});

async function testKey(override = {}) {
  const settings = { ...(await getSettings()), ...override };
  if (!settings.apiKey) return { ok: false, message: '请先填写 API Key' };
  if (settings.baseUrl && !/^https?:\/\//i.test(settings.baseUrl)) {
    return { ok: false, message: 'Base URL 必须以 http:// 或 https:// 开头' };
  }

  try {
    const res = await fetch(modelsEndpointOf(settings.baseUrl), {
      headers: { authorization: `Bearer ${settings.apiKey}` },
      signal: AbortSignal.timeout(20_000)
    });
    if (res.ok) {
      let count = 0;
      try {
        const json = await res.json();
        count = Array.isArray(json?.data) ? json.data.length : 0;
      } catch {
        /* 有些兼容端点不返回 JSON */
      }
      return { ok: true, message: count ? `连接成功，可用模型 ${count} 个` : '连接成功' };
    }
    const detail = await res.text().catch(() => '');
    const err = mapStatus(res.status, detail, settings.baseUrl);
    return { ok: false, message: err };
  } catch (err) {
    return {
      ok: false,
      message: isLocalEndpoint(settings.baseUrl)
        ? '连不上本地模型服务。确认 Ollama 正在运行（ollama serve），Base URL 是 http://127.0.0.1:11434/v1。'
        : err?.message || '连接失败，请检查网络、代理或 Base URL'
    };
  }
}

function mapStatus(status, detail, baseUrl) {
  const local = isLocalEndpoint(baseUrl);
  if (local && (status === 401 || status === 403)) {
    return 'Ollama 拒绝了扩展来源（HTTP 403）。完全退出 Ollama 后，用 OLLAMA_ORIGINS=* 重新启动：$env:OLLAMA_ORIGINS="*"; ollama serve';
  }
  if (local && status === 404) {
    return '本地服务没有这个接口（HTTP 404）。Base URL 要带 /v1，例如 http://127.0.0.1:11434/v1';
  }
  if (status === 401 || status === 403) return 'API Key 无效或没有权限';
  if (status === 402) return '账户余额不足';
  if (status === 404) return '接口地址不存在，请检查 Base URL（例如 https://api.deepseek.com）';
  if (status === 429) return '请求过于频繁，稍后再试';
  return `服务返回 HTTP ${status}${detail ? `：${String(detail).replace(/\s+/g, ' ').slice(0, 120)}` : ''}`;
}

async function getStats() {
  const today = new Date().toISOString().slice(0, 10);
  const { stats } = await chrome.storage.local.get('stats');
  if (!stats || stats.date !== today) {
    return { date: today, segments: 0, chars: 0, requests: 0 };
  }
  return stats;
}

/** 并发批次会同时读写同一份计数，串行化避免丢更新 */
let statsChain = Promise.resolve();

function bumpStats(delta) {
  statsChain = statsChain.then(() => applyStatsDelta(delta)).catch(() => {});
  return statsChain;
}

async function applyStatsDelta({ segments = 0, chars = 0, requests = 1 }) {
  const today = new Date().toISOString().slice(0, 10);
  const { stats } = await chrome.storage.local.get('stats');
  const base = stats && stats.date === today ? stats : { date: today, segments: 0, chars: 0, requests: 0 };
  await chrome.storage.local.set({
    stats: {
      date: today,
      segments: base.segments + segments,
      chars: base.chars + chars,
      requests: base.requests + requests
    }
  });
}
