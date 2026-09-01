# 03 — Sampling：无 API Key 借 host LLM

来源: https://staging.anna.partners/developers/tools/executa-sampling.md

Sampling = 插件以协议中立方式描述一次补全，Anna 走用户偏好的 provider、计费、返回结果。MCP `sampling/createMessage` 的等价物。**协议 v2 起可用**。一次请求 → 一次响应（多轮/工具调用要另用 Agent Sessions）。

## 三个前置条件（缺一不可）

1. **v2 协商**：host 发 `initialize`，plugin 回 `protocolVersion:"2.0"` + `capabilities.sampling = {}`（见 02）。
2. **manifest 声明**：describe 里 `host_capabilities: ["llm.sample"]`（校验器拒绝未知能力串）。
3. **用户授权**：用户在 Anna Admin 里为这个 Executa 开启 sampling；授权带每 invoke 的 `maxCalls` / `maxTokensTotal` 上限。

缺任一 → `-32008 SAMPLING_NOT_NEGOTIATED`，请求到不了模型。

## 请求字段（反向 RPC，从插件 stdout 发出）

```json
{ "jsonrpc":"2.0", "id":"550e8400-…", "method":"sampling/createMessage",
  "params": {
    "messages": [ { "role":"user", "content": { "type":"text", "text":"Summarize:\n…" } } ],
    "maxTokens": 400,
    "systemPrompt": "You are a concise assistant.",
    "temperature": 0.3,
    "stopSequences": ["\n\n###"],
    "modelPreferences": { "hints":[{ "name":"claude-sonnet" }],
                          "costPriority":0.4, "speedPriority":0.4, "intelligencePriority":0.2 },
    "includeContext": "none",
    "metadata": { "executa_invoke_id": "<the invoke_id>" }
  } }
```

| 字段 | 必需 | 说明 |
|---|---|---|
| `messages` | **yes** | 非空数组，≤64 条；每项 `{role, content:{type:"text", text}}`；role ∈ user/assistant/system |
| `maxTokens` | **yes** | 正整数，上限 = host 的 `maxTokensPerCall`（当前 8192） |
| `systemPrompt` | no | 纯文本 |
| `temperature` | no | 数字 |
| `stopSequences` | no | 字符串数组 |
| `modelPreferences` | no | 省略 = 用用户保存的偏好（**一般应省略**） |
| `includeContext` | no | **Phase 1 只接受 `"none"`** |
| `metadata` | no | 自由 dict；惯例放 `executa_invoke_id` 做 trace 拼接 |
| `responseFormat` | no | `{"type":"json_object"}` 或 `{"type":"json_schema","json_schema":{name,strict,schema}}` |
| `onUnsupported` | no | 模型不支持 json_schema 时：`"error"`(默认) / `"json_object"` / `"text"` |

## 响应（host 经 stdin 送回，同一通道）

```json
{ "jsonrpc":"2.0", "id":"550e8400-…",
  "result": {
    "role":"assistant", "content": { "type":"text", "text":"…" },
    "model":"claude-3-5-sonnet-20241022", "stopReason":"endTurn",
    "usage": { "inputTokens":312, "outputTokens":187, "totalTokens":499 },
    "_meta": { "provider":"anthropic", "latencyMs":1432 }
  } }
```

**结果文本在 `result.content.text`，始终是 string，自己解析。**
同 stdin 上区分请求/响应：有 `method` = Agent 请求；只有 id+result/error = 反向 RPC 响应。

## 模型选择优先级

1. `hints[*].name` → 第一个 model_name **包含** hint（大小写不敏感子串）的活跃模型；costPriority>0 时并列取最便宜
2. 无 hints/无匹配 → `user.settings.preferred_model`
3. 未设 → 默认 provider 最便宜的活跃模型

## 结构化输出（responseFormat）

