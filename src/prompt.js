/**
 * 提示词构造。
 *
 * 设计要点：
 * - system 保持稳定（利于 DeepSeek 上下文缓存），术语提示放在 user 里；
 * - 只下发原文里真正出现的术语，最多 26 条，按出现位置排序；
 * - 输出用 ⟦n⟧ 分片标记，便于流式解析与增量渲染。
 */
import { GLOSSARY } from './glossary.js';

export const PROMPT_VERSION = 'v1';

const SYSTEM = `你是资深中文技术译者，长期翻译 GitHub 上的开源文档、issue、Pull Request、发布说明和 API 文档。译文要像中文技术社区里写得好的文章，而不是机翻。

翻译要求：
1. 忠实、准确、通顺：不增删信息，不写解释，不加“译者注”，不加总结。
2. 下面这些一律保留英文原样，不要翻译：代码、命令、参数、路径、URL、文件名、变量名、函数名、类名、包名、版本号、错误信息、日志、产品名与 API 名（如 React、Kubernetes、Docker、npm、GitHub Actions），以及业界通用缩写（API、SDK、CLI、JSON、YAML、HTTP、PR、CI/CD、UI、UX）。
3. 计算机术语按中文技术社区的习惯译法，结合语境选词，不逐字直译。例如：
   out of the box → 开箱即用；under the hood → 底层实现上；boilerplate → 样板代码；gotcha → 坑；breaking change → 破坏性变更；edge case → 边界情况；workaround → 变通方案；shim → 兼容层；overhead → 开销；drop-in replacement → 可直接替换的方案；opinionated → 有明确取舍的。
4. 句子要符合中文表达习惯：拆开过长的英文从句，被动句改成主动句，把 it / they 指代的对象讲清楚，不要保留英文语序。
5. 已经是中文的片段原样输出；纯代码、纯符号、纯链接的片段原样输出。
6. 不要新增 Markdown 标记（**、\`、#、- 等），除非原文片段里本来就有。
7. 中英文之间保留一个空格；数字与单位按中文习惯书写，如 10 毫秒、3 个。

输出格式（必须严格遵守）：
- 每段译文前面单独一行写 ⟦编号⟧，紧接着写该段译文。
- 按输入编号输出全部片段，不合并、不拆分、不遗漏、不改变顺序。
- 除编号标记和译文外，不要输出任何其他内容。`;

function normalizeExtra(raw) {
  return String(raw || '')
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith('#'))
    .map((line) => {
      const m = line.match(/^(.+?)\s*(?:=>|=|\|)\s*(.+)$/);
      if (!m) return null;
      return { en: m[1].trim(), zh: m[2].trim(), note: '用户指定，必须遵守' };
    })
    .filter(Boolean);
}

/**
 * 挑出本批原文里命中的术语（含用户自定义术语）。
 * @param {{text:string}[]} segments
 * @param {string} extra 用户自定义术语文本
 * @param {number} limit
 */
export function pickGlossary(segments, extra = '', limit = 26) {
  const haystack = segments.map((s) => s.text).join('\n').toLowerCase();
  const positions = new Map();

  const consider = (entry) => {
    const needle = entry.en.toLowerCase();
    if (!needle) return;
    const idx = haystack.indexOf(needle);
    if (idx === -1) return;
    const prev = positions.get(entry.en);
    if (!prev || idx < prev.entry.at) positions.set(entry.en, { entry: { ...entry, at: idx } });
  };

  for (const entry of normalizeExtra(extra)) consider(entry);
  for (const entry of GLOSSARY) consider(entry);
  // 用户自定义术语排最前：position 减一个大数，保证优先进入 26 条上限
  for (const entry of normalizeExtra(extra)) {
    const hit = positions.get(entry.en);
    if (hit) hit.entry.at = hit.entry.at - 1e9;
  }

  return [...positions.values()]
    .map((v) => v.entry)
    .sort((a, b) => a.at - b.at)
    .slice(0, limit);
}

/**
 * @param {object} opts
 * @param {{id:string,text:string}[]} opts.segments
 * @param {string} opts.title
 * @param {string} opts.url
 * @param {{en:string,zh:string,note?:string}[]} opts.glossary
 * @param {string} opts.targetLang
 * @param {boolean} opts.strict 第二次尝试时加强格式要求
 */
export function buildMessages({ segments, title, url, glossary = [], targetLang = '简体中文', strict = false }) {
  const system = strict
    ? `${SYSTEM}\n\n注意：必须为每一个输入片段输出 ⟦编号⟧，一段都不能少；编号使用输入中的数字，不要重新编号。`
    : SYSTEM;

  const parts = [];
  if (title) parts.push(`页面标题：${String(title).slice(0, 200)}`);
  if (url) parts.push(`页面地址：${String(url).slice(0, 300)}`);
  parts.push(`目标语言：${targetLang}`);

  if (glossary.length) {
    parts.push('');
    parts.push('术语参考（按语境选用，原文没出现的不要硬套）：');
    for (const g of glossary) {
      parts.push(`- ${g.en} → ${g.zh}${g.note ? `（${g.note}）` : ''}`);
    }
  }

  parts.push('');
  parts.push(`待翻译片段（共 ${segments.length} 段）：`);
  parts.push('');
  for (const seg of segments) {
    parts.push(`⟦${seg.id}⟧`);
    parts.push(seg.text);
    parts.push('');
  }

  return [
    { role: 'system', content: system },
    { role: 'user', content: parts.join('\n').trim() }
  ];
}
