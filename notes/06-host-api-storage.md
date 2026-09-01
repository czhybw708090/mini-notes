# 06 — Host API: storage.*（APS 键值存储）

来源: https://staging.anna.partners/developers/reference/host-api-storage.md

## 两后端、同一表面

- **APS 后端（生产 canonical）**：Postgres 行、每行 etag（`W/"<gen>-<digest>"`）、字节/条目配额、`if_match` 乐观并发、`ttl_seconds`、`metadata`/`tags`、丰富错误码。
- **legacy runtime_state 回退**（anna-app-core dispatcher 内）：整桶存单个 JSON 列，硬上限 **256 KiB**（`MAX_RUNTIME_STATE_BYTES`），每次 set/delete 广播 `runtime_state_synced`；**不支持** if_match/metadata/tags/ttl。

## ACL 双层（重要）

1. **主门禁**：`manifest.ui.host_api.storage`（string[]）必须含被调方法（`get`/`set`/`delete`/`list`）或 `*`。`manifest.permissions[]` 只是展示/审计，**调度器从不检查它**。
2. 能力串只门禁**非默认 scope/owner**：默认 `scope=app, owner=self` 不需要任何额外声明。跨 owner 的 scope=app / scope=tool 当前一律 `not_implemented`。

## key / value 规则

- key：总长 ≤1024 字符；每个 `/` 段 ≤128 字符；无前导 `/`；无空段、`.`、`..` 段；无 ASCII 控制符/`\`/零宽/bidi 字符；段内无首尾空白。大小写敏感（`foo/bar` ≠ `Foo/bar`）。**建议稳定前缀方案：`notes/<id>`**。
- value：任意 JSON 可序列化类型（函数/BigInt/循环引用在 postMessage 处被拒）。`null` 合法且能往返——**判断缺失 vs 存了 null 必须用 `cur.exists`，不是 `cur.value`**。
- etag 不透明，当黑盒 token 用。

## 方法签名与返回形状

### storage.get

```ts
anna.storage.get(args: {key: string, scope?: 'app'|'user'|'tool', owner?: string},
                 opts?: {timeoutMs?: number})
  => Promise<{value: any, etag?: string, generation?: number, exists: boolean}>
```

命中 → `{value, etag, generation, exists: true}`；缺失/过期/软删除 → `{value: null, exists: false}`（三者同形）。etag 回喂 set/delete 的 if_match。

### storage.set

```ts
anna.storage.set(args: {key, value, scope?, owner?, if_match?, metadata?, tags?, ttl_seconds?},
                 opts?)
  => Promise<{etag: string, generation: number, size_bytes: number}>
```

- `if_match`：与活行 etag 不匹配（含行已不存在）→ `precondition_failed`（镜像 GCS/S3 If-Match）。并发首插竞争也表现为 precondition_failed——重试读-改-写循环。
- `ttl_seconds`：1..365 天；过期行对 get 表现为 404。
- `metadata`（自由对象）/`tags`（≤32 个自由标签）：list 时往返，不做索引；legacy 后端忽略。
- 没有 bundle 侧体积预检——超限以 `value_too_large`（APS 行上限）或 `state_too_large`（legacy 256 KiB）返回。

### storage.delete

```ts
anna.storage.delete(args: {key, scope?, owner?, if_match?}, opts?)
  => Promise<{deleted: true}>
```

软删除：立即从 get/list 消失、配额字节立即归还。if_match 不匹配 → `precondition_failed`；legacy 后端忽略 if_match。APS 缺 key 报 `not_found`；legacy 静默 no-op。

### storage.list

```ts
anna.storage.list(args?: {prefix?, cursor?, limit?, scope?, owner?}, opts?)
  => Promise<{items: Array<{key, etag, size_bytes, metadata, tags, updated_at}>,
              next_cursor: string|null}>
```

- **只返回元数据行，不含 value**——需要内容再逐条 storage.get。
- `prefix`：startswith 匹配，无 glob/正则；可以 `/` 结尾；空串列全桶。同 key 校验。
- `cursor`：不透明（base64 化），跨部署不稳定，重试时从头翻页。legacy 后端用裸 key 作 cursor。
- `limit`：1..1000，默认 100。APS 后端静默 clamp，legacy 超界报 invalid_arg。

## 错误码

`StorageErrorCode`：`not_found`、`precondition_failed`、`invalid_path`、`value_too_large`、`quota_exceeded`、`forbidden_scope`、`not_granted`、`pending_upload`、`rate_limited`、`internal_error`；另有 SDK 层 `invalid_arg`（缺 key 等）。

## 本地 dev 注意

dev harness 用 in-memory WindowStore（见 09）。只有跑过 legacy 后端的 app 切 APS 时会静默丢失跨窗口实时同步——焦点回来时轮询 storage.get 兜底。实现本 app 时优先假设 APS 形状（`exists`/etag 字段齐全），legacy 后端下 etag 等字段缺失时降级。
