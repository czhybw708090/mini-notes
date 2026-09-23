# Mini Notes with LLM Summary

Anna App：本地笔记应用。UI 跑在 Anna iframe 里，笔记通过 `anna.storage`
Host API 持久化（APS KV，单 key `notes`）；Summarize 通过
`anna.tools.invoke` 驱动本地 Executa Tool（Go，`executas/notes-summarizer/`），
该工具用反向 JSON-RPC `sampling/createMessage` 借 host LLM 生成总结。

## 组件关系

```
manifest.json ──描述──▶ iframe UI（bundle/，Vite+TS 构建）
    │                      │ anna.storage.*（读/写笔记，APS KV）
    │ required_executas    │ anna.tools.invoke（method: summarize）
    ▼                      ▼
executas/notes-summarizer/（Go 二进制，JSON-RPC 2.0 over stdio）
    │ 反向 RPC sampling/createMessage → host LLM → summary 返回
    ▼
dist/notes-summarizer-<ver>-<platform>.*  ← scripts/build-binary.sh 产出，
                                            GitHub Actions 发布为 Release assets
```

- **manifest**：声明 UI 视图、host_api 权限（storage/tools）、`required_executas`
  （`bundled:notes-summarizer`）。schema 2，`anna-app validate --strict` 校验。
- `ui.host_api.storage` 保留完整的 `get` / `set` / `delete` 声明；应用实际只用
  `get` / `set`，因为删除按单 key 设计实现为 get → 改 → set，不调用
  `storage.delete`。
- **bundle**：前端静态 SPA（相对路径，无框架，原生 DOM），连接 host SDK
  （`/static/anna-apps/_sdk/...`）后拿到 `anna.storage` / `anna.tools`。
- **executas**：本地工具子进程，host 按 manifest 的 required_executas 拉起，
  stdio 行分隔 JSON-RPC；sampling 是工具反向请求 host LLM 的通道。
- **Anna storage / APS KV**：笔记的持久层，前端只经 Host API 读写，
  不碰 localStorage / 内存 state（内存仅作渲染镜像）。
- **binary archive**：发布产物，根目录带 manifest.json（entrypoint +
  permissions），三平台三份，裸二进制会被拒。

## 项目结构

```
manifest.json                  # App manifest（schema 2）
package.json / tsconfig.json / vite.config.ts / index.html
src/                           # 前端（Vite + TS，无框架）
  main.ts                      #   入口：连 host → 加载笔记 → 绑 UI，失败路径全 catch
  anna/runtime.ts              #   SDK 桥（动态 import，独立打开时优雅降级）
  anna/storage.ts              #   笔记持久化：单 key "notes" 数组，增删都是 get→改→set
  anna/tools.ts                #   tools.invoke 封装 + tool_id 运行时解析
  ui.ts / types.ts / style.css
executas/notes-summarizer/     # Executa Tool（Go，JSON-RPC 2.0 over stdio）
  main.go                      #   initialize/describe/invoke/health + sampling 反向 RPC
  e2e_mock_host.py             #   自建 host 模拟器（全链路 + 失败路径）
  executa.json                 #   dev 注册信息（stdio 子进程注册键）
fixtures/sampling-mock.jsonl   # --mock-sampling 回放 fixture
scripts/
  test-executa.sh              # 绕过 harness 的 stdio 全链路测试（19 断言）
  build-binary.sh              # 三平台交叉编译 + 归档 + describe smoke test
  ui-e2e.mjs                   # 浏览器实测（playwright，拦截 RPC 留证据）
.github/workflows/release.yml  # push v* / 手动触发 → 三平台 Release assets
notes/                         # 官方文档协议摘录（executa/sampling/storage/manifest）
bundle/ dist/                  # 构建产物（gitignore）
```

## 安装依赖

```bash
# Node.js（vite 8 需要较新版本，本项目在 node v26 验证）+ npm
# Go 1.21+（executa 构建）
# anna-app CLI：npm 全局安装（本地 harness 需要 uvx anna-app-runtime-local，
#   首次跑 dev 前可先 uvx anna-app-runtime-local@0.2.0a21 预热缓存，
#   否则冷拉可能超 harness 的 bridge 就绪超时）
# 可选：playwright（npm i --no-save playwright && npx playwright install chromium）
```

## 构建前端 bundle

```bash
npm install
npm run build      # 产物在 bundle/，base 相对路径
```

一键自检：`./scripts/selfcheck.sh`。

## 校验 manifest

```bash
anna-app validate --strict
```

## 本地 UI harness

