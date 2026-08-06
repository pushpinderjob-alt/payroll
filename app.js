(function () {
  "use strict";

  /* ================= Storage ================= */
  var STORE_EMPLOYEES = "payroll_employees";
  var STORE_ATTENDANCE = "payroll_attendance";
  var STORE_SETTINGS = "payroll_settings";

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) {
      return fallback;
    }
  }
  function save(key, value) {
    localStorage.setItem(key, JSON.stringify(value));
  }

  var employees = load(STORE_EMPLOYEES, []);
  var attendance = load(STORE_ATTENDANCE, {});
  var settings = Object.assign(
    { workingDays: 6, currency: "\u20B9" },
    load(STORE_SETTINGS, {})
  );

  function persistEmployees() { save(STORE_EMPLOYEES, employees); }
  function persistAttendance() { save(STORE_ATTENDANCE, attendance); }
  function persistSettings() { save(STORE_SETTINGS, settings); }

  /* ================= State ================= */
  var activeTab = "attendance";
  var attDate = todayStr();
  var reportMonth = currentMonthStr();

  /* ================= Date helpers ================= */
  function pad(n) { return n < 10 ? "0" + n : "" + n; }
  function dateStr(y, m, d) { return y + "-" + pad(m + 1) + "-" + pad(d); }
  function todayStr() {
    var t = new Date();
    return dateStr(t.getFullYear(), t.getMonth(), t.getDate());
  }
  function parseDate(str) {
    var p = str.split("-");
    return new Date(+p[0], +p[1] - 1, +p[2]);
  }
  function addDays(str, n) {
    var d = parseDate(str);
    d.setDate(d.getDate() + n);
    return dateStr(d.getFullYear(), d.getMonth(), d.getDate());
  }
  function monthStrOf(dateStrInput) {
    return dateStrInput.slice(0, 7);
  }
  function currentMonthStr() {
    var t = new Date();
    return t.getFullYear() + "-" + pad(t.getMonth() + 1);
  }
  function monthBounds(monthStr) {
    var p = monthStr.split("-");
    var y = +p[0], m = +p[1] - 1;
    return { year: y, month: m, days: new Date(y, m + 1, 0).getDate() };
  }
  function shiftMonth(monthStr, n) {
    var p = monthStr.split("-");
    var d = new Date(+p[0], +p[1] - 1 + n, 1);
    return d.getFullYear() + "-" + pad(d.getMonth() + 1);
  }

  function workingDaysInMonth(monthStr) {
    var b = monthBounds(monthStr);
    var setting = settings.workingDays;
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
      minimumFractionDigits: 2,
      maximumFractionDigits: 2
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
    var wd = workingDaysInMonth(monthStr);
    return wd > 0 ? salary / wd : 0;
  }

  /* ================= DOM helpers ================= */
  function $(sel) { return document.querySelector(sel); }
  function $all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }

  function toast(msg, isError) {
    var t = $("#toast");
    t.textContent = msg;
    t.classList.toggle("error", !!isError);
    t.classList.remove("hidden");
    clearTimeout(t._timer);
    t._timer = setTimeout(function () { t.classList.add("hidden"); }, 2400);
  }

  function uid() {
    return "e" + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  /* ================= Tabs ================= */
  function switchTab(tab) {
    activeTab = tab;
    $all(".tab").forEach(function (b) {
      b.classList.toggle("active", b.dataset.tab === tab);
    });
    $all(".tab-panel").forEach(function (p) {
      p.classList.toggle("active", p.id === "tab-" + tab);
    });
    if (tab === "attendance") renderAttendance();
    if (tab === "employees") renderEmployees();
    if (tab === "reports") renderReports();
  }

  /* ================= Attendance ================= */
  function getDayRecord(dateStr) {
    if (!attendance[dateStr]) attendance[dateStr] = {};
    return attendance[dateStr];
  }
  function getStatus(dateStr, empId) {
    var r = getDayRecord(dateStr)[empId];
    return r ? r.status : "absent";
  }
  function setStatus(dateStr, empId, status) {
    var rec = getDayRecord(dateStr);
    if (!rec[empId]) rec[empId] = {};
    rec[empId].status = status;
    persistAttendance();
  }

  function renderAttendance() {
    $("#attDate").value = attDate;
    var active = employees.filter(function (e) { return e.active !== false; });

    $("#emptyEmployees").classList.toggle("hidden", active.length > 0);
    $("#attendanceList").classList.toggle("hidden", active.length === 0);
    $("#attSummary").classList.toggle("hidden", active.length === 0);
    if (active.length === 0) { $("#attSummary").innerHTML = ""; return; }

    var list = $("#attendanceList");
    list.innerHTML = "";
    var day = getDayRecord(attDate);

    active.forEach(function (emp) {
      var rec = day[emp.id] || {};
      var status = rec.status || "absent";
      var isPresent = status === "present";

      var row = document.createElement("div");
      row.className = "att-row";

      var info = document.createElement("div");
      info.className = "att-emp";
      info.innerHTML = '<div class="name"></div><div class="salary">Monthly: </div>';
      info.querySelector(".name").textContent = emp.name;
      info.querySelector(".salary").textContent = "Monthly: " + money(emp.salary);

      var times = document.createElement("div");
      times.className = "att-times";
      var inBox = document.createElement("input");
      inBox.type = "time";
      inBox.value = rec.in || "";
      inBox.disabled = !isPresent;
      var outBox = document.createElement("input");
      outBox.type = "time";
      outBox.value = rec.out || "";
      outBox.disabled = !isPresent;

      inBox.addEventListener("change", function () {
        var r = getDayRecord(attDate);
        if (!r[emp.id]) r[emp.id] = {};
        r[emp.id].in = inBox.value;
        persistAttendance();
        updateHours(emp);
      });
      outBox.addEventListener("change", function () {
        var r = getDayRecord(attDate);
        if (!r[emp.id]) r[emp.id] = {};
        r[emp.id].out = outBox.value;
        persistAttendance();
        updateHours(emp);
      });
      times.appendChild(inBox);
      times.appendChild(outBox);

      var hours = document.createElement("div");
      hours.className = "hours-pill";

      var badge = document.createElement("button");
      badge.className = "status-badge " + status;
      badge.addEventListener("click", function () {
        var next = status === "present" ? "leave" : status === "leave" ? "absent" : "present";
        setStatus(attDate, emp.id, next);
        renderAttendance();
      });

      row.appendChild(info);
      row.appendChild(times);
      row.appendChild(hours);
      row.appendChild(badge);

      list.appendChild(row);

      function refresh() {
        badge.className = "status-badge " + status;
        badge.textContent = status === "present" ? "Present" : status === "leave" ? "Paid Leave" : "Absent";
        inBox.disabled = !isPresent;
        outBox.disabled = !isPresent;
        if (!isPresent) { inBox.value = ""; outBox.value = ""; }
        updateHours(emp);
      }
      function updateHours(e) {
        var r = getDayRecord(attDate)[e.id] || {};
        if (r.status !== "present") {
          hours.textContent = "-";
          hours.classList.remove("earned");
          return;
        }
        var h = hoursBetween(r.in, r.out);
        var rate = dailyRate(e.salary, monthStrOf(attDate));
        hours.textContent = h + " h \u00B7 " + money(rate);
        hours.classList.add("earned");
      }
      refresh();
    });

    renderAttendanceSummary(active, day);
  }

  function renderAttendanceSummary(active, day) {
    var present = 0, leave = 0, absent = 0, hours = 0, pay = 0;
    var rate = dailyRate(
      active.reduce(function (s, e) { return s + e.salary; }, 0),
      monthStrOf(attDate)
    );
    active.forEach(function (e) {
      var r = day[e.id] || {};
      var st = r.status || "absent";
      if (st === "present") { present++; hours += hoursBetween(r.in, r.out); pay += dailyRate(e.salary, monthStrOf(attDate)); }
      else if (st === "leave") { leave++; pay += dailyRate(e.salary, monthStrOf(attDate)); }
      else absent++;
    });

    $("#attSummary").innerHTML =
      stat("Present", present) +
      stat("Paid Leave", leave) +
      stat("Absent", absent) +
      stat("Total Hours", hours.toFixed(2) + " h") +
      stat("Day Payroll", money(pay));

    function stat(label, val) {
      return '<div class="stat"><b>' + val + '</b><span>' + label + "</span></div>";
    }
  }

  /* ================= Employees ================= */
  function renderEmployees() {
    var list = $("#employeeList");
    list.innerHTML = "";
    if (employees.length === 0) {
      list.innerHTML = '<div class="empty-state"><p>No employees yet. Add your first employee.</p></div>';
      return;
    }
    employees.forEach(function (emp) {
      var row = document.createElement("div");
      row.className = "emp-row";

      var main = document.createElement("div");
      main.className = "emp-main";
      var nameEl = document.createElement("div");
      nameEl.className = "name";
      nameEl.textContent = emp.name;
      var meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = emp.id ? "" : "";
      meta.textContent = "Per working day: " + money(dailyRate(emp.salary, reportMonth));
      main.appendChild(nameEl);
      main.appendChild(meta);

      var sal = document.createElement("div");
      sal.className = "emp-salary";
      sal.textContent = money(emp.salary) + "/mo";

      var actions = document.createElement("div");
      actions.className = "emp-actions";
      var editBtn = document.createElement("button");
      editBtn.className = "icon-btn";
      editBtn.innerHTML = "\u270E";
      editBtn.title = "Edit";
      editBtn.addEventListener("click", function () { openEmployeeForm(emp); });
      var delBtn = document.createElement("button");
      delBtn.className = "icon-btn delete";
      delBtn.innerHTML = "\u2715";
      delBtn.title = "Delete";
      delBtn.addEventListener("click", function () { deleteEmployee(emp.id); });
      actions.appendChild(editBtn);
      actions.appendChild(delBtn);

      row.appendChild(main);
      row.appendChild(sal);
      row.appendChild(actions);
      list.appendChild(row);
    });
  }

  function openEmployeeForm(emp) {
    $("#employeeFormWrap").classList.remove("hidden");
    $("#employeeFormTitle").textContent = emp ? "Edit Employee" : "Add Employee";
    $("#empName").value = emp ? emp.name : "";
    $("#empSalary").value = emp ? emp.salary : "";
    $("#employeeForm").dataset.id = emp ? emp.id : "";
    $("#empName").focus();
  }

  function closeEmployeeForm() {
    $("#employeeFormWrap").classList.add("hidden");
  }

  function deleteEmployee(id) {
    var emp = employees.find(function (e) { return e.id === id; });
    if (!emp) return;
    if (!confirm('Delete "' + emp.name + '" and all their attendance records?')) return;
    employees = employees.filter(function (e) { return e.id !== id; });
    Object.keys(attendance).forEach(function (d) {
      if (attendance[d][id]) delete attendance[d][id];
    });
    persistEmployees();
    persistAttendance();
    renderEmployees();
    toast("Employee deleted");
  }

  /* ================= Reports ================= */
  function renderReports() {
    $("#reportMonth").value = reportMonth;
    var b = monthBounds(reportMonth);
    var active = employees.filter(function (e) { return e.active !== false; });
    var wd = workingDaysInMonth(reportMonth);

    var rows = active.map(function (emp) {
      var present = 0, leave = 0, absent = 0, hours = 0;
      for (var d = 1; d <= b.days; d++) {
        var ds = dateStr(b.year, b.month, d);
        var rec = (attendance[ds] && attendance[ds][emp.id]) || {};
        var st = rec.status || "absent";
        if (st === "present") { present++; hours += hoursBetween(rec.in, rec.out); }
        else if (st === "leave") leave++;
        else absent++;
      }
      var rate = dailyRate(emp.salary, reportMonth);
      var earned = (present + leave) * rate;
      return { emp: emp, present: present, leave: leave, absent: absent, hours: hours, earned: earned, rate: rate };
    });

    var totalPay = rows.reduce(function (s, r) { return s + r.earned; }, 0);
    var totalHours = rows.reduce(function (s, r) { return s + r.hours; }, 0);
    var totalMonthly = active.reduce(function (s, e) { return s + e.salary; }, 0);

    $("#reportSummary").innerHTML =
      '<div class="report-card highlight"><div class="label">Payroll To Be Paid</div><div class="value">' + money(totalPay) + "</div></div>" +
      '<div class="report-card"><div class="label">Employees</div><div class="value">' + active.length + "</div></div>" +
      '<div class="report-card"><div class="label">Working Days</div><div class="value">' + wd + "</div></div>" +
      '<div class="report-card"><div class="label">Total Hours Worked</div><div class="value">' + totalHours.toFixed(2) + ' h</div></div>' +
      '<div class="report-card"><div class="label">Combined Monthly Salary</div><div class="value">' + money(totalMonthly) + "</div></div>";

    var tbody = $("#reportTable tbody");
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
  }

  function esc(s) {
    var div = document.createElement("div");
    div.textContent = s;
    return div.innerHTML;
  }

  function exportCsv() {
    var b = monthBounds(reportMonth);
    var active = employees.filter(function (e) { return e.active !== false; });
    var lines = [
      "Employee,Monthly Salary,Present,Paid Leave,Absent,Hours Worked,Per-Day Rate,Salary This Month"
    ];
    var totalPay = 0;
    active.forEach(function (emp) {
      var present = 0, leave = 0, absent = 0, hours = 0;
      for (var d = 1; d <= b.days; d++) {
        var ds = dateStr(b.year, b.month, d);
        var rec = (attendance[ds] && attendance[ds][emp.id]) || {};
        var st = rec.status || "absent";
        if (st === "present") { present++; hours += hoursBetween(rec.in, rec.out); }
        else if (st === "leave") leave++;
        else absent++;
      }
      var rate = dailyRate(emp.salary, reportMonth);
      var earned = (present + leave) * rate;
      totalPay += earned;
      lines.push([
        '"' + emp.name.replace(/"/g, '""') + '"',
        emp.salary.toFixed(2),
        present, leave, absent,
        hours.toFixed(2),
        rate.toFixed(2),
        earned.toFixed(2)
      ].join(","));
    });
    lines.push([, , , , , , ,].join(","));
    lines.push(['"TOTAL"', , , , , , , totalPay.toFixed(2)].join(","));

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

  /* ================= Settings ================= */
  function renderSettingsForm() {
    $("#workingDays").value = String(settings.workingDays);
    $("#currency").value = settings.currency;
  }

  /* ================= Wiring ================= */
  function init() {
    // Tabs
    $all(".tab").forEach(function (b) {
      b.addEventListener("click", function () { switchTab(b.dataset.tab); });
    });
    $all("[data-goto]").forEach(function (b) {
      b.addEventListener("click", function () { switchTab(b.dataset.goto); });
    });

    // Attendance date nav
    $("#attDate").addEventListener("change", function () {
      if (!this.value) return;
      attDate = this.value;
      renderAttendance();
    });
    $("#prevDay").addEventListener("click", function () { attDate = addDays(attDate, -1); renderAttendance(); });
    $("#nextDay").addEventListener("click", function () { attDate = addDays(attDate, 1); renderAttendance(); });
    $("#todayBtn").addEventListener("click", function () { attDate = todayStr(); renderAttendance(); });

    // Employee form
    $("#addEmployeeBtn").addEventListener("click", function () { openEmployeeForm(null); });
    $("#cancelEmployeeForm").addEventListener("click", closeEmployeeForm);
    $("#employeeForm").addEventListener("submit", function (e) {
      e.preventDefault();
      var id = this.dataset.id;
      var name = $("#empName").value.trim();
      var salary = parseFloat($("#empSalary").value);
      if (!name || isNaN(salary) || salary < 0) {
        toast("Enter a valid name and salary", true);
        return;
      }
      if (id) {
        var emp = employees.find(function (x) { return x.id === id; });
        if (emp) { emp.name = name; emp.salary = salary; }
      } else {
        employees.push({ id: uid(), name: name, salary: salary, active: true });
      }
      persistEmployees();
      closeEmployeeForm();
      renderEmployees();
      toast(id ? "Employee updated" : "Employee added");
    });

    // Reports nav
    $("#reportMonth").addEventListener("change", function () {
      if (!this.value) return;
      reportMonth = this.value;
      renderReports();
    });
    $("#prevMonth").addEventListener("click", function () { reportMonth = shiftMonth(reportMonth, -1); renderReports(); });
    $("#nextMonth").addEventListener("click", function () { reportMonth = shiftMonth(reportMonth, 1); renderReports(); });
    $("#exportCsv").addEventListener("click", exportCsv);

    // Settings
    renderSettingsForm();
    $("#settingsForm").addEventListener("submit", function (e) {
      e.preventDefault();
      settings.workingDays = parseInt($("#workingDays").value, 10);
      settings.currency = ($("#currency").value.trim() || "\u20B9");
      persistSettings();
      toast("Settings saved");
    });
    $("#resetAll").addEventListener("click", function () {
      if (!confirm("This will erase ALL employees and attendance data. Continue?")) return;
      employees = [];
      attendance = {};
      persistEmployees();
      persistAttendance();
      switchTab(activeTab);
      toast("All data erased");
    });

    switchTab("attendance");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
