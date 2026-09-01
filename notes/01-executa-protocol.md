# 01 — Executa 协议（JSON-RPC 2.0 over stdio）

来源: https://staging.anna.partners/developers/tools/executa-protocol.md

## 传输规则

- JSON-RPC 2.0 over stdio，**行分隔（LF）**，UTF-8，一条消息一行，无 Content-Length 头。
- **stdout 只用于协议响应**；stderr 用于日志（Agent 采集到 trace view）。
- 单行响应 ≤ 2 MiB；超过 ~512 KiB 建议用 file transport（见下）。
- **插件进程必须长驻**：循环读 stdin，只在 stdin EOF 或信号时退出。写一条响应就退 = 协议违规，被标 Stopped，每次调用都冷启动。**每次写完响应必须 flush stdout**。

## describe（裸 manifest，无包裹）

请求 `{"jsonrpc":"2.0","method":"describe","id":1}`（无 params）。

**响应 result 直接就是 manifest 对象，没有外层包裹：**

```json
{
  "jsonrpc": "2.0", "id": 1,
  "result": {
    "name": "my-tool", "display_name": "My Tool", "version": "1.0.0",
    "description": "What this plugin does.", "author": "...", "homepage": "...",
    "icon": "🔧", "category": "productivity", "license": "MIT",
    "host_capabilities": ["llm.sample"],
    "tools": [
      { "name": "do_something", "description": "Description shown to the LLM.",
        "timeout": 60, "streaming": false,
        "parameters": [
          { "name": "input_text", "type": "string", "description": "Input.", "required": true },
          { "name": "count", "type": "integer", "required": false, "default": 1 },
          { "name": "tags", "type": "array", "items": {"type": "string"}, "required": false }
        ] }
    ],
    "credentials": [ { "name": "MY_API_KEY", "display_name": "My API Key", "required": true, "sensitive": true } ],
    "runtime": { "type": "uv", "min_version": "0.1.0" }
  }
}
```

manifest 必需字段：`name`、`version`（SemVer）、`description`、`tools`（≥1 条）。
`name` 不是身份标识——发布时 registry 铸造稳定 `tool_id`，Agent 按 `tool_id` 关联安装与运行中的插件，name 不匹配无所谓。

### 工具定义

| 字段 | 必需 | 说明 |
|---|---|---|
| `name` | yes | 插件内唯一 |
| `description` | yes | 给 LLM 看的选型提示 |
| `parameters` | no | 空 list = 无参数 |
| `timeout` | no | 每工具超时秒数，默认 60 |
| `streaming` | no | 保留字段 |

### parameters[] 用法

每项字段：`name`、`type`、`description`、`required`（**默认 true**）、`default`、`enum`；array 另加 `items`（JSON Schema 形式）或 `items_type`（协议简写）。

`type` 取值：`string` `integer` `number` `boolean` `array` `object`。
array 无 items 声明时**默认 string 列表**（避免 LLM 传 JSON 编码字符串）。

## invoke

**参数形状用 `tool`，不是 `name`：**

```json
{ "jsonrpc":"2.0", "method":"invoke", "id":2,
  "params": { "tool":"do_something", "arguments":{"input_text":"hello"},
              "context": { "credentials":{"MY_API_KEY":"sk_..."} } } }
```

`params.context.credentials` 仅当用户配置了凭据才注入，LLM 看不到。

**成功响应（InvokeResult 形状）：**

```json
{ "jsonrpc":"2.0", "id":2, "result": { "success":true, "data":{...}, "duration_ms":12 } }
```

Agent 把 result 解码为 `{success, data, error, duration_ms}`；`data` 下的内容就是 LLM 看到的内容；`duration_ms` 可选。

**工具级失败（可恢复错误，应告知 LLM）—— 不是 JSON-RPC error frame：**

```json
{ "jsonrpc":"2.0", "id":2, "result": { "success":false, "error":"city not found" } }
```

## health（可选）

`{"jsonrpc":"2.0","method":"health","id":3}` → `{"result":{"status":"ready","message":"","details":{}}}`。
status ∈ `ready` | `error` | `initializing`。省略该方法视为健康（-32601 被忽略）。

## JSON-RPC 错误码

| 码 | 含义 |
|---|---|
| -32700 | Parse error |
| -32600 | Invalid request |
| -32601 | Method / tool not found |
| -32602 | Invalid params |
| -32603 | Internal error |
| -32000 ~ -32099 | 实现自定义 server error |

> 分界线：**预期失败**（not found / rate limited）用 `result.success=false`；**程序员错误**（unknown tool / missing arg）用 JSON-RPC `error` frame。Agent 在 trace view 中区别对待。

## 默认超时

| 方法 | 默认 | 可覆盖 |
|---|---|---|
| describe | 5 s | 不可配（binary onefile 首次启动 60 s） |
| health | 3 s | 不可配 |
| invoke | 60 s | `tools[].timeout` |

超时 → SIGTERM，请求以 JSON-RPC timeout error 解析。

## 生命周期摘要

spawn → 立刻 describe（等 5s）→ invoke 循环（每工具超时）→ 空闲/关闭时 SIGTERM（5s 宽限）→ SIGKILL。
意外退出：指数退避重启，最多 3 次。**SIGTERM 要干净处理**；仅真崩溃才非零退出。

## 反向 RPC 与 invoke 关联（v2）

- 每个反向 RPC 都挂在某个 in-flight `invoke` 上执行。host 在 forward invoke 里注入 `params.context.invoke_id`；**插件必须原样回显**在反向 RPC 的 `params.context.invoke_id`。
- 路由规则：匹配 → 用该 invoke 的 token/deadline/quota；未知/已结束 → `-32602 UNKNOWN_INVOKE_CONTEXT`；省略且恰好 1 个活跃 invoke → 回退兼容；省略且多个活跃 → `-32602 MISSING_INVOKE_CONTEXT`（绝不猜测）。
- 官方 SDK 自动盖章（Go: `InlineRequest.InvokeID` / `Client.SetInvokeID`）。

## File transport（大响应）

超过 ~512 KiB：把完整响应写到临时文件，stdout 发指针：

```json
{ "jsonrpc":"2.0", "id":4, "__file_transport": "/tmp/executa-resp-XXXXXX.json" }
```

Agent 读文件、解码、删除。
