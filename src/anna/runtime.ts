// Anna App UI SDK 桥接层。
//
// SDK 由 host 提供，是单文件 ESM，位于绝对路径
// /static/anna-apps/_sdk/latest/index.js（notes/05）。它不在我们的
// bundle 里，构建期也不该被解析：把 URL 放进变量 + @vite-ignore，
// Vite 会把运行时 import 原样保留，而不是在打包期解析绝对路径。
//
// 独立打开 bundle（无 wid/t，也没有 host 服务）时 SDK 加载或
// connect 会失败 —— connectAnna 返回 null 交给 UI 降级，绝不向上抛。

export const ANNA_SDK_URL = "/static/anna-apps/_sdk/latest/index.js";

export interface RpcOk<T> {
  ok: true;
  result: T;
}

export interface RpcErr {
  ok: false;
  error: { code: string; message: string; details?: unknown };
}

/** notes/05：SDK 返回的运行时对象形状（只声明本项目用到的部分）。 */
export interface AnnaAppRuntime {
  windowUuid: string;
  appId: string;
  viewMeta: { name: string; title: string };
  capabilities: { tools: string[]; chat: string[]; storage: string[] };
  entryPayload: unknown;
  runtimeState: Record<string, unknown>;
  storage: {
    get(args: { key: string }, opts?: { timeoutMs?: number }): Promise<unknown>;
    set(args: { key: string; value: unknown }, opts?: { timeoutMs?: number }): Promise<unknown>;
    delete(args: { key: string }, opts?: { timeoutMs?: number }): Promise<unknown>;
  };
  tools: {
    list(opts?: { timeoutMs?: number }): Promise<unknown>;
    invoke(
      args: { tool_id: string; method?: string; args?: unknown; timeoutMs?: number },
      opts?: { timeoutMs?: number },
    ): Promise<unknown>;
  };
}

interface AnnaSdkModule {
  AnnaAppRuntime: {
    connect(): Promise<AnnaAppRuntime>;
  };
}

/**
 * 连接 Anna host 运行时。失败（独立打开、无 wid/t、host 不可达等）
 * 一律返回 null 让调用方降级渲染，不抛未捕获异常。
 */
export async function connectAnna(): Promise<AnnaAppRuntime | null> {
  try {
    const mod = (await import(/* @vite-ignore */ ANNA_SDK_URL)) as AnnaSdkModule;
    return await mod.AnnaAppRuntime.connect();
  } catch (err) {
    console.warn("[mini-notes] 未在 Anna 中运行，SDK 连接失败:", err);
    return null;
  }
}

/**
 * 解包 SDK RPC 的 Promise（notes/05、06）：
 * - {ok:true, result}        → result
 * - {ok:false, error}        → 抛 Error（消息含 code）
 * - 直接是业务 payload（部分命名空间/版本直接 resolve 数据）→ 原样返回
 */
export function unwrapRpc<T>(resp: unknown): T {
  if (resp !== null && typeof resp === "object" && "ok" in resp) {
    const r = resp as RpcOk<unknown> | RpcErr;
    if (r.ok === false) {
      const e = (r as RpcErr).error;
      throw new Error(`[${e.code}] ${e.message}`);
    }
    return (r as RpcOk<unknown>).result as T;
  }
  return resp as T;
}
