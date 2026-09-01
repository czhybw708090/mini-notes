# 02 — Executa 生命周期与 v2 握手（initialize + 反向 RPC 分发）

来源: https://staging.anna.partners/developers/tools/executa-lifecycle.md

## 五阶段

| # | 阶段 | 方向 | 默认超时 | 要点 |
|---|---|---|---|---|
| 1 | spawn | Agent → OS | — | 用户环境启动进程，管道 stdin/stdout/stderr |
| 2 | **initialize** | Agent → Plugin | 5 s | v2 握手；-32601 或超时则静默降级 v1 |
| 3 | describe | Agent → Plugin | 5 s（binary onefile 首启 60 s） | 返回 manifest，进程生命周期内缓存 |
| 4 | invoke | Agent → Plugin（循环） | 60 s/工具，可覆盖 | 热路径；v2 协商成功后每次 invoke 解锁反向 RPC |
| 5 | shutdown | 关 stdin → SIGTERM → SIGKILL | 5 s 宽限 | 必须读 stdin 到 EOF；响应一次就 exit 会被标 Stopped |

意外退出：指数退避重启，最多 3 次，基础延迟 1 s。

## initialize 握手（v2 capability negotiation）

Agent 总是先尝试 v2。握手交换：host 能给什么（sampling caps、fileTransport）+ plugin 要用什么（host 能力的子集）。

**请求（Agent → Plugin，id 固定 0）：**

```json
{ "jsonrpc":"2.0", "id":0, "method":"initialize",
  "params": {
    "protocolVersion": "2.0",
    "clientInfo": { "name":"matrix-agent", "version":"1.0" },
    "capabilities": {
      "sampling": {
        "modalities": ["text"],
        "maxTokensPerCall": 8192,
        "maxCallsPerInvoke": 8,
        "responseFormat": ["json_object", "json_schema"]
      },
      "fileTransport": true
    }
  } }
```

**响应（Plugin → Agent）：**

```json
{ "jsonrpc":"2.0", "id":0,
  "result": {
    "protocolVersion": "2.0",
    "server_info": { "name":"my-tool", "version":"0.1.0" },
    "capabilities": { "sampling": {} }
  } }
```

plugin 回显协商后的 `protocolVersion`，`capabilities` 只列**打算使用的能力子集**；空对象 `{}` 合法（表示"知晓该能力，无额外选项"）。

### 降级 v1

以下任一情况透明回退 protocol 1.1：initialize 超时、返回 -32601、任何 error frame。
**v1 插件失去全部反向 RPC**（sampling、storage、未来的 logging/progress）。

## 双重门槛：manifest 声明 + 运行时协商

initialize 协商**必要但不充分**——还必须在 describe manifest 里声明：

```json
{ "name":"my-tool", "version":"0.1.0",
  "host_capabilities": ["llm.sample", "storage.tool"], "tools":[...] }
```

| 能力串 | 解锁 | 反向 RPC 方法 |
|---|---|---|
| `llm.sample` | Sampling | `sampling/createMessage` |
| `storage.user` | APS 用户盘 | `storage/*`、`files/*`（scope:"user"） |
| `storage.app` | APS app 命名空间 | `storage/*`、`files/*` |
| `storage.tool` | APS 工具私有命名空间 | `storage/*`、`files/*` |

缺 manifest 声明 → 网关直接拒：`-32008 not_negotiated`（sampling）、`-32021 not_granted`（storage）。
publish 校验器拒绝未知能力串。

## 每次 invoke 的 context 注入

```json
{ "method":"invoke",
  "params": {
    "tool":"summarize", "arguments":{ "text":"…" },
    "context": {
      "credentials":    { "OPENAI_API_KEY":"sk-…" },
      "invoke_id":      "8f1c…",
      "sampling_token": "eyJ…",
      "storage_token":  "eyJ…"
    } } }
```

| 字段 | 来源 | 用途 |
|---|---|---|
| `credentials` | 平台授权 + 插件覆盖 | 调第三方 API |
| `invoke_id` | Agent 铸造（UUID hex） | 审计关联；反向 RPC 预算键 |
| `sampling_token` | Nexus，JWT `aud=executa-sampling`，TTL 600 s | sampling/createMessage 鉴权 |
| `storage_token` | Nexus，JWT `aud=aps-storage`，TTL 600 s | storage/* 与 files/* 鉴权 |

token 绑定 (user_id, executa_tool_id, tool_invoke_id)，invoke 结束即过期——**绝不跨 invoke 持久化**。

## 反向 RPC 分发（单 stdin 双通道）

同一 stdin 上既有 Agent 发起的请求，也有 host 对反向 RPC 的响应。**区分方法：有 `method` 字段 = Agent 请求；只有 `id` + `result|error` = 反向 RPC 的响应**。官方 SDK 已处理。

## 关闭契约

1. Agent 关闭 stdin → 循环自然退出
2. 等最多 5 s
3. SIGTERM，再等 5 s
4. SIGKILL

关闭时 flush 缓冲、关文件句柄。仅真崩溃才非零退出（非零计入重启预算）。

## 健康探针

同 01：`health` → `{status: "ready"|"error"|"initializing", message, details}`。省略 health 视为健康（-32601 被忽略）。
