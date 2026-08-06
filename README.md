# Payroll & Attendance App — TKSR Product Services

A simple daily attendance and salary application built for **GitHub Pages** (static hosting, no server needed).

- Track daily attendance with **clock in/out** times
- Each employee has a **monthly salary**
- Computes **hours worked** and **salary to be paid** per day and per month
- Working-day aware (5/6/7 day weeks) — salary is split into a daily rate
- All data is stored in the browser (localStorage); no data leaves the device
- Export any month's report to **CSV**

## Files

| File        | Purpose                                        |
|-------------|------------------------------------------------|
| `index.html`| App interface                                  |
| `styles.css`| Styling                                        |
| `app.js`    | Attendance, payroll and reporting logic        |
| `CNAME`     | Binds the site to `payroll.tksrproductservices.com` |

## Deploying to GitHub Pages

1. Create a new repository on GitHub, e.g. `payroll`. It can be **private** — GitHub Pages works on private repos.
2. Upload these 4 files (`index.html`, `styles.css`, `app.js`, `CNAME`) to the `main` branch.
3. Go to **Settings → Pages** and set:
   - Source: **Deploy from a branch**
   - Branch: `main`, folder: `/ (root)`
4. GitHub will start serving it at `https://<your-username>.github.io/<repo>/`.

## Pointing payroll.tksrproductservices.com to it

GitHub Pages allows **one custom domain per project site**, so a second subdomain like `payroll.` works alongside your existing `www.` site (it just needs its own repository).

1. Go to **Settings → Pages** in the repo and enter the custom domain:
   `payroll.tksrproductservices.com`
2. Tick **Enforce HTTPS** after GitHub validates the domain.
3. In your DNS provider's dashboard (where `tksrproductservices.com` is managed), add this record:

   | Type  | Name                          | Value                      |
   |-------|-------------------------------|----------------------------|
   | CNAME | `payroll`                     | `<your-username>.github.io`|

4. Wait for DNS to propagate (minutes to a few hours). Your app will then be live at:
   **https://payroll.tksrproductservices.com**

> Note: GitHub Pages custom domains must be added to the repo's Pages settings **and** have a matching DNS record. The included `CNAME` file tells GitHub Pages which domain to expect on every deploy.

## Usage

1. **Employees tab** — add each employee with their name and monthly salary.
2. **Attendance tab** — pick a date, click the status badge to cycle **Present → Paid Leave → Absent**, and enter clock in/out times for present employees. The app shows hours worked and that day's pay instantly.
3. **Reports tab** — pick a month to see days present/leave/absent, total hours, and salary to be paid. Click **Export CSV** for an Excel-compatible file.
4. **Settings tab** — choose working days per week and currency symbol.

## How salary is calculated

- Working days in the month are counted based on your setting (default: Mon–Sat).
- Daily rate = monthly salary ÷ working days in the month.
- **Present** or **Paid Leave** = one daily rate. **Absent** = nothing.
- Salary shown for the month = daily rate × (present + paid leave days) recorded so far.
