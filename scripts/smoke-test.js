// End-to-end API tests. Runs the real Express app against a throw-away store.
//   npm test                          -> JSON file backend (temp file)
//   TEST_DATABASE_URL=postgres://... npm test -> PostgreSQL backend (tables are WIPED first, use a scratch database!)
const assert = require('assert');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { createStore } = require('../lib/db');
const { ensureAdmin } = require('../lib/admin');

process.env.SESSION_SECRET = 'test-secret';
delete process.env.DATABASE_URL; // never touch the app's real database from tests
if (process.env.TEST_DATABASE_URL) process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
if (!process.env.DATABASE_URL) process.env.JSON_DB_PATH = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'eod-')), 'db.json');
const { createApp } = require('../server');

let passed = 0;
const t = async (name, fn) => {
  try { await fn(); passed++; console.log('  ok  ' + name); }
  catch (e) { console.error('FAIL  ' + name + '\n      ' + e.message); process.exitCode = 1; }
};

class Client {
  constructor(base) { this.base = base; this.cookie = ''; }
  async req(method, url, body) {
    const res = await fetch(this.base + url, {
      method, redirect: 'manual',
      headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(this.cookie ? { Cookie: this.cookie } : {}) },
      body: body !== undefined ? JSON.stringify(body) : undefined
    });
    const sc = res.headers.getSetCookie ? res.headers.getSetCookie() : [];
    if (sc.length) this.cookie = sc.map(c => c.split(';')[0]).join('; ');
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, json, text, headers: res.headers };
  }
  get(u) { return this.req('GET', u); }
  post(u, b) { return this.req('POST', u, b ?? {}); }
  put(u, b) { return this.req('PUT', u, b); }
  patch(u, b) { return this.req('PATCH', u, b); }
  del(u) { return this.req('DELETE', u); }
}

