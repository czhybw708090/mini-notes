// 共享领域类型：UI 层与 anna 层都依赖这里，避免循环依赖。

export interface Note {
  id: string;
  content: string;
  /** ISO 8601 */
  createdAt: string;
  /** 与数组下标一致（数组顺序即显示顺序，见 anna/storage.ts） */
  order: number;
}

export interface SummaryResult {
  summary: string;
  /** 客户端收到结果的时间（ISO 8601） */
  generatedAt: string;
}
