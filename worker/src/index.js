/* TKSR Payroll & Attendance API — Cloudflare Worker + D1 */

const enc = new TextEncoder();
const dec = new TextDecoder();

/* ---------------- HTTP helpers ---------------- */

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function corsHeaders(request) {
  return {
    'access-control-allow-origin': request ? request.headers.get('origin') || '*' : '*',
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-max-age': '86400',
    vary: 'Origin'
  };
}

function respond(data, status, request) {
  return new Response(JSON.stringify(data), {
    status: status || 200,
    headers: Object.assign({ 'content-type': 'application/json; charset=utf-8' }, corsHeaders(request))
  });
}

function badRequest(message, request) {
  return respond({ error: message }, 400, request);
}

/* ---------------- Encoding helpers ---------------- */

function b64(bytes) {
  let bin = '';
  bytes.forEach(function (b) { bin += String.fromCharCode(b); });
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function unb64(s) {
  s = s.replace(/-/g, '+').replace(/_/g, '/');
  while (s.length % 4) s += '=';
  const bin = atob(s);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

function hexBytes(hex) {
  const u8 = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) u8[i / 2] = parseInt(hex.substr(i, 2), 16);
  return u8;
}

function bytesHex(bytes) {
  return Array.from(bytes).map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
}

function randomSalt() {
  return bytesHex(crypto.getRandomValues(new Uint8Array(16)));
}

/* ---------------- Crypto: passwords & JWT ---------------- */

async function deriveKey(password, saltHex, iterations) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: hexBytes(saltHex), iterations: iterations || 100000 },
    key, 256
  );
  return bytesHex(new Uint8Array(bits));
}

function safeEqual(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

async function hmacKey(secret) {
  return crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign', 'verify']);
}

async function signJwt(payload, secret) {
  const h = b64(enc.encode(JSON.stringify({ alg: 'HS256', typ: 'JWT' })));
  const p = b64(enc.encode(JSON.stringify(payload)));
  const data = h + '.' + p;
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), enc.encode(data));
  return data + '.' + b64(new Uint8Array(sig));
}

async function verifyJwt(token, secret) {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  try {
    const data = parts[0] + '.' + parts[1];
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), unb64(parts[2]), enc.encode(data));
    if (!ok) return null;
    const payload = JSON.parse(dec.decode(unb64(parts[1])));
    if (!payload.exp || payload.exp * 1000 < Date.now()) return null;
    return payload;
  } catch (e) {
    return null;
  }
}

/* ---------------- Auth helpers ---------------- */

async function requireUser(request, env) {
  const h = request.headers.get('authorization') || '';
  if (!h.startsWith('Bearer ')) throw new HttpError(401, 'Not authenticated');
  const payload = await verifyJwt(h.slice(7), env.JWT_SECRET);
  if (!payload) throw new HttpError(401, 'Invalid or expired session');
  const user = await env.DB.prepare(
    'SELECT id, email, name, role, salary, active, created_at FROM users WHERE id = ?'
  ).bind(payload.sub).first();
  if (!user) throw new HttpError(401, 'User not found');
  if (!user.active) throw new HttpError(403, 'Account deactivated');
  return user;
}

function requireAdmin(user) {
  if (user.role !== 'admin') throw new HttpError(403, 'Admin access required');
}

async function getUserByEmail(env, email) {
  return env.DB.prepare('SELECT * FROM users WHERE lower(email) = lower(?)').bind(email).first();
}

/* ---------------- Handlers ---------------- */

