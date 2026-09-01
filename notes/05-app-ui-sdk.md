# 05 — App UI SDK（iframe 内加载与调用）

来源: https://staging.anna.partners/developers/apps/app-ui-sdk.md

## 加载方式

SDK 是 host 提供的**单文件 ESM**：`/static/anna-apps/_sdk/latest/index.js`。在 iframe 内运行，通过 postMessage 与父窗口通信。**原生 ES module**（`export AnnaAppRuntime`，无 window 全局），必须用 `<script type="module">` + import；SDK origin 已自动进 bundle CSP 的 script-src。无需打包器。

## 最小 bundle

```html
<script type="module">
  import { AnnaAppRuntime } from "/static/anna-apps/_sdk/latest/index.js";
  const anna = await AnnaAppRuntime.connect();
  // anna.storage.set({ key: "notes", value: ... });
</script>
```

## `AnnaAppRuntime.connect()` 背后

1. 从 iframe URL 读 `?wid=…&t=…`
2. postMessage 发 `window.hello` RPC 给父窗口
3. 收到 `capabilities`、`view_meta`、`entry_payload`、`runtime_state`、`geometry` 并 resolve
4. 启动 10s 心跳（首次 hello 后 `window.ready`，之后 `window.heartbeat`）
5. 订阅 host 事件（`auth.refresh` 内部自动换 token；另有 `entry_payload`、`runtime_state_synced`、`geometry_changed`、`close`…）

## 返回对象形状

```ts
interface AnnaAppRuntime {
  windowUuid: string; appId: string; versionId: string;
  viewMeta:   { name: string; title: string; default_size: {w,h}; … };
  capabilities: { tools: string[]; chat: string[]; storage: string[]; … };
  entryPayload: any;                    // open_app_view(payload=…) 传入
  runtimeState: Record<string, any>;    // 服务端持久化的 runtime_state
  geometry: { x; y; w; h; … };
  tools:    { list(); invoke(args); };
  storage:  { get(args); set(args); delete(args); };   // list 见 06
  window: {
    set_title({title}); resize({w,h}); focus();
    close({reason?}); open_view({view, payload?});
    report_error({message, stack?});
  };
  on(event: "entry_payload"|"runtime_state_synced"|"geometry_changed"|"title_changed"|"close",
     handler): () => void;   // 返回退订函数
}
```

- 命名空间代理由 `window.hello` 返回的 `capabilities` 动态生成——manifest 没列的方法，调用直接 `permission_denied`，客户端无法越权。
- `window.*` 永远允许，无需授权。

## 首次打开 vs 恢复

| 字段 | 来源 | 用途 |
|---|---|---|
| `entry_payload` | `open_app_view(payload=…)` / `update_app_view(runtime_state_patch=…)` | 每次调用时 LLM/用户的指令 |
| `runtime_state` | 此前会话的 storage.set | 自己持久化的 UI 状态（legacy 总桶 ≤256 KB） |

推荐模式：`runtimeState?.bootedOnce` 为真 → 用 runtime_state 重建 UI 再合并 entry_payload；否则用 entry_payload 引导并 set bootedOnce。订阅 `entry_payload` / `runtime_state_synced` 事件做增量更新。

## 调用 Executa

```js
const { result } = await anna.tools.invoke({
  tool_id: "tool-yourhandle-browser-abcd1234",
  method:  "page.fetch",   // mint-only tool_id 时必需
  args:    { url: "https://example.com" }
});
```

host 把 tool_id 解析为 (plugin_name, tool_name) 后经 NATS 调用户当前在线的 Anna Agent；无 agent 在线 → `agent_unavailable`。

## RPC 响应 / 错误形状

每个 RPC 返回 Promise，resolve 为：

```ts
{ ok: true,  result: any }
{ ok: false, error: { code: string; message: string; details?: any } }
```

常见错误码：`invalid_token`（SDK 自动刷新多数情况）、`permission_denied`（(ns,method) 不在 host_api 或 tool_id 不在白名单）、`invalid_arg`、`not_found`、`agent_unavailable`、`bundle_not_ready`、`rate_limited`。

**注意：SDK 层的调用形状是 `const { result } = await anna.tools.invoke(...)` / `const { value } = await anna.storage.get(...)`，即 Promise resolve 为 `{ok, result}` 且习惯性解构 `result`；而 `ok:false` 时同一位置是 `error`。写代码时先判 `ok`。**
