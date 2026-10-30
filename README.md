# Digital Desk — EOD Report Management System

A company-level **End-of-Day report** application. Employees log what they completed, what is in progress,
pending or blocked; administrators get a live view of the whole team with calendar, performance analytics
and CSV export.

**Stack:** Node.js · Express · express-session · bcryptjs · vanilla HTML/CSS/JS · Chart.js ·
PostgreSQL (production) / JSON file (zero-setup local development)

## Features

The original dark-mode interface (top bar, tabs, cards, calendar) is unchanged; everything below was added inside it.

| Tab | What you get |
|---|---|
| **EOD LOG** | Shared team view for any date · log tasks with status, description and remarks · **edit** and remove your own tasks · "your tasks today" counters |
| **REPORTS** | Report history with from/to date, employee, status and text filters · pagination · edit/remove · CSV export |
| **CALENDAR** | Monthly calendar with `done/total to-dos` per day · month navigation · click a day to see (and edit) its tasks |
| **PERFORMANCE** | Employee-wise completion % cards · status breakdown and date-wise charts · date-range filter · CSV export |
| **ADMIN** | Totals (employees, reports, completed / in progress / pending / blocked) · employee-wise overview · create accounts · enable / disable · reset password · promote / demote |

**Visibility:** as in the original app the EOD log is shared — everyone can read the team's tasks, but only the
author can edit a task, and only the author or an admin can remove it.

**Security:** bcrypt hashing · sessions stored in PostgreSQL · `httpOnly`/`SameSite`/`Secure` cookies · helmet headers ·
login throttling · disabled accounts are signed out immediately · forced password change for the development default
and for admin-created / admin-reset passwords · last-admin and self-lockout protection · CSV formula-injection
protection · server-side validation and permission checks on every route.

## Run locally

Requires Node.js 18+.

```bash
npm install
npm start
```

Open <http://localhost:3000>.

* With no `DATABASE_URL`, data is stored in `data/db.json` (git-ignored, created automatically).
* On the very first start a development administrator is created:
  **name `Admin` / password `admin123`** — you will be forced to choose a new password at first login.
  To choose your own initial password instead: `ADMIN_PASSWORD='YourPassw0rd' npm start`.

### Locked out? (disabled / forgotten admin)

```bash
ADMIN_PASSWORD='NewStrongPassw0rd' npm run reset-admin
```

This creates the administrator or re-enables an existing/disabled one and sets the password.
(The app never re-enables a disabled admin silently; it only logs a warning at startup.)

### Run against PostgreSQL locally

```bash
export DATABASE_URL=postgres://user:password@localhost:5432/eod
ADMIN_PASSWORD='YourPassw0rd' npm start     # tables are created automatically
```

### Tests

```bash
npm test                                                     # 27 API tests against the JSON backend
TEST_DATABASE_URL=postgres://... npm test                    # same suite against PostgreSQL (WIPES that database - use a scratch DB)
```

## Deploy on Render (PostgreSQL)

The repo contains a `render.yaml` Blueprint.

1. Push this repository to GitHub (already done if you are reading this there).
2. In Render: **New → Blueprint** → choose the repository → **Apply**.
3. When prompted, enter **`ADMIN_PASSWORD`** (min. 8 characters). `SESSION_SECRET` is generated automatically and
   `DATABASE_URL` is wired to the new `eod-db` database.
4. Wait for the deploy, open the service URL and sign in as **`Admin`** with the password you entered.
5. Create employee accounts from **Employees**. Each employee must set their own password at first login.

Manual setup (instead of the Blueprint): create a PostgreSQL database and a Node **Web Service**
(build `npm ci`, start `npm start`, health check path `/healthz`) and set the environment variables below.

| Variable | Required | Purpose |
|---|---|---|
| `NODE_ENV` | yes (`production`) | secure cookies, proxy trust, strict startup checks |
| `DATABASE_URL` | yes | PostgreSQL connection string (use Render's *Internal* URL) |
| `SESSION_SECRET` | yes | long random string used to sign session cookies |
| `ADMIN_PASSWORD` | first deploy | password for the first administrator (min 8 chars) |
| `ADMIN_NAME` | no | administrator login name (default `Admin`) |
| `DATABASE_SSL` | no | `true` if connecting to a database that requires SSL from outside Render |
| `COOKIE_SECURE` | no | override the secure-cookie default (`true` in production) |

No secrets are stored in the repository. Render's free PostgreSQL tier is time-limited — use a paid database
plan if the data must be kept long-term. The free web service sleeps when idle (first request after a pause is slow).

## Project structure

```
server.js            Express app: auth, users, reports, stats, calendar, performance, export
lib/db.js            Storage layer: PostgresStore + JsonStore behind one async interface
lib/admin.js         Safe first-admin creation / recovery
scripts/reset-admin.js   CLI: create / re-enable the administrator
scripts/smoke-test.js    End-to-end API test suite (npm test)
public/              Original frontend (index.html, style.css, app.js) — Chart.js is served from node_modules
render.yaml          Render Blueprint (web service + PostgreSQL)
```

## API overview

All routes except `/api/login`, `/api/me` and `/healthz` require a session.

`POST /api/login` · `POST /api/logout` · `GET /api/me` · `POST /api/me/password` ·
`GET|POST /api/users` · `PATCH /api/users/:id` (admin) ·
`GET|POST /api/tasks` · `PUT|DELETE /api/tasks/:id` ·
`GET /api/stats` · `GET /api/calendar?year&month` · `GET /api/performance` · `GET /api/export` ·
list endpoints accept `from`, `to`, `status`, `q` and (admin only) `userId`.
