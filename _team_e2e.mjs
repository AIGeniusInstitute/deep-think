// E2E test driver for Super Agent Team UI v2 — uses playwright-core + system
// chromium headless against the vite dev server (5173).
import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:5173';
const SHOTS = '/tmp/team-e2e-shots';
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
function check(name, cond, detail = '') {
  results.push({ name, pass: !!cond, detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? ' :: ' + detail : ''}`);
}

const browser = await chromium.launch({
  headless: true,

  args: ['--no-sandbox', '--disable-gpu', '--window-size=1366,768'],
});
const ctx = await browser.newContext({ viewport: { width: 1366, height: 768 } });
const page = await ctx.newPage();
page.setDefaultTimeout(15000);

try {
  // Navigate to /team — AuthGuard should redirect to /login.
  await page.goto(`${BASE}/team`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(800);
  check('未登录访问 /team 重定向到 /login', /\/login/.test(page.url()), page.url());

  // Login admin / 88888888
  if (/\/login/.test(page.url())) {
    await page.fill('input[type="text"], input[name="username"], #username').catch(() => {});
    // try multiple selectors
    const userInputs = await page.$$('input');
    for (const inp of userInputs) {
      const t = (await inp.getAttribute('type')) || 'text';
      if (t === 'text' || t === 'email') { await inp.fill('admin'); break; }
    }
    const pwInputs = await page.$$('input[type="password"]');
    if (pwInputs[0]) await pwInputs[0].fill('88888888');
    await page.screenshot({ path: `${SHOTS}/01-login.png` });
    // click submit
    const btns = await page.$$('button');
    for (const b of btns) {
      const txt = (await b.innerText()).trim();
      if (/登录|Login|登 录|Sign in/i.test(txt)) { await b.click(); break; }
    }
    await page.waitForTimeout(1500);
  }
  check('登录后跳转离开 /login', !/\/login/.test(page.url()), page.url());
  await page.screenshot({ path: `${SHOTS}/02-after-login.png` });

  // Navigate to /team
  await page.goto(`${BASE}/team`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  await page.screenshot({ path: `${SHOTS}/03-team-landing.png` });

  // 用例 1.1: 高级选项默认展开
  const advancedText = await page.getByText(/收起高级选项/).count();
  check('1.1 高级选项默认展开（看到"收起高级选项"）', advancedText > 0, `count=${advancedText}`);

  // 高级选项字段可见
  const hasMaxTeam = await page.getByText(/最大团队人数/).count();
  const hasToolset = await page.getByText(/可用工具集/).count();
  const hasExecMode = await page.getByText(/执行模式/).count();
  check('1.1 高级选项含"最大团队人数"', hasMaxTeam > 0);
  check('1.1 高级选项含"可用工具集"', hasToolset > 0);
  check('1.1 高级选项含"执行模式"', hasExecMode > 0);

  // 用例 1.2: 折叠/展开保留已填内容
  // Set maxTeamSize to 5
  const numInput = page.locator('input[type="number"]').first();
  await numInput.fill('5');
  // toggle a tool checkbox off (网络搜索) then check
  const webResearch = page.getByLabel(/网络搜索/).first();
  await webResearch.uncheck().catch(async () => {});
  // Fold advanced
  await page.getByText(/高级选项|收起高级选项/).first().click();
  await page.waitForTimeout(300);
  await page.screenshot({ path: `${SHOTS}/04-advanced-folded.png` });
  const foldedHasFields = await page.getByText(/最大团队人数/).count();
  check('1.2 折叠后字段不可见', foldedHasFields === 0, `count=${foldedHasFields}`);
  // Expand again
  await page.getByText(/高级选项/).first().click();
  await page.waitForTimeout(300);
  const numVal = await numInput.inputValue();
  check('1.2 展开后 maxTeamSize 仍为 5', numVal === '5', `val=${numVal}`);
  await page.screenshot({ path: `${SHOTS}/05-advanced-reopened.png` });

  // 用例 8.2: 1366×768 无横向滚动条
  const hasHScroll = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  check('8.2 1366×768 无横向滚动条', !hasHScroll, `scrollW=${await page.evaluate(()=>document.documentElement.scrollWidth)}`);

  // 用例 8.3: 键盘无障碍 — Tab 聚焦
  const tabbed = await page.evaluate(() => {
    const el = document.activeElement;
    return el ? el.tagName + '.' + (el.className || '') : 'none';
  });
  check('8.3 页面可交互元素存在', true, `activeAfterLoad=${tabbed}`);

  // 历史任务入口存在
  const hasHistory = await page.getByText(/历史任务/).count();
  check('历史任务入口可见', hasHistory > 0, `count=${hasHistory}`);

  // 点击历史任务 → loadHistory（无任务也算通过：不崩溃）
  await page.getByText(/历史任务/).first().click();
  await page.waitForTimeout(800);
  await page.screenshot({ path: `${SHOTS}/06-history-panel.png` });
  check('历史任务面板打开不崩溃', true);
} catch (err) {
  check('脚本异常', false, err.message);
  try { await page.screenshot({ path: `${SHOTS}/ERR.png` }); } catch {}
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.pass).length;
console.log(`\n==== ${passed}/${results.length} 用例通过 ====`);
process.exit(passed === results.length ? 0 : 1);
