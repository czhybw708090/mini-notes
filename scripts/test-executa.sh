#!/bin/bash
#
# Manual stdio test for the notes-summarizer Executa tool.
# Drives the binary directly over two named pipes, without the Anna
# harness: sends JSON-RPC lines on stdin, parses each stdout line,
# and acts as a mock host by answering sampling/createMessage with a
# canned LLM result, proving the full round-trip.
#
# Exit code: 0 = all checks passed, 1 = at least one check failed.
#
# One-line smoke check (describe only), useful for CI:
#   echo '{"jsonrpc":"2.0","id":1,"method":"describe"}' | ./bin/notes-summarizer

set -u

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TOOL_DIR="$ROOT/executas/notes-summarizer"
BIN="$TOOL_DIR/bin/notes-summarizer"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/test-executa.XXXXXX")"
ERR_LOG="$WORK/stderr.log"

PASS=0
FAIL=0

pass() {
  PASS=$((PASS + 1))
  printf 'PASS: %s\n' "$1"
}

fail() {
  FAIL=$((FAIL + 1))
  printf 'FAIL: %s\n' "$1"
  if [ -n "${2:-}" ]; then
    printf '      %s\n' "$2"
  fi
}

# assert_py <label> <json-text> <python-expr-over-variable-d>
assert_py() {
  if python3 -c 'import json, sys; d = json.loads(sys.argv[1]); sys.exit(0 if ('"$3"') else 1)' "$2" 2>/dev/null; then
    pass "$1"
  else
    fail "$1" "$2"
  fi
}

