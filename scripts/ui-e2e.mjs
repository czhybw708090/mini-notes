// 浏览器端到端实测：起 anna-app dev 后，用真实浏览器打开 harness
// dashboard，在 iframe 里实测创建/列表/删除/Summarize，并拦截
// /api/session/call 请求体留「读走 storage、写走 storage、总结走
// tools.invoke」的 RPC 证据。
//
// 用法：node scripts/ui-e2e.mjs [dashboard-url]（默认 http://127.0.0.1:5180/）
// 依赖：npm i --no-save playwright && npx playwright install chromium

import { chromium } from "playwright";

const BASE = process.argv[2] ?? "http://127.0.0.1:5180/";

const rpcCalls = []; // 证据：iframe 经 dashboard 发出的 host RPC
const notes = ["明天跟客户 follow up", "修复登录 bug"];

function fail(msg) {
  console.error(`FAIL: ${msg}`);
  process.exit(1);
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 900, height: 900 } });

// 拦截 dashboard 的 RPC 中转请求，记录 ns/method/args。
page.on("request", (req) => {
  if (req.method() !== "POST" || !req.url().includes("/api/session/call")) return;
  let body = null;
  try {
    body = JSON.parse(req.postData() ?? "{}");
  } catch {
    /* 非 JSON 不记录 */
  }
  if (body) rpcCalls.push({ ns: body.ns, method: body.method, args: body.args });
});

page.on("console", (msg) => {
  const loc = msg.location();
  const tag = loc.url.includes("/anna-apps/") ? "iframe" : "page";
  if (tag === "iframe") console.log(`[console:${tag}] ${msg.text()}`);
});

await page.goto(BASE, { waitUntil: "domcontentloaded" });
const frameEl = await page.waitForSelector('iframe[src*="wid="]', { timeout: 30000 });
const frameUrl = await frameEl.getAttribute("src");
console.log(`iframe src = ${frameUrl}`);
const frame = page.frames().find((f) => f.url().includes("wid="));
if (!frame) fail("找不到 iframe 对应的 frame");

// 等 app 连上 runtime 并加载完笔记（控件由 setControlsEnabled(true) 解锁）。
await frame.waitForSelector("#add-note:not([disabled])", { timeout: 30000 });
await frame.waitForFunction(() => /^已加载 \d+ 条笔记$/.test(document.getElementById("status").textContent), null, { timeout: 30000 });
console.log(`初始状态: ${await frame.textContent("#status")}`);

// --- 创建 ---
for (let i = 0; i < notes.length; i++) {
  await frame.fill("#note-input", notes[i]);
  await frame.click("#add-note");
  // 等列表实际长出第 i+1 条（status 在第一条保存后一直是「已保存」，不能拿它当同步点）。
  await frame.waitForFunction(
    (n) => document.querySelectorAll("#note-list li").length === n,
    i + 1,
    { timeout: 10000 },
  );
}
const liCount = await frame.locator("#note-list li").count();
if (liCount !== notes.length) fail(`创建后期望 ${notes.length} 条笔记，实际 ${liCount} 条`);
const shown = await frame.locator("#note-list li span").allTextContents();
console.log(`创建 2 条后列表: ${JSON.stringify(shown)}`);
await page.screenshot({ path: "/tmp/anna-ui-list.png" });

// --- 空输入拦截 ---
await frame.fill("#note-input", "   ");
await frame.click("#add-note");
await frame.waitForFunction(() => document.getElementById("status").textContent === "笔记内容不能为空", null, { timeout: 5000 });
console.log("空输入拦截生效: 笔记内容不能为空");
const liCountAfterEmpty = await frame.locator("#note-list li").count();
if (liCountAfterEmpty !== notes.length) fail("空输入不应新增笔记");

// --- 删除 ---
await frame.locator("#note-list li").first().locator("button", { hasText: "删除" }).click();
await frame.waitForFunction(
  (n) => document.querySelectorAll("#note-list li").length === n,
  notes.length - 1,
  { timeout: 10000 },
);
const liCountAfterDelete = await frame.locator("#note-list li").count();
if (liCountAfterDelete !== notes.length - 1) fail(`删除后期望 ${notes.length - 1} 条，实际 ${liCountAfterDelete} 条`);
console.log(`删除 1 条后剩余: ${JSON.stringify(await frame.locator("#note-list li span").allTextContents())}`);

// --- Summarize（预期失败：--no-llm 环境，记录错误原文）---
await frame.click("#summarize");
await frame.waitForFunction(
  () => document.getElementById("status").textContent.includes("总结失败"),
  null,
  { timeout: 70000 },
);
const summarizeError = (await frame.textContent("#status")).trim();
console.log(`Summarize 实际状态: ${summarizeError}`);
await page.screenshot({ path: "/tmp/anna-ui-summarize-error.png" });

await browser.close();

// --- 证据汇总 ---
console.log("\n===== RPC 证据（/api/session/call 请求体）=====");
for (const c of rpcCalls) console.log(JSON.stringify(c));
const storageOps = rpcCalls.filter((c) => c.ns === "storage");
const toolInvokes = rpcCalls.filter((c) => c.ns === "tools" && c.method === "invoke");
if (storageOps.length === 0) fail("未捕获任何 storage RPC");
if (toolInvokes.length === 0) fail("未捕获 tools.invoke RPC");
console.log(`\nstorage RPC 共 ${storageOps.length} 次，tools.invoke 共 ${toolInvokes.length} 次`);
console.log(`SUMMARIZE_ERROR_RAW=${summarizeError}`);
console.log("PASS");
