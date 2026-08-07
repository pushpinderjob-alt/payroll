# Payroll & Attendance — TKSR Product Services

Attendance + payroll app for a small business. Employees log in, clock in/out, and admins manage accounts and salary.

## Architecture

- **Frontend** (static) — hosted on **GitHub Pages** at `payroll.tksrproductservices.com`
- **Backend** — **Cloudflare Worker** (API) + **Cloudflare D1** (SQLite database)
- **Auth** — email + password. JWT sessions. Password hashing via PBKDF2 (Web Crypto).
- **Roles**
  - **Admin** — first account created is the admin. Manages employees, marks leave/absence, corrects clock times, views monthly reports, exports CSV, configures settings.
  - **Employee** — logs in with an admin-created account, clocks in/out, sees own attendance and salary.

## Repository layout

```
index.html          Frontend (login + role-based app)
styles.css          Styling
app.js              Frontend logic (calls the Worker API)
CNAME               Binds GitHub Pages to payroll.tksrproductservices.com
worker/
  wrangler.toml     Cloudflare Worker config (edit database_id)
  schema.sql        D1 database schema
  src/index.js      Cloudflare Worker API
```

## 1. Deploy the frontend (GitHub Pages) — already done

Repo: `https://github.com/pushpinderjob-alt/payroll` — public, main branch, Actions-based Pages deployment.

## 2. Deploy the backend (Cloudflare Worker)

Requires a free Cloudflare account.

```powershell
cd worker
npm i -g wrangler            # or: npx wrangler
wrangler login               # opens browser to authenticate your Cloudflare account
wrangler d1 create tksr-payroll     # note the printed database_id
```

Edit `worker/wrangler.toml`: replace `database_id = "REPLACE_WITH_DATABASE_ID"`.

```powershell
wrangler d1 execute tksr-payroll --remote --file=schema.sql   # create tables
wrangler secret put JWT_SECRET                                # any long random string
wrangler deploy                                               # deploy the API
```

The API URL will look like `https://tksr-payroll-api.<subdomain>.workers.dev`.

## 3. Point the frontend at the API

In `app.js`, set `API_BASE` to your worker URL:

```js
var API_BASE = "https://tksr-payroll-api.xxxxx.workers.dev";
```

Commit and push to `main` — GitHub Actions redeploys automatically.

## 4. First run

1. Open `https://payroll.tksrproductservices.com`
2. Click **Create Account** — the first account automatically becomes **Admin**.
3. Sign in, go to **Employees**, add employees with their email + a temporary password (give it to them).
4. Employees sign in and use **Clock In / Clock Out**.
5. Admin uses **Attendance** (mark leave/absence, correct times) and **Reports** (monthly summary + CSV).

## API summary

| Method | Path | Access | Purpose |
|--------|------|--------|---------|
| POST | `/api/auth/signup` | public (first user) / admin | Create admin (bootstrap) or employee |
| POST | `/api/auth/login` | public | Login -> JWT + user |
| GET | `/api/me` | any | Current user |
| GET | `/api/me/status?date=` | employee | Today's record |
| GET | `/api/me/attendance?month=` | employee | Own month records |
| POST | `/api/clock/in` | employee | Clock in (`{date, time}`) |
| POST | `/api/clock/out` | employee | Clock out (`{date, time}`) |
| GET | `/api/users` | admin | List users |
| POST | `/api/users` | admin | Create user |
| PUT | `/api/users/:id` | admin | Update user / reset password |
| DELETE | `/api/users/:id` | admin | Delete user + records |
| GET | `/api/attendance?date= or ?month=` | admin | Records |
| POST | `/api/attendance` | admin | Upsert record (leave/absent/times) |
| DELETE | `/api/attendance/:id` | admin | Delete record |
| GET/PUT | `/api/settings` | any / admin | Working days + currency |

## Salary calculation

- Working days per month counted from `work_days_per_week` (default Mon–Sat).
- Daily rate = monthly salary ÷ working days in month.
- **Present** or **Paid Leave** = one daily rate. **Absent** = nothing.
- Month salary shown = daily rate × (present + paid leave days) recorded.
