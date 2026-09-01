# 09 — 本地开发（anna-app dev）与 mock 行为

来源: https://staging.anna.partners/developers/apps/local-dev.md 、apps/app-quickstart.md 、tools/executa-sampling.md（Testing locally）

## dev harness 构成

`anna-app dev` 在本机启动完整自包含 harness：

- production 同款 RPC dispatcher（`anna-app-core`）
- in-memory `WindowStore`（无 Postgres/NATS/Executa Agent）
- 静态文件服务，把 bundle 装进 iframe（`/anna-apps/<slug>/dev/index.html?wid=<uuid>&t=<dev-token>`）
- SSE 中继（`auth.refresh`、`app/method`、`entry_payload` 与生产一致地推送进 iframe）
- 进程 supervisor：**`executas/<name>/` 的 `tools.invoke` RPC 经 stdio 转发给本地插件进程**（无 NATS）

打开 `http://127.0.0.1:5180/dev/<wid>?t=<dev-token>`（默认端口 5180）。

## 运行时模式（自动二选一）

- **uvx（终端用户默认）**：`uvx anna-app-runtime-local@<PIN> anna-app-bridge`；wheel 一次性拉取缓存。doctor 里 "no cache" 行指的就是它。
- **nexus-source**：传 `--matrix-nexus-root` / 设 `$ANNA_NEXUS_ROOT` / 自动检测在 nexus checkout 内时用源码树。

两种模式字节等价（同一个 wheel 里的 dispatcher）。

## 常用 CLI flags

| Flag | 默认 | 用途 |
|---|---|---|
| `--manifest <path>` | `manifest.json` | manifest 路径（相对 `--cwd`） |
| `--bundle <dir>` | `./bundle` | 静态根，served at `/anna-apps/<slug>/dev/` |
| `--slug <slug>` | manifest `slug` → `name` | URL 与 SSE topic 用 |
| `--view <name>` | manifest 默认 | 启动时打开非默认视图 |
| `--port <n>` | 5180 | dev server 端口 |
| `--user-id <id>` | 1 | harness user_id（也可 `manifest.dev.user_id`） |
| `--no-watch` | 开 | 关 bundle watcher（LiveReload） |
| `--executa <spec>`（可重复） | 自动探测 | 显式注册 executa：`dir=<path>[,tool_id=<id>][,type=python|node|go|binary][,command="<argv>"]`；给出即替代自动探测，且无视该目录的 `enabled:false` |

## `manifest.dev` 块（可选；生产 dispatcher 忽略，publish 剥离）

```jsonc
{
  "dev": {
    "fixtures": ["fixtures/*.jsonl"],        // 回放录制
    "seed_storage": { "theme": "dark" },      // 初始 runtime_state
    "user_id": 1,                             // 覆盖 --user-id 默认
    "mocks": { "tools.invoke": { "success": true, "data": {} } }  // 静态响应，键 "ns.method"
  }
}
```

## LLM 相关 mock 行为（重点确认项）

**`anna-app dev` 的 flag：**

| Flag | 行为 |
|---|---|
| `--no-llm` | `anna.llm.*` / `anna.agent.*` 桥默认连真实 nexus（需 `anna-app login`）。带此 flag 离线开发：**调用返回 `llm_disabled`** |
| `--mock-llm <fixture>` | 从 JSONL fixture 回放罐头响应 |

注意：这两个 flag 作用于 **iframe 侧的 anna.llm/anna.agent 桥**。

**`anna-app executa dev` 子命令的 flag（插件侧 sampling mock）：**

| Flag | 行为 |
|---|---|
| `--mock-sampling ./sampling-fixture.jsonl` | dev harness 用与生产相同的规则校验 `responseFormat` 并合成 `_meta.responseFormat`；sampling 反向 RPC 由 JSONL fixture 回放。fixture 响应里省略 json_schema 支持即可测 `onUnsupported` 分支 |

> 也就是说：Executa 插件里的 sampling/createMessage 在本地测试时要用 `anna-app executa dev --dir <plugin-dir> --mock-sampling <fixture>` 形态驱动（详见 executa-sampling.md §Testing locally）；`anna-app dev`（整体 app harness）文档未列出 `--mock-sampling`，其 LLM mock 是 `--no-llm` / `--mock-llm`。实现时以 `anna-app --help` 实测为准。

## dev 里没有的东西

- 无 `chat.read_history` / `chat.write_message` 持久化（Phase 3 才有）
- `anna.llm.*` / `anna.agent.*` 默认桥接真实 nexus（须 login）；离线用 `--no-llm` / `--mock-llm`
- 无真实 Executa NATS —— `tools.invoke` 走本地 stdio 子进程；要练生产 NATS 路径需 staging nexus + `anna-app dev --remote`（Phase 9）

## 快速命令

```bash
anna-app init <dir> --slug <slug>   # 脚手架（含 manifest.json schema 2）
anna-app dev                        # 起 harness
anna-app validate [--strict]        # 发布前校验
```

doctor 检查项：uv、uvx 缓存、（contributor 场景的）in-tree runtime 路径。见 00-environment 的实测输出。
