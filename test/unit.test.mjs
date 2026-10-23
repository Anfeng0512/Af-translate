import test from 'node:test';
import assert from 'node:assert/strict';

import { parseMarkers } from '../src/markers.js';
import { GLOSSARY } from '../src/glossary.js';
import { pickGlossary, buildMessages } from '../src/prompt.js';
import { DEFAULT_SETTINGS } from '../src/settings.js';

test('parseMarkers: 多段完整输出', () => {
  const out = parseMarkers('⟦s1⟧\n你好\n⟦s2⟧\n世界');
  assert.equal(out.get('s1'), '你好');
  assert.equal(out.get('s2'), '世界');
});

test('parseMarkers: 流式过程中的最后一段', () => {
  assert.equal(parseMarkers('⟦s1⟧\n开箱即').get('s1'), '开箱即');
});

test('parseMarkers: 还没写正文的片段不返回', () => {
  const out = parseMarkers('⟦s1⟧\n⟦s2⟧\n有内容');
  assert.equal(out.has('s1'), false);
  assert.equal(out.get('s2'), '有内容');
});

test('parseMarkers: 噪声与非法编号', () => {
  const out = parseMarkers('好的，以下是译文：\n⟦b12⟧\n译文\n⟦x_y⟧\n另一段');
  assert.equal(out.get('b12'), '译文');
  assert.equal(out.get('x_y'), '另一段');
  assert.equal(out.size, 2);
});

test('glossary: 条目格式完整且无重复', () => {
  assert.ok(GLOSSARY.length > 150, `术语表条目过少：${GLOSSARY.length}`);
  const seen = new Set();
  for (const entry of GLOSSARY) {
    assert.ok(entry.en && entry.zh, JSON.stringify(entry));
    assert.equal(seen.has(entry.en.toLowerCase()), false, `重复术语：${entry.en}`);
    seen.add(entry.en.toLowerCase());
  }
});

test('pickGlossary: 只下发命中的术语', () => {
  const hits = pickGlossary([{ text: 'It works out of the box, and hydration is automatic.' }]);
  const en = hits.map((h) => h.en);
  assert.ok(en.includes('out of the box'));
  assert.ok(en.includes('hydration'));
  assert.ok(!en.includes('deadlock'));
});

test('pickGlossary: 自定义术语优先，且支持多种分隔符', () => {
  const hits = pickGlossary([{ text: 'Our widget uses magic mode.' }], 'magic mode => 魔法模式\nfoo = 福');
  assert.equal(hits[0].en, 'magic mode');
  assert.equal(hits[0].zh, '魔法模式');
});

test('buildMessages: 标记、页面上下文与术语提示', () => {
  const messages = buildMessages({
    segments: [
      { id: 's1', text: 'Hello world' },
      { id: 's2', text: 'Second' }
    ],
    title: 'README',
    url: 'https://github.com/a/b',
    glossary: [{ en: 'out of the box', zh: '开箱即用' }],
    targetLang: '简体中文'
  });
  assert.equal(messages.length, 2);
  assert.equal(messages[0].role, 'system');
  assert.match(messages[0].content, /⟦编号⟧/);
  const user = messages[1].content;
  assert.match(user, /页面标题：README/);
  assert.match(user, /https:\/\/github\.com\/a\/b/);
  assert.match(user, /⟦s1⟧\nHello world/);
  assert.match(user, /⟦s2⟧\nSecond/);
  assert.match(user, /out of the box → 开箱即用/);
});

test('buildMessages: strict 模式加强格式要求', () => {
  const normal = buildMessages({ segments: [{ id: 's1', text: 'x' }] });
  const strict = buildMessages({ segments: [{ id: 's1', text: 'x' }], strict: true });
  assert.ok(strict[0].content.length > normal[0].content.length);
  assert.match(strict[0].content, /一段都不能少/);
});

test('settings: 默认站点包含 GitHub，且默认不自动开启', () => {
  assert.ok(DEFAULT_SETTINGS.sites.includes('github.com'));
  assert.equal(DEFAULT_SETTINGS.enabled, false);
  assert.equal(DEFAULT_SETTINGS.mode, 'bilingual');
});