async function handleSignup(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const name = String(body.name || '').trim();
  const password = String(body.password || '');

  if (!email || !name || password.length < 6) {
    throw new HttpError(400, 'Email, name and a password of at least 6 characters are required');
  }

  const count = await env.DB.prepare('SELECT COUNT(*) AS c FROM users').first();
  const isFirstUser = count.c === 0;

  if (!isFirstUser) {
    const admin = await requireUser(request, env);
    requireAdmin(admin);
  }

  const existing = await getUserByEmail(env, email);
  if (existing) throw new HttpError(409, 'An account with this email already exists');

  const salt = randomSalt();
  const hash = await deriveKey(password, salt);
  const role = isFirstUser ? 'admin' : (body.role === 'admin' ? 'admin' : 'employee');
  const salary = isNaN(parseFloat(body.salary)) ? 0 : Math.max(0, parseFloat(body.salary));
  const now = new Date().toISOString();

  const r = await env.DB.prepare(
    'INSERT INTO users (email, name, role, salary, password_hash, salt, active, created_at) VALUES (?,?,?,?,?,?,1,?)'
  ).bind(email, name, role, salary, hash, salt, now).run();

  const user = await env.DB.prepare(
    'SELECT id, email, name, role, salary, active, created_at FROM users WHERE id = ?'
  ).bind(r.meta.last_row_id).first();

  return respond({ user: user, firstUser: isFirstUser }, 201, request);
}

async function handleLogin(request, env) {
  const body = await request.json().catch(() => ({}));
  const email = String(body.email || '').trim().toLowerCase();
  const password = String(body.password || '');
  if (!email || !password) throw new HttpError(400, 'Email and password are required');

  const user = await getUserByEmail(env, email);
  if (!user) throw new HttpError(401, 'Invalid email or password');
  if (!user.active) throw new HttpError(403, 'Account deactivated');

  const hash = await deriveKey(password, user.salt);
  if (!safeEqual(hash, user.password_hash)) throw new HttpError(401, 'Invalid email or password');

  const token = await signJwt({
    sub: user.id,
    email: user.email,
    role: user.role,
    exp: Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30
  }, env.JWT_SECRET);

  return respond({
    token: token,
    user: { id: user.id, email: user.email, name: user.name, role: user.role, salary: user.salary, active: user.active }
  }, 200, request);
}

async function handleMe(request, env, user) {
  return respond({ user: user }, 200, request);
}

function localTimeHM() {
  // Worker runs in UTC; the client sends its local time instead. Fallback is UTC time.
  const d = new Date();
  return String(d.getUTCHours()).padStart(2, '0') + ':' + String(d.getUTCMinutes()).padStart(2, '0');
}

function validTime(t) {
  return typeof t === 'string' && /^([01]\d|2[0-3]):[0-5]\d$/.test(t);
}

async function handleClockIn(request, env, user) {
  if (user.role !== 'employee') throw new HttpError(400, 'Admin accounts do not clock in');
  const body = await request.json().catch(() => ({}));
  const date = String(body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Valid date (YYYY-MM-DD) required');
  const time = validTime(body.time) ? body.time : localTimeHM();

  const existing = await env.DB.prepare(
    'SELECT * FROM attendance WHERE user_id = ? AND work_date = ?'
  ).bind(user.id, date).first();
  if (existing) throw new HttpError(409, existing.clock_in ? 'Already clocked in for this date' : 'A record already exists for this date');

  const now = new Date().toISOString();
  const r = await env.DB.prepare(
    "INSERT INTO attendance (user_id, work_date, clock_in, clock_out, status, note, created_at) VALUES (?,?,?,NULL,'present',NULL,?)"
  ).bind(user.id, date, time, now).run();

  return respond({ ok: true, id: r.meta.last_row_id, work_date: date, clock_in: time }, 201, request);
}

async function handleClockOut(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const date = String(body.date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'Valid date (YYYY-MM-DD) required');
  const time = validTime(body.time) ? body.time : localTimeHM();

  const rec = await env.DB.prepare(
    'SELECT * FROM attendance WHERE user_id = ? AND work_date = ?'
  ).bind(user.id, date).first();
  if (!rec || !rec.clock_in) throw new HttpError(409, 'You have not clocked in for this date');
  if (rec.clock_out) throw new HttpError(409, 'Already clocked out for this date');

  await env.DB.prepare('UPDATE attendance SET clock_out = ? WHERE id = ?').bind(time, rec.id).run();

  return respond({ ok: true, id: rec.id, clock_in: rec.clock_in, clock_out: time }, 200, request);
}

async function handleMyStatus(request, env, user, url) {
  const date = url.searchParams.get('date');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date || '')) throw new HttpError(400, 'Valid date (YYYY-MM-DD) required');
  const rec = await env.DB.prepare(
    'SELECT id, work_date, clock_in, clock_out, status, note FROM attendance WHERE user_id = ? AND work_date = ?'
  ).bind(user.id, date).first();
  return respond({ date: date, record: rec || null }, 200, request);
}