- **L1 json_object**：保证合法 JSON、不限形状；不被能力门控；prompt 里**必须出现 "JSON" 字样**。
- **L2 json_schema**：schema 限制解码；依赖模型 `supports_structured_output` 标志。不支持时 `onUnsupported` 决定：`error` → `-32010 SAMPLING_UNSUPPORTED_RESPONSE_FORMAT`（error.data = {requested, modelName}）；`json_object` → 降级 L1；`text` → 放弃约束。
- 硬限制（违反 = `-32004 SAMPLING_INVALID_REQUEST`，本地+服务端双重校验）：schema 序列化 ≤32 KB；嵌套 ≤8；总节点 ≤512；`json_schema.name` 匹配 `^[a-zA-Z0-9_-]{1,64}$`。
- 响应 `_meta.responseFormat` 信息块：`{requested, applied, structuredValid, downgraded}`。`structuredValid` 仅供参考，**始终自己做 json parse + fallback**。

## 每 invoke 上限

| 上限 | 值 | 强制点 |
|---|---|---|
| 单次 maxTokens | 8192 | host `DEFAULT_SAMPLING_MAX_TOKENS_PER_CALL` |
| 每 invoke 调用次数 | 8 | `sampling_grant.maxCalls`，host 封顶 8 |
| 每 invoke 总 token | 32000 | `sampling_grant.maxTokensTotal`，host 封顶 32000 |
| sampling_token TTL | 600 s | JWT `aud=executa-sampling` |

次数与总 token 上限在同一 invoke_id 内是**终态**（不可重试越过），只能缩减负载或优雅退出。

## 错误码（JSON-RPC error，稳定码）

| 码 | 名 | 含义 |
|---|---|---|
| -32001 | SAMPLING_NOT_GRANTED | 用户未为此 Executa 开启 sampling |
| -32002 | SAMPLING_QUOTA_EXCEEDED | 账号配额耗尽 |
| -32003 | SAMPLING_PROVIDER_ERROR | 上游 provider 失败 |
| -32004 | SAMPLING_INVALID_REQUEST | 参数畸形（includeContext≠"none"、messages 空、schema 超限） |
| -32005 | SAMPLING_TIMEOUT | 补全超时 |
| -32006 | SAMPLING_MAX_CALLS_EXCEEDED | 每 invoke 调用次数到顶 |
| -32007 | SAMPLING_MAX_TOKENS_EXCEEDED | 每 invoke 累计 token 到顶 |
| -32008 | SAMPLING_NOT_NEGOTIATED | 未协商 v2 或 manifest 缺 `llm.sample` |
| -32009 | SAMPLING_USER_DENIED | 用户明确拒绝 |
| -32010 | SAMPLING_UNSUPPORTED_RESPONSE_FORMAT | 模型不支持且 onUnsupported="error" |

结构化 `error.data.errorCode` 携带符号名，便于 switch。

## 本地测试 / mock

- **`anna-app executa dev --dir ./my-plugin --mock-sampling ./sampling-fixture.jsonl`** — dev harness 用与生产相同的规则校验 responseFormat，并在 mock 模式下合成 `_meta.responseFormat`；fixture 响应省略 json_schema 支持即可测 onUnsupported 分支。
- 完整命令形态见 executa-sampling.md §Testing locally（这是 `anna-app executa dev` 子命令的 flag，不是 `anna-app dev` 的）。

## 易踩坑（文档官方列表）

- 写完 invoke 结果后**不要 process.exit()**——sampling 响应异步到达，提前退出丢反向 RPC。
- **metadata 里回显 invoke_id**（Nexus 靠它归因用量、执行 caps）。
- 不要自带 API Key（想用 OPENAI_API_KEY 时基本都是该用 sampling 的信号）。
- `SAMPLING_MAX_TOKENS_EXCEEDED` / `SAMPLING_USER_DENIED` 是终态，同 invoke 内不可重试。
- 不要信任 `structuredValid` 做解析判断；优先 `onUnsupported:"json_object"` 而非默认 `"error"`。

## SDK

Python `executa_sdk.SamplingClient.create_message`；Node `new SamplingClient().createMessage()`；Go `sampling.New(nil).CreateMessage()`。三者都是单 reader / 多 writer 分发器，均暴露 responseFormat / onUnsupported。
