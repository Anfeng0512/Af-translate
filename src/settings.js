/**
 * 设置的默认值与读写。
 * 所有设置放在 chrome.storage.local（而不是 sync），避免 API Key 被同步到云端。
 */

export const DEFAULT_SITES = [
  'github.com',
  'gist.github.com',
  'gitlab.com',
  'developer.mozilla.org',
  'docs.python.org',
  'react.dev',
  'nodejs.org',
  'go.dev',
  'rust-lang.org',
  'kubernetes.io',
  'docs.docker.com',
  'npmjs.com',
  'pypi.org',
  'stackoverflow.com'
];

export const DEFAULT_SETTINGS = Object.freeze({
  /** 扩展总开关：关掉后所有页面都不翻译 */
  enabled: false,
  /** 命中站点列表时自动翻译 */
  auto: true,
  /** bilingual = 原文 + 译文对照；zh = 只留译文 */
  mode: 'bilingual',
  targetLang: '简体中文',
  apiKey: '',
  /** OpenAI 兼容端点，默认 DeepSeek 官方 */
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-chat',
  sites: DEFAULT_SITES,
  /** 用户自定义术语，每行 "英文 => 译法"，也接受 | 或 = 分隔 */
  glossaryExtra: '',
  maxBatchChars: 1600,
  concurrency: 3
});

export async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  const merged = { ...DEFAULT_SETTINGS, ...(settings || {}) };
  if (!Array.isArray(merged.sites)) merged.sites = DEFAULT_SITES;
  merged.sites = merged.sites.map((s) => String(s).trim()).filter(Boolean);
  merged.concurrency = clamp(Number(merged.concurrency) || 3, 1, 6);
  merged.maxBatchChars = clamp(Number(merged.maxBatchChars) || 1600, 400, 6000);
  return merged;
}

export async function setSettings(patch) {
  const current = await getSettings();
  const next = { ...current, ...patch };
  await chrome.storage.local.set({ settings: next });
  return next;
}

function clamp(n, min, max) {
  return Math.min(max, Math.max(min, n));
}
