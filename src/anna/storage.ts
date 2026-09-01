// 笔记持久化：全部走 anna.storage.*（notes/06）。
//
// 设计：所有笔记存在单一 key "notes" 下，value 是一个数组。
// 为什么单 key 数组而不是每条笔记一个 key（notes/<id>）：
//   - 显示顺序就是数组顺序（即添加顺序），无需额外的索引 key。
//     storage.list 只返回元数据不含 value（notes/06），每条一 key
//     就必须再维护一个顺序 key，或者放弃稳定排序。
//   - 笔记量小、整读整写：一次 get 拿全部、一次 set 写全部，
//     没有 N 次往返，也没有读-改-写并发窗口的复杂合并。
//   - 增删都是 load → modify → save 三步，逻辑单一。
//
// 缺失判断必须用 exists 而不是 value == null（null 是合法值，notes/06）。

import type { AnnaAppRuntime } from "./runtime";
import { unwrapRpc } from "./runtime";
import type { Note } from "../types";

export const NOTES_KEY = "notes";

interface StorageValue {
  value: unknown;
  /** APS 后端必有（false = 明确缺失）；legacy 后端没有该字段（dev harness 实测），
   * 缺失表现为 {value:null}。两种后端统一降级到 value 判断。 */
  exists?: boolean;
}

/** 读取全部笔记；key 不存在或 value 不是数组时返回空列表。 */
export async function loadNotes(anna: AnnaAppRuntime): Promise<Note[]> {
  const data = unwrapRpc<StorageValue>(await anna.storage.get({ key: NOTES_KEY }));
  if (!data) return [];
  if (data.exists === false) return []; // APS：明确缺失
  if (!Array.isArray(data.value)) return []; // legacy 缺失为 value:null，同样落到这里
  return data.value.filter(isNote);
}

/** 整数组重写持久化；order 归一为数组下标。 */
export async function saveNotes(anna: AnnaAppRuntime, notes: Note[]): Promise<void> {
  const normalized = notes.map((n, i) => ({ ...n, order: i }));
  await anna.storage.set({ key: NOTES_KEY, value: normalized });
}

export async function addNote(anna: AnnaAppRuntime, content: string): Promise<Note[]> {
  const notes = await loadNotes(anna);
  notes.push({
    id: genId(),
    content,
    createdAt: new Date().toISOString(),
    order: notes.length, // saveNotes 会再次归一，这里只是初值
  });
  await saveNotes(anna, notes);
  return notes;
}

export async function deleteNote(anna: AnnaAppRuntime, id: string): Promise<Note[]> {
  const notes = await loadNotes(anna);
  const next = notes.filter((n) => n.id !== id);
  await saveNotes(anna, next);
  return next;
}

// ---- 内部工具 ----

function isNote(v: unknown): v is Note {
  return (
    typeof v === "object" &&
    v !== null &&
    typeof (v as Note).id === "string" &&
    typeof (v as Note).content === "string"
  );
}

function genId(): string {
  // crypto.randomUUID 在现代浏览器和 dev harness iframe 中都可用；
  // 兜底覆盖非常老的 webview。
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `n-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}
