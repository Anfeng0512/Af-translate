import { getSettings, setSettings } from '../settings.js';

const $ = (id) => document.getElementById(id);

let settings = null;
let pageState = null;
let activeTabId = null;

async function init() {
  settings = await getSettings();
  renderSettings();

  const stats = (await chrome.runtime.sendMessage({ type: 'tt:stats' }).catch(() => null)) || {};
  const segments = stats.segments || 0;
  const chars = stats.chars || 0;
  $('stats').textContent = segments ? `${segments} 段 · ${formatChars(chars)}` : '今天还没有翻译';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTabId = tab?.id ?? null;
  pageState = activeTabId ? await sendToPage({ type: 'tt:getState' }) : null;

  renderPage();
  bind();
}

function formatChars(chars) {
  if (chars >= 10000) return `${(chars / 10000).toFixed(1)} 万字`;
  if (chars >= 1000) return `${(chars / 1000).toFixed(1)} 千字`;
  return `${chars} 字`;
}

function renderSettings() {
  $('enabled').checked = !!settings.enabled;
  $('auto').checked = !!settings.auto;
  for (const btn of $('mode').querySelectorAll('button')) {
    btn.setAttribute('aria-pressed', String(btn.dataset.mode === settings.mode));
  }
  const keyBadge = $('keyState');
  if (settings.apiKey) {
    keyBadge.textContent = 'API Key 已配置';
    keyBadge.className = 'badge ok';
  } else {
    keyBadge.textContent = 'API Key 未配置';
    keyBadge.className = 'badge warn';
  }
}

function renderPage() {
  const action = $('action');
  const hint = $('hint');
  const addSite = $('addSite');
  addSite.hidden = true;

  if (!pageState) {
    $('site').textContent = '当前页面不可翻译';
    action.disabled = true;
    action.textContent = '无法翻译此页';
    hint.textContent = '浏览器系统页、应用商店、PDF 阅读器等页面无法注入翻译。';
    return;
  }

  $('site').textContent = pageState.host || '—';
  const active = !!pageState.active;
  action.disabled = false;
  action.classList.toggle('is-ghost', active);
  action.textContent = active ? '还原原文' : '翻译本页';

  if (!settings.apiKey) {
    hint.textContent = '先在「设置」里填入 DeepSeek API Key。';
  } else if (!settings.enabled) {
    hint.textContent = '总开关已关闭，打开后才会翻译。';
  } else if (!pageState.siteMatched && !active) {
    hint.textContent = '当前站点不在自动列表；可以手动翻译，或加入自动列表。';
    if (pageState.host) {
      addSite.hidden = false;
      addSite.textContent = `把 ${pageState.host} 加入自动翻译`;
    }
  } else if (active && pageState.failed) {
    hint.textContent = `${pageState.done} 段已翻译，${pageState.failed} 段失败。`;
  } else if (active) {
    hint.textContent = `${pageState.done} 段译文已插入页面（Alt+T 可切换）。`;
  } else {
    hint.textContent = '快捷键 Alt+T 可翻译 / 还原当前页。';
  }
}

function bind() {
  $('enabled').addEventListener('change', async (event) => {
    settings = await setSettings({ enabled: event.target.checked });
    renderSettings();
    renderPage();
  });

  $('auto').addEventListener('change', async (event) => {
    settings = await setSettings({ auto: event.target.checked });
    renderSettings();
  });

  $('mode').addEventListener('click', async (event) => {
    const btn = event.target.closest('button[data-mode]');
    if (!btn) return;
    settings = await setSettings({ mode: btn.dataset.mode });
    renderSettings();
  });

  $('action').addEventListener('click', async () => {
    if (!pageState) return;
    const type = pageState.active ? 'tt:restore' : 'tt:translate';
    $('action').disabled = true;
    await sendToPage({ type });
    setTimeout(async () => {
      pageState = await sendToPage({ type: 'tt:getState' });
      renderPage();
    }, 350);
  });

  $('addSite').addEventListener('click', async () => {
    if (!pageState?.host) return;
    const sites = [...new Set([...(settings.sites || []), pageState.host])];
    settings = await setSettings({ sites });
    pageState = await sendToPage({ type: 'tt:getState' });
    renderPage();
  });

  $('options').addEventListener('click', () => chrome.runtime.openOptionsPage());
}

async function sendToPage(message) {
  if (!activeTabId) return null;
  try {
    const res = await chrome.tabs.sendMessage(activeTabId, message);
    return res || null;
  } catch {
    return null;
  }
}

init().catch((err) => {
  const hint = $('hint');
  if (hint) hint.textContent = `初始化失败：${err?.message || err}`;
});