async function handleMyAttendance(request, env, user, url) {
  const month = url.searchParams.get('month') || new Date().toISOString().slice(0, 7);
  const rows = await env.DB.prepare(
    "SELECT id, work_date, clock_in, clock_out, status, note FROM attendance WHERE user_id = ? AND work_date LIKE ? ORDER BY work_date"
  ).bind(user.id, month + '%').all();
  return respond({ month: month, records: rows.results }, 200, request);
}

/* Employee: clock correction requests */

function validCorrectionReason(r) {
  return ['forgot_clock_out', 'clocked_out_early', 'forgot_clock_in', 'wrong_time', 'other'].indexOf(r) >= 0;
}

async function handleCreateCorrection(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const workDate = String(body.work_date || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(workDate)) throw new HttpError(400, 'Valid date (YYYY-MM-DD) required');
  const reason = String(body.reason || '').trim();
  if (!validCorrectionReason(reason)) throw new HttpError(400, 'Valid reason required');
  const note = body.note ? String(body.note).trim() : '';
  const reqIn = validTime(body.requested_clock_in) ? body.requested_clock_in : null;
  const reqOut = validTime(body.requested_clock_out) ? body.requested_clock_out : null;

  if (!reqIn && !reqOut && !note) throw new HttpError(400, 'Provide the correct clock time(s) or a note');
  if (reason === 'other' && !note) throw new HttpError(400, 'Please describe the issue in the note');

  const dup = await env.DB.prepare(
    "SELECT id FROM corrections WHERE user_id = ? AND work_date = ? AND status = 'pending'"
  ).bind(user.id, workDate).first();
  if (dup) throw new HttpError(409, 'You already have a pending request for this date');

  const cur = await env.DB.prepare(
    'SELECT clock_in, clock_out FROM attendance WHERE user_id = ? AND work_date = ?'
  ).bind(user.id, workDate).first();

  const now = new Date().toISOString();
  const r = await env.DB.prepare(
    "INSERT INTO corrections (user_id, work_date, reason, note, current_clock_in, current_clock_out, requested_clock_in, requested_clock_out, status, admin_note, created_at, decided_at, decided_by) VALUES (?,?,?,?,?,?,?,?,'pending',NULL,?,NULL,NULL)"
  ).bind(user.id, workDate, reason, note, cur ? cur.clock_in : null, cur ? cur.clock_out : null, reqIn, reqOut, now).run();

  const row = await env.DB.prepare('SELECT * FROM corrections WHERE id = ?').bind(r.meta.last_row_id).first();
  return respond({ correction: row }, 201, request);
}

async function handleMyCorrections(request, env, user) {
  const rows = await env.DB.prepare(
    'SELECT * FROM corrections WHERE user_id = ? ORDER BY created_at DESC'
  ).bind(user.id).all();
  return respond({ corrections: rows.results }, 200, request);
}

/* Admin: correction requests */

async function handleListCorrections(request, env, url) {
  const status = url.searchParams.get('status');
  let rows;
  if (status && ['pending', 'approved', 'rejected'].indexOf(status) >= 0) {
    rows = await env.DB.prepare(
      "SELECT c.*, u.name AS user_name, u.email AS user_email FROM corrections c JOIN users u ON u.id = c.user_id WHERE c.status = ? ORDER BY (c.status = 'pending') DESC, c.created_at DESC"
    ).bind(status).all();
  } else {
    rows = await env.DB.prepare(
      "SELECT c.*, u.name AS user_name, u.email AS user_email FROM corrections c JOIN users u ON u.id = c.user_id ORDER BY (c.status = 'pending') DESC, c.created_at DESC"
    ).all();
  }
  return respond({ corrections: rows.results }, 200, request);
}