```bash
anna-app dev --no-llm --slug mini-notes
# 打开 http://127.0.0.1:5180/，在 iframe 里实测创建/列表/删除/Summarize。
# 仓库目录名含空格时必带 --slug：否则 deriveSlug 回退到目录名，
# app 静态路由会 404（实测）。
```

浏览器自动实测（playwright，拦截 `/api/session/call` 请求体留
storage.get/set 与 tools.invoke 的 RPC 证据）：

```bash
node scripts/ui-e2e.mjs
```

### 为什么 --no-llm 下 Summarize 预期失败

`--no-llm` 禁用了 harness 的 llm bridge，executa 发出的
sampling/createMessage 反向 RPC 会被 harness 拒绝。所以 Summarize
点击后 UI 显示：

```
总结失败：sampling failed (-32603 harness started with --no-llm)
```

链路已经完整走通：tools.invoke → executa → sampling 请求发出 →
ACL 放行（manifest 声明了 `ui.host_api.llm`）→ harness 因 --no-llm
主动拒绝（-32603）。这是 **App 调试路径的预期行为**（等价于题目的
[-32603]），不代表后端 sampling 链路有问题——后端链路独立于 UI
验证，见下节。

## 单独测后端 sampling 链路

```bash
anna-app executa dev --dir executas/notes-summarizer \
  --invoke summarize \
  --args '{"notes":["明天跟客户 follow up","修复登录 bug","Workshop 内容想法"]}' \
  --mock-sampling fixtures/sampling-mock.jsonl
```

fixture 格式（JSONL，每行一条 mock 规则）：

```json
{"ns":"sampling","method":"createMessage",
 "match":{"contentIncludes":"请总结以下笔记"},
 "result":{...sampling 响应（role/content/model/stopReason）...}}
```

`contentIncludes` 命中固定的 prompt 前缀「请总结以下笔记」，说明 sampling 请求
携带了笔记内容；它不依赖某一条具体笔记文本。tool 侧 stderr 会打印
`[sampling] request sent id=sr-1`，即反向 RPC 已发出的证据。

## 手动测 Executa JSON-RPC

构建一次二进制，然后按行发 JSON-RPC 帧（每行一帧，stdin EOF 即退出）：

```bash
cd executas/notes-summarizer && go build -o bin/notes-summarizer .

# initialize：协议 v2 协商，应回显 protocolVersion 2.0 且带 sampling 能力
echo '{"jsonrpc":"2.0","method":"initialize","id":0,"params":{"protocolVersion":"2.0"}}' | ./bin/notes-summarizer

# describe：裸 manifest（name/host_capabilities/tools）
echo '{"jsonrpc":"2.0","id":1,"method":"describe"}' | ./bin/notes-summarizer

# health
echo '{"jsonrpc":"2.0","id":3,"method":"health"}' | ./bin/notes-summarizer

# invoke 需要 sampling 响应才能返回：单发会挂到超时。
# 全链路（含 sampling 往返）用：
./scripts/test-executa.sh          # shell 版，19 断言
python3 e2e_mock_host.py           # python 版，自建 mock host + 失败路径
```

注意：工具对每个请求起独立 goroutine，多个请求连续发送时响应可能
乱序（JSON-RPC 2.0 允许，按 id 匹配即可）。

## 确认笔记走 anna.storage

- 代码路径：`src/main.ts` 顶部数据契约注释——读走 `storage.get`、
  写走 `storage.set`（增删都是 get→改→set），总结前先 get 重读。
- 运行时证据：`node scripts/ui-e2e.mjs` 拦截的 RPC 请求体里能看到
  `{"ns":"storage","method":"get/set","args":{"key":"notes",...}}`；
  harness 日志里 storage backend 为 legacy（in-memory runtime_state）。
- 存储形状：单 key `notes`，值为笔记数组（含 id/content/createdAt/order），
  数组顺序即显示顺序。

## 确认 summary 链路（tools.invoke → Executa → sampling）

```
Summarize 按钮
  → resolveToolId()（tools.list() / __ANNA_TOOL_IDS__ 解析真实 tool_id）
  → anna.tools.invoke {tool_id, method:"summarize", args:{notes}}
    → harness 把 invoke 转发给 executa 子进程（stdio JSON-RPC）
      → executa 发反向 RPC sampling/createMessage（经 stdout）
        → host LLM 生成总结 → 响应回 executa
      → executa 返回 {success:true, data:{summary}}
  → UI 展示 summary
```

证据读取方式：

- 前端：ui-e2e.mjs 拦截到 `ns=tools method=invoke`，args 的
  tool_id 为运行时解析结果（dev 下是 executa.json 的真实 id）与
  重读后的 notes。
- 后端：executa stderr 的 `[sampling] request sent id=sr-1`；
  fixture 的 contentIncludes 子串命中 = 请求携带了笔记内容；
  返回的 summary 文本来自 fixture（mock 回放），非前端本地拼接。

