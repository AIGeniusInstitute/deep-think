// E2E for 全托管模式 (autonomous mode) — covers PRD §F1-F10 happy paths.
//
// Login admin / 88888888 against vite dev server (5173) which proxies /api
// to the backend. Mirrors autonomy.mjs conventions.
//
// Tests:
// 1. GET /api/config/autonomous?chat_jid=xxx returns current state (default false)
// 2. PUT /api/config/autonomous toggles per-chat flag and reads back
// 3. GET /api/config/autonomous/all (admin only) returns map of enabled chats
// 4. MessageCreateSchema accepts autonomous=true in POST /api/messages body
// 5. GET /api/groups includes autonomous field per group
// 6. POST /api/tasks with execution_type=agent accepts autonomous=true

import { chromium } from 'playwright-core';
import fs from 'node:fs';

const BASE = process.env.AUTONOMOUS_E2E_BASE || 'http://127.0.0.1:9899';
const SHOTS = '/tmp/autonomous-e2e-shots';
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
  // Hit login API directly. This avoids needing the frontend dev server.
  const res = await api('/api/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username: 'admin', password: '88888888' }),
  });
  check('login API returns 200', res.status === 200, `status=${res.status}`);
}

async function api(path, init = {}) {
  const { body, ...rest } = init;
  const res = await page.request.fetch(`${BASE}${path}`, {
    ...rest,
    data: body,
    headers: { 'content-type': 'application/json', ...(init.headers || {}) },
  });
  return { status: res.status(), body: await res.json().catch(() => null) };
}

try {
  await login();

  // Find admin's home chat jid (folder=main → jid web:main)
  const groupsResp = await api('/api/groups');
  check('GET /api/groups 200', groupsResp.status === 200, `status=${groupsResp.status}`);
  const groupsList = groupsResp.body?.groups || [];
  const adminHome = Object.values(groupsList).find((g) => g.is_home && g.folder === 'main');
  check('admin home workspace exists', !!adminHome, JSON.stringify({ groups: Object.keys(groupsList) }).slice(0, 200));
  const chatJid = adminHome?.jid || 'web:main';

  // F1 — GET current autonomous state (default false)
  const r1 = await api(`/api/config/autonomous?chat_jid=${encodeURIComponent(chatJid)}`);
  check('GET /api/config/autonomous 200', r1.status === 200, `status=${r1.status}`);
  check('default autonomous=false', r1.body?.enabled === false, JSON.stringify(r1.body));

  // F2 — PUT autonomous=true, read back
  const r2 = await api('/api/config/autonomous', {
    method: 'PUT',
    body: JSON.stringify({ chat_jid: chatJid, enabled: true }),
  });
  check('PUT /api/config/autonomous enabled=true 200', r2.status === 200, `status=${r2.status}`);
  check('PUT returns enabled=true', r2.body?.enabled === true, JSON.stringify(r2.body));

  const r3 = await api(`/api/config/autonomous?chat_jid=${encodeURIComponent(chatJid)}`);
  check('read-back after enable: autonomous=true', r3.body?.enabled === true, JSON.stringify(r3.body));

  // F3 — GET /api/config/autonomous/all (admin) includes the chat
  const r4 = await api('/api/config/autonomous/all');
  check('GET /api/config/autonomous/all 200 (admin)', r4.status === 200, `status=${r4.status}`);
  check('all-list includes the just-enabled chat', r4.body?.groups?.[chatJid] === true, JSON.stringify(r4.body).slice(0, 200));

  // F5 — GET /api/groups includes autonomous field
  const r5 = await api('/api/groups');
  const groupAfter = r5.body?.groups?.[chatJid];
  check('GET /api/groups returns autonomous=true on enabled chat', groupAfter?.autonomous === true, JSON.stringify(groupAfter).slice(0, 200));

  // F4 — POST /api/messages with autonomous flag (don't actually run agent here;
  // we only verify the schema accepts the field. To avoid side-effects we use
  // an invalid chatJid so the request fails 404 before reaching the agent.)
  const r6 = await api('/api/messages', {
    method: 'POST',
    body: JSON.stringify({ chatJid: 'web:__nonexistent_chat__', content: 'e2e probe', autonomous: true }),
  });
  // 404 expected because the chat doesn't exist; the point is the schema
  // accepted the autonomous field (otherwise we'd get 400 'invalid').
  check('POST /api/messages with autonomous=true passes schema (not 400)', r6.status !== 400, `status=${r6.status}`);

  // F10 — POST /api/tasks with execution_type=agent + autonomous=true (won't
  // actually schedule a run, just verify schema acceptance). Use a one-shot far
  // in the future so it doesn't fire during the test.
  const farFuture = new Date(Date.now() + 365 * 24 * 3600 * 1000).toISOString();
  const r7 = await api('/api/tasks', {
    method: 'POST',
    body: JSON.stringify({
      prompt: 'e2e autonomous probe — safe to delete',
      schedule_type: 'once',
      schedule_value: farFuture,
      execution_type: 'agent',
      autonomous: true,
      context_mode: 'isolated',
    }),
  });
  check('POST /api/tasks with autonomous=true 200', r7.status === 200, `status=${r7.status} body=${JSON.stringify(r7.body).slice(0, 200)}`);

  // Cleanup: turn autonomous back off and delete the probe task
  await api('/api/config/autonomous', {
    method: 'PUT',
    body: JSON.stringify({ chat_jid: chatJid, enabled: false }),
  });
  if (r7.body?.taskId || r7.body?.id) {
    await api(`/api/tasks/${r7.body.taskId || r7.body.id}`, { method: 'DELETE' });
  }

  // Verify cleanup
  const rCleanup = await api(`/api/config/autonomous?chat_jid=${encodeURIComponent(chatJid)}`);
  check('cleanup restored autonomous=false', rCleanup.body?.enabled === false, JSON.stringify(rCleanup.body));
} catch (err) {
  check('no uncaught exception', false, (err?.message || String(err)).slice(0, 200));
  await page.screenshot({ path: `${SHOTS}/crash.png` }).catch(() => {});
} finally {
  await browser.close();
}

const passed = results.filter((r) => r.pass).length;
const failed = results.length - passed;
console.log(`\n=== autonomous E2E: ${passed} passed / ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
