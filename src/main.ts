// 应用入口：连接 Anna host → 加载笔记 → 绑定 UI。
// 所有失败路径都被 catch；独立打开 bundle 时优雅降级为提示条，
// 绝不产生未捕获异常。
//
// 数据契约（贯穿本文件，storage 是唯一事实来源）：
//   - 读笔记 → anna.storage.get（禁止内存 state / localStorage 当事实来源）
//   - 写笔记 → anna.storage.set（增删都是 get → 改 → set）
//   - 总结   → anna.tools.invoke（本地 executa 反向 sampling 借 host LLM）

import "./style.css";

import { connectAnna } from "./anna/runtime";
import type { AnnaAppRuntime } from "./anna/runtime";
import { addNote, deleteNote, loadNotes } from "./anna/storage";
import { summarizeNotes } from "./anna/tools";
import { bindHandlers, renderNotes, setBusy, setControlsEnabled, setStatus, showBanner, showSummary } from "./ui";
import type { Note } from "./types";

// 兜底：即使某条异步链路漏了 try/catch，也只打日志，不让
// unhandledrejection 冒出去（独立打开时 SDK 404 是最常见场景）。
window.addEventListener("unhandledrejection", (e) => {
  console.error("[mini-notes] unhandled rejection:", e.reason);
  e.preventDefault();
});

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function main(): Promise<void> {
  const anna = await connectAnna();
  if (!anna) {
    // 没有 host 运行时（直接打开 bundle/index.html，无 wid/t）。
    showBanner("请在 Anna 中运行此应用：当前环境缺少宿主运行时，笔记功能不可用。");
    setStatus("未连接 Anna 运行时", "error");
    return;
  }

  setControlsEnabled(true);

  // 已判非 null；别名让回调闭包里持有收窄后的类型。
  const runtime: AnnaAppRuntime = anna;
  let notes: Note[] = []; // storage 的同步镜像，仅用于渲染

  function render(): void {
    renderNotes(notes, removeNote);
  }

  // 契约「读走 storage」：启动即加载全部笔记（按数组顺序 = order 升序）；
  // 失败显示错误状态，不白屏。
  setStatus("正在加载笔记…");
  try {
    notes = await loadNotes(runtime);
    setStatus(`已加载 ${notes.length} 条笔记`);
  } catch (err) {
    setStatus(`加载笔记失败：${msg(err)}`, "error");
  }

  function removeNote(id: string): void {
    // 契约「写走 storage」：删除 = storage.get → 过滤 → storage.set；
    // UI 用返回结果立即重绘。
    deleteNote(runtime, id)
      .then((next) => {
        notes = next;
        render();
        setStatus("已删除");
      })
      .catch((err) => setStatus(`删除失败：${msg(err)}`, "error"));
  }

  render();

  bindHandlers({
    onAdd(content) {
      // 契约「写走 storage」：创建 = storage.get → 追加
      // （id/createdAt/order 在 anna/storage.ts 生成）→ storage.set。
      addNote(runtime, content)
        .then((next) => {
          notes = next;
          render();
          setStatus("已保存");
        })
        .catch((err) => setStatus(`保存失败：${msg(err)}`, "error"));
    },
    onDelete: removeNote,
    // 契约「总结走 tools.invoke」：禁止本地拼 summary、禁止直调
    // anna.llm.complete。先 storage.get 重读（保证总结的是持久化后
    // 的最新笔记），再 tools.invoke。
    onSummarize: async () => {
      if (notes.length === 0) {
        setStatus("没有笔记可总结");
        return;
      }
      setBusy(true);
      setStatus("正在生成总结…");
      try {
        const fresh = await loadNotes(runtime); // 读走 storage
        notes = fresh;
        render();
        if (fresh.length === 0) {
          setStatus("没有笔记可总结");
          return;
        }
        const res = await summarizeNotes(runtime, fresh.map((n) => n.content));
        showSummary(res.summary);
        setStatus("总结完成");
      } catch (err) {
        // 包括预期中的失败（harness --no-llm、sampling 未授权、
        // agent 不在线…）：展示给用户，不崩溃、不静默。
        setStatus(`总结失败：${msg(err)}`, "error");
      } finally {
        setBusy(false);
      }
    },
  });
}

main();
