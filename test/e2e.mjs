/**
 * 真实 Chrome + 本地 mock API 的端到端测试。
 *
 * 覆盖：扩展加载 → 设置写入 → 自动翻译 → 流式渲染 → 双语/仅中文 → 还原 → 缓存命中 → 选中翻译。
 * 运行：node test/e2e.mjs
 */
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMockServer } from './mock-server.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
/** 可用 EXT_DIR 指向解压后的发布包，验证 zip 是否完整 */
const EXT_DIR = process.env.EXT_DIR ? path.resolve(process.env.EXT_DIR) : ROOT;
const CHROME =
  process.env.CHROME_PATH ||
  (process.platform === 'win32'
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : 'google-chrome');
const DEBUG_PORT = Number(process.env.DEBUG_PORT || 9333);

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function log(step, message) {
  console.log(`\x1b[36m[${step}]\x1b[0m ${message}`);
}

function ok(message) {
  console.log(`\x1b[32m  ✓\x1b[0m ${message}`);
}

/* ------------------------------- CDP ------------------------------- */

class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.ws = new WebSocket(wsUrl);
    this.ready = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', resolve, { once: true });
      this.ws.addEventListener('error', reject, { once: true });
    });
    this.ws.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return;
      }
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject, timer } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        clearTimeout(timer);
        if (msg.error) reject(new Error(`${msg.error.message} (${msg.error.code})`));
        else resolve(msg.result);
      } else if (msg.method) {
        for (const fn of this.listeners) fn(msg);
      }
    });
  }

  static async connect(wsUrl) {
    const cdp = new Cdp(wsUrl);
    await cdp.ready;
    return cdp;
  }

  send(method, params = {}, timeout = 20000) {
    const id = ++this.id;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeout);
      this.pending.set(id, { resolve, reject, timer });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(fn) {
    this.listeners.push(fn);
  }

  async evaluate(expression, { awaitPromise = false } = {}) {
    const res = await this.send('Runtime.evaluate', {
      expression,
      returnByValue: true,
      awaitPromise,
      userGesture: true
    });
    if (res.exceptionDetails) {
      const text = res.exceptionDetails.exception?.description || res.exceptionDetails.text;
      throw new Error(`页面脚本异常：${text}`);
    }
    return res.result?.value;
  }

  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

async function httpJson(url, method = 'GET') {
  const res = await fetch(url, { method });
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

async function listTargets() {
  return httpJson(`http://127.0.0.1:${DEBUG_PORT}/json/list`);
}

async function openPage(url, { onConnect } = {}) {
  const target = await httpJson(`http://127.0.0.1:${DEBUG_PORT}/json/new?about:blank`, 'PUT');
  if (!target?.webSocketDebuggerUrl) throw new Error(`无法新建页面：${url}`);
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl);
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  onConnect?.(cdp);
  await cdp.send('Page.navigate', { url });
  await waitFor(
    async () => {
      const ready = await cdp.evaluate(`document.readyState === 'complete' && location.href.startsWith(${JSON.stringify(url.slice(0, 30))})`);
      return ready || null;
    },
    { timeout: 20000, label: `页面加载：${url}` }
  );
  return { target, cdp, url };
}

async function closeTarget(id) {
  try {
    await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/close/${id}`);
  } catch {
    /* ignore */
  }
}

async function waitFor(fn, { timeout = 20000, interval = 200, label = '条件' } = {}) {
  const started = Date.now();
  let lastErr;
  while (Date.now() - started < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (err) {
      lastErr = err;
    }
    await sleep(interval);
  }
  throw new Error(`等待「${label}」超时${lastErr ? `：${lastErr.message}` : ''}`);
}

/* ------------------------------ 启动 Chrome ------------------------------ */

async function launchChrome(profileDir) {
  if (!existsSync(CHROME)) throw new Error(`找不到 Chrome：${CHROME}`);
  const args = [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-component-update',
    '--disable-features=Translate,TranslateUI',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profileDir}`,
    `--remote-debugging-port=${DEBUG_PORT}`,
    '--window-size=1200,900',
    'about:blank'
  ];
  if (process.platform === 'linux') args.push('--no-sandbox', '--disable-dev-shm-usage');
  const child = spawn(CHROME, args, { stdio: process.env.CI ? ['ignore', 'inherit', 'inherit'] : 'ignore' });
  child.on('error', (err) => console.error('Chrome 启动失败：', err.message));
  await waitFor(
    async () => {
      try {
        const version = await httpJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
        return version?.Browser;
      } catch {
        return null;
      }
    },
    { timeout: 20000, label: 'Chrome DevTools 端口' }
  );
  return child;
}