(async () => {
  const store = createStore();
  await store.init();
  if (store.kind === 'postgres') await store.pool.query('TRUNCATE tasks, users RESTART IDENTITY CASCADE');
  const silent = { log() {}, warn() {} };
  await ensureAdmin(store, { name: 'Admin', password: 'AdminPass123', log: silent });
  const app = await createApp(store);
  const server = await new Promise(r => { const s = app.listen(0, () => r(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;
  console.log(`Testing against ${store.kind} backend at ${base}`);

  const admin = new Client(base), alice = new Client(base), bob = new Client(base), anon = new Client(base);
  let aliceTask, bobTask, adminTask;

  await t('health check', async () => { const r = await anon.get('/healthz'); assert.equal(r.status, 200); });
  await t('static index + chart vendor file served', async () => {
    assert.equal((await anon.get('/')).status, 200);
    assert.equal((await anon.get('/vendor/chart.js')).status, 200);
  });
  await t('unauthenticated API access is rejected', async () => {
    for (const u of ['/api/tasks', '/api/stats', '/api/calendar?year=2026&month=10', '/api/performance', '/api/export', '/api/users']) {
      assert.equal((await anon.get(u)).status, 401, u);
    }
    assert.equal((await anon.post('/api/tasks', { date: '2026-10-01', task: 'x' })).status, 401);
  });
  await t('login: wrong password / unknown user / empty rejected', async () => {
    assert.equal((await anon.post('/api/login', { name: 'Admin', password: 'nope' })).status, 401);
    assert.equal((await anon.post('/api/login', { name: 'ghost', password: 'nope1234' })).status, 401);
    assert.equal((await anon.post('/api/login', {})).status, 400);
  });
  await t('login: admin (case-insensitive name) + /api/me', async () => {
    const r = await admin.post('/api/login', { name: 'aDmIn', password: 'AdminPass123' });
    assert.equal(r.status, 200); assert.equal(r.json.user.role, 'admin');
    assert.ok(!('passwordHash' in r.json.user));
    assert.equal((await admin.get('/api/me')).json.user.name, 'Admin');
  });
  await t('admin creates employees; validation + duplicates', async () => {
    assert.equal((await admin.post('/api/users', { name: 'Alice', password: 'short' })).status, 400);
    assert.equal((await admin.post('/api/users', { name: 'A', password: 'longenough1' })).status, 400);
    const r = await admin.post('/api/users', { name: 'Alice', password: 'AlicePass1' });
    assert.equal(r.status, 201); assert.equal(r.json.user.role, 'member'); assert.equal(r.json.user.mustChangePassword, true);
    assert.equal((await admin.post('/api/users', { name: 'alice', password: 'AlicePass1' })).status, 409);
    assert.equal((await admin.post('/api/users', { name: 'Bob', password: 'BobPass123' })).status, 201);
  });
  await t('employee login + forced password change flow', async () => {
    const r = await alice.post('/api/login', { name: 'Alice', password: 'AlicePass1' });
    assert.equal(r.status, 200); assert.equal(r.json.user.mustChangePassword, true);
    assert.equal((await alice.post('/api/me/password', { currentPassword: 'wrong', newPassword: 'AlicePass2!' })).status, 400);
    assert.equal((await alice.post('/api/me/password', { currentPassword: 'AlicePass1', newPassword: 'short' })).status, 400);
    const ok = await alice.post('/api/me/password', { currentPassword: 'AlicePass1', newPassword: 'AlicePass2!' });
    assert.equal(ok.status, 200); assert.equal(ok.json.user.mustChangePassword, false);
    await bob.post('/api/login', { name: 'Bob', password: 'BobPass123' });
    // old password no longer works
    assert.equal((await new Client(base).post('/api/login', { name: 'Alice', password: 'AlicePass1' })).status, 401);
  });
  await t('employee cannot use admin endpoints', async () => {
    assert.equal((await alice.get('/api/users')).status, 403);
    assert.equal((await alice.post('/api/users', { name: 'Eve', password: 'EvePass123' })).status, 403);
    assert.equal((await alice.patch('/api/users/1', { status: 'disabled' })).status, 403);
  });
  await t('create reports: validation', async () => {
    assert.equal((await alice.post('/api/tasks', { date: '2026-10-01' })).status, 400);
    assert.equal((await alice.post('/api/tasks', { date: '2026-02-31', task: 'x' })).status, 400);
    assert.equal((await alice.post('/api/tasks', { date: 'bad', task: 'x' })).status, 400);
    assert.equal((await alice.post('/api/tasks', { date: '2026-10-01', task: 'x', status: 'Weird' })).status, 400);
    assert.equal((await alice.post('/api/tasks', { date: '2026-10-01', task: 'x'.repeat(201) })).status, 400);
  });
  await t('create reports (all statuses)', async () => {
    let r = await alice.post('/api/tasks', { date: '2026-10-05', task: 'Design landing page', description: 'Hero + pricing', status: 'Completed', remarks: 'ok' });
    assert.equal(r.status, 201); aliceTask = r.json.task; assert.equal(aliceTask.userName, 'Alice');
    await alice.post('/api/tasks', { date: '2026-10-05', task: 'API integration', status: 'In Progress' });
    await alice.post('/api/tasks', { date: '2026-10-06', task: 'Write docs', status: 'Pending' });
    await alice.post('/api/tasks', { date: '2026-10-06', task: 'Deploy', status: 'Blocked' });
    r = await bob.post('/api/tasks', { date: '2026-10-05', task: 'Bob task', status: 'Completed' }); bobTask = r.json.task;
    await bob.post('/api/tasks', { date: '2026-10-07', task: '=SUM(1+1)', status: 'Completed', remarks: 'He said "hi", ok' });
    r = await admin.post('/api/tasks', { date: '2026-10-05', task: 'Admin task', status: 'Completed' }); adminTask = r.json.task;
  });
  await t('shared team view: employees can read all reports and filter by employee', async () => {
    const r = await alice.get('/api/tasks'); assert.equal(r.json.tasks.length, 7);
    const f = await alice.get(`/api/tasks?userId=${bobTask.userId}`);
    assert.equal(f.json.tasks.length, 2); assert.ok(f.json.tasks.every(x => x.userName === 'Bob'));
    assert.equal((await alice.get('/api/tasks?date=2026-10-05')).json.tasks.length, 4);
  });
  await t('admin sees all and can filter by employee / date / status / search', async () => {
    assert.equal((await admin.get('/api/tasks')).json.tasks.length, 7);
    assert.equal((await admin.get(`/api/tasks?userId=${bobTask.userId}`)).json.tasks.length, 2);
    assert.equal((await admin.get('/api/tasks?date=2026-10-05')).json.tasks.length, 4);
    assert.equal((await admin.get('/api/tasks?from=2026-10-06&to=2026-10-07')).json.tasks.length, 3);
    assert.equal((await admin.get('/api/tasks?status=Blocked')).json.tasks.length, 1);
    assert.equal((await admin.get('/api/tasks?q=landing')).json.tasks.length, 1);
    assert.equal((await admin.get('/api/tasks?q=100%25')).json.tasks.length, 0);
    assert.equal((await admin.get('/api/tasks?from=2026-10-09&to=2026-10-01')).status, 400);
    assert.equal((await admin.get('/api/tasks?status=bogus')).status, 400);
  });
  await t('edit report: owner OK, others (even admin) forbidden, validation', async () => {
    let r = await alice.put(`/api/tasks/${aliceTask.id}`, { task: 'Design landing page v2', status: 'In Progress', date: '2026-10-05', description: 'changed', remarks: '' });
    assert.equal(r.status, 200); assert.equal(r.json.task.task, 'Design landing page v2'); assert.equal(r.json.task.status, 'In Progress');
    assert.equal((await alice.get(`/api/tasks?q=v2`)).json.tasks.length, 1);
    assert.equal((await bob.put(`/api/tasks/${aliceTask.id}`, { task: 'hijack' })).status, 403);
    assert.equal((await admin.put(`/api/tasks/${aliceTask.id}`, { task: 'hijack' })).status, 403);
    assert.equal((await alice.put(`/api/tasks/${aliceTask.id}`, { task: '   ' })).status, 400);
    assert.equal((await alice.put(`/api/tasks/${aliceTask.id}`, { status: 'Nope' })).status, 400);
    assert.equal((await alice.put('/api/tasks/99999', { task: 'x' })).status, 404);
    assert.equal((await alice.put('/api/tasks/abc', { task: 'x' })).status, 400);
    await alice.put(`/api/tasks/${aliceTask.id}`, { status: 'Completed', task: 'Design landing page' });
  });
  await t('delete report: owner OK, other employee forbidden, admin OK', async () => {
    assert.equal((await alice.del(`/api/tasks/${bobTask.id}`)).status, 403);
    assert.equal((await bob.del(`/api/tasks/${bobTask.id}`)).status, 200);
    assert.equal((await bob.del(`/api/tasks/${bobTask.id}`)).status, 404);
    const r = await alice.post('/api/tasks', { date: '2026-10-09', task: 'temp' });
    assert.equal((await admin.del(`/api/tasks/${r.json.task.id}`)).status, 200);
    assert.equal((await alice.get('/api/tasks?date=2026-10-09')).json.tasks.length, 0);
  });
  await t('stats: employee scope + admin scope', async () => {
    const e = await alice.get(`/api/stats?from=2026-10-01&to=2026-10-31&userId=${aliceTask.userId}`);
    assert.equal(e.json.totals.total, 4); assert.equal(e.json.totals.completed, 1);
    assert.equal(e.json.totals.inProgress, 1); assert.equal(e.json.totals.pending, 1); assert.equal(e.json.totals.blocked, 1);
    assert.equal(e.json.totals.pct, 25); assert.ok(!e.json.employees, 'admin-only fields hidden from employees');
    assert.equal((await alice.get('/api/stats')).json.totals.total, 6, 'team-wide by default');
    const a = await admin.get('/api/stats?today=2026-10-05');
    assert.equal(a.json.totals.total, 6); assert.equal(a.json.employees.total, 2); assert.equal(a.json.employees.active, 2);
    assert.equal(a.json.employees.reportedToday, 2); // Alice + Admin on 10-05 (Bob's was deleted)
    assert.ok(a.json.byEmployee.find(x => x.name === 'Alice').total === 4);
  });
  await t('calendar: counts per day, validation, scoping', async () => {
    const c = await alice.get(`/api/calendar?year=2026&month=10&userId=${aliceTask.userId}`);
    assert.equal(c.json.byDay['05'].total, 2); assert.equal(c.json.byDay['06'].total, 2);
    assert.equal(c.json.byDay['06'].completed, 0); assert.equal(c.json.byDay['05'].done, 1); assert.equal(c.json.summary.total, 4);
    assert.equal((await alice.get('/api/calendar?year=2026&month=10')).json.byDay['05'].total, 3, 'team-wide by default');
    const a = await admin.get('/api/calendar?year=2026&month=10');
    assert.equal(a.json.byDay['05'].total, 3); assert.equal(a.json.byDay['05'].employees, 2);
    assert.equal((await admin.get(`/api/calendar?year=2026&month=10&userId=${adminTask.userId}`)).json.byDay['05'].total, 1);
    assert.equal((await alice.get('/api/calendar?year=2026&month=13')).status, 400);
    assert.equal((await alice.get('/api/calendar?year=abc&month=1')).status, 400);
    assert.deepEqual((await alice.get('/api/calendar?year=2026&month=2')).json.byDay, {});
    assert.equal(Object.keys((await alice.get('/api/calendar?year=2026&month=12')).json.byDay).length, 0);
  });
  await t('performance: per-employee, date-wise, scoping, date filter', async () => {
    const a = await admin.get('/api/performance?from=2026-10-01&to=2026-10-31');
    const alicePerf = a.json.performance.find(x => x.name === 'Alice');
    assert.equal(alicePerf.total, 4); assert.equal(alicePerf.pct, 25); assert.equal(alicePerf.activeDays, 2); assert.equal(alicePerf.avgPerDay, 2);
    assert.equal(a.json.daily.length, 3);
    const e = await alice.get('/api/performance');
    assert.ok(e.json.performance.length >= 2); assert.equal(e.json.performance.find(x => x.name === 'Alice').done, 1);
    assert.equal((await alice.get(`/api/performance?userId=${aliceTask.userId}`)).json.performance.length, 1);
    assert.equal((await admin.get('/api/performance?from=2026-10-06&to=2026-10-06')).json.totals.total, 2);
  });
  await t('CSV export: scoped, filtered, escaped, formula-safe, validated', async () => {
    const e = await alice.get(`/api/export?from=2026-10-01&to=2026-10-31&userId=${aliceTask.userId}`);
    assert.equal(e.status, 200); assert.match(e.headers.get('content-type'), /text\/csv/);
    assert.match(e.headers.get('content-disposition'), /attachment; filename="eod-reports-2026-10-01_to_2026-10-31\.csv"/);
    const lines = e.text.replace('﻿', '').trim().split('\r\n');
    assert.equal(lines.length, 5); assert.ok(!e.text.includes('Admin task'));
    const a = await admin.get('/api/export?from=2026-10-07&to=2026-10-07');
    assert.ok(a.text.includes(`"'=SUM(1+1)"`), 'formula neutralised'); assert.ok(a.text.includes('"He said ""hi"", ok"'));
    assert.equal((await admin.get('/api/export?from=2026-10-07&to=2026-10-07')).text.trim().split('\r\n').length, 2);
    assert.equal((await admin.get('/api/export?from=nope')).status, 400);
    assert.equal((await admin.get('/api/export')).status, 200);
  });
  await t('admin guards: cannot disable/demote self or the last admin', async () => {
    const me = (await admin.get('/api/me')).json.user.id;
    assert.equal((await admin.patch(`/api/users/${me}`, { status: 'disabled' })).status, 400);
    assert.equal((await admin.patch(`/api/users/${me}`, { role: 'member' })).status, 400);
    assert.equal((await admin.patch(`/api/users/${me}`, { status: 'bogus' })).status, 400);
    assert.equal((await admin.patch('/api/users/9999', { status: 'active' })).status, 404);
  });
  await t('role promotion: second admin; last-admin protection holds', async () => {
    const bobId = (await admin.get('/api/users')).json.users.find(u => u.name === 'Bob').id;
    assert.equal((await admin.patch(`/api/users/${bobId}`, { role: 'admin' })).status, 200);
    const bob2 = new Client(base); await bob2.post('/api/login', { name: 'Bob', password: 'BobPass123' });
    assert.equal((await bob2.get('/api/users')).status, 200);
    // Bob (admin) disables Admin: allowed since Bob remains; then Admin (disabled) can't act
    const adminId = (await admin.get('/api/me')).json.user.id;
    assert.equal((await bob2.patch(`/api/users/${adminId}`, { status: 'disabled' })).status, 200);
    assert.equal((await admin.get('/api/tasks')).status, 401, 'disabled admin session killed immediately');
    assert.equal((await new Client(base).post('/api/login', { name: 'Admin', password: 'AdminPass123' })).status, 403);
    assert.equal((await bob2.patch(`/api/users/${adminId}`, { status: 'active' })).status, 200);
    assert.equal((await bob2.patch(`/api/users/${bobId}`, { role: 'member' })).status, 400); // self-demotion blocked
    assert.equal((await admin.patch(`/api/users/${bobId}`, { role: 'member' })).status, 401); // admin session was killed; re-login:
    await admin.post('/api/login', { name: 'Admin', password: 'AdminPass123' });
    assert.equal((await admin.patch(`/api/users/${bobId}`, { role: 'member' })).status, 200);
  });
  await t('disable employee: session killed at once, login blocked, reports kept; re-enable', async () => {
    const users = (await admin.get('/api/users')).json.users;
    const aliceId = users.find(u => u.name === 'Alice').id;
    assert.equal(users.find(u => u.name === 'Alice').reportCount, 4);
    assert.equal((await admin.patch(`/api/users/${aliceId}`, { status: 'disabled' })).status, 200);
    assert.equal((await alice.get('/api/tasks')).status, 401);
    assert.equal((await alice.post('/api/tasks', { date: '2026-10-01', task: 'x' })).status, 401);
    const l = await new Client(base).post('/api/login', { name: 'Alice', password: 'AlicePass2!' });
    assert.equal(l.status, 403); assert.match(l.json.error, /disabled/);
    assert.equal((await new Client(base).post('/api/login', { name: 'Alice', password: 'wrong' })).status, 401, 'no status leak without password');
    assert.equal((await admin.get(`/api/tasks?userId=${aliceId}`)).json.tasks.length, 4);
    assert.equal((await admin.patch(`/api/users/${aliceId}`, { status: 'active' })).status, 200);
    assert.equal((await alice.post('/api/login', { name: 'Alice', password: 'AlicePass2!' })).status, 200);
  });
  await t('admin password reset forces change at next login', async () => {
    const aliceId = (await admin.get('/api/users')).json.users.find(u => u.name === 'Alice').id;
    assert.equal((await admin.patch(`/api/users/${aliceId}`, { password: 'x' })).status, 400);
    assert.equal((await admin.patch(`/api/users/${aliceId}`, { password: 'ResetPass99' })).status, 200);
    const c = new Client(base);
    const r = await c.post('/api/login', { name: 'Alice', password: 'ResetPass99' });
    assert.equal(r.status, 200); assert.equal(r.json.user.mustChangePassword, true);
  });
  await t('logout destroys session', async () => {
    assert.equal((await alice.post('/api/logout')).status, 200);
    assert.equal((await alice.get('/api/tasks')).status, 401);
    assert.equal((await alice.get('/api/me')).json.user, null);
  });
  await t('login throttling after repeated failures', async () => {
    const c = new Client(base); let last;
    for (let i = 0; i < 10; i++) last = await c.post('/api/login', { name: 'Throttle', password: 'wrongpass' + i });
    assert.equal(last.status, 429);
  });
  await t('errors: malformed JSON, unknown API route, no stack leak', async () => {
    const res = await fetch(base + '/api/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{bad' });
    assert.equal(res.status, 400);
    const nf = await admin.get('/api/nope'); assert.equal(nf.status, 404);
    assert.ok(!/at .*\.js/.test(nf.text));
  });
  await t('ensureAdmin: recovers a disabled sole admin only with an explicit password', async () => {
    const users = await store.listUsers();
    for (const u of users) if (u.role === 'admin') await store.updateUser(u.id, { status: 'disabled' });
    assert.equal(await store.countActiveAdmins(), 0);
    assert.equal(await ensureAdmin(store, { name: 'Admin', log: silent }), 'warned');
    assert.equal(await store.countActiveAdmins(), 0, 'no silent re-enable');
    assert.equal(await ensureAdmin(store, { name: 'Admin', password: 'Recovered123', log: silent }), 'recovered');
    assert.equal(await store.countActiveAdmins(), 1);
    assert.equal((await new Client(base).post('/api/login', { name: 'Admin', password: 'Recovered123' })).status, 200);
  });
  await t('persistence: data survives a fresh store instance', async () => {
    const store2 = createStore(); await store2.init();
    assert.ok((await store2.listTasks()).length >= 5);
    assert.ok((await store2.findUserByName('alice')) !== null);
    if (store2 !== store) await store2.close();
  });

  server.close();
  await store.close();
  console.log(`\n${passed} tests passed` + (process.exitCode ? ' — WITH FAILURES' : ''));
})().catch(e => { console.error(e); process.exit(1); });
