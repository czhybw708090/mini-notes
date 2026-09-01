// DOM 渲染层。只操作 DOM，不 import 任何 anna.* 模块 ——
// 宿主交互以回调注入，渲染与数据层解耦，方便单独测试。

import type { Note } from "./types";

function $<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少元素 #${id}`);
  return el as T;
}

export interface NoteHandlers {
  onAdd(content: string): void;
  onDelete(id: string): void;
  onSummarize(): void;
}

/** 重绘笔记列表；按数组顺序（即添加顺序）渲染。 */
export function renderNotes(notes: Note[], onDelete: (id: string) => void): void {
  const list = $<HTMLUListElement>("note-list");
  list.textContent = "";
  if (notes.length === 0) {
    const li = document.createElement("li");
    li.className = "empty";
    li.textContent = "还没有笔记，先写一条吧。";
    list.appendChild(li);
    return;
  }
  for (const note of notes) {
    const li = document.createElement("li");
    const text = document.createElement("span");
    text.textContent = note.content; // textContent：笔记内容不当作 HTML
    const del = document.createElement("button");
    del.type = "button";
    del.textContent = "删除";
    del.addEventListener("click", () => onDelete(note.id));
    li.append(text, del);
    list.appendChild(li);
  }
}

export function showSummary(text: string): void {
  $("summary-box").hidden = false;
  $("summary-text").textContent = text;
}

export function setStatus(text: string, kind: "info" | "error" = "info"): void {
  const el = $("status");
  el.textContent = text;
  el.className = kind;
}

/** 连接成功前保持禁用；降级模式（独立打开）一直禁用。 */
export function setControlsEnabled(enabled: boolean): void {
  $<HTMLButtonElement>("summarize").disabled = !enabled;
  $<HTMLButtonElement>("add-note").disabled = !enabled;
  $<HTMLInputElement>("note-input").disabled = !enabled;
}

/** 总结进行中禁用 Summarize 按钮防止重复触发；输入框保持可用。 */
export function setBusy(busy: boolean): void {
  $<HTMLButtonElement>("summarize").disabled = busy;
}

export function showBanner(text: string): void {
  const el = $("banner");
  el.textContent = text;
  el.hidden = false;
}

/** 绑定表单与按钮事件（幂等，只调用一次）。 */
export function bindHandlers(handlers: NoteHandlers): void {
  const form = $<HTMLFormElement>("note-form");
  const input = $<HTMLInputElement>("note-input");
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const content = input.value.trim();
    if (!content) {
      // 前端拦截空输入：不触发保存，给出提示。
      setStatus("笔记内容不能为空", "error");
      return;
    }
    input.value = "";
    handlers.onAdd(content);
  });
  $("summarize").addEventListener("click", () => handlers.onSummarize());
}
