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
//   - 本地 dev：harness 按根目录 app.json 的 bundled_executas 把
//     manifest 里的 `bundled:<handle>` 替换成 executa.json 的真实
//     tool_id（tool-test-…），tools.list 返回的就是这个可 invoke 的
//     id。写死 bundled: 会因 ExecutaPool 按真实 id 注册而对不上
//     （not registered → tools.invoke is not available）。
//   - 兜底：SDK 没有 list（或调用失败）时退回 bundled: 常量，
//     至少保证老 harness 下 invoke 仍会发出。
const DEV_FALLBACK_TOOL_ID = "bundled:notes-summarizer";

/** tools.list 的条目形状（只声明用到的字段）。 */
interface ToolListEntry {
  tool_id: string;
  status?: string;
}
interface ToolListResult {
  tools: ToolListEntry[];
}

/**
 * 运行时解析 notes-summarizer 的可 invoke tool_id：
 *   a. window.__ANNA_TOOL_IDS__["notes-summarizer"]（发布后 sidecar）；
 *   b. 否则 tools.list()：优先 tool_id 含 "notes-summarizer" 的条目，
 *      其次第一个条目；
 *   c. 都没有（SDK 无 list / list 失败）才回退 DEV_FALLBACK_TOOL_ID。
 */
export async function resolveToolId(anna: AnnaAppRuntime): Promise<string> {
  const g = window as unknown as { __ANNA_TOOL_IDS__?: Record<string, string> };
  const published = g.__ANNA_TOOL_IDS__ && g.__ANNA_TOOL_IDS__["notes-summarizer"];
  if (published) return published;

  try {
    const listed = unwrapRpc<unknown>(await anna.tools.list()) as
      | ToolListResult
      | ToolListEntry[]
      | ToolListEntry
      | null
      | undefined;
    // tools.list 在不同 harness 版本返回过数组 / {tools:[…]} / 单对象，
    // 都归一成条目数组。
    let entries: ToolListEntry[] = [];
    if (Array.isArray(listed)) {
      entries = listed as ToolListEntry[];
    } else if (listed && Array.isArray((listed as ToolListResult).tools)) {
      entries = (listed as ToolListResult).tools;
    } else if (listed) {
      entries = [listed as ToolListEntry];
    }
    const hit =
      entries.find((t) => t && typeof t.tool_id === "string" && t.tool_id.includes("notes-summarizer")) ??
      entries.find((t) => t && typeof t.tool_id === "string");
    if (hit) return hit.tool_id;
  } catch (err) {
    console.warn("[mini-notes] tools.list 不可用，回退 bundled tool_id:", err);
  }
  return DEV_FALLBACK_TOOL_ID;
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
      tool_id: await resolveToolId(anna),
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
