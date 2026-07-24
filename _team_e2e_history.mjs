// History retrospection E2E — AC5.5/5.6 (trace retrospection), AC6.3 (failed terminal),
// AC7.1 (history reopen), AC4.x (node status colors).
// Opens a previously-run team build (graph-18c504bd: research node completed + run failed).
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
page.setDefaultTimeout(20000);

try {
  // login
  await page.goto('http://127.0.0.1:5173/login', { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  const ins = await page.$$('input'); for (const i of ins) { const t = (await i.getAttribute('type')) || 'text'; if (t === 'text') { await i.fill('admin'); break; } }
  const pw = await page.$$('input[type=password]'); if (pw[0]) await pw[0].fill('88888888');
  const bs = await page.$$('button'); for (const b of bs) { const tx = (await b.innerText()).trim(); if (/登录|Login|Sign in/i.test(tx)) { await b.click(); break; } }
  await page.waitForFunction(() => !/\/login/.test(location.href), { timeout: 15000 });
  await page.goto('http://127.0.0.1:5173/team', { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // AC7.0 历史入口
  const hasHistory = await page.getByText(/历史任务/).count();
  check('TC7.0 历史任务入口可见', hasHistory > 0, `count=${hasHistory}`);
  await page.getByText(/历史任务/).first().click();
  await page.waitForTimeout(1200);
  await page.screenshot({ path: `${SHOTS}/h1-history-list.png` });

  // AC7.2 历史列表显示状态/摘要/时间
  const listItems = await page.getByText(/completed|failed|running|暂无历史任务/).count();
  check('TC7.2 历史列表显示状态', listItems > 0, `count=${listItems}`);

  // 找一个 completed 的 team build（组建成功，run 已终态）点击重开
  // 历史项 status 来自 graph_run，可能是 failed。点第一个含"completed/failed"的历史项
  const historyBtns = await page.locator('button', { hasText: /completed|failed|running/i }).count();
  check('TC7.x 历史列表有可点击项', historyBtns > 0, `count=${historyBtns}`);
  if (historyBtns > 0) {
    await page.locator('button', { hasText: /completed|failed/i }).first().click();
    await page.waitForTimeout(2500);
    await page.screenshot({ path: `${SHOTS}/h2-reopened-run.png` });

    // AC7.1 重开后进入执行视图（顶栏"新建团队"）
    const inExec = await page.getByText(/新建团队/).count();
    check('TC7.1 历史重开进入执行视图', inExec > 0, `newTeam=${inExec}`);

    // AC4.x DAG 节点存在
    const rfNodes = await page.locator('.react-flow__node').count();
    check('TC4.x 重开后 DAG 节点渲染', rfNodes > 0, `nodes=${rfNodes}`);

    // AC6.3 终态：run 已 failed/completed → 终止按钮 disabled
    // 等待 currentRun 加载（轮询）→ isTerminal → 按钮 disabled，最多 12s
    let termDisabled = false;
    try {
      await page.waitForFunction(
        async () => {
          const btn = [...document.querySelectorAll('button')].find((b) => /终止任务|终止中/.test(b.innerText));
          return btn && btn.disabled;
        },
        { timeout: 12000 },
      );
      termDisabled = true;
    } catch { /* 仍可点 → 非终态 */ }
    check("TC6.3 终态时终止按钮 disabled", termDisabled, "disabled=" + termDisabled);

    // AC5.5/5.6 trace 回溯 — 点节点看 trace
    if (rfNodes > 0) {
      await page.locator('.react-flow__node').first().click();
      await page.waitForTimeout(2000);
      await page.screenshot({ path: `${SHOTS}/h3-trace-retro.png` });
      const tracePanel = await page.getByText(/节点内子步骤|加载节点内 trace|暂无子步骤/).count();
      check('TC5.5/5.6 历史重开后 trace 面板可回溯', tracePanel > 0, `panel=${tracePanel}`);
      // 直接 API 校验 trace 数据持久化（任意 completed 节点）
      const runsRes = await page.evaluate(async () => {
        // 拿当前 runId：从 TeamPage 顶栏文本"运行 xxx"
        const txt = document.body.innerText;
        const m = txt.match(/运行\s+([a-f0-9-]+)/);
        const rid = m ? m[1] : null;
        if (!rid) return { err: 'no runId in page' };
        const r = await fetch('/api/graph/runs/' + rid, { credentials: 'include' });
        return await r.json();
      });
      const nodeRuns = runsRes?.nodeRuns || [];
      const completedNode = nodeRuns.find((n) => n.status === 'completed');
      if (completedNode) {
        const nid = completedNode.node_id || completedNode.nodeId;
        const rid = completedNode.graph_run_id || runsRes?.run?.id;
        const traceRes = await page.evaluate(async ([r, n]) => {
          const rr = await fetch(`/api/graph/runs/${r}/nodes/${n}/trace`, { credentials: 'include' });
          return { status: rr.status, body: await rr.text() };
        }, [rid, nid]);
        let tn = 0, tc = 0;
        try { const j = JSON.parse(traceRes.body); tn = (j.traceNodes||[]).length; tc = (j.toolCalls||[]).length; } catch {}
        check('TC5.7 trace 数据刷新后持久化可回溯', tn > 0 || tc > 0, `node=${nid} tn=${tn} tc=${tc} http=${traceRes.status}`);
      } else {
        check('TC5.7 trace 持久化', false, `nodeRuns=${nodeRuns.length} 无 completed 节点`);
      }
      // 兜底：直接用已知 failed run（graph-18c504bd，research 节点 completed + 完整 trace）
      // 验证 trace 数据持久化可回溯（AC5.6/5.7）
      const known = await page.evaluate(async () => {
        const rid = 'graph-18c504bd-6232-47db-af8b-c4f9e206f84b';
        const rr = await fetch('/api/graph/runs/' + rid, { credentials: 'include' });
        const rj = await rr.json();
        const nrs = rj?.nodeRuns || [];
        const done = nrs.find((n) => n.status === 'completed');
        if (!done) return { ok: false, reason: 'no completed node', nrs: nrs.length };
        const nid = done.node_id || done.nodeId;
        const tr = await fetch(`/api/graph/runs/${rid}/nodes/${nid}/trace`, { credentials: 'include' });
        const tj = await tr.json();
        return { ok: (tj.traceNodes?.length || 0) + (tj.toolCalls?.length || 0) > 0, tn: tj.traceNodes?.length, tc: tj.toolCalls?.length, http: tr.status };
      });
      if (!known.ok && results.find((r) => r.name.startsWith('TC5.7'))?.pass) {
        // 已通过则跳过
      } else {
        check('TC5.7 trace 数据持久化可回溯（已知 failed run）', known.ok, JSON.stringify(known));
      }
    }
  }
} catch (e) {
  check('脚本异常', false, e.message);
  try { await page.screenshot({ path: `${SHOTS}/h-ERR.png` }); } catch {}
} finally { await browser.close(); }
const passed = results.filter((r) => r.pass).length;
console.log(`\n==== ${passed}/${results.length} 用例通过 ====`);
process.exit(passed === results.length ? 0 : 1);
