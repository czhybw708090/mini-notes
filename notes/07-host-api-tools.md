# 07 — Host API: tools.*（iframe 直调 Executa）

来源: https://staging.anna.partners/developers/reference/host-api-tools.md

iframe 内绕过 LLM 直接驱动已安装的 Executa 工具（确定性 UI 动作："点按钮 → 跑工具"）。

## ACL 双层

一个工具必须同时满足：(a) 在 `manifest.required_executas` 或 `optional_executas` 中声明；(b) 被 `manifest.ui.host_api.tools` 的条目匹配（`"required:*"`、`"optional:*"`、裸 `tool_id`、或任何 `<prefix>:<tool_id>`）。`tools.list` 返回恰好两者交集；`tools.invoke` 每次调用再查，违规 `permission_denied`。

## tools.invoke（本 app 的核心调用）

```ts
anna.tools.invoke(args: {tool_id: string, method?: string, args?: object, timeoutMs?: number},
                  opts?: {timeoutMs?: number}) => Promise<object>
```

- `tool_id`（必需）：server 铸造。mint-only id 形如 `tool-{handle}-{slug}-{uniq}`（**无分隔符**）；legacy 形如 `plugin.tool` / `plugin__tool`。
- `method`：插件侧方法名。**mint-only tool_id 必需**（id 里没有 `.`/`__` 分隔符时省略会 `invalid_arg`）；提供 method 时 tool_id 原样作 plugin_name、method 作 tool_name。
- `args`：结构化参数，原样转发为插件的 `arguments`。host 不做字段级校验。
- `timeoutMs`：毫秒，服务端 clamp 到 [1000, **90000**]（同步通道的公网长连接上限）。省略 → 插件 manifest 的 `tool_def.timeout` → 默认 65 s。host 等待 = clamp 值 + 2000 ms 宽限。

**返回值 = 两层 envelope 剥离后的插件 payload（强制 object）**。原始 NATS 回复是
`{success, data:{success, data:<payload>, error?}}`：外层失败 → `executa_unavailable`；内层失败 → `tool_failed`；否则插件 payload 直接落在 Promise 上。
即：插件 `invoke` 返回 `{success:true, data:{...}}` 时，iframe 拿到的是 **`data` 里的内容**。

错误码：`tool_timeout`、`tool_failed`、`executa_unavailable`、`agent_unavailable`、`permission_denied`、`invalid_arg`。

> 注意与插件侧的时间单位差异：插件 manifest `tools[].timeout` 是**秒**（协议层，见 01），而 iframe 的 `timeoutMs` 是**毫秒**。

## 其他方法

- `tools.list(args?)` → `{tools: [{tool_id, status?}]}`。纯 ACL 投影，无 Agent/NATS 往返；boot 时调用来决定渲染哪些按钮。status ∈ available/deploying/unavailable。
- `tools.invokeAsync(args)` → `{jobId, state:"queued", deadlineMs}` 立即返回；长任务唯一正确通道。`timeoutMs` 是 job deadline（60 s–24 h）；`clientTag`（≤120 字符）是 reload 恢复键。进度经 `tool_job` 窗口事件 + `tools.getJob`。
- `tools.getJob({jobId, sinceSeq?, limit?})` → JobSnapshot（authoritative）。
- `tools.cancelJob({jobId, reason?})` — 协作式、幂等。
- `tools.listJobs({tool_id?, state?, clientTag?, since?, limit?})` — reload 恢复入口，state ∈ queued|running|succeeded|failed|cancelled|expired。

本 app（同步短总结）用 `tools.invoke` 即可，不需要 async job 通道。

## 本地 dev 下的差异

dev harness 里 `tools.invoke` 不经过 NATS/Executa Agent：RPC 直接进 production 同款 dispatcher，**经 stdio 转发给 `executas/<name>/` 的本地子进程**（见 09-local-dev）。所以 tool_id 是脚手架里的合成 id（`tool-dev-<slug>`），method 参数必须显式传。