async function loadExtension() {
  // Chrome 137+ 起 --load-extension 在正式版被禁用，改用 CDP Extensions.loadUnpacked
  const version = await httpJson(`http://127.0.0.1:${DEBUG_PORT}/json/version`);
  const browser = await Cdp.connect(version.webSocketDebuggerUrl);
  const { id } = await browser.send('Extensions.loadUnpacked', { path: EXT_DIR });
  browser.close();
  return id;
}

async function findServiceWorker(id) {
  for (let i = 0; i < 60; i++) {
    const targets = await listTargets().catch(() => []);
    const sw = targets.find(
      (t) => t.type === 'service_worker' && String(t.url).startsWith(`chrome-extension://${id}/`)
    );
    if (sw?.['webSocketDebuggerUrl']) return sw;
    await sleep(250);
  }
  throw new Error('未找到扩展 Service Worker，扩展可能没有加载成功');
}

async function storageSet(cdp, settings) {
  await cdp.evaluate(
    `(async () => { await chrome.storage.local.set({ settings: ${JSON.stringify(settings)} }); return true; })()`,
    { awaitPromise: true }
  );
}

async function sendToContent(cdp, message) {
  return cdp.evaluate(
    `(async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (!tab) return { error: 'no active tab' };
      try { return await chrome.tabs.sendMessage(tab.id, ${JSON.stringify(message)}); }
      catch (err) { return { error: err.message }; }
    })()`,
    { awaitPromise: true }
  );
}

/* ------------------------------- 测试主体 ------------------------------- */

