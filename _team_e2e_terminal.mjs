// Minimal terminal-state verification for AC6.2.
// Lightweight task + no web-research toolset → agents finish fast via pure LLM.
import { chromium } from 'playwright-core';
import fs from 'node:fs';
const SHOTS = '/tmp/team-e2e-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
function check(n, c, d = '') { results.push({ name: n, pass: !!c, detail: d }); console.log(`${c ? 'PASS' : 'FAIL'}  ${n}${d ? ' :: ' + d : ''}`); }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu'] });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await ctx.newPage();
page.setDefaultTimeout(30000);

let buildId = null;
page.on('response', async (res) => {
  const u = res.url();
  if (u.includes('/api/team/runs') && res.request().method() === 'POST' && res.status() < 300) {
    try { const j = await res.json(); if (j?.buildId) buildId = j.buildId; } catch {}
  }
});

try {
  // login
  await page.goto('http://127.0.0.1:5173/login', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const ins = await page.$$('input'); for (const i of ins) { const t = (await i.getAttribute('type')) || 'text'; if (t === 'text') { await i.fill('admin'); break; } }
  const pw = await page.$$('input[type=password]'); if (pw[0]) await pw[0].fill('88888888');
  const bs = await page.$$('button'); for (const b of bs) { const tx = (await b.innerText()).trim(); if (/登录|Login|Sign in/i.test(tx)) { await b.click(); break; } }
  await page.waitForFunction(() => !/\/login/.test(location.href), { timeout: 15000 });
  await page.goto('http://127.0.0.1:5173/team', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1200);

  // 轻量纯文本任务，明确不联网；toolset 不含 web-research（只留 code-execution）
  await page.locator('textarea').first().fill('基于你自身已有知识，用中文写一首四句的五言绝句（主题：春天），并在末尾用一句话点评。不要使用任何网络搜索工具，直接作答。');
  // 取消勾选"网络搜索"与"文件读写"与"DeepThink MCP"，只留"代码执行"
  const checkboxes = page.locator('input[type="checkbox"]');
  const cnt = await checkboxes.count();
  for (let i = 0; i < cnt; i++) {
    const cb = checkboxes.nth(i);
    const label = await cb.evaluate((el) => el.parentElement?.innerText || '');
    if (/网络搜索|文件读写|DeepThink MCP/.test(label)) { if (await cb.isChecked()) await cb.uncheck(); }
  }
  await page.locator('input[type="number"]').first().fill('2');
  await page.screenshot({ path: `${SHOTS}/t1-light-task.png` });

  await page.getByText(/组建团队并启动/).click();
  // 等组建成功
  let built = false; const s0 = Date.now();
  while (Date.now() - s0 < 180000) {
    await sleep(3000);
    if ((await page.getByText(/已成功组建 \d+ 个 Agent 角色/).count()) > 0) { built = true; break; }
    if ((await page.locator('div.text-red-600').count()) > 0) break;
  }
  check('组建成功', built, `waited=${((Date.now()-s0)/1000|0)}s`);
  if (!built) { console.log('abort'); await browser.close(); process.exit(1); }

  // 取 graphRunId
  const planRes = await page.evaluate(async (bid) => { const r = await fetch('/api/team/runs/' + bid, { credentials: 'include' }); return r.json(); }, buildId);
  const graphRunId = planRes?.runId;
  const roles = (planRes?.plan?.members || []).map((m) => m.role);
  console.log('roles:', roles.join(' | '), 'runId:', graphRunId);
  check('获取 graphRunId', !!graphRunId, graphRunId || '');

  // 等终态（最多 300s）
  let finalStatus = null; const s1 = Date.now();
  while (Date.now() - s1 < 300000) {
    const r = await page.evaluate(async (id) => { const r = await fetch('/api/graph/runs/' + id, { credentials: 'include' }); return r.json(); }, graphRunId);
    const st = r?.run?.status;
    if (['completed', 'failed', 'cancelled'].includes(st)) { finalStatus = st; break; }
    await sleep(5000);
  }
  check('TC6.2 run 到达终态', finalStatus !== null, `status=${finalStatus} waited=${((Date.now()-s1)/1000|0)}s`);

  if (finalStatus === 'completed') {
    await sleep(1500);
    await page.screenshot({ path: `${SHOTS}/t2-final-completed.png` });
    // DAG 全绿：react-flow 节点无红/灰（状态 completed）— 检查完成消息
    const completeMsg = await page.getByText(/完成|总结|已完成|任务完成|全部完成/).count();
    check('TC6.2a 完成态对话面板含最终/完成消息', completeMsg > 0, `count=${completeMsg}`);
    // 节点状态 API 全 completed
    const rAll = await page.evaluate(async (id) => { const r = await fetch('/api/graph/runs/' + id, { credentials: 'include' }); return r.json(); }, graphRunId);
    const nrs = rAll?.nodeRuns || [];
    const allCompleted = nrs.length > 0 && nrs.every((n) => n.status === 'completed' || n.status === 'skipped');
    check('TC6.2b 所有节点 completed/skipped（DAG 全绿）', allCompleted, nrs.map((n) => (n.title || '') + '=' + n.status).join(' | '));
  } else {
    check('TC6.2a 完成态（非 completed）', false, `finalStatus=${finalStatus}`);
    check('TC6.2b DAG 全绿（非 completed）', false, `finalStatus=${finalStatus}`);
  }
} catch (e) {
  check('脚本异常', false, e.message);
  try { await page.screenshot({ path: `${SHOTS}/t-ERR.png` }); } catch {}
} finally { await browser.close(); }
const passed = results.filter((r) => r.pass).length;
console.log(`\n==== ${passed}/${results.length} 用例通过 ====`);
process.exit(passed === results.length ? 0 : 1);
