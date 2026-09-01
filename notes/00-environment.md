# 00 — 环境与安装事实（2026-08-27 实测）

## 版本

| 组件 | 实测版本 | 要求 |
|---|---|---|
| Node.js | v26.4.0 | 22+ ✓ |
| Go | go1.27.0 darwin/arm64 | 1.21+ ✓ |
| anna-app CLI | 0.1.49 | — |
| uv | 0.12.3 | dev 必需 ✓ |

平台：macOS 14.8.1 (arm64)，无 Homebrew。

## anna-app 安装方式（以官方文档为准）

- 官方文档（apps/app-quickstart）指定的包名是 **`@anna-ai/cli`**：
  `npm i -g @anna-ai/cli`（包名 `@anna-ai/app-cli` 在 npm 上**不存在**，勿用）。
- 本机 npm 全局 prefix 是 root 所有的 `/usr/local`，无法直接全局安装。改为用户级 prefix：
  `npm config set prefix "$HOME/.npm-global"`，bin 落在 `~/.npm-global/bin/anna-app`。
- Go 同理装到 `~/sdk/go`，PATH 已写入 `~/.zshrc` / `~/.zprofile` / `~/.zshenv`，并 symlink 到 `~/.local/bin/go`。

## anna-app doctor 输出（2026-08-27）

```
anna-app doctor
  ✓ uv      uv 0.12.3 (507230998 2026-08-07 aarch64-apple-darwin)
  · uvx     no cache for anna-app-runtime-local@0.2.0a21
    first 'anna-app dev' will install via 'uvx anna-app-runtime-local@0.2.0a21' (one-time)
  · nexus   not found (uvx mode will be used)
  · key     /Users/dd/.anna-app/dev.key (missing — will be auto-created on first run)

  all required checks passed
```

- `uvx` 无缓存、`nexus` 缺失、`dev.key` 缺失均为提示项（首次 `anna-app dev` 自动处理），非致命。
- doctor 只检查 uv / uvx 缓存 / dev key；它**不检查** Go / Node 之外的工具链。

## 文档来源

官方文档（staging.anna.partners，2026-08-27 拉取，原始 markdown 缓存于 /tmp/anna-docs/）：

- tools/executa-protocol、tools/executa-sampling、tools/executa-lifecycle、tools/executa-binary
- reference/app-manifest、reference/ui-manifest、reference/host-api-storage、reference/host-api-tools
- apps/app-ui-sdk、apps/local-dev、apps/app-quickstart
