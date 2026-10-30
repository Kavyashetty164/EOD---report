const express = require('express');
const session = require('express-session');
const helmet = require('helmet');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const path = require('path');

const { createStore } = require('./lib/db');
const { ensureAdmin } = require('./lib/admin');

const PORT = process.env.PORT || 3000;
const isProd = process.env.NODE_ENV === 'production';

const STATUSES = ['Completed', 'In Progress', 'Pending', 'Blocked'];
const LIMITS = { task: 200, description: 2000, remarks: 1000 };

// ---------------------------------------------------------------- helpers
const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const str = v => (typeof v === 'string' ? v : '');
const httpError = (status, message) => Object.assign(new Error(message), { status });

function isValidDate(s) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const d = new Date(s + 'T00:00:00Z');
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}
// Optional date query param: '' -> undefined, invalid -> 400
function dateParam(v, label) {
  const s = str(v).trim();
  if (!s) return undefined;
  if (!isValidDate(s)) throw httpError(400, `Invalid ${label} date (use YYYY-MM-DD)`);
  return s;
}
function dateRange(q) {
  const from = dateParam(q.from, 'from');
  const to = dateParam(q.to, 'to');
  if (from && to && from > to) throw httpError(400, '"From" date must not be after "To" date');
  return { from, to };
}
function statusParam(v) {
  const s = str(v).trim();
  if (!s) return undefined;
  if (!STATUSES.includes(s)) throw httpError(400, 'Invalid status');
  return s;
}
function idParam(v) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1) throw httpError(400, 'Invalid id');
  return n;
}

function publicUser(u) {
  return { id: u.id, name: u.name, role: u.role, status: u.status, mustChangePassword: !!u.mustChangePassword };
}

function validateTaskBody(body, { partial = false } = {}) {
  const out = {};
  if (!partial || 'date' in body) {
    const date = str(body.date).trim();
    if (!isValidDate(date)) throw httpError(400, 'A valid date is required');
    out.date = date;
  }
  if (!partial || 'task' in body) {
    const task = str(body.task).trim();
    if (!task) throw httpError(400, 'Task title is required');
    if (task.length > LIMITS.task) throw httpError(400, `Task title must be at most ${LIMITS.task} characters`);
    out.task = task;
  }
  if (!partial || 'status' in body) {
    const status = str(body.status).trim() || 'Completed';
    if (!STATUSES.includes(status)) throw httpError(400, 'Invalid status');
    out.status = status;
  }
  for (const k of ['description', 'remarks']) {
    if (!partial || k in body) {
      const v = str(body[k]).trim();
      if (v.length > LIMITS[k]) throw httpError(400, `${k[0].toUpperCase() + k.slice(1)} must be at most ${LIMITS[k]} characters`);
      out[k] = v;
    }
  }
  return out;
}

function countByStatus(tasks) {
  const c = { total: tasks.length, completed: 0, inProgress: 0, pending: 0, blocked: 0 };
  for (const t of tasks) {
    if (t.status === 'Completed') c.completed++;
    else if (t.status === 'In Progress') c.inProgress++;
    else if (t.status === 'Pending') c.pending++;
    else if (t.status === 'Blocked') c.blocked++;
  }
  c.done = c.completed; // original frontend field name
  c.pct = c.total ? Math.round((c.completed / c.total) * 100) : 0;
  return c;
}

function dailySeries(tasks) {
  const byDate = {};
  for (const t of tasks) (byDate[t.date] = byDate[t.date] || []).push(t);
  return Object.keys(byDate).sort().map(date => ({ date, ...countByStatus(byDate[date]) }));
}

// ------------------------------------------------------- login throttling
const attempts = new Map(); // key -> { n, until }
const MAX_ATTEMPTS = 8, WINDOW_MS = 15 * 60 * 1000;
function throttleKey(req, name) { return `${req.ip}|${name.toLowerCase()}`; }
function isThrottled(key) {
  const a = attempts.get(key);
  if (!a) return false;
  if (a.until < Date.now()) { attempts.delete(key); return false; }
  return a.n >= MAX_ATTEMPTS;
}
function recordFailure(key) {
  const a = attempts.get(key) || { n: 0, until: Date.now() + WINDOW_MS };
  a.n++;
  attempts.set(key, a);
}

