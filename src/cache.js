/**
 * 译文缓存：按「模型 + 目标语言 + 提示词版本 + 原文」哈希存到 chrome.storage.local。
 * 同一段文字（比如反复出现的表格表头、同一仓库的不同页面）只花一次 token。
 */
const PREFIX = 'ttc:';
const COUNT_KEY = 'ttc#count';
const MAX_ENTRIES = 8000;

export async function hashKey(text) {
  const data = new TextEncoder().encode(text);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest).slice(0, 12))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}

export async function cacheGetMany(keys) {
  if (!keys.length) return {};
  const storageKeys = keys.map((k) => PREFIX + k);
  const obj = await chrome.storage.local.get(storageKeys);
  const out = {};
  for (const k of keys) {
    const hit = obj[PREFIX + k];
    if (hit && typeof hit.t === 'string' && hit.t) out[k] = hit.t;
  }
  return out;
}

export async function cacheSetMany(entries) {
  if (!entries.length) return;
  const now = Date.now();
  const payload = {};
  for (const { key, text } of entries) {
    if (!key || !text) continue;
    payload[PREFIX + key] = { t: text, ts: now };
  }
  const added = Object.keys(payload).length;
  if (!added) return;
  await chrome.storage.local.set(payload);
  await bumpCount(added);
}

/** 多个批次并发写入时串行更新计数，避免读改写丢更新 */
let countChain = Promise.resolve();

function bumpCount(added) {
  countChain = countChain
    .then(async () => {
      const { [COUNT_KEY]: count = 0 } = await chrome.storage.local.get(COUNT_KEY);
      const next = count + added;
      if (next > MAX_ENTRIES) await prune();
      else await chrome.storage.local.set({ [COUNT_KEY]: next });
    })
    .catch(() => {});
  return countChain;
}

async function prune() {
  const all = await chrome.storage.local.get(null);
  const entries = Object.entries(all)
    .filter(([k, v]) => k.startsWith(PREFIX) && v && typeof v.ts === 'number')
    .sort((a, b) => a[1].ts - b[1].ts);
  if (!entries.length) return;
  const removeCount = Math.ceil(entries.length * 0.3);
  const removeKeys = entries.slice(0, removeCount).map(([k]) => k);
  await chrome.storage.local.remove(removeKeys);
  await chrome.storage.local.set({ [COUNT_KEY]: entries.length - removeCount });
}

export async function clearCache() {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith(PREFIX));
  if (keys.length) await chrome.storage.local.remove(keys);
  await chrome.storage.local.set({ [COUNT_KEY]: 0 });
  return keys.length;
}

export async function cacheSize() {
  const { [COUNT_KEY]: count = 0 } = await chrome.storage.local.get(COUNT_KEY);
  return count;
}
