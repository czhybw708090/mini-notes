#!/bin/bash
#
# 构建 notes-summarizer 的二进制发布产物（Anna executa binary distribution）。
# Go 交叉编译三平台 + 按平台归档到 dist/：
#   darwin/arm64  -> darwin-arm64   .tar.gz（内含 bin/notes-summarizer）
#   darwin/amd64  -> darwin-x86_64  .tar.gz（GOARCH=amd64 对应平台 key x86_64）
#   windows/amd64 -> windows-x86_64 .zip   （产物带 .exe）
#
# 归档根目录带 manifest.json（entrypoint + permissions，规范要求裸可执行
# 文件会被拒）；tar 保留二进制可执行位。每个归档完成后做 describe smoke
# test（initialize 协商 v2 → describe，断言 name/host_capabilities/tools）。
#
# 用法：
#   ./scripts/build-binary.sh        # 只构建「当前机器可运行」的平台
#   ./scripts/build-binary.sh all    # 三平台全量（CI 用）
#   VERSION=0.2.0 ./scripts/build-binary.sh   # 覆盖版本（默认 0.1.0，与
#                                             # executa describe 的 version 一致）

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOL_DIR="$ROOT/executas/notes-summarizer"
DIST="$ROOT/dist"
NAME="notes-summarizer"
VERSION="${VERSION:-0.1.0}"

usage() {
  sed -n '2,16p' "$0" | sed 's/^# \{0,1\}//'
  exit 1
}

# 三平台编译/归档参数表：GOOS GOARCH 平台key 归档扩展 二进制名
# （binary 名统一 notes-summarizer[.exe]，manifest 的 entrypoint 只按平台
#   区分 .exe 后缀。）
platform_row() {
  case "$1" in
    darwin-arm64)   echo "darwin arm64 darwin-arm64   tar.gz notes-summarizer";;
    darwin-x86_64)  echo "darwin amd64 darwin-x86_64  tar.gz notes-summarizer";;
    windows-x86_64) echo "windows amd64 windows-x86_64 zip    notes-summarizer.exe";;
    *) return 1;;
  esac
}

# 本机平台检测：uname 归一到三平台 key；不支持则报错。
host_platform() {
  local os arch
  case "$(uname -s)" in
    Darwin)  os=darwin;;
    Linux)   os=linux;;
    MINGW*|MSYS*|CYGWIN*) os=windows;;
    *) echo "unsupported host os: $(uname -s)" >&2; return 1;;
  esac
  case "$(uname -m)" in
    arm64|aarch64) arch=arm64;;
    x86_64|amd64)  arch=amd64;;
    *) echo "unsupported host arch: $(uname -m)" >&2; return 1;;
  esac
  case "$os/$arch" in
    darwin/arm64)   echo "darwin-arm64";;
    darwin/amd64)   echo "darwin-x86_64";;
    windows/amd64)  echo "windows-x86_64";;
    *) echo "host $os/$arch is not one of the three buildable platforms" >&2; return 1;;
  esac
}

# describe smoke test：直接以 stdin 驱动归档内二进制（与 harness 同协议），
# 断言 describe 返回含 name / host_capabilities / tools。
smoke_test() {
  local bin="$1" out
  out="$(
    printf '%s\n%s\n' \
      '{"jsonrpc":"2.0","method":"initialize","id":0,"params":{"protocolVersion":"2.0"}}' \
      '{"jsonrpc":"2.0","method":"describe","id":1}' |
      "$bin" 2>/dev/null
  )" || { echo "FAIL: smoke test could not run $bin" >&2; return 1; }
  python3 - "$out" "$bin" <<'PY'
import json, sys
# 工具对每个请求起独立 goroutine 处理，响应可能乱序（JSON-RPC 2.0
# 允许；harness 也按 id 匹配），故按 id 找 describe 响应而非按行序。
lines = [l for l in sys.argv[1].splitlines() if l.strip()]
desc = None
for l in lines:
    try:
        m = json.loads(l)
    except ValueError:
        continue
    if isinstance(m, dict) and m.get("id") == 1 and "result" in m:
        desc = m
assert desc is not None, f"no describe response in {lines}"
r = desc["result"]
assert r.get("name") == "notes-summarizer", r
assert "host_capabilities" in r, r
assert isinstance(r.get("tools"), list) and r["tools"], r
print(f"  smoke OK: name={r['name']} host_capabilities={r['host_capabilities']} tools={[t['name'] for t in r['tools']]}")
PY
}

