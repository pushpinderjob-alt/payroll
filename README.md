# Payroll & Attendance — TKSR Product Services

Attendance + payroll app for a small business. Employees log in, clock in/out, and admins manage accounts and salary.

## Architecture

- **Frontend** (static) — hosted on **GitHub Pages** at `payroll.tksrproductservices.com`
- **Backend** — **Cloudflare Worker** (API) + **Cloudflare D1** (SQLite database)
- **Auth** — email + password (PBKDF2) and optional **Sign in with Google** (OAuth 2.0 + PKCE). JWT sessions. Password hashing via PBKDF2 (Web Crypto).
- **Roles**
  - **Admin** — first account created is the admin. Manages employees, marks leave/absence, corrects clock times, approves clock-correction requests, views monthly reports, exports CSV, configures settings.
  - **Employee** — logs in with an admin-created account, clocks in/out, sees own attendance, and requests clock corrections.

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
4. Employees sign in and use **Clock In / Clock Out**; they can also request a **clock correction** (missed/mistyped time) from their dashboard.
5. Admin uses **Attendance** (mark leave/absence, correct times), **Requests** (approve/reject employee clock corrections), and **Reports** (monthly summary + CSV).

## 5. Enable Google login (optional)

Employees can sign in with Google instead of a password. Google sign-in only works for emails that already have an account in the system (same email as the one used to log in before). No new accounts are auto-created.

1. Go to <https://console.cloud.google.com> and create a project (or pick an existing one).
2. **APIs & Services → OAuth consent screen** → set it up as an **External** app with the app name/domain. Add the test users if you keep the app in "Testing" mode.
3. **APIs & Services → Credentials → Create Credentials → OAuth client ID → Web application**:
   - **Authorized JavaScript origins:** `https://payroll.tksrproductservices.com`
   - **Authorized redirect URIs:** `https://tksr-payroll-api.pushpinderjob.workers.dev/api/auth/google/callback`
4. Copy the **Client ID** (public, safe to share) and the **Client secret**.
5. Configure the Worker:

```powershell
cd worker
npx wrangler secret put GOOGLE_CLIENT_SECRET    # paste the client secret
```

   Add the public client ID and redirect URI to `worker/wrangler.toml`:

```toml
[vars]
GOOGLE_CLIENT_ID = "xxxx.apps.googleusercontent.com"
GOOGLE_REDIRECT_URI = "https://tksr-payroll-api.pushpinderjob.workers.dev/api/auth/google/callback"
```

6. Redeploy: `npx wrangler deploy`. The **Continue with Google** button now appears on the sign-in screen.

> How it works: the browser redirects to Google, Google sends the code to the Worker's `/api/auth/google/callback` (on workers.dev, which always has a valid HTTPS certificate). The Worker exchanges it with the client secret, checks the email against the users table, and bounces back to the app with a JWT in the URL fragment. This avoids depending on a TLS certificate for the Pages custom domain.

## API summary

| Method | Path | Access | Purpose |
|--------|------|--------|---------|
| POST | `/api/auth/signup` | public (first user) / admin | Create admin (bootstrap) or employee |
| POST | `/api/auth/login` | public | Login -> JWT + user |
| GET | `/api/auth/google/config` | public | Google OAuth config (client id, redirect uri) or `enabled:false` |
| POST | `/api/auth/google/token` | public | Exchange Google OAuth code -> JWT + user |
| GET | `/api/me` | any | Current user |
| GET | `/api/me/status?date=` | employee | Today's record |
| GET | `/api/me/attendance?month=` | employee | Own month records |
| POST | `/api/clock/in` | employee | Clock in (`{date, time}`) |
| POST | `/api/clock/out` | employee | Clock out (`{date, time}`) |
| POST | `/api/corrections` | employee | Create clock-correction request |
| GET | `/api/corrections/mine` | employee | Own correction requests |
| GET | `/api/corrections?status=` | admin | List requests (optional pending filter) |
| POST | `/api/corrections/:id/approve` | admin | Approve (updates attendance) |
| POST | `/api/corrections/:id/reject` | admin | Reject |
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