cleanup() {
  if [ -n "${TOOL_PID:-}" ]; then
    kill "$TOOL_PID" 2>/dev/null
  fi
  exec 3>&- 2>/dev/null
  exec 4<&- 2>/dev/null
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "== build =="
if ! (cd "$TOOL_DIR" && go build -o bin/notes-summarizer .); then
  fail "go build"
  exit 1
fi
pass "go build executas/notes-summarizer"

echo "== pipes =="
mkfifo "$WORK/in" "$WORK/out" || { fail "mkfifo"; exit 1; }
"$BIN" <"$WORK/in" >"$WORK/out" 2>"$ERR_LOG" &
TOOL_PID=$!
# Keep fd 3 open as the writer so the tool does not see EOF until the
# very end; fd 4 is the reader.
exec 3>"$WORK/in"
exec 4<"$WORK/out"

send() {
  printf '%s\n' "$1" >&3
}

# Read one JSON-RPC line from the tool, with a 15s watchdog.
recv() {
  local line
  if ! IFS= read -r -t 15 line <&4; then
    fail "no output from tool (timeout or EOF)"
    return 1
  fi
  printf '%s' "$line"
}

echo "== 1. initialize (v2) =="
send '{"jsonrpc":"2.0","method":"initialize","id":0,"params":{"protocolVersion":"2.0"}}'
INIT_RESP="$(recv)" || exit 1
assert_py "echoes protocolVersion 2.0" "$INIT_RESP" "d['result']['protocolVersion']=='2.0'"
assert_py "advertises client_capabilities.sampling" "$INIT_RESP" "'sampling' in d['result']['client_capabilities']"

echo "== 2. describe =="
send '{"jsonrpc":"2.0","method":"describe","id":1}'
DESC_RESP="$(recv)" || exit 1
assert_py "bare manifest, no wrapper" "$DESC_RESP" "d['result'].get('name')=='notes-summarizer' and 'manifest' not in d['result']"
assert_py "display_name present" "$DESC_RESP" "d['result'].get('display_name')=='Notes Summarizer'"
assert_py "version present" "$DESC_RESP" "d['result'].get('version')=='0.1.0'"
assert_py "host_capabilities is [llm.sample]" "$DESC_RESP" "d['result'].get('host_capabilities')==['llm.sample']"
assert_py "tools[0].name is summarize" "$DESC_RESP" "d['result']['tools'][0]['name']=='summarize'"
assert_py "tools[0].parameters declares notes array of strings" "$DESC_RESP" "d['result']['tools'][0]['parameters'][0]['name']=='notes' and d['result']['tools'][0]['parameters'][0]['type']=='array' and d['result']['tools'][0]['parameters'][0]['items']['type']=='string'"

echo "== 3. invoke summarize (sampling round-trip) =="
send '{"jsonrpc":"2.0","method":"invoke","id":2,"params":{"tool":"summarize","arguments":{"notes":["a","b","c"]},"context":{"invoke_id":"inv-manual-1"}}}'
SAMPLING_REQ=""
i=0
while [ "$i" -lt 5 ]; do
  i=$((i + 1))
  line="$(recv)" || exit 1
  if python3 -c 'import json, sys; d = json.loads(sys.argv[1]); sys.exit(0 if d.get("method") == "sampling/createMessage" else 1)' "$line" 2>/dev/null; then
    SAMPLING_REQ="$line"
    break
  fi
done
if [ -z "$SAMPLING_REQ" ]; then
  fail "tool did not emit sampling/createMessage"
  exit 1
fi
pass "tool emitted sampling/createMessage (evidence below)"
printf '%s\n' "$SAMPLING_REQ"
assert_py "sampling echoes invoke_id in metadata" "$SAMPLING_REQ" "d['params']['metadata'].get('invoke_id')=='inv-manual-1'"
assert_py "sampling carries tool tag in metadata" "$SAMPLING_REQ" "d['params']['metadata'].get('tool')=='summarize'"
assert_py "sampling prompt contains the notes" "$SAMPLING_REQ" "'请总结以下笔记' in d['params']['messages'][0]['content']['text'] and 'a' in d['params']['messages'][0]['content']['text'] and 'c' in d['params']['messages'][0]['content']['text']"
assert_py "sampling maxTokens is 512" "$SAMPLING_REQ" "d['params'].get('maxTokens')==512"

MOCK_SUMMARY="模拟总结：笔记 a、b、c 的要点。"
MOCK_REPLY="$(python3 -c '
import json, sys
req = json.loads(sys.argv[1])
rid = req["id"]
reply = {"jsonrpc": "2.0", "id": rid, "result": {
    "role": "assistant",
    "content": {"type": "text", "text": sys.argv[2]},
    "model": "mock-model",
    "stopReason": "endTurn",
}}
print(json.dumps(reply, ensure_ascii=False))
' "$SAMPLING_REQ" "$MOCK_SUMMARY")"
send "$MOCK_REPLY"
INVOKE_RESP="$(recv)" || exit 1
assert_py "invoke returns success=true" "$INVOKE_RESP" "d['result']['success'] is True"
assert_py "invoke returns the mock summary" "$INVOKE_RESP" "d['result']['data']['summary']=='$MOCK_SUMMARY'"

echo "== 4. health =="
send '{"jsonrpc":"2.0","method":"health","id":3}'
HEALTH_RESP="$(recv)" || exit 1
assert_py "health reports healthy" "$HEALTH_RESP" "d['result']['status']=='healthy'"

echo "== 5. shutdown =="
send '{"jsonrpc":"2.0","method":"shutdown","id":4}'
SHUTDOWN_RESP="$(recv)" || exit 1
assert_py "shutdown ack ok:true" "$SHUTDOWN_RESP" "d['result']['ok'] is True"

echo "== 6. stdin EOF =="
exec 3>&-
wait "$TOOL_PID"
TOOL_RC=$?
if [ "$TOOL_RC" -eq 0 ]; then
  pass "tool exits 0 on stdin EOF"
else
  fail "tool exit code on EOF (expected 0)" "$TOOL_RC"
fi

echo
echo "Result: $PASS passed, $FAIL failed"
if [ "$FAIL" -gt 0 ]; then
  echo "--- tool stderr log ---"
  cat "$ERR_LOG"
  exit 1
fi
exit 0
