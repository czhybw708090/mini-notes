#!/usr/bin/env python3
"""Minimal host simulator for the notes-summarizer executa.

Drives the real binary over stdio pipes and emulates the Anna Agent:
  1. initialize (v2) -> expect negotiated 2.0 + sampling capability
  2. describe -> expect bare manifest
  3. invoke summarize -> tool must emit sampling/createMessage on stdout;
     host answers with a fake LLM result; tool must return the summary
  4. invoke again, host answers sampling with error -32008 -> invoke must
     fail with success=false (and the process must survive)
  5. health still answers (main loop not crashed)
  6. invoke with empty notes -> success=false without any sampling request
  7. stdin EOF -> process exits 0

Usage: python3 e2e_mock_host.py
"""
import json
import os
import select
import subprocess
import sys

BIN = os.path.join(os.path.dirname(os.path.abspath(__file__)), "bin", "notes-summarizer")
READ_TIMEOUT = 15  # seconds per expected frame

failures = []


def check(cond, label, detail=None):
    if cond:
        print(f"  PASS  {label}")
    else:
        print(f"  FAIL  {label}" + (f"  << {detail}" if detail is not None else ""))
        failures.append(label)


def read_line(proc, timeout=READ_TIMEOUT):
    """Read one JSON line from the tool's stdout, with a watchdog."""
    r, _, _ = select.select([proc.stdout], [], [], timeout)
    if not r:
        raise RuntimeError("timeout waiting for tool output")
    line = proc.stdout.readline()
    if not line:
        raise RuntimeError("tool exited unexpectedly (stdout closed)")
    return json.loads(line)


def read_until_id(proc, expect_id, timeout=READ_TIMEOUT):
    """Read frames until the one with the expected id arrives (handles
    out-of-order goroutine responses)."""
    while True:
        msg = read_line(proc, timeout)
        if msg.get("id") == expect_id:
            return msg
        print(f"  [host] skipped frame id={msg.get('id')} method={msg.get('method')}")


def read_sampling_request(proc, timeout=READ_TIMEOUT):
    """Read frames until a sampling/createMessage request appears."""
    while True:
        msg = read_line(proc, timeout)
        if msg.get("method") == "sampling/createMessage":
            return msg
        raise AssertionError(f"expected sampling request, got: {json.dumps(msg)}")


def send(proc, msg):
    proc.stdin.write(json.dumps(msg, ensure_ascii=False) + "\n")
    proc.stdin.flush()


def main():
    proc = subprocess.Popen(
        [BIN],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.DEVNULL,
        text=True,
        bufsize=1,
    )

    print("== 1. initialize (v2) ==")
    send(proc, {"jsonrpc": "2.0", "method": "initialize", "id": 0,
                "params": {"protocolVersion": "2.0"}})
    r = read_until_id(proc, 0)
    check(r["result"]["protocolVersion"] == "2.0", "negotiated 2.0", r)
    check("sampling" in r["result"]["client_capabilities"], "sampling capability advertised", r)

    print("== 2. describe ==")
    send(proc, {"jsonrpc": "2.0", "method": "describe", "id": 1})
    r = read_until_id(proc, 1)
    check(r["result"]["name"] == "notes-summarizer", "bare manifest (no wrapper)", r)
    check(r["result"]["host_capabilities"] == ["llm.sample"], "llm.sample declared", r)

    print("== 3. invoke summarize (happy path) ==")
    send(proc, {"jsonrpc": "2.0", "method": "invoke", "id": 2,
                "params": {"tool": "summarize",
                           "arguments": {"notes": ["今天修了一个登录 bug", "明天要写发布文档"]},
                           "context": {"invoke_id": "inv-abc-123"}}})
    sampling_req = read_sampling_request(proc)
    print("=== SAMPLING REQUEST (actual wire JSON) ===")
    print(json.dumps(sampling_req, ensure_ascii=False, indent=2))
    md = sampling_req["params"]["metadata"]
    check(md.get("invoke_id") == "inv-abc-123", "metadata echoes invoke_id", md)
    check(md.get("tool") == "summarize", "metadata carries tool", md)
    check(sampling_req["params"]["maxTokens"] == 512, "maxTokens 512", sampling_req)
    check(sampling_req["params"]["messages"][0]["content"]["type"] == "text", "text message shape")
    check("请总结以下笔记" in sampling_req["params"]["messages"][0]["content"]["text"], "prompt contains instructions")

    fake_summary = "模拟总结：已修复登录 bug，明天完成发布文档。"
    send(proc, {"jsonrpc": "2.0", "id": sampling_req["id"],
                "result": {"role": "assistant",
                           "content": {"type": "text", "text": fake_summary},
                           "model": "mock-model", "stopReason": "endTurn",
                           "usage": {"inputTokens": 42, "outputTokens": 12, "totalTokens": 54}}})
    r = read_until_id(proc, 2)
    print("=== INVOKE RESPONSE (actual wire JSON) ===")
    print(json.dumps(r, ensure_ascii=False, indent=2))
    check(r["result"]["success"] is True, "invoke success explicit true", r)
    check(r["result"]["data"]["summary"] == fake_summary, "summary carried back", r)

    print("== 4. invoke with sampling error -32008 (failure path) ==")
    send(proc, {"jsonrpc": "2.0", "method": "invoke", "id": 3,
                "params": {"tool": "summarize",
                           "arguments": {"notes": ["另一条笔记"]},
                           "context": {"invoke_id": "inv-fail-1"}}})
    sampling_req = read_sampling_request(proc)
    send(proc, {"jsonrpc": "2.0", "id": sampling_req["id"],
                "error": {"code": -32008, "message": "SAMPLING_NOT_NEGOTIATED"}})
    r = read_until_id(proc, 3)
    print("=== FAIL-PATH INVOKE RESPONSE (actual wire JSON) ===")
    print(json.dumps(r, ensure_ascii=False, indent=2))
    check(r["result"]["success"] is False, "invoke success false on sampling error", r)
    check("-32008" in r["result"]["error"], "sampling error code surfaced", r)

    print("== 5. main loop survives failure ==")
    send(proc, {"jsonrpc": "2.0", "method": "health", "id": 4})
    r = read_until_id(proc, 4)
    check(r["result"]["status"] == "healthy", "health after failure", r)

    print("== 6. empty notes (no sampling request) ==")
    send(proc, {"jsonrpc": "2.0", "method": "invoke", "id": 5,
                "params": {"tool": "summarize", "arguments": {"notes": []}}})
    r = read_until_id(proc, 5)
    check(r["result"]["success"] is False, "empty notes rejected", r)
    check("为空" in r["result"]["error"], "human-readable error", r)

    print("== 7. shutdown then EOF ==")
    send(proc, {"jsonrpc": "2.0", "method": "shutdown", "id": 6})
    r = read_until_id(proc, 6)
    check(r["result"] == {"ok": True}, "shutdown ack", r)
    proc.stdin.close()
    code = proc.wait(timeout=5)
    check(code == 0, f"exit 0 on stdin EOF (got {code})", code)

    if failures:
        print(f"\n{failures.__len__()} CHECK(S) FAILED")
        sys.exit(1)
    print("\nALL E2E CHECKS PASSED")


if __name__ == "__main__":
    main()
