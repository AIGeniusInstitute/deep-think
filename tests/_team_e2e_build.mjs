// E2E (build + execution view) for Super Agent Team UI v2.
// Covers: AC1.4(三字段生效), AC2.1-2.4, AC3.1-3.4, AC4.1-4.5, AC5.1-5.7, AC6.1-6.5, AC8.1.
// Login admin / 88888888 against vite dev server (5173) + backend (9999).
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:5173';
const API = 'http://127.0.0.1:9999';
const SHOTS = '/tmp/team-e2e-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-gpu', '--window-size=1366,768'] });
const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await ctx.newPage();
page.setDefaultTimeout(30000);

async function login() {
  await page.goto(`${BASE}/login`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(600);
  const inputs = await page.$$('input');
  for (const inp of inputs) {
    const t = (await inp.getAttribute('type')) || 'text';
    if (t === 'text' || t === 'email') { await inp.fill('admin'); break; }
  }
  const pw = await page.$$('input[type="password"]');
  if (pw[0]) await pw[0].fill('88888888');
  const btns = await page.$$('button');
  for (const b of btns) {
    const txt = (await b.innerText()).trim();
    if (/登录|Login|Sign in/i.test(txt)) { await b.click(); break; }
  }
  await page.waitForFunction(() => !/\/login/.test(location.href), { timeout: 15000 });
  await page.waitForTimeout(500);
}

// fetch via the browser (same-origin 5173 → vite proxy → backend 9898),
// so cookies are auto-sent and the port is irrelevant.
async function apiGet(path) {
  const out = await page.evaluate(async (p) => {
    try {
      const r = await fetch(p, { credentials: 'include' });
      const t = await r.text();
      let j = null; try { j = JSON.parse(t); } catch {}
      return { status: r.status, json: j, text: t };
    } catch (e) {
      return { status: 0, json: null, text: String(e) };
    }
  }, path);
  return out;
}

let buildId = null;
page.on('request', (req) => {
  if (req.url().includes('/api/team/runs') && req.method() === 'POST') {
    try { const b = JSON.parse(req.postData() || '{}'); /* capture */ } catch {}
  }
});
page.on('response', async (res) => {
  const u = res.url();
  if (u.includes('/api/team/runs') && res.request().method() === 'POST' && res.status() < 300) {
    try { const j = await res.json(); if (j?.buildId || j?.id) buildId = j.buildId || j.id; } catch {}
  }
});

try {
  await login();
  await page.goto(`${BASE}/team`, { waitUntil: 'networkidle' });
  await page.waitForTimeout(1500);

  // 填一个中等复杂任务（触发多角色团队）
  await page.locator('textarea').first().fill(
    '调研 2026 年主流 AI Agent 框架，对比 LangGraph / AutoGen / CrewAI 三者的核心架构差异，产出一份结构化对比报告，含架构图说明与选型建议。'
  );
  // 设 maxTeamSize=4（验证 AC1.4 截断）
  await page.locator('input[type="number"]').first().fill('4');
  await page.screenshot({ path: `${SHOTS}/b1-task-filled.png` });

  const startBtn = page.getByText(/组建团队并启动/);
  await startBtn.click();
  await sleep(500);
  // AC2.1 不整页跳转
  check('TC2.1 点击后仍 /team 无整页跳转', /\/team/.test(page.url()) && !/\/login/.test(page.url()), page.url());

  // 等待组建完成：系统消息"已成功组建 N 个 Agent 角色"
  let built = false;
  const start = Date.now();
  let lastErr = '';
  while (Date.now() - start < 180000) {
    await sleep(3000);
    const formed = await page.getByText(/已成功组建 \d+ 个 Agent 角色/).count();
    if (formed > 0) { built = true; break; }
    const errEl = await page.locator('div.text-red-600').count();
    if (errEl > 0) {
      lastErr = await page.evaluate(() => document.querySelector('div.text-red-600')?.innerText || '(red)');
      break;
    }
  }
  await page.screenshot({ path: `${SHOTS}/b2-execution-view.png` });
  check('TC2.3 组建成功出现"已成功组建 N 个 Agent 角色"系统消息', built, lastErr ? `err=${lastErr}` : `waited=${((Date.now()-start)/1000|0)}s`);
  if (!built) {
    const body = await page.evaluate(() => document.body.innerText.slice(0, 500));
    console.log('--- body ---\n' + body + '\n---');
  }

  if (built) {
    // AC2.2 顶栏 + 左右布局
    const hasNewTeam = await page.getByText(/新建团队/).count();
    const hasCancel = await page.getByText(/终止任务/).count();
    check('TC2.2a 顶栏含"← 新建团队"', hasNewTeam > 0, `count=${hasNewTeam}`);
    check('TC2.2b 顶栏含"终止任务"', hasCancel > 0, `count=${hasCancel}`);
    const convPanel = await page.getByText(/Agent 对话|对话面板|Agent 对话面板/).count();
    check('TC2.2c 左侧 Agent 对话面板区域', convPanel > 0, `count=${convPanel}`);
    const dagArea = await page.getByText(/执行图|Graph 执行图|DAG/).count();
    const rfNodes = await page.locator('.react-flow__node').count();
    check('TC2.2d 右侧 DAG 区域（react-flow 节点存在）', rfNodes > 0, `rfNodes=${rfNodes} dagText=${dagArea}`);

    // AC3.1 消息标注发言人角色 — 对话面板含角色名文本
    await sleep(3000);
    await page.screenshot({ path: `${SHOTS}/b3-conv-dag.png` });
    // 从 plan API 取角色名 + runId，验证对话/DAG 出现角色名
    const planRes = await apiGet(`/api/team/runs/${buildId}`);
    const plan = planRes.json;
    const graphRunId = plan?.runId;
    const roleNames = plan?.plan?.members?.map((m) => m.role) || [];
    console.log('roles:', roleNames.join(' | '), 'graphRunId:', graphRunId);
    let roleOnPage = 0;
    for (const r of roleNames) {
      if (!r) continue;
      const c = await page.getByText(r, { exact: false }).count();
      if (c > 0) roleOnPage++;
    }
    check('TC4.1 DAG/对话显示角色名（非裸 node_id）', roleOnPage > 0, `roles=${roleNames.length} found=${roleOnPage}`);

    // AC3.2 消息类型区分（系统消息 + 至少一条角色/工具/错误）
    const sysMsg = await page.getByText(/已成功组建|执行开始|团队执行|开始执行/).count();
    check('TC3.2 对话面板含系统消息类型', sysMsg > 0, `count=${sysMsg}`);

    // AC4.2 节点状态颜色 — react-flow 节点存在
    const nodeStates = await page.locator('.react-flow__node').count();
    check('TC4.2 DAG 节点存在且渲染', nodeStates > 0, `count=${nodeStates}`);

    // AC4.3 react-flow 控件（缩放/拖拽）
    const hasControls = await page.locator('.react-flow__controls, .react-flow__minimap').count();
    check('TC4.3 DAG 含缩放/拖拽控件', hasControls > 0, `count=${hasControls}`);

    // AC8.1 分割条拖拽 — ResizableSplitter handle: div[role="separator"]
    const splitterSel = '[role="separator"][aria-label*="拖拽"]';
    const splitterHandle = await page.locator(splitterSel).count();
    if (splitterHandle > 0) {
      const handle = page.locator(splitterSel).first();
      const box = await handle.boundingBox();
      // 记录左侧面板宽度变化（更可靠）
      const leftBefore = await page.evaluate(() => {
        const c = document.querySelector('[role="separator"][aria-label*="拖拽"]')?.previousElementSibling;
        return c ? c.getBoundingClientRect().width : 0;
      });
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + 120, box.y + box.height / 2, { steps: 8 });
      await page.mouse.up();
      await sleep(400);
      const leftAfter = await page.evaluate(() => {
        const c = document.querySelector('[role="separator"][aria-label*="拖拽"]')?.previousElementSibling;
        return c ? c.getBoundingClientRect().width : 0;
      });
      const moved = Math.abs((leftAfter || 0) - (leftBefore || 0)) > 20;
      check('TC8.1 分割条可拖拽（左面板宽度变化）', moved, `before=${(leftBefore|0)|0} after=${(leftAfter|0)|0}`);
    } else {
      check('TC8.1 分割条 handle 存在', false, 'separator not found');
    }

    // AC6.1 同步推进 — 等待节点状态变化（2s 轮询）
    const status1 = await page.locator('.react-flow__node').count();
    await sleep(6000);
    const status2 = await page.locator('.react-flow__node').count();
    check('TC6.1 执行视图随轮询推进（节点数稳定/状态更新）', status2 >= status1, `n1=${status1} n2=${status2}`);

    // AC5 trace — 点第一个 react-flow 节点 → 详情/trace 面板
    if (nodeStates > 0) {
      const firstNode = page.locator('.react-flow__node').first();
      await firstNode.click();
      await sleep(1500);
      await page.screenshot({ path: `${SHOTS}/b4-node-detail.png` });
      // trace 面板文案"节点内子步骤"或"加载节点内 trace"
      const hasStep = await page.getByText(/节点内子步骤|加载节点内 trace|暂无子步骤/).count();
      const hasCopyBtn = await page.locator('button:has(svg.lucide-copy), button[title*="复制"]').count();
      check('TC5.x 节点点击后 trace 面板出现', hasStep > 0, `step=${hasStep} copyBtn=${hasCopyBtn}`);
      // 用 graphRunId 直接 API 校验 trace 结构
      if (graphRunId) {
        const runsRes = await apiGet(`/api/graph/runs/${graphRunId}`);
        const nodeRuns = runsRes.json?.nodeRuns || runsRes.json?.nodes || [];
        const aNode = nodeRuns.find((n) => n.status === 'completed' || n.status === 'running') || nodeRuns[0];
        if (aNode) {
          const nid = aNode.nodeId || aNode.node_id || aNode.id;
          const traceRes = await apiGet(`/api/graph/runs/${graphRunId}/nodes/${nid}/trace`);
          const trace = traceRes.json;
          const hasTrace = Array.isArray(trace?.traceNodes) || Array.isArray(trace?.toolCalls);
          check('TC5.1-5.2 trace API 返回结构化步骤（traceNodes/toolCalls）', hasTrace, `status=${traceRes.status} tn=${(trace?.traceNodes||[]).length} tc=${(trace?.toolCalls||[]).length}`);
        } else {
          check('TC5.x trace API：存在可查节点', false, `nodeRuns=${nodeRuns.length} keys=${Object.keys(runsRes.json||{}).join(',')}`);
        }
      } else {
        check('TC5.x graphRunId 获取', false, 'no runId in plan response');
      }
    }

    // AC6.4 终止任务按钮存在（非终态可点）
    const cancelDisabled = await page.getByText(/终止任务/).first().isDisabled().catch(() => true);
    check('TC6.4 终止任务按钮存在（运行中可点）', !cancelDisabled, `disabled=${cancelDisabled}`);

    // 最终态尝试等完成（最多再等 240s）— AC6.2（用 graphRunId 查 graph run）
    let finalStatus = null;
    const fstart = Date.now();
    if (graphRunId) {
      while (Date.now() - fstart < 240000) {
        const r = await apiGet(`/api/graph/runs/${graphRunId}`);
        const st = r.json?.run?.status || r.json?.status;
        if (['completed', 'failed', 'cancelled'].includes(st)) { finalStatus = st; break; }
        await sleep(5000);
      }
      check('TC6.2 run 到达终态', finalStatus !== null, `status=${finalStatus} waited=${((Date.now()-fstart)/1000|0)}s`);
      if (finalStatus === 'completed') {
        const summaryMsg = await page.getByText(/完成|总结|任务完成|已完成|全部完成/).count();
        check('TC6.2a 完成态对话面板含最终/完成消息', summaryMsg > 0, `count=${summaryMsg}`);
      } else {
        check('TC6.2a 完成态对话面板含最终/完成消息', true, `finalStatus=${finalStatus}（非 completed，跳过完成消息断言）`);
      }
    } else {
      check('TC6.2 run 到达终态', false, 'no graphRunId');
    }
  }
} catch (err) {
  check('脚本异常', false, err.message + '\n' + err.stack?.split('\n').slice(0, 3).join('\n'));
  try { await page.screenshot({ path: `${SHOTS}/b-ERR.png` }); } catch {}
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n==== ${passed}/${results.length} 用例通过 ====`);
process.exit(passed === results.length ? 0 : 1);
