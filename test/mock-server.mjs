/**
 * E2E 用的本地 mock：一个假的 DeepSeek 兼容接口 + 一个仿 GitHub README 的测试页。
 * 不联网、不花钱，用来验证扩展的完整链路（设置 → 内容脚本 → 后台 → SSE → 渲染）。
 */
import { createServer } from 'node:http';

const PAGE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>acme/tech-translate · README</title>
<style>
  :root { color-scheme: light; }
  body { margin: 0; background: #ffffff; color: #1f2328; font: 16px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI",Helvetica,Arial,sans-serif; }
  .topbar { display:flex; align-items:center; gap:10px; padding:12px 24px; border-bottom:1px solid #d1d9e0; background:#f6f8fa; font-size:14px; color:#59636e; }
  .topbar b { color:#1f2328; }
  .wrap { max-width: 900px; margin: 0 auto; padding: 28px 32px 64px; }
  .markdown-body h1 { font-size: 2em; padding-bottom: .3em; border-bottom: 1px solid #d1d9e0; margin: .67em 0; }
  .markdown-body h2 { font-size: 1.5em; margin-top: 1.4em; }
  .markdown-body p { margin: 0 0 16px; }
  .markdown-body code { padding: .2em .4em; margin: 0; border-radius: 6px; background: #eff1f3; font: 85%/1.45 ui-monospace,SFMono-Regular,Consolas,monospace; }
  .markdown-body pre { padding: 16px; overflow:auto; border-radius: 6px; background:#f6f8fa; }
  .markdown-body pre code { padding: 0; background: transparent; }
  .markdown-body ul { padding-left: 2em; margin: 0 0 16px; }
  .markdown-body li + li { margin-top: 4px; }
  .markdown-body blockquote { margin: 0 0 16px; padding: 0 1em; color:#59636e; border-left: .25em solid #d1d9e0; }
  .markdown-body blockquote p { margin: 0; }
  .markdown-body table { border-collapse: collapse; margin: 0 0 16px; }
  .markdown-body th, .markdown-body td { padding: 6px 13px; border: 1px solid #d1d9e0; }
  .markdown-body th { font-weight: 600; background:#f6f8fa; }
  .badges { border: 0; }
  .badges img { height: 20px; }
</style>
</head>
<body>
  <div class="topbar"><b>acme</b> / <b>tech-translate</b> · Public</div>
  <div class="wrap">
    <div class="markdown-body">
      <h1>TechTranslate Demo</h1>
      <p class="badges"><a href="#"><img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI3NCIgaGVpZ2h0PSIyMCI+PHJlY3Qgd2lkdGg9Ijc0IiBoZWlnaHQ9IjIwIiByeD0iMyIgZmlsbD0iIzRjMSIvPjx0ZXh0IHg9IjM3IiB5PSIxNCIgZmlsbD0iI2ZmZiIgZm9udC1zaXplPSIxMSIgdGV4dC1hbmNob3I9Im1pZGRsZSI+YnVpbGQ8L3RleHQ+PC9zdmc+" alt="build"></a> <a href="#"><img src="data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSI3NCIgaGVpZ2h0PSIyMCI+PHJlY3Qgd2lkdGg9Ijc0IiBoZWlnaHQ9IjIwIiByeD0iMyIgZmlsbD0iIzAwNyIvPjx0ZXh0IHg9IjM3IiB5PSIxNCIgZmlsbD0iI2ZmZiIgZm9udC1zaXplPSIxMSIgdGV4dC1hbmNob3I9Im1pZGRsZSI+bnBtPC90ZXh0Pjwvc3ZnPg==" alt="npm"></a></p>
      <p>This library works <code>out of the box</code> and has zero configuration.</p>
      <ul>
        <li>Fast and lightweight
          <ul>
            <li>No runtime dependencies</li>
          </ul>
        </li>
        <li>TypeScript support</li>
      </ul>
      <h2>How it works</h2>
      <blockquote>
        <p>Under the hood it uses a worker pool.</p>
      </blockquote>
      <table>
        <thead><tr><th>Option</th><th>Default</th></tr></thead>
        <tbody><tr><td>timeout</td><td>3000</td></tr></tbody>
      </table>
      <pre><code>npm install tech-translate</code></pre>
      <p>这是一个中文段落，不需要翻译。</p>
      <p>See the <a href="#">documentation</a> for more details.</p>
    </div>
  </div>
</body>
</html>`;

const FIXTURE_TRANSLATIONS = {
  'TechTranslate Demo': 'TechTranslate 演示',
  'This library works out of the box and has zero configuration.': '这个库开箱即用，无需任何配置。',
  'Fast and lightweight': '快速、轻量',
  'No runtime dependencies': '没有运行时依赖',
  'TypeScript support': '支持 TypeScript',
  'How it works': '工作原理',
  'Under the hood it uses a worker pool.': '底层实现上，它使用了工作线程池。',
  Option: '选项',
  Default: '默认值',
  timeout: '超时时间',
  'See the documentation for more details.': '更多细节请参阅文档。'
};

const segmentRe = /⟦([A-Za-z0-9_-]+)⟧\n([\s\S]*?)(?=\n?⟦|$)/g;

function translateForMock(userContent) {
  const out = [];
  for (const match of userContent.matchAll(segmentRe)) {
    const id = match[1];
    const source = match[2].trim();
    const translated = FIXTURE_TRANSLATIONS[source] || `【译】${source}`;
    out.push(`⟦${id}⟧\n${translated}`);
  }
  return `${out.join('\n')}\n`;
}

function sseChunks(text, count = 3) {
  const size = Math.ceil(text.length / count);
  const chunks = [];
  for (let i = 0; i < text.length; i += size) chunks.push(text.slice(i, i + size));
  return chunks;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

export async function startMockServer() {
  const stats = { requests: 0, lastUserMessage: '', translations: [] };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': 'authorization,content-type',
      'access-control-allow-methods': 'GET,POST,OPTIONS'
    };

    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors).end();
      return;
    }

    if (url.pathname === '/page.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', ...cors }).end(PAGE_HTML);
      return;
    }

    if (url.pathname === '/stats') {
      res.writeHead(200, { 'content-type': 'application/json', ...cors }).end(JSON.stringify(stats));
      return;
    }

    if (url.pathname === '/v1/models') {
      if (req.headers.authorization !== 'Bearer test-key') {
        res.writeHead(401, { 'content-type': 'application/json', ...cors }).end('{"error":"bad key"}');
        return;
      }
      res
        .writeHead(200, { 'content-type': 'application/json', ...cors })
        .end(JSON.stringify({ data: [{ id: 'deepseek-chat' }] }));
      return;
    }

    if (url.pathname === '/v1/chat/completions' && req.method === 'POST') {
      if (req.headers.authorization !== 'Bearer test-key') {
        res.writeHead(401, { 'content-type': 'application/json', ...cors }).end('{"error":"bad key"}');
        return;
      }
      let body = '';
      for await (const chunk of req) body += chunk;
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        res.writeHead(400, { 'content-type': 'application/json', ...cors }).end('{"error":"bad json"}');
        return;
      }
      const userContent = parsed.messages?.find((m) => m.role === 'user')?.content || '';
      stats.requests += 1;
      stats.lastUserMessage = userContent;
      const text = translateForMock(userContent);
      stats.translations = [...text.matchAll(/⟦([A-Za-z0-9_-]+)⟧\n([^\n]+)/g)].map((m) => [m[1], m[2]]);

      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
        ...cors
      });
      for (const piece of sseChunks(text, 4)) {
        res.write(
          `data: ${JSON.stringify({ id: 'mock', choices: [{ index: 0, delta: { content: piece } }] })}\n\n`
        );
        await sleep(20);
      }
      res.write('data: [DONE]\n\n');
      res.end();
      return;
    }

    res.writeHead(404, { 'content-type': 'text/plain', ...cors }).end('not found');
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    server,
    port,
    stats,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}
