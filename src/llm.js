/**
 * 调用 OpenAI 兼容的流式 Chat Completions（默认 DeepSeek）。
 * 只负责「发请求 + 读 SSE + 回调累计文本」，重试、缓存、分片解析在 background.js。
 */

export class TranslateError extends Error {
  constructor(code, message, status = 0) {
    super(message);
    this.name = 'TranslateError';
    this.code = code;
    this.status = status;
  }
}

export function endpointOf(baseUrl) {
  const base = String(baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

export function modelsEndpointOf(baseUrl) {
  const base = String(baseUrl || 'https://api.deepseek.com').trim().replace(/\/+$/, '');
  return `${base.replace(/\/chat\/completions$/, '')}/models`;
}

export function isLocalEndpoint(baseUrl) {
  try {
    const host = new URL(String(baseUrl || '')).hostname.toLowerCase();
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch {
    return false;
  }
}

function mapHttpError(status, detail, baseUrl) {
  const snippet = String(detail || '')
    .replace(/\s+/g, ' ')
    .slice(0, 200);
  const local = isLocalEndpoint(baseUrl);

  if (local) {
    if (status === 401 || status === 403) {
      return new TranslateError(
        'origin',
        '本地模型拒绝了扩展来源。Ollama 默认只允许网页来源：请完全退出 Ollama，再执行  $env:OLLAMA_ORIGINS="*"; ollama serve  （或 setx OLLAMA_ORIGINS "*" 永久生效）后重启。',
        status
      );
    }
    if (status === 404) {
      return new TranslateError(
        'request',
        '本地服务没有这个接口（HTTP 404）。Base URL 要带 /v1，例如 http://127.0.0.1:11434/v1。',
        status
      );
    }
    if (status >= 500) {
      return new TranslateError('server', `本地模型服务出错（HTTP ${status}）${snippet ? `：${snippet}` : ''}`, status);
    }
  }

  switch (status) {
    case 401:
    case 403:
      return new TranslateError('auth', 'API Key 无效或没有权限，请在扩展设置里检查。', status);
    case 402:
      return new TranslateError('quota', 'DeepSeek 账户余额不足，请充值后再试。', status);
    case 429:
      return new TranslateError('rate', '请求过于频繁，已自动重试；如果持续出现请调低并发数。', status);
    case 400:
      return new TranslateError('request', `请求被拒绝${snippet ? `：${snippet}` : ''}`, status);
    default:
      if (status >= 500) return new TranslateError('server', `翻译服务暂时不可用（HTTP ${status}），稍后重试。`, status);
      return new TranslateError('http', `请求失败（HTTP ${status}）${snippet ? `：${snippet}` : ''}`, status);
  }
}

/**
 * @param {object} opts
 * @param {object} opts.settings
 * @param {{role:string,content:string}[]} opts.messages
 * @param {(acc:string)=>void} opts.onDelta
 * @param {AbortSignal} [opts.signal]
 * @returns {Promise<string>} 完整输出文本
 */
export async function streamChat({ settings, messages, onDelta, signal }) {
  const url = endpointOf(settings.baseUrl);
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(new TranslateError('timeout', '翻译请求超时（180 秒）。')), 180_000);
  const merged = anySignal(signal, timeout.signal);

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.apiKey}`
      },
      body: JSON.stringify({
        model: settings.model || 'deepseek-chat',
        messages,
        stream: true,
        temperature: 0.2,
        max_tokens: 8000
      }),
      signal: merged
    });
  } catch (err) {
    clearTimeout(timer);
    if (signal?.aborted) throw err;
    if (err?.name === 'AbortError') throw new TranslateError('timeout', '翻译请求超时，请重试。');
    if (isLocalEndpoint(settings.baseUrl)) {
      throw new TranslateError(
        'network',
        '连不上本地模型服务。确认 Ollama 正在运行（ollama serve），Base URL 是 http://127.0.0.1:11434/v1。'
      );
    }
    throw new TranslateError('network', '无法连接翻译服务，请检查网络或代理设置。');
  }

  if (!res.ok) {
    clearTimeout(timer);
    const detail = await res.text().catch(() => '');
    throw mapHttpError(res.status, detail, settings.baseUrl);
  }
  if (!res.body) {
    clearTimeout(timer);
    throw new TranslateError('server', '翻译服务返回了空响应。');
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let acc = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let newline;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).replace(/\r$/, '').trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (!data || data === '[DONE]') continue;
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          continue;
        }
        if (json?.error) {
          const detail = json.error.message || json.error.type || JSON.stringify(json.error);
          throw new TranslateError('server', `翻译服务返回错误：${String(detail).slice(0, 160)}`);
        }
        const delta = json?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string' && delta) {
          acc += delta;
          try {
            onDelta(acc);
          } catch {
            /* 渲染层异常不应中断翻译 */
          }
        }
      }
    }
  } catch (err) {
    if (signal?.aborted) throw err;
    if (err?.name === 'AbortError') throw new TranslateError('timeout', '翻译请求超时，请重试。');
    if (err instanceof TranslateError) throw err;
    throw new TranslateError('network', '翻译数据流中断，请重试。');
  } finally {
    clearTimeout(timer);
    reader.releaseLock?.();
  }

  return acc.trim();
}

function anySignal(a, b) {
  if (!a) return b;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([a, b]);
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  a.addEventListener('abort', onAbort, { once: true });
  b.addEventListener('abort', onAbort, { once: true });
  return ctrl.signal;
}
