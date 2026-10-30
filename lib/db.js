// Storage layer. Two interchangeable backends behind one async interface:
//   - PostgresStore : used when DATABASE_URL is set (production / Render)
//   - JsonStore     : zero-setup local development (data/db.json, same file format as before)
const fs = require('fs');
const path = require('path');

const MAX_ROWS = 20000;

// ---------------------------------------------------------------- JSON store
class JsonStore {
  constructor(file) {
    this.kind = 'json';
    this.file = file || path.join(__dirname, '..', 'data', 'db.json');
  }

  async init() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    if (!fs.existsSync(this.file)) this._save({ users: [], tasks: [], nextUserId: 1, nextTaskId: 1 });
  }

  // The file is re-read on every operation so that CLI scripts (reset-admin)
  // running next to the server never see/leave stale data.
  _load() {
    const db = JSON.parse(fs.readFileSync(this.file, 'utf-8'));
    db.users = db.users || [];
    db.tasks = db.tasks || [];
    db.nextUserId = db.nextUserId || Math.max(0, ...db.users.map(u => u.id)) + 1;
    db.nextTaskId = db.nextTaskId || Math.max(0, ...db.tasks.map(t => t.id)) + 1;
    return db;
  }

  // Atomic write: write a temp file, then rename over the original.
  _save(db) {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
    fs.renameSync(tmp, this.file);
  }

  _user(u) {
    if (!u) return null;
    return {
      id: u.id, name: u.name, passwordHash: u.passwordHash, role: u.role,
      status: u.status, mustChangePassword: !!u.mustChangePassword, createdAt: u.createdAt || null
    };
  }

  async listUsers() { return this._load().users.map(u => this._user(u)); }
  async getUser(id) { return this._user(this._load().users.find(u => u.id === id)); }
  async findUserByName(name) {
    const n = String(name || '').toLowerCase();
    return this._user(this._load().users.find(u => u.name.toLowerCase() === n));
  }
  async countActiveAdmins() {
    return this._load().users.filter(u => u.role === 'admin' && u.status === 'active').length;
  }
  async createUser({ name, passwordHash, role, status = 'active', mustChangePassword = false }) {
    const db = this._load();
    const u = { id: db.nextUserId++, name, passwordHash, role, status, mustChangePassword, createdAt: new Date().toISOString() };
    db.users.push(u);
    this._save(db);
    return this._user(u);
  }
  async updateUser(id, patch) {
    const db = this._load();
    const u = db.users.find(x => x.id === id);
    if (!u) return null;
    Object.assign(u, patch);
    this._save(db);
    return this._user(u);
  }

  _task(t, users) {
    const owner = users.find(u => u.id === t.userId);
    return {
      id: t.id, userId: t.userId, userName: owner ? owner.name : (t.userName || 'Unknown'),
      date: t.date, task: t.task, description: t.description || '', status: t.status,
      remarks: t.remarks || '', createdAt: t.createdAt || null, updatedAt: t.updatedAt || t.createdAt || null
    };
  }

  async listTasks({ userId, date, from, to, status, q } = {}) {
    const db = this._load();
    const needle = q ? q.toLowerCase() : null;
    return db.tasks
      .filter(t => (!userId || t.userId === userId) &&
        (!date || t.date === date) &&
        (!from || t.date >= from) &&
        (!to || t.date <= to) &&
        (!status || t.status === status) &&
        (!needle || `${t.task} ${t.description || ''} ${t.remarks || ''}`.toLowerCase().includes(needle)))
      .sort((a, b) => b.date.localeCompare(a.date) || b.id - a.id)
      .slice(0, MAX_ROWS)
      .map(t => this._task(t, db.users));
  }
  async getTask(id) {
    const db = this._load();
    const t = db.tasks.find(x => x.id === id);
    return t ? this._task(t, db.users) : null;
  }
  async createTask({ userId, date, task, description, status, remarks }) {
    const db = this._load();
    const now = new Date().toISOString();
    const t = { id: db.nextTaskId++, userId, date, task, description, status, remarks, createdAt: now, updatedAt: now };
    db.tasks.push(t);
    this._save(db);
    return this._task(t, db.users);
  }
  async updateTask(id, patch) {
    const db = this._load();
    const t = db.tasks.find(x => x.id === id);
    if (!t) return null;
    Object.assign(t, patch, { updatedAt: new Date().toISOString() });
    this._save(db);
    return this._task(t, db.users);
  }
  async deleteTask(id) {
    const db = this._load();
    const i = db.tasks.findIndex(x => x.id === id);
    if (i === -1) return false;
    db.tasks.splice(i, 1);
    this._save(db);
    return true;
  }

  sessionStore() { return null; } // express-session MemoryStore (dev only)
  async close() {}
}

// ---------------------------------------------------------- PostgreSQL store
class PostgresStore {
  constructor(connectionString, { ssl = false } = {}) {
    const { Pool, types } = require('pg');
    types.setTypeParser(1082, v => v); // DATE -> 'YYYY-MM-DD' string (no timezone shifting)
    this.kind = 'postgres';
    this.pool = new Pool({ connectionString, ssl: ssl ? { rejectUnauthorized: false } : false, max: 10 });
  }

