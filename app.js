(function () {
  "use strict";

  /* =========================================================
     CONFIG: point this at your deployed Cloudflare Worker.
     Example: const API_BASE = 'https://tksr-payroll-api.xxx.workers.dev';
     ========================================================= */
  var API_BASE = "https://tksr-payroll-api.pushpinderjob.workers.dev";

  var TOKEN_KEY = "payroll_token";
  var USER_KEY = "payroll_user";

  /* ================= State ================= */
  var token = localStorage.getItem(TOKEN_KEY) || null;
  var currentUser = null;
  var settings = { work_days_per_week: 6, currency: "\u20B9" };
  var adminAttDate = todayStr();
  var reportMonth = currentMonthStr();
  var reportRows = [];

  /* ================= Date helpers ================= */
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function dateStr(y, m, d) { return y + "-" + pad(m + 1) + "-" + pad(d); }
  function todayStr() {
    var t = new Date();
    return dateStr(t.getFullYear(), t.getMonth(), t.getDate());
  }
  function nowHM() {
    var t = new Date();
    return pad(t.getHours()) + ":" + pad(t.getMinutes());
  }
  function parseDate(s) {
    var p = s.split("-");
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function addDays(s, n) {
    var d = parseDate(s);
    d.setDate(d.getDate() + n);
    return dateStr(d.getFullYear(), d.getMonth(), d.getDate());
  }
  function monthStrOf(dateStrInput) { return dateStrInput.slice(0, 7); }
  function currentMonthStr() {
    var t = new Date();
    return t.getFullYear() + "-" + pad(t.getMonth() + 1);
  }
  function shiftMonth(m, n) {
    var p = m.split("-");
    var d = new Date(+p[0], +p[1] - 1 + n, 1);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1);
  }
  function monthBounds(m) {
    var p = m.split("-");
    var y = +p[0], mm = +p[1] - 1;
    return { year: y, month: mm, days: new Date(y, mm + 1, 0).getDate() };
  }
  function workingDaysInMonth(m, setting) {
    var b = monthBounds(m);
    var count = 0;
    for (var d = 1; d <= b.days; d++) {
      var dow = new Date(b.year, b.month, d).getDay();
      if (setting === 7) count++;
      else if (setting === 6 && dow !== 0) count++;
      else if (setting === 5 && dow !== 0 && dow !== 6) count++;
    }
    return count;
  }

  /* ================= Money & time ================= */
  function money(n) {
    return settings.currency + Number(n).toLocaleString("en-IN", {
      minimumFractionDigits: 2, maximumFractionDigits: 2
    });
  }
  function hoursBetween(inT, outT) {
    if (!inT || !outT) return 0;
    var a = inT.split(":"), b = outT.split(":");
    var mins = (+b[0] * 60 + +b[1]) - (+a[0] * 60 + +a[1]);
    if (mins < 0) mins += 24 * 60;
    return Math.round((mins / 60) * 100) / 100;
  }
  function dailyRate(salary, monthStr) {
    var wd = workingDaysInMonth(monthStr, settings.work_days_per_week);
    return wd > 0 ? salary / wd : 0;
  }

  /* ================= DOM helpers ================= */
  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
  function esc(s) {
    var div = document.createElement("div");
    div.textContent = s == null ? "" : s;
    return div.innerHTML;
  }
  function b64url(bytes) {
    var bin = "";
    for (var i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function randomB64url(len) {
    var bytes = new Uint8Array(len);
    crypto.getRandomValues(bytes);
    return b64url(bytes);
  }
  function toast(msg, isError) {
    var t = $("#toast");
    t.textContent = msg;
    t.classList.toggle("error", !!isError);
    t.classList.remove("hidden");
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.add("hidden"); }, 2600);
  }

  /* ================= API client ================= */
  async function api(path, opts) {
    opts = opts || {};
    var headers = { "content-type": "application/json" };
    if (token) headers.authorization = "Bearer " + token;
    var res = await fetch(API_BASE + path, {
      method: opts.method || "GET",
      headers: headers,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    var data = null;
    try { data = await res.json(); } catch (e) { /* no body */ }
    if (!res.ok) {
      var msg = (data && data.error) || ("Request failed (" + res.status + ")");
      if (res.status === 401 && opts.path !== "/api/auth/login") {
        forceLogout();
      }
      var err = new Error(msg);
      err.status = res.status;
      throw err;
    }
    return data;
  }

  /* ================= Auth flow ================= */
  function forceLogout() {
    token = null;
    currentUser = null;
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(USER_KEY);
    showAuth();
  }

  function setSession(t, user) {
    token = t;
    currentUser = user;
    localStorage.setItem(TOKEN_KEY, t);
    localStorage.setItem(USER_KEY, JSON.stringify(user));
  }

  function showAuth() {
    $("#appView").classList.add("hidden");
    $("#authView").classList.remove("hidden");
  }

  async function showApp() {
    $("#authView").classList.add("hidden");
    $("#appView").classList.remove("hidden");
    $("#userName").textContent = currentUser.name;
    $("#userRole").textContent = currentUser.role === "admin" ? "Admin" : "Employee";
    buildTabs();
    try {
      await loadSettings();
    } catch (e) { /* non-fatal */ }
    if (currentUser.role === "admin") {
      renderAdminAttendance();
      refreshReqBadge();
      if (window._reqTimer) clearInterval(window._reqTimer);
      window._reqTimer = setInterval(refreshReqBadge, 60000);
    } else {
      renderEmployeeDashboard();
    }
  }

  async function restoreSession() {
    if (!token) { showAuth(); return; }
    try {
      var data = await api("/api/me");
      currentUser = data.user;
      localStorage.setItem(USER_KEY, JSON.stringify(currentUser));
      await showApp();
    } catch (e) {
      forceLogout();
    }
  }

  /* ================= Tabs ================= */
  function buildTabs() {
    var nav = $("#roleTabs");
    nav.innerHTML = "";
    var tabs = [];
    if (currentUser.role === "admin") {
      tabs = [
        { id: "attendance", label: "Attendance" },
        { id: "employees", label: "Employees" },
        { id: "reports", label: "Reports" },
        { id: "requests", label: "Requests" },
        { id: "settings", label: "Settings" }
      ];
    } else {
      tabs = [{ id: "dashboard", label: "My Attendance" }];
    }
    tabs.forEach(function (t) {
      var b = document.createElement("button");
      b.className = "tab" + (t.id === tabs[0].id ? " active" : "");
      b.dataset.tab = t.id;
      b.textContent = t.label;
      if (t.id === "requests") {
        var badge = document.createElement("span");
        badge.className = "tab-badge hidden";
        badge.id = "reqBadge";
        b.appendChild(document.createTextNode(" "));
        b.appendChild(badge);
      }
      b.addEventListener("click", function () { switchTab(t.id); });
      nav.appendChild(b);
    });
    $all(".tab-panel").forEach(function (p) { p.classList.remove("active"); });
    $("#tab-" + tabs[0].id).classList.add("active");
  }

  function switchTab(tab) {
    $all(".tab").forEach(function (b) { b.classList.toggle("active", b.dataset.tab === tab); });
    $all(".tab-panel").forEach(function (p) { p.classList.toggle("active", p.id === "tab-" + tab); });
    if (tab === "attendance") renderAdminAttendance();
    if (tab === "employees") renderEmployees();
    if (tab === "reports") renderReports();
    if (tab === "requests") renderCorrections();
    if (tab === "settings") renderSettingsForm();
    if (tab === "dashboard") renderEmployeeDashboard();
  }

  /* ================= Settings ================= */
  async function loadSettings() {
    try {
      var data = await api("/api/settings");
      settings = Object.assign(settings, data.settings);
    } catch (e) { /* keep defaults */ }
  }

  /* =========================================================
     ADMIN — ATTENDANCE (day view)
     ========================================================= */
  async function renderAdminAttendance() {
    $("#attDate").value = adminAttDate;
    var list = $("#adminAttList");
    var summary = $("#adminAttSummary");
    list.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    summary.classList.add("hidden");

    try {
      var usersData = await api("/api/users");
      var attData = await api("/api/attendance?date=" + adminAttDate);
      var users = usersData.users.filter(function (u) { return u.role === "employee"; });
      var records = attData.records;

      if (users.length === 0) {
        list.innerHTML = '<div class="empty-state"><p>No employees yet.</p><button class="btn primary" id="gotoEmployees">Add Employees</button></div>';
        var g = $("#gotoEmployees");
        if (g) g.addEventListener("click", function () { switchTab("employees"); });
        return;
      }

      list.innerHTML = "";
      var byUser = {};
      records.forEach(function (r) { byUser[r.user_id] = r; });

      users.forEach(function (u) {
        var rec = byUser[u.id] || null;
        list.appendChild(adminAttRow(u, rec));
      });
      renderAdminAttSummary(users, records);
    } catch (e) {
      list.innerHTML = '<div class="empty-state"><p>Error: ' + esc(e.message) + "</p></div>";
    }
  }

  function adminAttRow(user, rec) {
    var status = rec ? rec.status : "absent";
    var row = document.createElement("div");
    row.className = "att-row";

    var info = document.createElement("div");
    info.className = "att-emp";
    info.innerHTML = '<div class="name"></div><div class="salary"></div>';
    info.querySelector(".name").textContent = user.name;
    info.querySelector(".salary").textContent = "Monthly: " + money(user.salary);
    if (rec && rec.task) {
      var task = document.createElement("div");
      task.className = "att-task";
      task.textContent = "Task: " + rec.task;
      info.appendChild(task);
    }

    var times = document.createElement("div");
    times.className = "att-times";
    var inBox = document.createElement("input");
    inBox.type = "time";
    inBox.value = rec && rec.clock_in ? rec.clock_in : "";
    var outBox = document.createElement("input");
    outBox.type = "time";
    outBox.value = rec && rec.clock_out ? rec.clock_out : "";
    times.appendChild(inBox);
    times.appendChild(outBox);

    var hours = document.createElement("div");
    hours.className = "hours-pill";

    var statusSel = document.createElement("select");
    statusSel.className = "status-select";
    ["present", "leave", "absent"].forEach(function (s) {
      var o = document.createElement("option");
      o.value = s;
      o.textContent = s === "present" ? "Present" : s === "leave" ? "Paid Leave" : "Absent";
      if (s === status) o.selected = true;
      statusSel.appendChild(o);
    });

    var delBtn = document.createElement("button");
    delBtn.className = "icon-btn delete";
    delBtn.innerHTML = "\u2715";
    delBtn.title = "Delete record";
    delBtn.style.display = rec ? "" : "none";

    row.appendChild(info);
    row.appendChild(times);
    row.appendChild(hours);
    var right = document.createElement("div");
    right.className = "att-actions";
    right.appendChild(statusSel);
    right.appendChild(delBtn);
    row.appendChild(right);

    function isPresent() { return statusSel.value === "present"; }
    function update() {
      inBox.disabled = !isPresent();
      outBox.disabled = !isPresent();
      if (!isPresent()) { inBox.value = ""; outBox.value = ""; }
      refreshHours();
    }
    function refreshHours() {
      if (statusSel.value !== "present") {
        hours.textContent = "-";
        hours.classList.remove("earned");
        return;
      }
      var h = hoursBetween(inBox.value, outBox.value);
      if (!h) {
        hours.textContent = "Full day";
        hours.classList.add("earned");
        return;
      }
      hours.textContent = h + " h \u00B7 " + money(dailyRate(user.salary, monthStrOf(adminAttDate)));
      hours.classList.add("earned");
    }

    var saveTimer = null;
    async function save() {
      var body = {
        user_id: user.id,
        date: adminAttDate,
        status: statusSel.value,
        clock_in: inBox.value || null,
        clock_out: outBox.value || null
      };
      try {
        var res = await api("/api/attendance", { method: "POST", body: body });
        if (res.record) { delBtn.style.display = ""; }
        toast("Saved for " + user.name);
      } catch (e) {
        toast(e.message, true);
      }
    }
    function scheduleSave() {
      clearTimeout(saveTimer);
      saveTimer = setTimeout(save, 500);
    }

    statusSel.addEventListener("change", function () { update(); scheduleSave(); });
    inBox.addEventListener("change", scheduleSave);
    outBox.addEventListener("change", scheduleSave);
    delBtn.addEventListener("click", async function () {
      if (!rec) return;
      if (!confirm('Delete the record for ' + user.name + ' on ' + adminAttDate + "?")) return;
      try {
        await api("/api/attendance/" + rec.id, { method: "DELETE" });
        toast("Record deleted");
        renderAdminAttendance();
      } catch (e) { toast(e.message, true); }
    });

    update();
    return row;
  }

  function renderAdminAttSummary(users, records) {
    var byUser = {};
    records.forEach(function (r) { byUser[r.user_id] = r; });
    var present = 0, leave = 0, absent = 0, hours = 0, pay = 0;
    users.forEach(function (u) {
      var r = byUser[u.id] || null;
      var st = r ? r.status : "absent";
      var rate = dailyRate(u.salary, monthStrOf(adminAttDate));
      if (st === "present") { present++; hours += hoursBetween(r.clock_in, r.clock_out); pay += rate; }
      else if (st === "leave") { leave++; pay += rate; }
      else absent++;
    });
    $("#adminAttSummary").classList.remove("hidden");
    $("#adminAttSummary").innerHTML =
      stat("Present", present) + stat("Paid Leave", leave) + stat("Absent", absent) +
      stat("Total Hours", hours ? hours.toFixed(2) + " h" : "0 h") +
      stat("Day Payroll", money(pay));
    function stat(label, val) { return '<div class="stat"><b>' + val + '</b><span>' + label + "</span></div>"; }
  }

  /* =========================================================
     ADMIN — EMPLOYEES
     ========================================================= */
  async function renderEmployees() {
    var list = $("#employeeList");
    list.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    try {
      var data = await api("/api/users");
      var users = data.users;
      if (users.length === 0) {
        list.innerHTML = '<div class="empty-state"><p>No users yet.</p></div>';
        return;
      }
      list.innerHTML = "";
      users.forEach(function (u) { list.appendChild(empRow(u)); });
    } catch (e) {
      list.innerHTML = '<div class="empty-state"><p>Error: ' + esc(e.message) + "</p></div>";
    }
  }

  function empRow(u) {
    var row = document.createElement("div");
    row.className = "emp-row";

    var main = document.createElement("div");
    main.className = "emp-main";
    var nameEl = document.createElement("div");
    nameEl.className = "name";
    nameEl.textContent = u.name + (u.role === "admin" ? " (Admin)" : "") + (u.active ? "" : " (Inactive)");
    var meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = u.email;
    main.appendChild(nameEl);
    main.appendChild(meta);

    var sal = document.createElement("div");
    sal.className = "emp-salary";
    sal.textContent = u.role === "employee" ? money(u.salary) + "/mo" : "-";

    var actions = document.createElement("div");
    actions.className = "emp-actions";
    var editBtn = document.createElement("button");
    editBtn.className = "icon-btn";
    editBtn.innerHTML = "\u270E";
    editBtn.title = "Edit";
    editBtn.addEventListener("click", function () { openEmployeeForm(u); });
    actions.appendChild(editBtn);
    if (u.role === "employee") {
      var delBtn = document.createElement("button");
      delBtn.className = "icon-btn delete";
      delBtn.innerHTML = "\u2715";
      delBtn.title = "Delete";
      delBtn.addEventListener("click", function () { deleteEmployee(u); });
      actions.appendChild(delBtn);
    }

    row.appendChild(main);
    row.appendChild(sal);
    row.appendChild(actions);
    return row;
  }

  function openEmployeeForm(u) {
    $("#employeeFormWrap").classList.remove("hidden");
    var isEdit = !!u;
    $("#employeeFormTitle").textContent = isEdit ? "Edit User" : "Add Employee";
    $("#empName").value = u ? u.name : "";
    $("#empEmail").value = u ? u.email : "";
    $("#empSalary").value = u && u.role === "employee" ? u.salary : "";
    $("#empPassword").value = "";
    $("#empPassword").placeholder = isEdit ? "Leave blank to keep current" : "min 6 characters";
    var wrap = $("#employeeForm");
    wrap.dataset.id = u ? u.id : "";
    wrap.dataset.role = u ? u.role : "";
    $("#empSalary").disabled = u && u.role === "admin";
    $("#empEmail").focus();
  }

  async function deleteEmployee(u) {
    if (!confirm('Delete "' + u.name + '" and all their attendance records?')) return;
    try {
      await api("/api/users/" + u.id, { method: "DELETE" });
      toast("Employee deleted");
      renderEmployees();
    } catch (e) { toast(e.message, true); }
  }

  /* =========================================================
     ADMIN — REPORTS
     ========================================================= */
  async function renderReports() {
    $("#reportMonth").value = reportMonth;
    var b = monthBounds(reportMonth);
    var summaryEl = $("#reportSummary");
    var tbody = $("#reportTable tbody");
    summaryEl.innerHTML = '<div class="report-card"><div class="label">Loading...</div><div class="value">-</div></div>';
    tbody.innerHTML = "";

    try {
      var usersData = await api("/api/users");
      var attData = await api("/api/attendance?month=" + reportMonth);
      var emps = usersData.users.filter(function (u) { return u.role === "employee"; });
      var records = attData.records;
      var wd = workingDaysInMonth(reportMonth, settings.work_days_per_week);

      var rows = emps.map(function (emp) {
        var present = 0, leave = 0, absent = 0, hours = 0;
        records.forEach(function (r) {
          if (r.user_id !== emp.id) return;
          if (r.status === "present") { present++; hours += hoursBetween(r.clock_in, r.clock_out); }
          else if (r.status === "leave") leave++;
          else absent++;
        });
        var rate = dailyRate(emp.salary, reportMonth);
        var earned = (present + leave) * rate;
        return { emp: emp, present: present, leave: leave, absent: absent, hours: hours, earned: earned };
      });

      var totalPay = rows.reduce(function (s, r) { return s + r.earned; }, 0);
      var totalHours = rows.reduce(function (s, r) { return s + r.hours; }, 0);
      var totalMonthly = emps.reduce(function (s, e) { return s + e.salary; }, 0);
      reportRows = rows;

      summaryEl.innerHTML =
        '<div class="report-card highlight"><div class="label">Payroll To Be Paid</div><div class="value">' + money(totalPay) + "</div></div>" +
        '<div class="report-card"><div class="label">Employees</div><div class="value">' + emps.length + "</div></div>" +
        '<div class="report-card"><div class="label">Working Days</div><div class="value">' + wd + "</div></div>" +
        '<div class="report-card"><div class="label">Total Hours Worked</div><div class="value">' + totalHours.toFixed(2) + ' h</div></div>' +
        '<div class="report-card"><div class="label">Combined Monthly Salary</div><div class="value">' + money(totalMonthly) + "</div></div>";

      tbody.innerHTML = "";
      rows.forEach(function (r) {
        var tr = document.createElement("tr");
        tr.innerHTML =
          "<td><strong>" + esc(r.emp.name) + "</strong></td>" +
          '<td class="num">' + money(r.emp.salary) + "</td>" +
          '<td class="num"><span class="badge ok">' + r.present + "</span></td>" +
          '<td class="num"><span class="badge leave">' + r.leave + "</span></td>" +
          '<td class="num"><span class="badge bad">' + r.absent + "</span></td>" +
          '<td class="num">' + r.hours.toFixed(2) + ' h</td>' +
          '<td class="num"><strong>' + money(r.earned) + "</strong></td>";
        tbody.appendChild(tr);
      });

      if (rows.length) {
        var tr = document.createElement("tr");
        tr.className = "total-row";
        tr.innerHTML =
          "<td>Total</td><td class=\"num\">" + money(totalMonthly) + "</td>" +
          "<td class=\"num\">" + rows.reduce(function (s, r) { return s + r.present; }, 0) + "</td>" +
          "<td class=\"num\">" + rows.reduce(function (s, r) { return s + r.leave; }, 0) + "</td>" +
          "<td class=\"num\">" + rows.reduce(function (s, r) { return s + r.absent; }, 0) + "</td>" +
          '<td class="num">' + totalHours.toFixed(2) + ' h</td>' +
          '<td class="num"><strong>' + money(totalPay) + "</strong></td>";
        tbody.appendChild(tr);
      }
    } catch (e) {
      summaryEl.innerHTML = '<div class="report-card"><div class="label">Error</div><div class="value">' + esc(e.message) + "</div></div>";
    }
  }

  function exportCsv() {
    var rows = reportRows || [];
    var emps = rows.map(function (r) { return r.emp; });
    var totalPay = rows.reduce(function (s, r) { return s + r.earned; }, 0);
    var totalHours = rows.reduce(function (s, r) { return s + r.hours; }, 0);
    var lines = ["Employee,Monthly Salary,Present,Paid Leave,Absent,Hours Worked,Salary This Month"];
    rows.forEach(function (r) {
      lines.push([
        '"' + r.emp.name.replace(/"/g, '""') + '"',
        r.emp.salary.toFixed(2), r.present, r.leave, r.absent,
        r.hours.toFixed(2), r.earned.toFixed(2)
      ].join(","));
    });
    lines.push(["TOTAL", , , , , totalHours.toFixed(2), totalPay.toFixed(2)].join(","));
    var blob = new Blob(["\uFEFF" + lines.join("\n")], { type: "text/csv;charset=utf-8" });
    var a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "payroll-" + reportMonth + ".csv";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(a.href);
    toast("Report exported");
  }

  /* =========================================================
     ADMIN — SETTINGS
     ========================================================= */
  function renderSettingsForm() {
    $("#workingDays").value = String(settings.work_days_per_week);
    $("#currency").value = settings.currency;
  }

  /* =========================================================
     EMPLOYEE — DASHBOARD
     ========================================================= */
  async function renderEmployeeDashboard() {
    var date = todayStr();
    var dd = parseDate(date);
    var dayName = dd.toLocaleDateString(undefined, { weekday: "long" });
    var formatted = dd.toLocaleDateString(undefined, { day: "numeric", month: "long", year: "numeric" });
    $("#dashDate").textContent = dayName + ", " + formatted;

    var statsEl = $("#dashStats");
    var tableBody = $("#dashTable tbody");
    statsEl.innerHTML = "";
    tableBody.innerHTML = "";

    try {
      var statusData = await api("/api/me/status?date=" + date);
      var attData = await api("/api/me/attendance?month=" + monthStrOf(date));
      var records = attData.records;
      renderClockCard(statusData.record, date);
      renderDashStats(records, monthStrOf(date), statsEl);
      renderDashTable(records, tableBody);
    } catch (e) {
      $("#clockStatus").textContent = "Error: " + e.message;
    }
    renderMyCorrections();
  }

  function renderClockCard(rec, date) {
    var status = $("#clockStatus");
    var inBtn = $("#clockInBtn");
    var outBtn = $("#clockOutBtn");
    inBtn.disabled = false;
    outBtn.disabled = true;
    $("#taskInput").value = (rec && rec.task) || "";

    if (!rec || !rec.clock_in) {
      status.textContent = (rec && rec.status === "leave")
        ? "Marked as paid leave today."
        : "Not clocked in yet today.";
      return;
    }
    if (!rec.clock_out) {
      status.textContent = "Clocked in at " + rec.clock_in + ". Don't forget to clock out!";
      inBtn.disabled = true;
      outBtn.disabled = false;
      return;
    }
    status.textContent = "Clocked out at " + rec.clock_out + " (in at " + rec.clock_in + ", " +
      hoursBetween(rec.clock_in, rec.clock_out).toFixed(2) + " h).";
    inBtn.disabled = true;
  }

  async function doClock(action) {
    var date = todayStr();
    try {
      if (action === "in") {
        await api("/api/clock/in", { method: "POST", body: { date: date, time: nowHM() } });
        toast("Clocked in at " + nowHM());
      } else {
        await api("/api/clock/out", { method: "POST", body: { date: date, time: nowHM() } });
        toast("Clocked out at " + nowHM());
      }
      renderEmployeeDashboard();
    } catch (e) {
      toast(e.message, true);
    }
  }

  function renderDashStats(records, month, el) {
    var present = 0, leave = 0, absent = 0, hours = 0;
    records.forEach(function (r) {
      if (r.status === "present") { present++; hours += hoursBetween(r.clock_in, r.clock_out); }
      else if (r.status === "leave") leave++;
      else absent++;
    });
    var day = workingDaysInMonth(month, settings.work_days_per_week);
    el.innerHTML =
      '<div class="report-card"><div class="label">Days Present</div><div class="value">' + present + "</div></div>" +
      '<div class="report-card"><div class="label">Paid Leave</div><div class="value">' + leave + "</div></div>" +
      '<div class="report-card"><div class="label">Absent</div><div class="value">' + absent + "</div></div>" +
      '<div class="report-card"><div class="label">Hours Worked</div><div class="value">' + hours.toFixed(2) + ' h</div></div>' +
      '<div class="report-card"><div class="label">Working Days</div><div class="value">' + day + "</div></div>";
  }

  function renderDashTable(records, tbody) {
    tbody.innerHTML = "";
    if (records.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="muted">No records this month yet.</td></tr>';
      return;
    }
    records.slice().reverse().forEach(function (r) {
      var tr = document.createElement("tr");
      var hours = hoursBetween(r.clock_in, r.clock_out);
      var statusLabel = r.status === "present" ? "Present" : r.status === "leave" ? "Paid Leave" : "Absent";
      var badgeClass = r.status === "present" ? "ok" : r.status === "leave" ? "leave" : "bad";
      tr.innerHTML =
        "<td>" + esc(r.work_date) + "</td>" +
        '<td class="num">' + esc(r.clock_in || "-") + "</td>" +
        '<td class="num">' + esc(r.clock_out || "-") + "</td>" +
        '<td class="num">' + (r.status === "present" ? hours.toFixed(2) + " h" : "-") + "</td>" +
        '<td><span class="badge ' + badgeClass + '">' + statusLabel + "</span></td>" +
        '<td class="task-cell">' + (r.task ? esc(r.task) : '-') + "</td>";
      tbody.appendChild(tr);
    });
  }

  /* =========================================================
     GOOGLE LOGIN
     ========================================================= */
  var googleEnabled = false;

  function toggleGoogleWrap(loginTab) {
    var wrap = $("#googleLoginWrap");
    if (!wrap) return;
    wrap.classList.toggle("hidden", !(loginTab && googleEnabled));
  }

  function initGoogleLogin() {
    var wrap = $("#googleLoginWrap");
    if (!wrap) return;
    api("/api/auth/google/config").then(function (cfg) {
      googleEnabled = !!cfg.enabled;
      toggleGoogleWrap($(".auth-tab.active") && $(".auth-tab.active").dataset.mode === "login");
      if (googleEnabled) {
        $("#googleLoginBtn").addEventListener("click", function () { startGoogleLogin(cfg); });
      }
    }).catch(function () { googleEnabled = false; });
  }

  async function startGoogleLogin(cfg) {
    var state = randomB64url(24);
    sessionStorage.setItem("gstate", JSON.stringify({ state: state }));
    var q = new URLSearchParams({
      client_id: cfg.client_id,
      redirect_uri: cfg.redirect_uri,
      response_type: "code",
      scope: "openid email profile",
      state: state,
      prompt: "select_account"
    });
    location.href = "https://accounts.google.com/o/oauth2/v2/auth?" + q.toString();
  }

  /* =========================================================
     WIRING
     ========================================================= */
  function wireAuth() {
    $all(".auth-tab").forEach(function (b) {
      b.addEventListener("click", function () {
        $all(".auth-tab").forEach(function (x) { x.classList.toggle("active", x === b); });
        $("#loginForm").classList.toggle("hidden", b.dataset.mode !== "login");
        $("#signupForm").classList.toggle("hidden", b.dataset.mode !== "signup");
        toggleGoogleWrap(b.dataset.mode === "login");
        hideAuthError();
      });
    });

    $("#loginForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      hideAuthError();
      var email = $("#loginEmail").value.trim();
      var password = $("#loginPassword").value;
      try {
        var data = await api("/api/auth/login", { method: "POST", body: { email: email, password: password } });
        setSession(data.token, data.user);
        await showApp();
      } catch (err) {
        showAuthError(err.message);
      }
    });

    $("#signupForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      hideAuthError();
      var name = $("#suName").value.trim();
      var email = $("#suEmail").value.trim();
      var password = $("#suPassword").value;
      try {
        var data = await api("/api/auth/signup", { method: "POST", body: { name: name, email: email, password: password } });
        if (data.firstUser) {
          toast("Admin account created");
        }
        var login = await api("/api/auth/login", { method: "POST", body: { email: email, password: password } });
        setSession(login.token, login.user);
        await showApp();
      } catch (err) {
        showAuthError(err.message);
      }
    });

    $("#logoutBtn").addEventListener("click", function () {
      token = null;
      currentUser = null;
      localStorage.removeItem(TOKEN_KEY);
      localStorage.removeItem(USER_KEY);
      showAuth();
    });
  }

  function showAuthError(msg) {
    var el = $("#authError");
    el.textContent = msg;
    el.classList.remove("hidden");
  }
  function hideAuthError() {
    $("#authError").classList.add("hidden");
  }

  function wireAdmin() {
    $("#attDate").addEventListener("change", function () { if (this.value) { adminAttDate = this.value; renderAdminAttendance(); } });
    $("#prevDay").addEventListener("click", function () { adminAttDate = addDays(adminAttDate, -1); renderAdminAttendance(); });
    $("#nextDay").addEventListener("click", function () { adminAttDate = addDays(adminAttDate, 1); renderAdminAttendance(); });
    $("#todayBtn").addEventListener("click", function () { adminAttDate = todayStr(); renderAdminAttendance(); });

    $("#addEmployeeBtn").addEventListener("click", function () { openEmployeeForm(null); });
    $("#cancelEmployeeForm").addEventListener("click", function () { $("#employeeFormWrap").classList.add("hidden"); });

    $("#employeeForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      var id = this.dataset.id;
      var name = $("#empName").value.trim();
      var email = $("#empEmail").value.trim();
      var salary = parseFloat($("#empSalary").value);
      var password = $("#empPassword").value;
      var isEditAdmin = this.dataset.role === "admin";
      if (!name || !email) { toast("Name and email required", true); return; }
      if (isEditAdmin) {
        var upd = { name: name };
        if (password) upd.password = password;
        try {
          await api("/api/users/" + id, { method: "PUT", body: upd });
          toast("Admin updated");
        } catch (err) { toast(err.message, true); }
      } else if (id) {
        var upd2 = { name: name, salary: isNaN(salary) ? 0 : salary };
        if (password) upd2.password = password;
        try {
          await api("/api/users/" + id, { method: "PUT", body: upd2 });
          toast("Employee updated");
        } catch (err) { toast(err.message, true); }
      } else {
        if (isNaN(salary) || salary < 0) { toast("Enter a valid salary", true); return; }
        if (password.length < 6) { toast("Temporary password must be at least 6 characters", true); return; }
        try {
          await api("/api/users", { method: "POST", body: { name: name, email: email, salary: salary, role: "employee", password: password } });
          toast("Employee added");
        } catch (err) { toast(err.message, true); }
      }
      $("#employeeFormWrap").classList.add("hidden");
      renderEmployees();
    });

    $("#reportMonth").addEventListener("change", function () { if (this.value) { reportMonth = this.value; renderReports(); } });
    $("#prevMonth").addEventListener("click", function () { reportMonth = shiftMonth(reportMonth, -1); renderReports(); });
    $("#nextMonth").addEventListener("click", function () { reportMonth = shiftMonth(reportMonth, 1); renderReports(); });
    $("#exportCsv").addEventListener("click", exportCsv);

    $("#settingsForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      try {
        var data = await api("/api/settings", {
          method: "PUT",
          body: {
            work_days_per_week: parseInt($("#workingDays").value, 10),
            currency: ($("#currency").value.trim() || "\u20B9")
          }
        });
        settings = Object.assign(settings, data.settings);
        toast("Settings saved");
      } catch (err) { toast(err.message, true); }
    });

    $("#clearAttendanceBtn").addEventListener("click", async function () {
      if (!confirm("This will delete ALL attendance records. Continue?")) return;
      try {
        var data = await api("/api/users");
        var emps = data.users.filter(function (u) { return u.role === "employee"; });
        var att = await api("/api/attendance?month=" + currentMonthStr());
        // Delete all records across all months via repeated day queries is heavy;
        // simplest safe approach: delete current month only.
        for (var i = 0; i < att.records.length; i++) {
          await api("/api/attendance/" + att.records[i].id, { method: "DELETE" });
        }
        toast("Current month attendance cleared");
        if (currentUser.role === "admin") { switchTab("attendance"); }
      } catch (err) { toast(err.message, true); }
    });
  }

  function wireEmployee() {
    $("#clockInBtn").addEventListener("click", function () { doClock("in"); });
    $("#clockOutBtn").addEventListener("click", function () { doClock("out"); });
  }

  function wireTask() {
    $("#taskSaveBtn").addEventListener("click", async function () {
      var task = $("#taskInput").value.trim();
      try {
        await api("/api/me/task", { method: "PUT", body: { date: todayStr(), task: task } });
        var saved = $("#taskSaved");
        saved.classList.remove("hidden");
        clearTimeout(saved._timer);
        saved._timer = setTimeout(function () { saved.classList.add("hidden"); }, 2200);
        renderEmployeeDashboard();
      } catch (e) {
        toast(e.message, true);
      }
    });
  }

  /* ================= Corrections ================= */
  var CORR_REASONS = {
    forgot_clock_out: "Forgot to clock out",
    clocked_out_early: "Clocked out too early",
    forgot_clock_in: "Forgot to clock in",
    wrong_time: "Wrong clock time",
    other: "Other"
  };

  function reasonLabel(r) { return CORR_REASONS[r] || r; }

  function corrTimesText(c) {
    var parts = [];
    if (c.current_clock_in || c.current_clock_out) {
      parts.push("Current: " + (c.current_clock_in || "-") + " \u2192 " + (c.current_clock_out || "-"));
    }
    if (c.requested_clock_in || c.requested_clock_out) {
      parts.push("Requested: " + (c.requested_clock_in || "-") + " \u2192 " + (c.requested_clock_out || "-"));
    }
    return parts.join(" \u00B7 ") || "No time change requested";
  }

  function corrBadgeEl(status) {
    var b = document.createElement("span");
    b.className = "badge " + (status === "approved" ? "ok" : status === "rejected" ? "bad" : "leave");
    b.textContent = status.charAt(0).toUpperCase() + status.slice(1);
    return b;
  }

  function renderMyCorrections() {
    var el = $("#myRequests");
    if (!el) return;
    el.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    api("/api/corrections/mine").then(function (data) {
      var list = data.corrections || [];
      if (list.length === 0) {
        el.innerHTML = '<div class="empty-state"><p>No correction requests yet.</p></div>';
        return;
      }
      el.innerHTML = "";
      list.forEach(function (c) {
        var div = document.createElement("div");
        div.className = "req-row";
        var main = document.createElement("div");
        main.className = "req-main";
        var name = document.createElement("div");
        name.className = "name";
        name.textContent = c.work_date + " \u00B7 " + reasonLabel(c.reason);
        main.appendChild(name);
        var meta = document.createElement("div");
        meta.className = "meta";
        meta.textContent = corrTimesText(c);
        if (c.note) meta.textContent += " \u2014 " + c.note;
        main.appendChild(meta);
        if (c.status !== "pending" && c.admin_note) {
          var note = document.createElement("div");
          note.className = "meta-note";
          note.textContent = "Admin: " + c.admin_note;
          main.appendChild(note);
        }
        div.appendChild(main);
        div.appendChild(corrBadgeEl(c.status));
        el.appendChild(div);
      });
    }).catch(function (e) {
      el.innerHTML = '<div class="empty-state"><p>Error: ' + esc(e.message) + "</p></div>";
    });
  }

  function renderCorrections() {
    var el = $("#adminRequests");
    if (!el) return;
    el.innerHTML = '<div class="empty-state"><p>Loading...</p></div>';
    api("/api/corrections").then(function (data) {
      var list = data.corrections || [];
      if (list.length === 0) {
        el.innerHTML = '<div class="empty-state"><p>No correction requests.</p></div>';
      } else {
        el.innerHTML = "";
        appendCorrectionGroups(el, list);
      }
      refreshReqBadge();
    }).catch(function (e) {
      el.innerHTML = '<div class="empty-state"><p>Error: ' + esc(e.message) + "</p></div>";
    });
  }

  function groupKey(c) { return c.request_group || ("single-" + c.id); }

  function appendCorrectionGroups(el, list) {
    var groups = {};
    list.forEach(function (c) {
      var k = groupKey(c);
      if (!groups[k]) groups[k] = [];
      groups[k].push(c);
    });
    var pendingIn = function (rows) { return rows.some(function (r) { return r.status === "pending"; }); };
    var key = Object.keys(groups).sort(function (a, b) {
      var pa = pendingIn(groups[a]) ? 0 : 1;
      var pb = pendingIn(groups[b]) ? 0 : 1;
      return pa - pb;
    });
    key.forEach(function (k) {
      var rows = groups[k];
      var wrap = document.createElement("div");
      wrap.className = "req-group";
      if (k.indexOf("single-") === 0) {
        el.appendChild(adminReqRow(rows[0]));
        return;
      }
      var head = document.createElement("div");
      head.className = "req-group-head";
      var headName = document.createElement("span");
      headName.className = "name";
      headName.textContent = rows[0].user_name + " \u2014 " + rows.length + " date(s)";
      head.appendChild(headName);
      if (pendingIn(rows)) {
        var ok = document.createElement("button");
        ok.className = "btn primary";
        ok.textContent = "Approve All";
        ok.addEventListener("click", function () { decideCorrectionGroup(k, true); });
        var no = document.createElement("button");
        no.className = "btn ghost";
        no.textContent = "Reject All";
        no.addEventListener("click", function () { decideCorrectionGroup(k, false); });
        head.appendChild(ok);
        head.appendChild(no);
      } else {
        var badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = rows[0].status === "approved" ? "Approved" : "Rejected";
        head.appendChild(badge);
      }
      wrap.appendChild(head);
      rows.forEach(function (c) { wrap.appendChild(adminReqRow(c)); });
      el.appendChild(wrap);
    });
  }

  function adminReqRow(c) {
    var div = document.createElement("div");
    div.className = "req-row" + (c.status === "pending" ? " pending" : "");
    var main = document.createElement("div");
    main.className = "req-main";
    var name = document.createElement("div");
    name.className = "name";
    name.innerHTML = esc(c.user_name) + " \u00B7 " + esc(c.work_date) + " \u00B7 " + esc(reasonLabel(c.reason));
    main.appendChild(name);
    var meta = document.createElement("div");
    meta.className = "meta";
    meta.textContent = corrTimesText(c);
    main.appendChild(meta);
    if (c.note) {
      var n = document.createElement("div");
      n.className = "meta-note";
      n.textContent = "Note: " + c.note;
      main.appendChild(n);
    }
    if (c.status !== "pending" && c.admin_note) {
      var an = document.createElement("div");
      an.className = "meta-note";
      an.textContent = "Admin: " + c.admin_note;
      main.appendChild(an);
    }
    div.appendChild(main);
    div.appendChild(corrBadgeEl(c.status));

    if (c.status === "pending") {
      var actions = document.createElement("div");
      actions.className = "req-actions";
      var ok = document.createElement("button");
      ok.className = "btn primary";
      ok.textContent = "Approve";
      ok.addEventListener("click", function () { decideCorrection(c, true); });
      var no = document.createElement("button");
      no.className = "btn ghost";
      no.textContent = "Reject";
      no.addEventListener("click", function () { decideCorrection(c, false); });
      actions.appendChild(ok);
      actions.appendChild(no);
      div.appendChild(actions);
    }
    return div;
  }

  var pendingDecision = null;

  function openDecideModal(decision) {
    pendingDecision = decision;
    $("#corrDecideTitle").textContent = decision.approve ? "Approve request" : "Reject request";
    $("#corrDecideMsg").textContent = decision.message;
    $("#corrDecideNote").value = "";
    var okBtn = $("#corrDecideOk");
    okBtn.textContent = decision.approve ? "Approve" : "Reject";
    okBtn.className = decision.approve ? "btn primary" : "btn danger";
    $("#corrDecideModal").classList.remove("hidden");
  }

  function closeDecideModal() {
    pendingDecision = null;
    $("#corrDecideModal").classList.add("hidden");
  }

  async function confirmDecision() {
    var d = pendingDecision;
    if (!d) return;
    pendingDecision = null;
    var note = $("#corrDecideNote").value.trim();
    var path = d.group
      ? "/api/corrections/group/" + encodeURIComponent(d.group) + (d.approve ? "/approve" : "/reject")
      : "/api/corrections/" + d.c.id + (d.approve ? "/approve" : "/reject");
    try {
      await api(path, { method: "POST", body: { admin_note: note } });
      toast(d.approve ? "Request approved" : "Request rejected");
      closeDecideModal();
      renderCorrections();
    } catch (e) {
      toast(e.message, true);
    }
  }

  function decideCorrection(c, approve) {
    openDecideModal({
      approve: approve,
      c: c,
      message: approve
        ? "Approve this request? Attendance for " + c.user_name + " on " + c.work_date + " will be updated."
        : "Reject this request? The employee will see your note."
    });
  }

  function decideCorrectionGroup(group, approve) {
    openDecideModal({
      approve: approve,
      group: group,
      message: approve
        ? "Approve all dates in this request? Attendance for each will be updated."
        : "Reject all dates in this request? The employee will see your note."
    });
  }

  async function refreshReqBadge() {
    if (!currentUser || currentUser.role !== "admin") return;
    try {
      var data = await api("/api/corrections?status=pending");
      var n = (data.corrections || []).length;
      var badge = $("#reqBadge");
      if (badge) {
        badge.textContent = n > 99 ? "99+" : "" + n;
        badge.classList.toggle("hidden", n === 0);
      }
    } catch (e) { /* non-fatal */ }
  }

  var corrDates = [];

  function renderCorrChips() {
    var wrap = $("#corrDateChips");
    wrap.innerHTML = "";
    corrDates.forEach(function (d) {
      var row = document.createElement("div");
      row.className = "date-chip-row";
      var date = document.createElement("span");
      date.className = "chip-date";
      date.textContent = d.date;
      row.appendChild(date);
      var inp = document.createElement("input");
      inp.type = "time";
      inp.className = "chip-time";
      inp.value = d.in;
      inp.setAttribute("aria-label", "Clock in " + d.date);
      inp.addEventListener("input", function () { d.in = this.value; });
      row.appendChild(inp);
      var outp = document.createElement("input");
      outp.type = "time";
      outp.className = "chip-time";
      outp.value = d.out;
      outp.setAttribute("aria-label", "Clock out " + d.date);
      outp.addEventListener("input", function () { d.out = this.value; });
      row.appendChild(outp);
      var x = document.createElement("button");
      x.type = "button";
      x.className = "chip-x";
      x.setAttribute("aria-label", "Remove " + d.date);
      x.textContent = "\u00D7";
      x.addEventListener("click", function () {
        corrDates = corrDates.filter(function (y) { return y.date !== d.date; });
        renderCorrChips();
      });
      row.appendChild(x);
      wrap.appendChild(row);
    });
    wrap.classList.toggle("hidden", corrDates.length === 0);
  }

  function addCorrDate() {
    var input = $("#corrDate");
    var d = input.value;
    if (!d) { toast("Pick a date first", true); return; }
    if (corrDates.some(function (y) { return y.date === d; })) { toast("Date already added: " + d, true); return; }
    if (corrDates.length >= 31) { toast("Maximum 31 dates", true); return; }
    corrDates.push({ date: d, in: "", out: "" });
    renderCorrChips();
    input.value = "";
    toast("Added " + d);
  }

  function openCorrectionModal() {
    corrDates = [];
    renderCorrChips();
    $("#corrDate").value = todayStr();
    $("#corrReason").value = "forgot_clock_out";
    $("#corrNote").value = "";
    $("#corrModal").classList.remove("hidden");
  }

  function closeCorrectionModal() {
    $("#corrModal").classList.add("hidden");
  }

  function wireCorrections() {
    $("#requestCorrectionBtn").addEventListener("click", openCorrectionModal);
    $("#corrCancel").addEventListener("click", closeCorrectionModal);
    $("#corrDateAdd").addEventListener("click", addCorrDate);
    $("#corrDate").addEventListener("keydown", function (e) {
      if (e.key === "Enter") { e.preventDefault(); addCorrDate(); }
    });
    $("#corrDecideOk").addEventListener("click", confirmDecision);
    $("#corrDecideCancel").addEventListener("click", closeDecideModal);
    $("#corrDecideModal").addEventListener("click", function (e) {
      if (e.target === this) closeDecideModal();
    });
    $("#corrModal").addEventListener("click", function (e) {
      if (e.target === this) closeCorrectionModal();
    });
    $("#corrForm").addEventListener("submit", async function (e) {
      e.preventDefault();
      if (corrDates.length === 0) { toast("Add at least one date", true); return; }
      var note = $("#corrNote").value.trim();
      var hasTime = corrDates.some(function (x) { return x.in || x.out; });
      if (!hasTime && !note) {
        toast("Provide the correct time(s) or a note", true);
        return;
      }
      var body = {
        work_dates: corrDates.map(function (x) {
          return { date: x.date, requested_clock_in: x.in || null, requested_clock_out: x.out || null };
        }),
        reason: $("#corrReason").value,
        note: note
      };
      try {
        await api("/api/corrections", { method: "POST", body: body });
        toast("Request submitted for " + corrDates.length + " date(s)");
        closeCorrectionModal();
        renderEmployeeDashboard();
      } catch (err) {
        toast(err.message, true);
      }
    });
    $("#refreshReqs").addEventListener("click", renderCorrections);
  }

  /* ================= Boot ================= */
  document.addEventListener("DOMContentLoaded", function () {
    wireAuth();
    wireAdmin();
    wireEmployee();
    wireTask();
    wireCorrections();
    initGoogleLogin();
    restoreSession();
  });
})();
