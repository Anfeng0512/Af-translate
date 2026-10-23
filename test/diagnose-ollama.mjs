/**
 * 复现「翻译失败」：用真实 Chrome 加载扩展，把翻译接口指向本机 Ollama，
 * 抓取 Service Worker 的异常、控制台与网络失败原因。
 */
import { spawn } from 'node:child_process';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { startMockServer } from './mock-server.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CHROME =
  process.env.CHROME_PATH ||
  (process.platform === 'win32'
    ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
    : 'google-chrome');
const PORT = 9777;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.listeners = [];
    this.ready = new Promise((res, rej) => {
      this.ws.addEventListener('open', res, { once: true });
      this.ws.addEventListener('error', rej, { once: true });
    });
    this.ws.addEventListener('message', (e) => {
      const m = JSON.parse(e.data);
      if (m.id && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p.rej(new Error(JSON.stringify(m.error)));
        else p.res(m.result);
      } else if (m.method) {
        for (const fn of this.listeners) fn(m);
      }
    });
  }
  static async connect(u) {
    const c = new Cdp(u);
    await c.ready;
    return c;
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  on(fn) {
    this.listeners.push(fn);
  }
  async evaluate(expression, awaitPromise = false) {
    const r = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
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

const profile = await mkdtemp(path.join(tmpdir(), 'tt-diag-'));
const mock = await startMockServer();
const artifactDir = path.join(ROOT, 'test', 'artifacts');
await mkdir(artifactDir, { recursive: true });

const child = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-first-run',
    '--no-default-browser-check',
    '--enable-unsafe-extension-debugging',
    `--user-data-dir=${profile}`,
    `--remote-debugging-port=${PORT}`,
    '--window-size=1200,900',
    'about:blank'
  ],
  { stdio: 'ignore' }
);

try {
  let version;
  for (let i = 0; i < 60; i++) {
    try {
      version = await httpJson(`http://127.0.0.1:${PORT}/json/version`);
      break;
    } catch {
      await sleep(250);
    }
  }
  if (!version) throw new Error('Chrome 没起来');

  const browser = await Cdp.connect(version.webSocketDebuggerUrl);
  const { id: extensionId } = await browser.send('Extensions.loadUnpacked', { path: ROOT });

  let swTarget;
  for (let i = 0; i < 60 && !swTarget; i++) {
    const targets = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
    swTarget = targets.find((t) => t.type === 'service_worker' && t.url.includes(extensionId));
    if (!swTarget) await sleep(250);
  }
  if (!swTarget) throw new Error('扩展 SW 没起来');

  const sw = await Cdp.connect(swTarget.webSocketDebuggerUrl);
  const events = [];
  sw.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') {
      events.push({ kind: 'sw-exception', text: m.params.exceptionDetails?.exception?.description || m.params.exceptionDetails?.text });
    } else if (m.method === 'Runtime.consoleAPICalled') {
      events.push({ kind: 'sw-console', text: (m.params.args || []).map((a) => a.value ?? a.description).join(' ') });
    } else if (m.method === 'Network.loadingFailed') {
      events.push({ kind: 'sw-network-failed', text: `${m.params.errorText} ${m.params.blockedReason || ''}` });
    } else if (m.method === 'Network.requestWillBeSent') {
      const url = m.params.request.url;
      if (url.includes('chat/completions')) events.push({ kind: 'sw-request', text: url });
    } else if (m.method === 'Log.entryAdded') {
      events.push({ kind: 'sw-log', text: `${m.params.entry.level}: ${m.params.entry.text}` });
    }
  });
  await sw.send('Runtime.enable');
  await sw.send('Network.enable');
  await sw.send('Log.enable');

  const settings = {
    enabled: true,
    auto: true,
    mode: 'bilingual',
    targetLang: '简体中文',
    apiKey: 'ollama',
    baseUrl: process.env.OLLAMA_BASE || 'http://127.0.0.1:11434/v1',
    model: process.env.OLLAMA_MODEL || 'qwen3-rp-8k:latest',
    sites: ['127.0.0.1'],
    glossaryExtra: '',
    maxBatchChars: 1600,
    concurrency: 2
  };
  await sw.evaluate(
    `(async () => { await chrome.storage.local.set({ settings: ${JSON.stringify(settings)} }); return true; })()`,
    true
  );
  console.log('settings:', settings.baseUrl, settings.model);

  const target = await httpJson(`http://127.0.0.1:${PORT}/json/new?about:blank`, 'PUT');
  const page = await Cdp.connect(target.webSocketDebuggerUrl);
  const pageErrors = [];
  page.on((m) => {
    if (m.method === 'Runtime.exceptionThrown') pageErrors.push(m.params.exceptionDetails?.exception?.description);
    if (m.method === 'Runtime.consoleAPICalled') {
      const text = (m.params.args || []).map((a) => a.value ?? a.description).join(' ');
      if (/dshtr|tech|translate/i.test(text)) pageErrors.push(`console: ${text}`);
    }
  });
  await page.send('Page.enable');
  await page.send('Runtime.enable');
  await page.send('Page.navigate', { url: `${mock.baseUrl}/page.html` });

  const started = Date.now();
  let last = null;
  while (Date.now() - started < 120_000) {
    last = await page.evaluate(`(() => {
      const blocks = [...document.querySelectorAll('.dshtr-block')];
      const toasts = [...document.querySelectorAll('.dshtr-toast')].map((t) => t.textContent);
      return {
        total: blocks.length,
        filled: blocks.filter((b) => b.textContent.trim()).length,
        failed: blocks.filter((b) => b.textContent.includes('翻译失败')).length,
        samples: blocks.slice(0, 4).map((b) => b.textContent.trim().slice(0, 120)),
        toasts
      };
    })()`);
    if (last.failed > 0 || last.filled >= 8) break;
    await sleep(1000);
  }

  console.log('\n--- page state ---');
  console.log(JSON.stringify(last, null, 2));
  console.log('\n--- sw events ---');
  for (const e of events) console.log(`[${e.kind}] ${e.text}`);
  console.log('\n--- page errors ---');
  for (const e of pageErrors) console.log(e);

  await page.send('Page.captureScreenshot', { format: 'png' }).then(async (shot) => {
    await writeFile(path.join(artifactDir, 'ollama-diag.png'), Buffer.from(shot.data, 'base64'));
  });
} finally {
  child.kill();
  await mock.close().catch(() => {});
  await sleep(300);
  await rm(profile, { recursive: true, force: true }).catch(() => {});
  if (!existsSync(profile)) console.log('\nprofile cleaned');
}