async function handleDecideCorrection(request, env, url, admin, approve) {
  const parts = url.pathname.split('/');
  const id = parts[parts.length - 2];
  if (!/^\d+$/.test(id)) throw new HttpError(400, 'Invalid correction id');
  const body = await request.json().catch(() => ({}));
  const adminNote = body.admin_note ? String(body.admin_note).trim() : '';

  const corr = await env.DB.prepare('SELECT * FROM corrections WHERE id = ?').bind(id).first();
  if (!corr) throw new HttpError(404, 'Correction request not found');
  if (corr.status !== 'pending') throw new HttpError(400, 'This request has already been decided');

  const now = new Date().toISOString();

  if (approve) {
    const existing = await env.DB.prepare(
      'SELECT * FROM attendance WHERE user_id = ? AND work_date = ?'
    ).bind(corr.user_id, corr.work_date).first();
    if (existing) {
      const newIn = corr.requested_clock_in != null ? corr.requested_clock_in : existing.clock_in;
      const newOut = corr.requested_clock_out != null ? corr.requested_clock_out : existing.clock_out;
      await env.DB.prepare('UPDATE attendance SET clock_in = ?, clock_out = ? WHERE id = ?')
        .bind(newIn, newOut, existing.id).run();
    } else {
      await env.DB.prepare(
        "INSERT INTO attendance (user_id, work_date, clock_in, clock_out, status, note, created_at) VALUES (?,?,?,?,'present',?,?)"
      ).bind(corr.user_id, corr.work_date, corr.requested_clock_in, corr.requested_clock_out, adminNote || 'Corrected via request', now).run();
    }
  }

  await env.DB.prepare(
    'UPDATE corrections SET status = ?, admin_note = ?, decided_at = ?, decided_by = ? WHERE id = ?'
  ).bind(approve ? 'approved' : 'rejected', adminNote || null, now, admin.id, corr.id).run();

  const updated = await env.DB.prepare('SELECT * FROM corrections WHERE id = ?').bind(corr.id).first();
  return respond({ correction: updated }, 200, request);
}

async function handleApproveCorrection(request, env, url, admin) {
  return handleDecideCorrection(request, env, url, admin, true);
}

async function handleRejectCorrection(request, env, url, admin) {
  return handleDecideCorrection(request, env, url, admin, false);
}

/* Admin: users */

async function handleListUsers(request, env) {
  const rows = await env.DB.prepare(
    'SELECT id, email, name, role, salary, active, created_at FROM users ORDER BY role DESC, name'
  ).all();
  return respond({ users: rows.results }, 200, request);
}

async function handleCreateUser(request, env) {
  return handleSignup(request, env);
}

async function handleUpdateUser(request, env, url) {
  const id = url.pathname.split('/').pop();
  if (!/^\d+$/.test(id)) throw new HttpError(400, 'Invalid user id');
  const body = await request.json().catch(() => ({}));

  const current = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!current) throw new HttpError(404, 'User not found');

  const name = body.name !== undefined ? String(body.name).trim() : current.name;
  const salary = body.salary !== undefined ? Math.max(0, parseFloat(body.salary) || 0) : current.salary;
  const role = body.role !== undefined ? (body.role === 'admin' ? 'admin' : 'employee') : current.role;
  const active = body.active !== undefined ? (body.active ? 1 : 0) : current.active;

  await env.DB.prepare(
    'UPDATE users SET name = ?, salary = ?, role = ?, active = ? WHERE id = ?'
  ).bind(name, salary, role, active, id).run();

  if (body.password) {
    if (String(body.password).length < 6) throw new HttpError(400, 'Password must be at least 6 characters');
    const salt = randomSalt();
    const hash = await deriveKey(String(body.password), salt);
    await env.DB.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?').bind(hash, salt, id).run();
  }

  const updated = await env.DB.prepare(
    'SELECT id, email, name, role, salary, active, created_at FROM users WHERE id = ?'
  ).bind(id).first();
  return respond({ user: updated }, 200, request);
}

