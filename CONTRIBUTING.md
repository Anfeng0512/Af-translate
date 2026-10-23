# 参与贡献

感谢愿意改进 TechTranslate。项目刻意保持「**零构建、零运行时依赖**」：源码就是加载进浏览器的代码，改完在 `chrome://extensions` 点刷新即可生效，不需要打包工具。

## 开发环境

- Node.js 22+（只用于跑测试）
- Chrome / Edge 137+（E2E 测试需要新版 Chrome 的 `Extensions.loadUnpacked`）

## 本地开发

```powershell
# 1. 克隆
git clone https://github.com/Anfeng0512/Af-translate.git
cd tech-translate

# 2. 加载扩展
#    chrome://extensions → 开发者模式 → 加载已解压的扩展程序 → 选择本目录
#    改完代码后点扩展卡片上的刷新按钮，再刷新被测页面

# 3. 跑测试
node test/unit.test.mjs   # 单元测试：分片解析 / 术语表 / 提示词
node test/e2e.mjs         # 端到端：真实 headless Chrome + 本地 mock 接口
```

E2E 需要启动本机 Chrome。Windows 下如果路径不同，用环境变量指定：

```powershell
$env:CHROME_PATH = "C:\Program Files\Google\Chrome\Application\chrome.exe"
node test/e2e.mjs
```

## 目录速览

| 路径 | 作用 |
|---|---|
| `src/background.js` | Service Worker：分批、缓存、重试、右键菜单 |
| `src/content/content.js` | 正文识别、双语渲染、SPA 跟随、选区卡片 |
| `src/prompt.js` / `src/glossary.js` | 提示词与术语表 |
| `src/llm.js` | OpenAI 兼容流式请求与错误映射 |
| `src/popup/` / `src/options/` | 弹窗与设置页 |
| `test/` | 单元测试、mock 服务、Chrome E2E |

## 提交前检查

- [ ] `node test/unit.test.mjs` 全绿
- [ ] `node test/e2e.mjs` 全绿（或说明无法本地运行的原因）
- [ ] 没有引入新的运行时依赖；没有构建产物（`dist/`、`test/artifacts/` 已在 `.gitignore`）
- [ ] 没有把 API Key、个人路径、测试生成的临时文件提交进仓库
- [ ] 新增术语：只放「按语境可能有歧义」的术语，避免把 `go`、`run` 这类高频词塞进术语表

## 分支与提交信息

- 分支：`feat/xxx`、`fix/xxx`、`docs/xxx`
- 提交信息用祈使句，中文或英文都行，例如：
  - `fix: 本地 Ollama 403 时给出 OLLAMA_ORIGINS 提示`
  - `feat: 支持把当前站点加入自动翻译列表`

## 新增站点适配

如果某个文档站的正文没有被识别：

1. 先把选择器加到 `src/content/content.js` 的 `findRoots()` 里（优先 `article/main`，避免整页翻译）；
2. 在 `test/mock-server.mjs` 里补一个最简 HTML 片段；
3. 在 `test/e2e.mjs` 里加一条断言。

## 许可证

提交 PR 即表示同意以 [MIT](LICENSE) 协议发布你的贡献。


