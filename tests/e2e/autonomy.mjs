// E2E (autonomy layer) — P0 skeleton.
// Covers PRD §F6.1: login + /api/autonomy/* endpoints respond, 7 capabilities
// registered, signal injection works. Quantitative metric达标 scenarios are P1/P2
// (they require triggering real graph runs / learning loops).
//
// Login admin / 88888888 against vite dev server (5173), which proxies /api to
// the backend. Mirrors _team_e2e.mjs conventions.

import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = 'http://127.0.0.1:5173';
const SHOTS = '/tmp/autonomy-e2e-shots';
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
page.setDefaultTimeout(20000);

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
  const btn = await page.$('button[type="submit"], button:has-text("登录"), button:has-text("Login")');
  if (btn) await btn.click();
  await page.waitForTimeout(1200);
}

async function api(path, init = {}) {
  const { body, ...rest } = init;
  const res = await page.request.fetch(`${BASE}${path}`, {
    ...rest,
    data: body, // playwright uses `data`, not `body`
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

try {
  await login();
  check('login lands on app (not /login)', !page.url().includes('/login'), page.url());

  // F1.2 / F6.1.0 — 7 capabilities registered
  const caps = await api('/api/autonomy/capabilities');
  check('GET /api/autonomy/capabilities 200', caps.status === 200, `status=${caps.status}`);
  const capList = caps.body?.capabilities || [];
  check('7 capabilities present', Array.isArray(capList) && capList.length === 7, `len=${capList.length}`);
  const expected = ['perception','cognition','decision','execution','learning','adaptation','monitoring'];
  check('capabilities in canonical order',
    expected.every((c, i) => capList[i]?.capability === c),
    capList.map((c) => c.capability).join(','));

  // F2.2 — metrics aggregation endpoint (empty window → denominator 0 → null ratio, no NaN)
  const metrics = await api('/api/autonomy/metrics?capability=execution');
  check('GET /api/autonomy/metrics 200', metrics.status === 200, `status=${metrics.status}`);
  check('metrics returns array', Array.isArray(metrics.body?.metrics), JSON.stringify(metrics.body).slice(0, 120));

  // F6.1 — health endpoint returns 7-capability summary
  const health = await api('/api/autonomy/health');
  check('GET /api/autonomy/health 200', health.status === 200, `status=${health.status}`);
  check('health has 7 capabilities', Array.isArray(health.body?.capabilities) && health.body.capabilities.length === 7, `len=${health.body?.capabilities?.length}`);

  // F4 (signal injection, admin) — POST /api/autonomy/signals
  const sig = await api('/api/autonomy/signals', {
    method: 'POST',
    body: JSON.stringify({ signal_type: 'perf_degradation', payload: { source: 'e2e-skeleton' } }),
  });
  check('POST /api/autonomy/signals 200', sig.status === 200, `status=${sig.status}`);
  check('signal returns id', typeof sig.body?.id !== 'undefined', JSON.stringify(sig.body));

  // P1 WP4 — signal → process → applied → adaptation_speed metric (PRD §F4.1)
  const proc = await api('/api/autonomy/signals/process', { method: 'POST', body: '{}' });
  check('POST /api/autonomy/signals/process 200', proc.status === 200, `status=${proc.status}`);
  check('processed >= 1', (proc.body?.processed ?? 0) >= 1, JSON.stringify(proc.body));

  const sigs = await api('/api/autonomy/signals');
  check('GET /api/autonomy/signals 200', sigs.status === 200, `status=${sigs.status}`);
  const sigList = sigs.body?.signals || [];
  check('signal flipped to applied', sigList.some((s) => s.status === 'applied'), JSON.stringify(sigList).slice(0, 120));

  const adaptMetric = await api('/api/autonomy/metrics?capability=adaptation&metric=adaptation_speed_ms');
  check('adaptation_speed_ms metric collected (denominator≥1)',
    (adaptMetric.body?.metrics?.[0]?.denominator ?? 0) >= 1,
    JSON.stringify(adaptMetric.body).slice(0, 120));

  // P1 WP3 — lessons endpoint (PRD §F3.2; empty without a real graph run)
  const lessons = await api('/api/autonomy/lessons');
  check('GET /api/autonomy/lessons 200', lessons.status === 200, `status=${lessons.status}`);
  check('lessons returns array', Array.isArray(lessons.body?.lessons), JSON.stringify(lessons.body).slice(0, 80));

  // Non-admin capability: none here (admin logged in). Negative path: invalid capability.
  const bad = await api('/api/autonomy/metrics?capability=bogus');
  check('invalid capability → 400', bad.status === 400, `status=${bad.status}`);
} catch (err) {
  check('no uncaught exception', false, (err?.message || String(err)).slice(0, 200));
  await page.screenshot({ path: `${SHOTS}/crash.png` }).catch(() => {});
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log(`\n=== autonomy E2E: ${passed} passed / ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