async function handleDeleteUser(request, env, url) {
  const id = url.pathname.split('/').pop();
  if (!/^\d+$/.test(id)) throw new HttpError(400, 'Invalid user id');
  const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first();
  if (!user) throw new HttpError(404, 'User not found');
  if (user.role === 'admin') {
    const admins = await env.DB.prepare("SELECT COUNT(*) AS c FROM users WHERE role = 'admin'").first();
    if (admins.c <= 1) throw new HttpError(400, 'Cannot delete the last admin account');
  }
  await env.DB.prepare('DELETE FROM attendance WHERE user_id = ?').bind(id).run();
  await env.DB.prepare('DELETE FROM users WHERE id = ?').bind(id).run();
  return respond({ ok: true }, 200, request);
}

/* Admin: attendance */

async function handleListAttendance(request, env, url) {
  const date = url.searchParams.get('date');
  const month = url.searchParams.get('month');
  let rows;
  if (date) {
    rows = await env.DB.prepare(
      "SELECT a.id, a.user_id, a.work_date, a.clock_in, a.clock_out, a.status, a.note, u.name AS user_name, u.email AS user_email FROM attendance a JOIN users u ON u.id = a.user_id WHERE a.work_date = ? ORDER BY u.name"
    ).bind(date).all();
  } else if (month) {
    rows = await env.DB.prepare(
      "SELECT a.id, a.user_id, a.work_date, a.clock_in, a.clock_out, a.status, a.note, u.name AS user_name, u.email AS user_email FROM attendance a JOIN users u ON u.id = a.user_id WHERE a.work_date LIKE ? ORDER BY a.work_date, u.name"
    ).bind(month + '%').all();
  } else {
    throw new HttpError(400, 'Provide ?date=YYYY-MM-DD or ?month=YYYY-MM');
  }
  return respond({ records: rows.results }, 200, request);
}