async function main() {
  const artifactDir = path.join(ROOT, 'test', 'artifacts');
  await mkdir(artifactDir, { recursive: true });

  const mock = await startMockServer();
  log('mock', `本地翻译接口：${mock.baseUrl}/v1`);

  const profileDir = await mkdtemp(path.join(tmpdir(), 'tt-e2e-'));
  let chrome;
  let swCdp = null;
  try {
    chrome = await launchChrome(profileDir);
    log('chrome', '已启动（headless）');

    const extensionId = await loadExtension();
    log('extension', `扩展 id：${extensionId}`);
    const swTarget = await findServiceWorker(extensionId);
    swCdp = await Cdp.connect(swTarget.webSocketDebuggerUrl);
    ok('扩展已加载，Service Worker 就绪');

    const settings = {
      enabled: true,
      auto: true,
      mode: 'bilingual',
      targetLang: '简体中文',
      apiKey: 'test-key',
      baseUrl: `${mock.baseUrl}/v1`,
      model: 'deepseek-chat',
      sites: ['127.0.0.1', 'github.com'],
      glossaryExtra: '',
      maxBatchChars: 1600,
      concurrency: 2,
      selectionEnabled: true
    };

    await storageSet(swCdp, settings);
    ok('设置已写入 chrome.storage.local');

    log('page', '打开测试页…');
    const consoleErrors = [];
    const pageTab = await openPage(`${mock.baseUrl}/page.html`, {
      onConnect: (cdp) => {
        cdp.on((msg) => {
          if (msg.method === 'Runtime.exceptionThrown') {
            consoleErrors.push(msg.params.exceptionDetails?.exception?.description || 'unknown exception');
          }
        });
      }
    });
    const cdp = pageTab.cdp;

    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1200,
      height: 900,
      deviceScaleFactor: 1,
      mobile: false
    });

    log('translate', '等待自动翻译（流式渲染）…');
    const firstPass = await waitFor(
      async () => {
        const state = await cdp.evaluate(`(() => {
          const blocks = [...document.querySelectorAll('.dshtr-block')];
          return { total: blocks.length, filled: blocks.filter(b => b.textContent.trim()).length };
        })()`);
        return state.filled >= 8 ? state : null;
      },
      { timeout: 30000, label: '译文渲染' }
    );
    ok(`渲染出 ${firstPass.filled} 段译文`);

    const summary = await cdp.evaluate(`(() => {
      const blocks = [...document.querySelectorAll('.dshtr-block')].map((n) => n.textContent.trim());
      const sourceP = [...document.querySelectorAll('.markdown-body > p')].find((p) => p.textContent.startsWith('This library'));
      const zhP = [...document.querySelectorAll('.markdown-body > p')].find((p) => p.textContent.includes('中文段落'));
      const pre = document.querySelector('.markdown-body pre');
      return {
        blockCount: blocks.length,
        blocks,
        sourceVisible: getComputedStyle(sourceP).display !== 'none' && getComputedStyle(sourceP).visibility !== 'hidden',
        zhFollowedByTranslation: !!zhP?.nextElementSibling?.classList?.contains('dshtr-block'),
        preText: pre.textContent,
        preHasTranslation: !!pre.querySelector('.dshtr-block'),
        inlineCode: document.querySelector('.markdown-body p code').textContent,
        zhMode: document.documentElement.classList.contains('dshtr-zh'),
        wraps: document.querySelectorAll('.dshtr-src-wrap').length
      };
    })()`);

    const assert = (condition, message) => {
      if (!condition) throw new Error(`断言失败：${message}`);
      ok(message);
    };

    assert(summary.blockCount >= 8, `译文块数量 ${summary.blockCount} ≥ 8`);
    assert(summary.blocks.includes('这个库开箱即用，无需任何配置。'), '命中指定术语的段落译成预期中文');
    assert(summary.sourceVisible, '双语模式下原文仍然可见');
    assert(!summary.zhFollowedByTranslation, '已是中文的段落被跳过');
    assert(!summary.preHasTranslation && summary.preText.includes('npm install tech-translate'), '代码块未被翻译');
    assert(
      summary.inlineCode === 'out of the box',
      `行内代码未被改写（实际：${JSON.stringify(summary.inlineCode)}）`
    );
    assert(!summary.zhMode, '默认不是「仅中文」模式');

    await cdp.send('Page.captureScreenshot', { format: 'png' }).then(async (shot) => {
      await writeFile(path.join(artifactDir, 'translated.png'), Buffer.from(shot.data, 'base64'));
    });
    ok('截图已保存 test/artifacts/translated.png');

    // 缓存：还原后重新翻译，不应再发请求
    const requestsBefore = mock.stats.requests;
    await sendToContent(swCdp, { type: 'tt:restore' });
    await waitFor(async () => (await cdp.evaluate(`document.querySelectorAll('.dshtr-block').length === 0`)) || null, {
      label: '还原'
    });
    const restored = await cdp.evaluate(`({
      blocks: document.querySelectorAll('.dshtr-block').length,
      wraps: document.querySelectorAll('.dshtr-src-wrap').length,
      sourceVisible: [...document.querySelectorAll('.markdown-body > p')].some((p) => p.textContent.startsWith('This library') && getComputedStyle(p).display !== 'none')
    })`);
    assert(restored.blocks === 0 && restored.wraps === 0 && restored.sourceVisible, '还原后 DOM 干净、原文恢复');

    await sleep(400);
    await sendToContent(swCdp, { type: 'tt:translate' });
    await waitFor(
      async () => {
        const filled = await cdp.evaluate(
          `[...document.querySelectorAll('.dshtr-block')].filter(b => b.textContent.trim()).length`
        );
        return filled >= 8 ? filled : null;
      },
      { timeout: 15000, label: '缓存重译' }
    );
    await sleep(300);
    assert(mock.stats.requests === requestsBefore, `第二次翻译全部命中缓存（请求数仍是 ${requestsBefore}）`);

    // 仅中文模式
    log('mode', '切换到「仅中文」…');
    await swCdp.evaluate(
      `(async () => { const { settings } = await chrome.storage.local.get('settings'); settings.mode = 'zh'; await chrome.storage.local.set({ settings }); return true; })()`,
      { awaitPromise: true }
    );
    await waitFor(
      async () => {
        const state = await cdp.evaluate(`(() => {
          const p = [...document.querySelectorAll('.markdown-body > p')].find((p) => p.textContent.startsWith('This library'));
          const block = [...document.querySelectorAll('.dshtr-block')].find((b) => b.textContent.includes('这个库'));
          return {
            zh: document.documentElement.classList.contains('dshtr-zh'),
            srcHidden: p ? getComputedStyle(p).display === 'none' : false,
            translationVisible: block ? getComputedStyle(block).display !== 'none' : false
          };
        })()`);
        return state.zh && state.srcHidden && state.translationVisible ? state : null;
      },
      { timeout: 8000, label: '仅中文模式生效' }
    );
    ok('仅中文模式隐藏原文、保留译文');

    await swCdp.evaluate(
      `(async () => { const { settings } = await chrome.storage.local.get('settings'); settings.mode = 'bilingual'; await chrome.storage.local.set({ settings }); return true; })()`,
      { awaitPromise: true }
    );

    // 选中翻译
    log('selection', '测试选区翻译卡片…');
    const selText = await cdp.evaluate(`(() => {
      const p = [...document.querySelectorAll('.markdown-body > p')].find((p) => p.textContent.startsWith('This library'));
      const range = document.createRange();
      range.selectNodeContents(p);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      return p.textContent;
    })()`);
    await sendToContent(swCdp, { type: 'tt:selection', text: selText });
    const cardText = await waitFor(
      async () => {
        const text = await cdp.evaluate(`document.querySelector('#dshtr-card .dshtr-card-body')?.textContent.trim() || ''`);
        return text && text !== '正在翻译' ? text : null;
      },
      { timeout: 15000, label: '选区译文' }
    );
    assert(cardText.includes('这个库开箱即用'), `选区卡片显示译文：${cardText.slice(0, 40)}`);

    const cardShot = await cdp.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(artifactDir, 'selection-card.png'), Buffer.from(cardShot.data, 'base64'));
    ok('截图已保存 test/artifacts/selection-card.png');

    // 设置页：读取设置 → 测试连接 → 保存
    log('options', '测试设置页…');
    const optionsErrors = [];
    const optionsTab = await openPage(`chrome-extension://${extensionId}/src/options/options.html`, {
      onConnect: (oc) => {
        oc.on((msg) => {
          if (msg.method === 'Runtime.exceptionThrown') {
            optionsErrors.push(msg.params.exceptionDetails?.exception?.description || 'unknown exception');
          }
        });
      }
    });
    const oc = optionsTab.cdp;
    await oc.send('Emulation.setDeviceMetricsOverride', {
      width: 900,
      height: 1100,
      deviceScaleFactor: 1,
      mobile: false
    });

    const loaded = await oc.evaluate(`({
      key: document.getElementById('apiKey').value,
      base: document.getElementById('baseUrl').value,
      cache: document.getElementById('cacheSize').textContent,
      sites: document.getElementById('sites').value.includes('github.com')
    })`);
    assert(loaded.key === 'test-key' && loaded.base.includes('127.0.0.1'), '设置页正确读出已保存的配置');
    assert(loaded.cache && loaded.cache !== '—', `设置页读到缓存条目：${loaded.cache}`);

    await oc.evaluate(`document.getElementById('test').click()`);
    const testResult = await waitFor(
      async () => {
        const text = await oc.evaluate(`document.getElementById('testResult').textContent`);
        return text.includes('连接成功') ? text : null;
      },
      { timeout: 10000, label: '设置页测试连接' }
    );
    ok(`设置页「测试连接」通过：${testResult}`);

    await oc.evaluate(`document.getElementById('save').click()`);
    await waitFor(
      async () => (await oc.evaluate(`document.getElementById('toast').className.includes('show')`)) || null,
      { timeout: 5000, label: '设置页保存' }
    );
    const savedBase = await swCdp.evaluate(
      `(async () => { const { settings } = await chrome.storage.local.get('settings'); return settings.baseUrl; })()`,
      { awaitPromise: true }
    );
    assert(savedBase === `${mock.baseUrl}/v1`, '设置页保存写回 chrome.storage');

    const optionsShot = await oc.send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path.join(artifactDir, 'options.png'), Buffer.from(optionsShot.data, 'base64'));
    ok('截图已保存 test/artifacts/options.png');
    assert(optionsErrors.length === 0, `设置页无未捕获异常${optionsErrors.length ? `：${optionsErrors[0]}` : ''}`);

    // 弹窗：能读出配置与今日用量
    log('popup', '测试弹窗初始化…');
    const popupErrors = [];
    const popupTab = await openPage(`chrome-extension://${extensionId}/src/popup/popup.html`, {
      onConnect: (pc) => {
        pc.on((msg) => {
          if (msg.method === 'Runtime.exceptionThrown') {
            popupErrors.push(msg.params.exceptionDetails?.exception?.description || 'unknown exception');
          }
        });
      }
    });
    const pc = popupTab.cdp;
    await waitFor(
      async () => (await pc.evaluate(`document.getElementById('keyState').textContent.includes('已配置')`)) || null,
      { timeout: 5000, label: '弹窗初始化' }
    );
    const popupState = await pc.evaluate(`({
      key: document.getElementById('keyState').textContent,
      stats: document.getElementById('stats').textContent,
      enabled: document.getElementById('enabled').checked,
      mode: document.querySelector('#mode button[aria-pressed="true"]')?.dataset.mode
    })`);
    assert(popupState.key === 'API Key 已配置', '弹窗显示 API Key 状态');
    assert(popupState.stats.includes('段'), `弹窗显示今日用量：${popupState.stats}`);
    assert(popupState.enabled === true && popupState.mode === 'bilingual', '弹窗开关与模式回读正确');
    assert(popupErrors.length === 0, `弹窗无未捕获异常${popupErrors.length ? `：${popupErrors[0]}` : ''}`);

    assert(consoleErrors.length === 0, `页面无未捕获异常${consoleErrors.length ? `：${consoleErrors[0]}` : ''}`);

    cdp.close();
    oc.close();
    pc.close();
    swCdp.close();
    log('done', '全部通过');
  } finally {
    try {
      chrome?.kill();
    } catch {
      /* ignore */
    }
    await mock.close().catch(() => {});
    await sleep(300);
    await rm(profileDir, { recursive: true, force: true }).catch(() => {});
  }
}

main().catch((err) => {
  console.error(`\n\x1b[31m[E2E 失败]\x1b[0m ${err?.stack || err}`);
  process.exitCode = 1;
});