# 跨平台产物（如 macOS 上的 windows .exe）物理上无法执行：降级为
# 二进制格式静态检查（Mach-O / PE / ELF），仍保证「非文本、可执行格式」。
static_check() {
  local bin="$1" kind
  kind="$(file -b "$bin")"
  case "$kind" in
    *"Mach-O"*|*"PE32"*|*"ELF"*)
      echo "  static OK (not runnable on this host): $kind";;
    *)
      echo "FAIL: unexpected binary format: $kind" >&2; return 1;;
  esac
}

# 验收检查：host 能加载该二进制（空 stdin 跑一遍正常退出）就跑 describe
# smoke test；否则降级 static_check。
check_artifact() {
  local bin="$1"
  if "$bin" </dev/null >/dev/null 2>&1; then
    smoke_test "$bin"
  else
    static_check "$bin"
  fi
}

build_one() {
  local pkey="$1"
  local goos goarch ext bin
  read -r goos goarch _ ext bin <<<"$(platform_row "$pkey")"

  local stage
  stage="$(mktemp -d "${TMPDIR:-/tmp}/anna-bin.XXXXXX")"
  # RETURN trap 会在外层函数返回时再次触发，届时 stage 已销毁，
  # 故加存在性守卫（set -u 下直接展开会报 unbound）。
  trap '[ -n "${stage:-}" ] && rm -rf "$stage"' RETURN

  # 1. 交叉编译（纯 Go 无 cgo；产物自带 0755，tar 会保留）。
  echo "== build $pkey =="
  mkdir -p "$stage/bin"
  (
    cd "$TOOL_DIR"
    CGO_ENABLED=0 GOOS="$goos" GOARCH="$goarch" \
      go build -trimpath -ldflags "-s -w" -o "$stage/bin/$bin" .
  )

  # 2. 归档根 manifest.json（entrypoint 按平台区分 .exe；permissions
  #    声明 0o755 —— zip 不携带 Unix 权限位，安装端靠它恢复）。
  cat >"$stage/manifest.json" <<JSON
{
  "name": "$NAME",
  "version": "$VERSION",
  "runtime": {
    "binary": {
      "entrypoint": {
        "default": "bin/notes-summarizer",
        "windows-x86_64": "bin/notes-summarizer.exe"
      },
      "permissions": {
        "bin/notes-summarizer": "0o755",
        "bin/notes-summarizer.exe": "0o755"
      }
    }
  }
}
JSON

  # 3. 归档：macOS tar.gz（保留可执行位），Windows zip。
  mkdir -p "$DIST"
  local out="$DIST/$NAME-$VERSION-$pkey.$ext"
  rm -f "$out"
  if [ "$ext" = "tar.gz" ]; then
    tar -czf "$out" -C "$stage" bin manifest.json
  else
    if command -v zip >/dev/null 2>&1; then
      (cd "$stage" && zip -qr "$out" bin manifest.json)
    elif command -v powershell.exe >/dev/null 2>&1; then
      stage_win="$(cygpath -w "$stage")"
      out_win="$(cygpath -w "$out")"
      ANNA_STAGE_WIN="$stage_win" ANNA_OUT_WIN="$out_win" \
        powershell.exe -NoProfile -NonInteractive -Command '
          $stage = $env:ANNA_STAGE_WIN
          $out = $env:ANNA_OUT_WIN
          Push-Location $stage
          try { Compress-Archive -Path bin, manifest.json -DestinationPath $out -Force }
          finally { Pop-Location }
        '
    else
      echo "FAIL: zip or powershell.exe is required to create $out" >&2
      return 1
    fi
  fi
  [ -f "$out" ] || { echo "FAIL: archive was not created: $out" >&2; return 1; }

  # 4. 验收检查（smoke test / 跨平台静态检查）。
  check_artifact "$stage/bin/$bin" || return 1
  echo "  archive: $out"
}

main() {
  local targets=()
  case "${1:-}" in
    "")        targets=("$(host_platform)") || usage;;
    all)       targets=(darwin-arm64 darwin-x86_64 windows-x86_64);;
    -h|--help|*) usage;;
  esac
  local n=0
  for p in "${targets[@]}"; do
    build_one "$p" && n=$((n + 1))
  done
  echo "done: $n archive(s) built in dist/"
}

main "$@"