// ---------------------------------------------------------------- app
async function createApp(store) {
  const app = express();
  const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(8).toString('hex'), 10);

  let secret = process.env.SESSION_SECRET;
  if (!secret) {
    if (isProd) throw new Error('SESSION_SECRET environment variable is required in production.');
    secret = crypto.randomBytes(32).toString('hex'); // dev: random per process
    console.warn('[setup] SESSION_SECRET not set - using a temporary secret (sessions reset on restart).');
  }

  if (isProd) app.set('trust proxy', 1); // Render terminates TLS in front of the app
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: { directives: { ...helmet.contentSecurityPolicy.getDefaultDirectives(), 'upgrade-insecure-requests': null } }
  }));
  app.use(express.json({ limit: '100kb' }));

  app.use(session({
    store: store.sessionStore(session) || undefined,
    name: 'eod.sid',
    secret,
    resave: false,
    saveUninitialized: false,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: process.env.COOKIE_SECURE ? process.env.COOKIE_SECURE === 'true' : isProd,
      maxAge: 1000 * 60 * 60 * 12 // 12h
    }
  }));

  app.get('/vendor/chart.js', (req, res) =>
    res.sendFile(path.join(__dirname, 'node_modules', 'chart.js', 'dist', 'chart.umd.js'), { maxAge: '7d' }));
  app.use(express.static(path.join(__dirname, 'public')));

  app.get('/healthz', wrap(async (req, res) => {
    await store.countActiveAdmins(); // proves the database is reachable
    res.json({ ok: true, storage: store.kind });
  }));

  // -------- auth middleware: always re-reads the user so disabling takes effect immediately
  const requireAuth = wrap(async (req, res, next) => {
    if (!req.session.userId) throw httpError(401, 'Not logged in');
    const user = await store.getUser(req.session.userId);
    if (!user || user.status !== 'active') {
      await new Promise(r => req.session.destroy(r));
      throw httpError(401, 'Your session has ended or the account is disabled');
    }
    req.user = user;
    next();
  });
  const requireAdmin = (req, res, next) => {
    if (req.user.role !== 'admin') return next(httpError(403, 'Administrator access required'));
    next();
  };
  const isAdmin = req => req.user.role === 'admin';

  // Original behaviour: the EOD log is a shared team view, so everyone can read team data.
  // Editing/deleting is still restricted per report (see the task routes).
  const scopeUserId = req => {
    const raw = str(req.query.userId).trim();
    return raw ? idParam(raw) : undefined;
  };

  // ------------------------------------------------------------ auth routes
  app.post('/api/login', wrap(async (req, res) => {
    const name = str(req.body.name).trim();
    const password = str(req.body.password);
    if (!name || !password) throw httpError(400, 'Name and password are required');
    const key = throttleKey(req, name);
    if (isThrottled(key)) throw httpError(429, 'Too many failed attempts. Please try again in a few minutes.');

    const user = await store.findUserByName(name);
    const ok = bcrypt.compareSync(password, user ? user.passwordHash : DUMMY_HASH);
    if (!user || !ok) {
      recordFailure(key);
      throw httpError(401, 'Invalid name or password');
    }
    if (user.status !== 'active') throw httpError(403, 'This account has been disabled. Contact your administrator.');

    attempts.delete(key);
    await new Promise((resolve, reject) => req.session.regenerate(e => (e ? reject(e) : resolve())));
    req.session.userId = user.id;
    res.json({ user: publicUser(user) });
  }));

  app.post('/api/logout', (req, res) => {
    req.session.destroy(() => {
      res.clearCookie('eod.sid');
      res.json({ ok: true });
    });
  });

  app.get('/api/me', wrap(async (req, res) => {
    if (!req.session.userId) return res.json({ user: null });
    const user = await store.getUser(req.session.userId);
    if (!user || user.status !== 'active') return res.json({ user: null });
    res.json({ user: publicUser(user) });
  }));

  app.post('/api/me/password', requireAuth, wrap(async (req, res) => {
    const current = str(req.body.currentPassword);
    const next = str(req.body.newPassword);
    if (!bcrypt.compareSync(current, req.user.passwordHash)) throw httpError(400, 'Current password is incorrect');
    if (next.length < 8) throw httpError(400, 'New password must be at least 8 characters');
    if (next === current) throw httpError(400, 'New password must be different from the current one');
    const user = await store.updateUser(req.user.id, { passwordHash: bcrypt.hashSync(next, 10), mustChangePassword: false });
    res.json({ user: publicUser(user) });
  }));

  app.get('/api/team', requireAuth, wrap(async (req, res) => {
    const users = await store.listUsers();
    res.json({ users: users.map(u => ({ id: u.id, name: u.name, status: u.status })) });
  }));

  // ------------------------------------------------------- users (admin)
  app.get('/api/users', requireAuth, requireAdmin, wrap(async (req, res) => {
    const [users, tasks] = await Promise.all([store.listUsers(), store.listTasks()]);
    const counts = {};
    for (const t of tasks) counts[t.userId] = (counts[t.userId] || 0) + 1;
    res.json({ users: users.map(u => ({ ...publicUser(u), createdAt: u.createdAt, reportCount: counts[u.id] || 0 })) });
  }));

  app.post('/api/users', requireAuth, requireAdmin, wrap(async (req, res) => {
    const name = str(req.body.name).trim();
    const password = str(req.body.password);
    const role = req.body.role === 'admin' ? 'admin' : 'member';
    if (name.length < 2 || name.length > 50) throw httpError(400, 'Name must be 2-50 characters');
    if (password.length < 8) throw httpError(400, 'Password must be at least 8 characters');
    if (await store.findUserByName(name)) throw httpError(409, 'A user with that name already exists');
    const user = await store.createUser({ name, passwordHash: bcrypt.hashSync(password, 10), role, status: 'active', mustChangePassword: true });
    res.status(201).json({ user: publicUser(user) });
  }));

  app.patch('/api/users/:id', requireAuth, requireAdmin, wrap(async (req, res) => {
    const id = idParam(req.params.id);
    const target = await store.getUser(id);
    if (!target) throw httpError(404, 'User not found');
    const patch = {};
    const body = req.body || {};

    if ('status' in body) {
      if (!['active', 'disabled'].includes(body.status)) throw httpError(400, 'Invalid status');
      patch.status = body.status;
    }
    if ('role' in body) {
      if (!['admin', 'member'].includes(body.role)) throw httpError(400, 'Invalid role');
      patch.role = body.role;
    }
    if ('password' in body) {
      const pw = str(body.password);
      if (pw.length < 8) throw httpError(400, 'Password must be at least 8 characters');
      patch.passwordHash = bcrypt.hashSync(pw, 10);
      patch.mustChangePassword = id !== req.user.id;
    }
    // Lock-out protection: you cannot disable/demote yourself.
    if (id === req.user.id && (patch.status === 'disabled' || patch.role === 'member')) {
      throw httpError(400, 'You cannot disable or demote your own account');
    }
    const willStopBeingActiveAdmin = target.role === 'admin' && target.status === 'active' &&
      (patch.status === 'disabled' || patch.role === 'member');
    if (willStopBeingActiveAdmin && (await store.countActiveAdmins()) <= 1) {
      throw httpError(400, 'At least one active administrator is required');
    }
    const user = await store.updateUser(id, patch);
    res.json({ user: publicUser(user) });
  }));

  // ------------------------------------------------------- reports (tasks)
  function filtersFrom(req) {
    const { from, to } = dateRange(req.query);
    return {
      userId: scopeUserId(req),
      date: dateParam(req.query.date, 'date'),
      from, to,
      status: statusParam(req.query.status),
      q: str(req.query.q).trim().slice(0, 100) || undefined
    };
  }

  app.get('/api/tasks', requireAuth, wrap(async (req, res) => {
    res.json({ tasks: await store.listTasks(filtersFrom(req)) });
  }));

  app.post('/api/tasks', requireAuth, wrap(async (req, res) => {
    const data = validateTaskBody(req.body);
    const task = await store.createTask({ userId: req.user.id, ...data });
    res.status(201).json({ task });
  }));

  app.put('/api/tasks/:id', requireAuth, wrap(async (req, res) => {
    const id = idParam(req.params.id);
    const existing = await store.getTask(id);
    if (!existing) throw httpError(404, 'Report not found');
    if (existing.userId !== req.user.id) throw httpError(403, 'You can only edit your own reports');
    const task = await store.updateTask(id, validateTaskBody(req.body, { partial: true }));
    res.json({ task });
  }));

  app.delete('/api/tasks/:id', requireAuth, wrap(async (req, res) => {
    const id = idParam(req.params.id);
    const existing = await store.getTask(id);
    if (!existing) throw httpError(404, 'Report not found');
    if (existing.userId !== req.user.id && !isAdmin(req)) throw httpError(403, 'You can only delete your own reports');
    await store.deleteTask(id);
    res.json({ ok: true });
  }));

  // ------------------------------------------------------------- stats
  // Dashboard numbers for the selected range (employee: own data, admin: everyone or one employee)
  app.get('/api/stats', requireAuth, wrap(async (req, res) => {
    const f = filtersFrom(req);
    const tasks = await store.listTasks({ userId: f.userId, from: f.from, to: f.to });
    const out = {
      totals: countByStatus(tasks),
      daily: dailySeries(tasks),
      recent: tasks.slice(0, 8)
    };
    if (isAdmin(req)) {
      const users = await store.listUsers();
      const employees = users.filter(u => u.role === 'member');
      const today = str(req.query.today);
      out.employees = {
        total: employees.length,
        active: employees.filter(u => u.status === 'active').length,
        reportedToday: isValidDate(today) ? new Set(tasks.filter(t => t.date === today).map(t => t.userId)).size : null
      };
      out.byEmployee = users
        .map(u => ({ id: u.id, name: u.name, role: u.role, status: u.status, ...countByStatus(tasks.filter(t => t.userId === u.id)) }))
        .filter(r => r.status === 'active' || r.total > 0)
        .sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
    }
    res.json(out);
  }));

  // ---------------------------------------------------------- calendar
  app.get('/api/calendar', requireAuth, wrap(async (req, res) => {
    const year = Number(req.query.year), month = Number(req.query.month);
    if (!Number.isInteger(year) || year < 2000 || year > 2100 || !Number.isInteger(month) || month < 1 || month > 12) {
      throw httpError(400, 'Invalid year or month');
    }
    const mm = String(month).padStart(2, '0');
    const last = new Date(Date.UTC(year, month, 0)).getUTCDate();
    const tasks = await store.listTasks({ userId: scopeUserId(req), from: `${year}-${mm}-01`, to: `${year}-${mm}-${String(last).padStart(2, '0')}` });
    const byDay = {};
    const users = {};
    for (const t of tasks) {
      const day = t.date.slice(8, 10);
      (byDay[day] = byDay[day] || []).push(t);
      (users[day] = users[day] || new Set()).add(t.userId);
    }
    const out = {};
    for (const day of Object.keys(byDay)) out[day] = { ...countByStatus(byDay[day]), employees: users[day].size };
    res.json({ byDay: out, summary: countByStatus(tasks) });
  }));

  // ------------------------------------------------------- performance
  app.get('/api/performance', requireAuth, wrap(async (req, res) => {
    const f = filtersFrom(req);
    const tasks = await store.listTasks({ userId: f.userId, from: f.from, to: f.to });
    const users = await store.listUsers();
    const rows = users
      .filter(u => !f.userId || u.id === f.userId)
      .map(u => {
        const mine = tasks.filter(t => t.userId === u.id);
        const days = new Set(mine.map(t => t.date)).size;
        const c = countByStatus(mine);
        return {
          id: u.id, name: u.name, status: u.status, role: u.role, ...c,
          activeDays: days, avgPerDay: days ? Math.round((c.total / days) * 10) / 10 : 0
        };
      })
      .filter(r => r.status === 'active' || r.total > 0)
      .sort((a, b) => b.completed - a.completed || b.pct - a.pct || a.name.localeCompare(b.name));
    res.json({ performance: rows, totals: countByStatus(tasks), daily: dailySeries(tasks) });
  }));

  // -------------------------------------------------------- CSV export
  const csvCell = v => {
    let s = String(v ?? '');
    if (/^[=+\-@\t\r]/.test(s)) s = "'" + s; // neutralise spreadsheet formula injection
    return `"${s.replace(/"/g, '""')}"`;
  };
  app.get('/api/export', requireAuth, wrap(async (req, res) => {
    const tasks = (await store.listTasks(filtersFrom(req)))
      .sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);
    const header = ['ID', 'Date', 'Employee', 'Task', 'Description', 'Status', 'Remarks', 'Created At'];
    const rows = tasks.map(t => [t.id, t.date, t.userName, t.task, t.description, t.status, t.remarks, t.createdAt].map(csvCell).join(','));
    const csv = '﻿' + [header.map(csvCell).join(','), ...rows].join('\r\n');
    const f = filtersFrom(req);
    const safe = s => (s || 'all').replace(/[^0-9a-z-]/gi, '');
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="eod-reports-${safe(f.from)}_to_${safe(f.to)}.csv"`);
    res.send(csv);
  }));

  // ------------------------------------------------------------ fallbacks
  app.all('/api/*', (req, res) => res.status(404).json({ error: 'Not found' }));
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') err = httpError(400, 'Malformed JSON body');
    const status = err.status || 500;
    if (status >= 500) console.error(err);
    res.status(status).json({ error: status >= 500 ? 'Internal server error' : err.message });
  });

  return app;
}

async function main() {
  const store = createStore();
  await store.init();
  await ensureAdmin(store, {
    name: process.env.ADMIN_NAME || 'Admin',
    password: process.env.ADMIN_PASSWORD,
    production: isProd
  });
  const app = await createApp(store);
  const server = app.listen(PORT, () => {
    console.log(`EOD Report app running on port ${PORT} (storage: ${store.kind}${isProd ? ', production' : ''})`);
    if (store.kind === 'json' && isProd) {
      console.warn('[setup] WARNING: using the JSON file database in production - data is lost on redeploy. Set DATABASE_URL (PostgreSQL).');
    }
  });
  const shutdown = () => server.close(() => store.close().then(() => process.exit(0)));
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch(e => { console.error(e.message); process.exit(1); });
}

module.exports = { createApp };
