# 04 — Executa 二进制分发（archive 结构、平台 key、root manifest.json）

来源: https://staging.anna.partners/developers/tools/executa-binary.md

## 平台 key（"{os}-{arch}"，小写规范化；amd64/x64 自动折叠为 x86_64）

| Host | key |
|---|---|
| macOS Apple Silicon | `darwin-arm64` |
| macOS Intel | `darwin-x86_64` |
| Linux x86_64 | `linux-x86_64` |
| Linux ARM64 | `linux-aarch64` |
| Linux ARMv7 | `linux-armv7l` |
| Windows x86_64 | `windows-x86_64` |
| Windows ARM64 | `windows-arm64` |

解析回退：精确匹配 → OS 前缀（`darwin-*`）→ 通配（`*`/`any`/`universal`）→ 单条目 map。

## 单文件 vs 多文件

| 场景 | Archive 形状 |
|---|---|
| 单自包含二进制（Go/Rust/PyInstaller onefile/pkg） | 裸二进制，**或**（推荐）`.tar.gz`/`.zip` 含可执行文件 + `manifest.json` |
| 二进制 + 捆绑 lib/数据/子工具 | `.tar.gz`/`.zip`，含 `bin/`+`lib/`+`data/`+`manifest.json` |

Go 用 `go build` 即可，无额外产物（`-ldflags "-s -w"` 可减 ~30% 体积）。

## 分发的两种轨道（distribution 二选一）

| 轨道 | 声明 | 字节来源 |
|---|---|---|
| 直传（推荐） | `distribution.binary_artifacts`（本地 archive 路径） | `anna-app executa upload-binaries` 或 `apps cut` 自动推 |
| 拉取镜像 | `distribution.binary_urls`（公开 GET URL） | 平台在 cut/release 时下载并镜像 |

`binary_urls` 值可为字符串，或 asset dict：`{url(必), sha256(推荐), size, entrypoint, format}`；`format` ∈ tar.gz/tgz/zip/raw（省略按 URL 后缀推断）。
`binary_artifacts` 条目：`{path(必, 相对 executa 项目根, 占位符 {version}/{platform}/{tool_id}), entrypoint(推荐), format}`。裸可执行文件会被拒——必须打包 archive。

## 安装布局（multi-file）

```
~/.anna/executa/
  bin/my-tool                          → 稳定 shim，升级后仍可用
  tools/{tool_id}/
    v1.0.0/  (bin/ lib/ data/ manifest.json INSTALL.json)
    current → v1.0.0                   ← 原子蓝绿升级指针
```

旧版本按 `EXECUTA_KEEP_VERSIONS`（默认 2）GC。

## Archive root `manifest.json`（**强烈建议始终提供**）

三个无 manifest 时的静默损坏类别：bin/{name} 名冲突（URL 派生名如 `my` 会互相撞）、入口选错（只选唯一或第一个可执行文件）、ZIP 无 Unix 权限位（不声明时只 chmod 入口 0o755，辅助脚本保持 0o644 → 运行时 Permission denied）。

```json
{
  "name": "tool-acme-my-tool-abcd1234",
  "version": "1.0.0",
  "runtime": {
    "binary": {
      "entrypoint": {
        "default":         "bin/my-tool",
        "windows-x86_64":  "bin/my-tool.exe",
        "windows-arm64":   "bin/my-tool.exe"
      },
      "lib_dirs":  ["lib"],
      "data_dirs": ["data"],
      "permissions": {
        "bin/my-tool":         "0o755",
        "bin/post-install.sh": "0o755"
      }
    }
  }
}
```

| 字段 | 说明 |
|---|---|
| `name` | 人读标签，惯例用铸造的 `tool_id`。**非身份校验**——Agent 按 server-minted tool_id 关联安装与运行插件，与 describe 返回的 name 不一致也无害。仍是 `bin/{name}` shim 词干（除非给 executable_name） |
| `version` | 可选但推荐；写进 INSTALL.json，缺省时作版本目录名 |
| `runtime.binary.entrypoint` | **multi-file 必需**；字符串或 `{default, darwin-arm64, …}` 平台 map（查找：全 key → OS 前缀 → default） |
| `runtime.binary.lib_dirs` | 仅文档用途（Agent 自动 prepend lib/ 与 lib64/） |
| `runtime.binary.data_dirs` | 仅文档用途（Agent 自动暴露 `EXECUTA_DATA`） |
| `runtime.binary.permissions` | 相对路径 → 八进制模式；入口默认 0o755 |

无 manifest 的回退链（不推荐）：manifest entrypoint → asset dict entrypoint → 标准位置 `bin/{name}` → `bin/{name}.exe` → `{name}` → `{name}.exe` → 唯一可执行文件 → 字母序第一个（WARN）。

## 运行时环境变量（Agent 注入）

| 变量 | 值 |
|---|---|
| `EXECUTA_HOME` | `tools/{tool_id}/current/` 绝对路径 |
| `EXECUTA_DATA` | `${EXECUTA_HOME}/data`（存在时） |
| `LD_LIBRARY_PATH` / `DYLD_LIBRARY_PATH` | prepend `${EXECUTA_HOME}/lib` 与 lib64 |
| `PATH` | prepend `${EXECUTA_HOME}/share/bin`（Windows 另加 lib/） |
| 工作目录 | `EXECUTA_HOME` |

## 其他要点

- Go 交叉编译示例：`GOOS=darwin GOARCH=arm64 go build -ldflags "-s -w" -o dist/my-tool-darwin-arm64 .`（另有 darwin/amd64、linux/amd64|arm64、windows/amd64.exe）。
- 上传是内容寻址（未变则零字节传输），服务端独立复哈希、sha256 不匹配即拒。
- OIDC Trusted Publishing 仅覆盖二进制上传；lifecycle 动词（apps push/cut/release）仍用 PAT。
- 本地迭代可用 `distribution_type: local`（archive 在 Agent 机器路径上），同样安全校验（zip-slip、5GB 解压上限、.. 遍历）；sha256 校验跳过。
- `EXECUTA_INSTALL_V2=0` 回退旧安装布局；tool_id 保持稳定以便 `current` 原子更新。

## 说明

本任务（本地 dev + Go executa）真正用到的是：archive root manifest.json 的字段形状与平台 key 命名；本地 harness 的 executa 是通过 stdio 源码启动（见 09-local-dev），不经过二进制安装管线。