  async init() {
    await this.pool.query(`
      CREATE TABLE IF NOT EXISTS users (
        id SERIAL PRIMARY KEY,
        name TEXT NOT NULL,
        password_hash TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('admin','member')),
        status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
        must_change_password BOOLEAN NOT NULL DEFAULT FALSE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE UNIQUE INDEX IF NOT EXISTS users_name_lower_idx ON users (LOWER(name));
      CREATE TABLE IF NOT EXISTS tasks (
        id SERIAL PRIMARY KEY,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        date DATE NOT NULL,
        task TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'Completed',
        remarks TEXT NOT NULL DEFAULT '',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS tasks_date_idx ON tasks (date);
      CREATE INDEX IF NOT EXISTS tasks_user_date_idx ON tasks (user_id, date);
    `);
  }

  _user(r) {
    if (!r) return null;
    return {
      id: r.id, name: r.name, passwordHash: r.password_hash, role: r.role, status: r.status,
      mustChangePassword: r.must_change_password, createdAt: r.created_at && r.created_at.toISOString()
    };
  }
  _task(r) {
    return {
      id: r.id, userId: r.user_id, userName: r.user_name, date: r.date, task: r.task,
      description: r.description, status: r.status, remarks: r.remarks,
      createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString()
    };
  }

  async listUsers() {
    return (await this.pool.query('SELECT * FROM users ORDER BY id')).rows.map(r => this._user(r));
  }
  async getUser(id) {
    return this._user((await this.pool.query('SELECT * FROM users WHERE id=$1', [id])).rows[0]);
  }
  async findUserByName(name) {
    return this._user((await this.pool.query('SELECT * FROM users WHERE LOWER(name)=LOWER($1)', [String(name || '')])).rows[0]);
  }
  async countActiveAdmins() {
    const r = await this.pool.query("SELECT COUNT(*)::int AS n FROM users WHERE role='admin' AND status='active'");
    return r.rows[0].n;
  }
  async createUser({ name, passwordHash, role, status = 'active', mustChangePassword = false }) {
    const r = await this.pool.query(
      'INSERT INTO users (name, password_hash, role, status, must_change_password) VALUES ($1,$2,$3,$4,$5) RETURNING *',
      [name, passwordHash, role, status, mustChangePassword]);
    return this._user(r.rows[0]);
  }
  async updateUser(id, patch) {
    const cols = { name: 'name', passwordHash: 'password_hash', role: 'role', status: 'status', mustChangePassword: 'must_change_password' };
    const sets = [], vals = [];
    for (const [k, col] of Object.entries(cols)) {
      if (k in patch) { vals.push(patch[k]); sets.push(`${col}=$${vals.length}`); }
    }
    if (!sets.length) return this.getUser(id);
    vals.push(id);
    const r = await this.pool.query(`UPDATE users SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING *`, vals);
    return this._user(r.rows[0]);
  }

  _taskSelect(where) {
    return `SELECT t.*, u.name AS user_name FROM tasks t JOIN users u ON u.id = t.user_id ${where}`;
  }
  async listTasks({ userId, date, from, to, status, q } = {}) {
    const cond = [], vals = [];
    const add = (sql, v) => { vals.push(v); cond.push(sql.replace('?', '$' + vals.length)); };
    if (userId) add('t.user_id = ?', userId);
    if (date) add('t.date = ?', date);
    if (from) add('t.date >= ?', from);
    if (to) add('t.date <= ?', to);
    if (status) add('t.status = ?', status);
    if (q) add("(t.task || ' ' || t.description || ' ' || t.remarks) ILIKE ?", '%' + q.replace(/[\\%_]/g, '\\$&') + '%');
    const sql = this._taskSelect(cond.length ? 'WHERE ' + cond.join(' AND ') : '') +
      ` ORDER BY t.date DESC, t.id DESC LIMIT ${MAX_ROWS}`;
    return (await this.pool.query(sql, vals)).rows.map(r => this._task(r));
  }
  async getTask(id) {
    const r = await this.pool.query(this._taskSelect('WHERE t.id=$1'), [id]);
    return r.rows[0] ? this._task(r.rows[0]) : null;
  }
  async createTask({ userId, date, task, description, status, remarks }) {
    const r = await this.pool.query(
      'INSERT INTO tasks (user_id, date, task, description, status, remarks) VALUES ($1,$2,$3,$4,$5,$6) RETURNING id',
      [userId, date, task, description, status, remarks]);
    return this.getTask(r.rows[0].id);
  }
  async updateTask(id, patch) {
    const sets = ['updated_at = NOW()'], vals = [];
    for (const k of ['date', 'task', 'description', 'status', 'remarks']) {
      if (k in patch) { vals.push(patch[k]); sets.push(`${k}=$${vals.length}`); }
    }
    vals.push(id);
    const r = await this.pool.query(`UPDATE tasks SET ${sets.join(',')} WHERE id=$${vals.length} RETURNING id`, vals);
    return r.rows[0] ? this.getTask(id) : null;
  }
  async deleteTask(id) {
    return (await this.pool.query('DELETE FROM tasks WHERE id=$1', [id])).rowCount > 0;
  }

  sessionStore(session) {
    const PgStore = require('connect-pg-simple')(session);
    return new PgStore({ pool: this.pool, tableName: 'session', createTableIfMissing: true });
  }
  async close() { await this.pool.end(); }
}

function createStore() {
  if (process.env.DATABASE_URL) {
    return new PostgresStore(process.env.DATABASE_URL, { ssl: process.env.DATABASE_SSL === 'true' });
  }
  return new JsonStore(process.env.JSON_DB_PATH);
}

module.exports = { createStore, JsonStore, PostgresStore };