async function handleUpsertAttendance(request, env) {
  const body = await request.json().catch(() => ({}));
  const userId = parseInt(body.user_id, 10);
  const date = String(body.date || '').trim();
  const status = ['present', 'leave', 'absent'].indexOf(body.status) >= 0 ? body.status : 'present';
  if (!/^\d+$/.test(String(userId))) throw new HttpError(400, 'user_id required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new HttpError(400, 'date (YYYY-MM-DD) required');

  const user = await env.DB.prepare('SELECT id FROM users WHERE id = ?').bind(userId).first();
  if (!user) throw new HttpError(404, 'User not found');

  const clockIn = body.clock_in ? String(body.clock_in) : null;
  const clockOut = body.clock_out ? String(body.clock_out) : null;
  const note = body.note ? String(body.note).slice(0, 500) : null;

  const existing = await env.DB.prepare(
    'SELECT id FROM attendance WHERE user_id = ? AND work_date = ?'
  ).bind(userId, date).first();

  let id;
  if (existing) {
    await env.DB.prepare(
      'UPDATE attendance SET status = ?, clock_in = ?, clock_out = ?, note = ? WHERE id = ?'
    ).bind(status, clockIn, clockOut, note, existing.id).run();
    id = existing.id;
  } else {
    const r = await env.DB.prepare(
      "INSERT INTO attendance (user_id, work_date, clock_in, clock_out, status, note, created_at) VALUES (?,?,?,?,?,?,?)"
    ).bind(userId, date, clockIn, clockOut, status, note, new Date().toISOString()).run();
    id = r.meta.last_row_id;
  }

  const rec = await env.DB.prepare('SELECT * FROM attendance WHERE id = ?').bind(id).first();
  return respond({ record: rec }, 200, request);
}

async function handleDeleteAttendance(request, env, url) {
  const id = url.pathname.split('/').pop();
  if (!/^\d+$/.test(id)) throw new HttpError(400, 'Invalid record id');
  await env.DB.prepare('DELETE FROM attendance WHERE id = ?').bind(id).run();
  return respond({ ok: true }, 200, request);
}

/* Settings */

async function handleGetSettings(request, env) {
  const rows = await env.DB.prepare('SELECT key, value FROM settings').all();
  const s = { work_days_per_week: 6, currency: '\u20B9' };
  rows.results.forEach(function (r) {
    const v = parseInt(r.value, 10);
    if (r.key === 'work_days_per_week' && !isNaN(v)) s.work_days_per_week = v;
    else s[r.key] = r.value;
  });
  return respond({ settings: s }, 200, request);
}

async function handleUpdateSettings(request, env) {
  const body = await request.json().catch(() => ({}));
  if (body.work_days_per_week !== undefined) {
    const v = parseInt(body.work_days_per_week, 10);
    if ([5, 6, 7].indexOf(v) < 0) throw new HttpError(400, 'work_days_per_week must be 5, 6 or 7');
    await env.DB.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).bind('work_days_per_week', String(v)).run();
  }
  if (body.currency !== undefined) {
    const c = String(body.currency).trim().slice(0, 4);
    if (c) await env.DB.prepare(
      'INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).bind('currency', c).run();
  }
  return handleGetSettings(request, env);
}

/* ---------------- Router ---------------- */

async function route(request, env, url) {
  const path = url.pathname.replace(/\/+$/, '') || '/';
  const method = request.method;

  const adminOnly = async function (fn) {
    const user = await requireUser(request, env);
    requireAdmin(user);
    return fn(request, env, url, user);
  };

  // auth
  if (path === '/api/auth/signup' && method === 'POST') return handleSignup(request, env);
  if (path === '/api/auth/login' && method === 'POST') return handleLogin(request, env);

  // authenticated
  if (path === '/api/me' && method === 'GET') {
    const user = await requireUser(request, env);
    return handleMe(request, env, user);
  }
  if (path === '/api/me/status' && method === 'GET') {
    const user = await requireUser(request, env);
    return handleMyStatus(request, env, user, url);
  }
  if (path === '/api/me/attendance' && method === 'GET') {
    const user = await requireUser(request, env);
    return handleMyAttendance(request, env, user, url);
  }
  if (path === '/api/clock/in' && method === 'POST') {
    const user = await requireUser(request, env);
    return handleClockIn(request, env, user);
  }
  if (path === '/api/clock/out' && method === 'POST') {
    const user = await requireUser(request, env);
    return handleClockOut(request, env, user);
  }

  // admin: users
  if (path === '/api/users' && method === 'GET') return adminOnly(handleListUsers);
  if (path === '/api/users' && method === 'POST') return adminOnly(handleCreateUser);
  if (/^\/api\/users\/\d+$/.test(path) && method === 'PUT') return adminOnly(handleUpdateUser);
  if (/^\/api\/users\/\d+$/.test(path) && method === 'DELETE') return adminOnly(handleDeleteUser);

  // admin: attendance
  if (path === '/api/attendance' && method === 'GET') return adminOnly(handleListAttendance);
  if (path === '/api/attendance' && method === 'POST') return adminOnly(handleUpsertAttendance);
  if (/^\/api\/attendance\/\d+$/.test(path) && method === 'DELETE') return adminOnly(handleDeleteAttendance);

  // settings
  if (path === '/api/settings' && method === 'GET') {
    const user = await requireUser(request, env);
    return handleGetSettings(request, env);
  }
  if (path === '/api/settings' && method === 'PUT') return adminOnly(handleUpdateSettings);

  // corrections
  if (path === '/api/corrections' && method === 'POST') {
    const user = await requireUser(request, env);
    return handleCreateCorrection(request, env, user);
  }
  if (path === '/api/corrections/mine' && method === 'GET') {
    const user = await requireUser(request, env);
    return handleMyCorrections(request, env, user);
  }
  if (path === '/api/corrections' && method === 'GET') return adminOnly(handleListCorrections);
  if (/^\/api\/corrections\/\d+\/approve$/.test(path) && method === 'POST') return adminOnly(handleApproveCorrection);
  if (/^\/api\/corrections\/\d+\/reject$/.test(path) && method === 'POST') return adminOnly(handleRejectCorrection);

  if (path === '/api' || path === '/') {
    return respond({ ok: true, service: 'tksr-payroll-api' }, 200, request);
  }

  return respond({ error: 'Not found' }, 404, request);
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders(request) });
    }
    try {
      return await route(request, env, new URL(request.url));
    } catch (e) {
      if (e instanceof HttpError) return respond({ error: e.message }, e.status, request);
      return respond({ error: 'Internal server error: ' + (e && e.message ? e.message : e) }, 500, request);
    }
  }
};