## 二进制打包

```bash
./scripts/build-binary.sh          # 本机平台 → dist/
./scripts/build-binary.sh all      # 三平台全量（CI 用）
VERSION=0.2.0 ./scripts/build-binary.sh   # 覆盖版本（默认 0.1.0；同时写入归档名和 describe）
```

产出 `notes-summarizer-<version>-<platform-key>.<ext>`：
`darwin-arm64` / `darwin-x86_64`（.tar.gz，bin/ + 根 manifest.json，
二进制保留可执行位）、`windows-x86_64`（.zip，.exe）。每个归档构建后
自动跑 describe smoke test（跨平台产物在非原生 host 上降级为格式检查）。

## GitHub Actions 发布

`.github/workflows/release.yml`，两种触发：

- 推送 `v*` 标签（如 `v0.2.0`）
- 手动 workflow_dispatch（可填目标 tag；留空用最近 v* 标签）

三平台在各自原生 runner 上构建（macos-15 / macos-15-intel /
windows-latest），各跑 describe smoke test，最后由 release job 用
gh CLI 创建（或更新）Release 并上传三个 assets：

```
notes-summarizer-<ver>-darwin-arm64.tar.gz
notes-summarizer-<ver>-darwin-x86_64.tar.gz
notes-summarizer-<ver>-windows-x86_64.zip
```

### 关于 VS Code 的 "Unable to resolve action" 提示

编辑器里 release.yml 的 5 处 `uses:` 行可能被 VS Code GitHub Actions
扩展（github.vscode-github-actions）标 "Unable to resolve action"。
这是**伪报错**：本 workflow 只引用 `actions/checkout@v4`（×2）、
`actions/setup-go@v5`、`actions/upload-artifact@v4`、
`actions/download-artifact@v4` 四个官方一方 action，拼写与版本均正确
（文件无 BOM、无 CRLF、无隐藏字符）。报错来自扩展内置语言服务器在
本地联网解析 uses 目标失败（网络受限时 fetch action.yml 失败即标
Error 诊断），不影响 workflow 在真实 GitHub Actions 上运行——push 后
即按原样执行。

该扩展没有「关闭远程解析/校验」的设置项（其全部 settings 只有
`workflows.pinned.*` 三项、`remote-name`、`use-enterprise`），无法通过
settings.json 关掉此提示。消除编辑器警告的办法是禁用该扩展本身：

```
code --disable-extension github.vscode-github-actions
# 或在 VS Code 扩展面板里禁用 GitHub Actions
```

## 已知限制

本地 UI harness 里 sampling 反向 RPC 会被 `--no-llm` 拒绝（见上），
完整 summary 需接真实 LLM，或用 `--mock-sampling` 单独验证后端。
插件协议链路已由 `test-executa.sh` / `e2e_mock_host.py`
（自建 host 模拟）与 `anna-app executa dev`（真实 harness）两条路径验证。

## FAQ

### 为什么 `--no-llm` 下点击 Summarize 会报 -32603？

这是预期行为，不是 bug。`--no-llm` 只启动 UI harness，不提供 LLM bridge；
UI 到 tools.invoke、Executa 到 sampling 请求的链路仍会运行，但 sampling 会被
harness 以 `-32603` 拒绝。需要验证真实 summary 时，应连接可用的 LLM，或使用
`--mock-sampling` 验证后端采样链路。

### 为什么工具身份要在四处保持一致？`app.json` 做什么？

四处分别是：`manifest.json` 的 `required_executas` 声明依赖
`bundled:notes-summarizer`；`manifest.json` 的 `ui.host_api.tools` 授权
`required:bundled:notes-summarizer`；前端 `src/anna/tools.ts` 通过发布时注入的
`window.__ANNA_TOOL_IDS__` 或运行时 `tools.list()` 解析可调用的真实 `tool_id`；
Executa `describe` 返回的工具名是 `notes-summarizer`。根目录 `app.json` 只负责
本地 dev harness 把这个 handle 映射到 `./executas/notes-summarizer` 并注册子进程，
不会替代 manifest 的声明、host API 授权或前端运行时解析。

### `--no-llm` 和 `--mock-sampling` 有什么区别？

`--no-llm` 用于 UI harness 调试，重点验证 iframe、storage、tools.invoke 和
失败展示；它预期不返回 LLM 总结。`--mock-sampling` 用于后端 Executa 验证，
用 `fixtures/sampling-mock.jsonl` 回放 sampling 响应，检查 prompt、反向 RPC 和
fixture summary，不需要真实 LLM，也不替代 UI harness 测试。
