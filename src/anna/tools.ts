// Executa 工具调用：总结一律通过 anna.tools.invoke 走本地
// notes-summarizer 插件（插件内反向 sampling 借 host LLM）。
// 前端绝不直接调 anna.llm.complete，也绝不本地拼总结。

import type { AnnaAppRuntime } from "./runtime";
import { unwrapRpc } from "./runtime";
import type { SummaryResult } from "../types";

// ---- tool_id 解析（四处身份见 README；dev 行为以本地 harness 实测为准）----
//
//   - 发布后：`anna-app apps publish` 铸造真实 id 并写
//     bundle/anna-tool-ids.js 注入 window.__ANNA_TOOL_IDS__ =
//     { "notes-summarizer": "<铸造 id>" }，运行时从那里取。
//   - 本地 dev（实测 anna-app dev）：没有 sidecar；harness 把
//     required_executas 的 `bundled:<handle>` 原样投影给 iframe ——
//     tools.list 返回 {"tool_id":"bundled:notes-summarizer"}，
//     invoke 传 executa.json 的占位 id 会 permission_denied。
//     所以 dev 回退用 `bundled:<handle>`。executa.json 里的 tool_id
//     只是 stdio 子进程在 harness 内部的注册键，iframe 层不用它。
const DEV_FALLBACK_TOOL_ID = "bundled:notes-summarizer";

export function resolveToolId(): string {
  const g = window as unknown as { __ANNA_TOOL_IDS__?: Record<string, string> };
  return (g.__ANNA_TOOL_IDS__ && g.__ANNA_TOOL_IDS__["notes-summarizer"]) || DEV_FALLBACK_TOOL_ID;
}

// 插件侧 sampling 等待上限 60s（executas/notes-summarizer/main.go），
// host 会把 timeoutMs clamp 到 [1000, 90000]（notes/07）。比插件内部
// 超时略宽，避免工具还没返回 host 先掐断。
const INVOKE_TIMEOUT_MS = 65000;

/**
 * 调用 summarize 工具，返回总结文本。
 * 失败（tool_failed / executa_unavailable / agent_unavailable …）
 * 抛 Error，由 UI 层展示。
 */
export async function summarizeNotes(
  anna: AnnaAppRuntime,
  contents: string[],
): Promise<SummaryResult> {
  const resp = unwrapRpc<unknown>(
    await anna.tools.invoke({
      tool_id: resolveToolId(),
      method: "summarize",
      args: { notes: contents },
      timeoutMs: INVOKE_TIMEOUT_MS,
    }),
  );

  // host 会剥两层 envelope：插件 {success:true, data:{summary}} 落到
  // iframe 的应是 data 内容即 {summary}（notes/07）。为稳妥兼容三种
  // 形状：{summary}、{success, data}、{success:false, error}。
  const payload = resp as Record<string, unknown> | null;
  if (payload !== null && typeof payload === "object") {
    if (payload.success === false) {
      throw new Error(typeof payload.error === "string" ? payload.error : "总结失败");
    }
    if (typeof payload.summary === "string" && payload.summary.length > 0) {
      return { summary: payload.summary, generatedAt: new Date().toISOString() };
    }
    const data = payload.data as Record<string, unknown> | undefined;
    if (data && typeof data.summary === "string" && data.summary.length > 0) {
      return { summary: data.summary, generatedAt: new Date().toISOString() };
    }
  }
  throw new Error("总结工具返回了无法识别的结果");
}
