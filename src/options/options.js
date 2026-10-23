import { getSettings, setSettings, DEFAULT_SITES } from '../settings.js';

const $ = (id) => document.getElementById(id);

let settings = null;

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
}

async function init() {
  settings = await getSettings();
  $('apiKey').value = settings.apiKey || '';
  $('baseUrl').value = settings.baseUrl || 'https://api.deepseek.com';
  $('model').value = settings.model || 'deepseek-chat';
  $('sites').value = (settings.sites || DEFAULT_SITES).join('\n');
  $('glossary').value = settings.glossaryExtra || '';
  $('concurrency').value = settings.concurrency;
  $('maxChars').value = settings.maxBatchChars;
  const mode = document.querySelector(`input[name="mode"][value="${settings.mode}"]`);
  if (mode) mode.checked = true;

  refreshCache();
  bind();
}

function bind() {
  $('toggleKey').addEventListener('click', () => {
    const input = $('apiKey');
    const show = input.type === 'password';
    input.type = show ? 'text' : 'password';
    $('toggleKey').textContent = show ? '隐藏' : '显示';
  });

  $('save').addEventListener('click', save);
  $('test').addEventListener('click', test);
  $('resetSites').addEventListener('click', () => {
    $('sites').value = DEFAULT_SITES.join('\n');
  });
  $('clearCache').addEventListener('click', async () => {
    const res = await chrome.runtime.sendMessage({ type: 'tt:clear-cache' }).catch(() => null);
    if (res?.ok) {
      toast(`已清空 ${res.removed} 条缓存`, 'ok');
      refreshCache();
    } else {
      toast(res?.message || '清空失败', 'err');
    }
  });
}

async function save() {
  const baseUrl = $('baseUrl').value.trim() || 'https://api.deepseek.com';
  if (!/^https?:\/\//i.test(baseUrl)) {
    toast('Base URL 必须以 http:// 或 https:// 开头', 'err');
    return;
  }
  const model = $('model').value.trim() || 'deepseek-chat';
  const apiKey = $('apiKey').value.trim();
  const sites = $('sites')
    .value.split('\n')
    .map((s) => s.trim())
    .filter(Boolean);
  const mode = document.querySelector('input[name="mode"]:checked')?.value || 'bilingual';
  const concurrency = clamp(parseInt($('concurrency').value, 10) || 3, 1, 6);
  const maxBatchChars = clamp(parseInt($('maxChars').value, 10) || 1600, 400, 6000);
  const glossaryExtra = $('glossary').value;

  // 先申请权限（必须在点击手势里），再写设置
  const granted = await ensureHostAccess(baseUrl);

  settings = await setSettings({
    apiKey,
    baseUrl,
    model,
    sites: sites.length ? sites : DEFAULT_SITES,
    mode,
    concurrency,
    maxBatchChars,
    glossaryExtra
  });

  if (granted) toast('设置已保存', 'ok');
  else toast('设置已保存，但没有获得该接口域名的访问权限，自定义端点可能调用失败', 'warn');
}

async function ensureHostAccess(baseUrl) {
  let origin;
  let hostname;
  try {
    const url = new URL(baseUrl);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
    hostname = url.hostname;
    origin = `${url.origin}/*`;
  } catch {
    return false;
  }

  // 这几个域名已写进 manifest 的 host_permissions，无需再弹授权
  if (hostname === 'api.deepseek.com' || hostname === 'localhost' || hostname === '127.0.0.1') {
    return true;
  }

  try {
    // chrome.permissions.request 必须在点击手势里调用，所以放在第一个 await
    return await chrome.permissions.request({ origins: [origin] });
  } catch {
    return false;
  }
}

async function test() {
  const baseUrl = $('baseUrl').value.trim() || 'https://api.deepseek.com';
  const apiKey = $('apiKey').value.trim();
  const model = $('model').value.trim() || 'deepseek-chat';
  const out = $('testResult');
  out.className = 'test-result';
  out.textContent = '正在测试…';

  if (!apiKey) {
    out.classList.add('err');
    out.textContent = '请先填写 API Key';
    return;
  }

  const granted = await ensureHostAccess(baseUrl);
  if (!granted) {
    out.classList.add('err');
    out.textContent = '没有该域名的访问权限，请在浏览器提示中允许';
    return;
  }

  const res = await chrome.runtime
    .sendMessage({ type: 'tt:test-key', settings: { apiKey, baseUrl, model } })
    .catch((err) => ({ ok: false, message: err?.message || '测试失败' }));

  out.classList.add(res?.ok ? 'ok' : 'err');
  out.textContent = res?.message || (res?.ok ? '连接成功' : '测试失败');
}

async function refreshCache() {
  const res = await chrome.runtime.sendMessage({ type: 'tt:cache-size' }).catch(() => null);
  $('cacheSize').textContent = res?.ok ? `${res.size} 条` : '—';
}

let toastTimer = 0;
function toast(message, kind = 'ok') {
  const el = $('toast');
  el.textContent = message;
  el.className = `toast show ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = `toast ${kind}`;
  }, 2600);
}

init().catch((err) => toast(`初始化失败：${err?.message || err}`, 'err'));
