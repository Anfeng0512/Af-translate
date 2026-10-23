/**
 * 解析模型输出中的 ⟦id⟧ 分片标记。
 * 流式过程中会被反复调用：只返回「已经出现标记」的片段，最后一段随输出增长。
 */
const MARKER_RE = /⟦\s*([A-Za-z0-9_-]+)\s*⟧/g;

export function parseMarkers(text) {
  const out = new Map();
  if (!text) return out;
  const matches = [];
  MARKER_RE.lastIndex = 0;
  let m;
  while ((m = MARKER_RE.exec(text))) {
    matches.push({ id: m[1], start: m.index, end: MARKER_RE.lastIndex });
  }
  for (let i = 0; i < matches.length; i++) {
    const end = i + 1 < matches.length ? matches[i + 1].start : text.length;
    const value = text.slice(matches[i].end, end).trim();
    if (value) out.set(matches[i].id, value);
  }
  return out;
}
