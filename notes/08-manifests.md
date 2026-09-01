# 08 — App manifest（schema 2）与 ui 段

来源: https://staging.anna.partners/developers/reference/app-manifest.md 、/reference/ui-manifest.md 、apps/app-quickstart.md

## 顶层字段（未知 key 会被拒）

| 字段 | 类型 | 说明 |
|---|---|---|
| `schema` | int | 版本号，取值 [1,2]，**默认 1** —— 本项目必须显式写 `2` |
| `required_executas` | `ManifestExecutaRef[]` | 必需 Executa：`{tool_id, version?, min_version?}`；`version:"latest"` 发布时自动冻结 |
| `optional_executas` | `ManifestExecutaRef[]` | 装了就用、没有也能跑；同形状 |
| `host_capabilities` | string[] | 严格白名单（校验 `_ALLOWED_HOST_CAPABILITIES`）：`aps.kv`、`aps.files`、`aps.scope.*`、`llm.sample`、`llm.complete`、`llm.embed`、`llm.agent.*`、`llm.image`、`web.*`、`host.upload`。**每个捆绑 Executa 也必须自己声明自己的 host_capabilities**（见 02/03）；每 invoke token 按「Executa 声明 + 用户授权」双重门禁 |
| `permissions` | string[] | 粗粒度权限 token，安装时展示、调度器强制（注意：storage 的实际门禁在 ui.host_api，见 06） |
| `tags` | string[] | 商店搜索/筛选 |
| `system_prompt_addendum` | string | App 在本轮活跃时注入系统提示，≤4000 字符 |
| `user_message_prefix_template` | string | #提及 App 时前置到用户消息，≤500 字符 |
| `ui` | UiManifestSection | bundle/views/host_api/CSP |
| `dev` | AppDevConfig（dev-only） | 本地 harness 专用；`anna-app publish` 剥离、生产 dispatcher 忽略 |

## ui 段

### bundle（UiBundleSection）

- `bundle.entry`（**必填**）：bundle 内 SPA 入口 HTML 相对路径
- `bundle.format`：默认 `static-spa`
- `bundle.external_origins`：iframe 允许加载资源的外部 origin（CSP 感知）

### views（UiViewSpec[]）

| 字段 | 说明 |
|---|---|
| `view.name` | 稳定标识（1–40 字符，App 内唯一）；`window.open_view` 使用（必填） |
| `view.title` | chrome 里的窗口标题（必填） |
| `view.entry` | 视图的 bundle 内子路由；默认 bundle 入口 |
| `view.icon` | bundle 相对图标 |
| `view.default` | App 激活时是否自动打开 |
| `view.default_size` / `min_size` / `max_size` | CSS 像素 `{w,h}`，界 [120, 4096] |
| `view.resizable` / `movable` / `single_instance` | 窗口 UX 标志 |
| `view.summary_template` | 为 LLM 总结视图状态的模板，≤400 字符 |

### 其他

- `csp_overrides`：按指令追加 CSP（object of directive → string[]）
- `state_merge`：并发 runtime_state 写冲突策略，默认 `last_writer_wins`
- `host_api`：UI bundle 可调用的 Host API 方法白名单，按命名空间（**决定 storage/tools 能否调用的关键**，见 06/07）

## 脚手架事实（quickstart 模板结构）

```
my-app/
├── manifest.json       # schema 2 — UI + executa + dev block
├── app.json            # 商店列表元数据（name, tagline, category）
├── bundle/             # index.html + app.js（iframe 入口，拉 AnnaAppRuntime SDK）
├── executas/
│   └── <name>/         # 本地 stdio executa（语言自动探测）
└── README.md
```

- 脚手架的 `tool_id` 是合成 dev id：`tool-dev-<slug>` —— 发布前即可在 manifest 里引用本地 executa。
- **executa 自动探测优先级**：`executa.json`（显式）> `pyproject.toml`（Python，经 `uv run`）> `package.json`（Node）> **`go.mod` + `executa.json`（Go）** > `bin/<name>`（预编译二进制）。
  → 本项目用 Go 写 Tool，目录里要放 `go.mod`（+ 按探测规则提供 `executa.json`）。
- 校验：`anna-app validate`（JSON Schema + ui 静态 + tool_id 交叉检查，Levenshtein-1 拼写建议）；`--strict` 另 grep bundle 验证 host_api 白名单覆盖。
