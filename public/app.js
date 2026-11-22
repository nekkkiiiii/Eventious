/* Eventious: event management frontend (data stored in MySQL via the API) */

const SEEN_KEY = "eventious.seenNotifs";
const PUSHED_KEY = "eventious.pushedNotifs";
const MONTHS = ["Jan","Feb","Mar","Apr","May","Jun","Jul","Aug","Sep","Oct","Nov","Dec"];
const MONTHS_FULL = ["January","February","March","April","May","June","July","August","September","October","November","December"];

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

/* ---------- Storage ---------- */
function load(key, fallback) {
  try { return JSON.parse(localStorage.getItem(key)) ?? fallback; }
  catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* storage unavailable */ }
}

/* ---------- API ---------- */
async function api(method, url, body) {
  let res;
  try {
    res = await fetch(url, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      body: body ? JSON.stringify(body) : undefined,
      credentials: "same-origin",
    });
  } catch {
    throw new Error("Can't reach the server. Check your connection.");
  }
  if (res.status === 401) {
    window.location.href = "/login.html";
    throw new Error("Session expired");
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Something went wrong.");
  return data;
}

let events = [];
let currentUser = null;
const isAdmin = () => currentUser?.role === "admin";

function replaceEvent(ev) {
  const i = events.findIndex((x) => x.id === ev.id);
  if (i >= 0) events[i] = ev; else events.push(ev);
}

/* ---------- Date helpers ---------- */
function parseYMD(str) {
  const [y, m, d] = str.split("-").map(Number);
  return new Date(y, m - 1, d);
}
function toYMD(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())}`;
}
function today() {
  const t = new Date(); t.setHours(0, 0, 0, 0); return t;
}
function daysUntil(ymd) {
  return Math.round((parseYMD(ymd) - today()) / 86400000);
}
function formatDate(ymd) {
  const d = parseYMD(ymd);
  return d.toLocaleDateString(undefined, { weekday: "short", month: "short", day: "numeric", year: "numeric" });
}
function formatTime(t) {
  if (!t) return "";
  const [h, m] = t.split(":").map(Number);
  const ampm = h >= 12 ? "PM" : "AM";
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, "0")} ${ampm}`;
}
function relative(days) {
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  if (days === -1) return "Yesterday";
  if (days < 0) return `${-days} days ago`;
  return `In ${days} days`;
}

/* ---------- Event helpers ---------- */
function statusOf(ev) {
  const d = daysUntil(ev.date);
  if (d < 0) return "past";
  if (d <= 1) return "urgent";
  if (d <= Number(ev.remindDays || 3)) return "soon";
  return "later";
}
function needsProgress(ev) {
  const total = ev.needs.length;
  const ready = ev.needs.filter((n) => n.ready).length;
  return { total, ready, pct: total ? Math.round((ready / total) * 100) : 100 };
}
const sortByDate = (a, b) => (a.date + (a.time || "")).localeCompare(b.date + (b.time || ""));
const upcoming = () => events.filter((e) => daysUntil(e.date) >= 0).sort(sortByDate);

function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

/* ---------- Notifications ---------- */
function getReminders() {
  return upcoming()
    .filter((ev) => statusOf(ev) !== "later")
    .map((ev) => {
      const d = daysUntil(ev.date);
      const p = needsProgress(ev);
      const pending = p.total - p.ready;
      let sub = `${relative(d)} · ${formatDate(ev.date)}${ev.time ? " at " + formatTime(ev.time) : ""}`;
      if (pending > 0) sub += ` · ${pending} need${pending > 1 ? "s" : ""} not ready`;
      return {
        key: `${ev.id}|${ev.date}|${d}`,
        id: ev.id,
        level: d <= 1 ? "urgent" : "soon",
        title: d === 0 ? `${ev.name} is today!` : d === 1 ? `${ev.name} is tomorrow` : `${ev.name} is coming up`,
        sub,
        pending,
      };
    });
}

function renderNotifications() {
  const reminders = getReminders();
  const seen = new Set(load(SEEN_KEY, []));
  const unseen = reminders.filter((r) => !seen.has(r.key)).length;

  const badge = $("#bellBadge");
  badge.textContent = unseen;
  badge.classList.toggle("hidden", unseen === 0);

  const html = reminders.length
    ? reminders.map((r) => `
        <li data-open="${r.id}">
          <span class="dot ${r.level}"></span>
          <div><div class="notif-title">${esc(r.title)}</div><div class="notif-sub">${esc(r.sub)}</div></div>
        </li>`).join("")
    : `<li class="empty">No reminders right now 🎉</li>`;
  $("#notifList").innerHTML = html;
  $("#dashReminders").innerHTML = html;

  updatePushButton();
  pushDesktopNotifications(reminders);
}

function markNotificationsSeen() {
  save(SEEN_KEY, getReminders().map((r) => r.key));
  renderNotifications();
}

function updatePushButton() {
  const btn = $("#enablePushBtn");
  if (!("Notification" in window)) { btn.classList.add("hidden"); return; }
  if (Notification.permission === "granted") { btn.textContent = "Desktop alerts on ✓"; btn.disabled = true; }
  else if (Notification.permission === "denied") { btn.textContent = "Alerts blocked in browser"; btn.disabled = true; }
}

function pushDesktopNotifications(reminders) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const pushed = new Set(load(PUSHED_KEY, []));
  reminders.forEach((r) => {
    if (pushed.has(r.key)) return;
    try {
      const n = new Notification(r.title, { body: r.sub, tag: r.key });
      n.onclick = () => { window.focus(); openDetail(r.id); };
    } catch { /* some browsers need a service worker */ }
    pushed.add(r.key);
  });
  save(PUSHED_KEY, [...pushed].slice(-200));
}

/* ---------- Rendering ---------- */
function dateBox(ymd) {
  const d = parseYMD(ymd);
  return `<div class="date-box"><div class="m">${MONTHS[d.getMonth()]}</div><div class="d">${d.getDate()}</div></div>`;
}
function statusPill(ev) {
  const s = statusOf(ev);
  const d = daysUntil(ev.date);
  const label = s === "past" ? "Done" : relative(d);
  return `<span class="pill ${s}">${label}</span>`;
}

function renderDashboard() {
  const up = upcoming();
  const thisWeek = up.filter((e) => daysUntil(e.date) <= 7).length;
  const pendingNeeds = up.reduce((sum, e) => sum + e.needs.filter((n) => !n.ready).length, 0);
  const thisMonth = up.filter((e) => {
    const d = parseYMD(e.date), t = today();
    return d.getMonth() === t.getMonth() && d.getFullYear() === t.getFullYear();
  }).length;

  $("#stats").innerHTML = [
    ["Upcoming events", up.length],
    ["This week", thisWeek],
    ["This month", thisMonth],
    ["Needs not ready", pendingNeeds],
  ].map(([label, num]) => `<div class="stat"><div class="num">${num}</div><div class="label">${label}</div></div>`).join("");

  $("#dashUpcoming").innerHTML = up.length
    ? up.slice(0, 6).map((ev) => {
        const p = needsProgress(ev);
        return `
        <div class="event-row" data-open="${ev.id}">
          ${dateBox(ev.date)}
          <div class="info">
            <div class="name">${esc(ev.name)}</div>
            <div class="muted small">${ev.time ? formatTime(ev.time) + " · " : ""}${esc(ev.venue || "No venue set")} · ${p.ready}/${p.total} needs ready</div>
          </div>
          ${statusPill(ev)}
        </div>`;
      }).join("")
    : `<div class="empty-state">No upcoming events yet. Click <strong>+ New Event</strong> to add one.</div>`;
}

function renderEvents() {
  const q = $("#searchInput").value.trim().toLowerCase();
  const filter = $("#filterSelect").value;
  let list = [...events];
  if (filter === "upcoming") list = list.filter((e) => daysUntil(e.date) >= 0).sort(sortByDate);
  else if (filter === "past") list = list.filter((e) => daysUntil(e.date) < 0).sort((a, b) => sortByDate(b, a));
  else list.sort(sortByDate);

  if (q) {
    list = list.filter((e) =>
      [e.name, e.venue, e.client, e.category, e.notes, ...e.needs.map((n) => n.name)]
        .join(" ").toLowerCase().includes(q));
  }

  $("#eventsList").innerHTML = list.length
    ? list.map((ev) => {
        const p = needsProgress(ev);
        return `
        <div class="card event-card" data-open="${ev.id}">
          <div class="top">
            <div>
              <span class="pill later" style="margin-bottom:6px">${esc(ev.category)}</span>
              <h3>${esc(ev.name)}</h3>
            </div>
            ${statusPill(ev)}
          </div>
          <div class="meta">
            <span>📅 ${formatDate(ev.date)}${ev.time ? " · " + formatTime(ev.time) : ""}</span>
            ${ev.venue ? `<span>📍 ${esc(ev.venue)}</span>` : ""}
            ${ev.client ? `<span>👤 ${esc(ev.client)}</span>` : ""}
            ${isAdmin() && ev.createdBy ? `<span>✍️ Booked by ${esc(ev.createdBy)}</span>` : ""}
          </div>
          ${ev.needs.length ? `<div class="needs-mini">${ev.needs.map((n) => `<span>${esc(n.name)} × ${n.qty}</span>`).join("")}</div>` : ""}
          <div>
            <div class="muted small" style="margin-bottom:4px">${p.ready}/${p.total} needs ready</div>
            <div class="progress"><div style="width:${p.pct}%"></div></div>
          </div>
        </div>`;
      }).join("")
    : `<div class="empty-state" style="grid-column:1/-1">No events found.</div>`;
}

let calMonth = today();
calMonth.setDate(1);

function renderCalendar() {
  const y = calMonth.getFullYear(), m = calMonth.getMonth();
  $("#calTitle").textContent = `${MONTHS_FULL[m]} ${y}`;
  const start = new Date(y, m, 1 - new Date(y, m, 1).getDay());
  const todayStr = toYMD(today());

  const byDate = {};
  events.forEach((e) => (byDate[e.date] ||= []).push(e));

  let html = ["Sun","Mon","Tue","Wed","Thu","Fri","Sat"].map((d) => `<div class="cal-dow">${d}</div>`).join("");
  for (let i = 0; i < 42; i++) {
    const d = new Date(start.getFullYear(), start.getMonth(), start.getDate() + i);
    const ymd = toYMD(d);
    const cls = ["cal-cell", d.getMonth() !== m ? "other" : "", ymd === todayStr ? "today" : ""].join(" ");
    const evs = (byDate[ymd] || []).sort(sortByDate);
    html += `<div class="${cls}" data-date="${ymd}">
      <div class="num">${d.getDate()}</div>
      ${evs.map((e) => `<div class="cal-event ${daysUntil(e.date) < 0 ? "past" : ""}" data-open="${e.id}" title="${esc(e.name)}">${e.time ? formatTime(e.time) + " " : ""}${esc(e.name)}</div>`).join("")}
    </div>`;
  }
  $("#calGrid").innerHTML = html;
}

function renderNeedsSummary() {
  const up = upcoming();
  const totals = {};
  up.forEach((ev) => ev.needs.forEach((n) => {
    const key = n.name.trim().toLowerCase();
    if (!key) return;
    totals[key] ||= { name: n.name.trim(), qty: 0, ready: 0, events: [] };
    totals[key].qty += Number(n.qty) || 0;
    if (n.ready) totals[key].ready += Number(n.qty) || 0;
    totals[key].events.push(ev.name);
  }));
  const rows = Object.values(totals).sort((a, b) => b.qty - a.qty);

  $("#needsSummary").innerHTML = rows.length
    ? `<table>
        <thead><tr><th>Item</th><th class="num">Total needed</th><th class="num">Ready</th><th class="num">Still needed</th><th>Used in</th></tr></thead>
        <tbody>${rows.map((r) => {
          const left = r.qty - r.ready;
          return `<tr>
            <td><strong>${esc(r.name)}</strong></td>
            <td class="num">${r.qty}</td>
            <td class="num">${r.ready}</td>
            <td class="num">${left > 0 ? `<span class="pill soon">${left}</span>` : `<span class="pill ok">0</span>`}</td>
            <td class="muted small">${esc([...new Set(r.events)].join(", "))}</td>
          </tr>`;
        }).join("")}</tbody>
      </table>`
    : `<div class="empty-state">No needs listed for upcoming events.</div>`;
}

function renderAll() {
  renderDashboard();
  renderEvents();
  renderCalendar();
  renderNeedsSummary();
  renderNotifications();
}

/* ---------- Users (admin only) ---------- */
let users = [];

async function loadUsers() {
  if (!isAdmin()) return;
  $("#usersTable").innerHTML = `<div class="loading">Loading users…</div>`;
  try {
    users = (await api("GET", "/api/users")).users;
    renderUsers();
  } catch (err) {
    $("#usersTable").innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
  }
}

function renderUsers() {
  $("#usersTable").innerHTML = `<div class="table-wrap"><table>
    <thead><tr><th>Name</th><th>Email</th><th>Role</th><th class="num">Events</th><th>Joined</th><th></th></tr></thead>
    <tbody>${users.map((u) => {
      const self = u.id === currentUser.id;
      return `<tr>
        <td><strong>${esc(u.name)}</strong>${self ? ` <span class="muted small">(you)</span>` : ""}</td>
        <td>${esc(u.email)}</td>
        <td>${self
          ? `<span class="pill admin">admin</span>`
          : `<select class="role-select" data-user="${u.id}">
               <option value="client" ${u.role === "client" ? "selected" : ""}>Client</option>
               <option value="admin" ${u.role === "admin" ? "selected" : ""}>Admin</option>
             </select>`}</td>
        <td class="num">${u.eventCount}</td>
        <td class="muted small">${esc(String(u.createdAt).slice(0, 10))}</td>
        <td>${self ? "" : `<button class="btn danger" data-delete-user="${u.id}">Remove</button>`}</td>
      </tr>`;
    }).join("")}</tbody>
  </table></div>`;
}

$("#usersTable").addEventListener("change", async (e) => {
  const sel = e.target.closest(".role-select");
  if (!sel) return;
  const u = users.find((x) => String(x.id) === sel.dataset.user);
  sel.disabled = true;
  try {
    await api("PATCH", `/api/users/${u.id}`, { role: sel.value });
    u.role = sel.value;
    toast(`${u.name} is now ${sel.value === "admin" ? "an admin" : "a client"}`);
  } catch (err) {
    sel.value = u.role;
    toast(err.message);
  } finally {
    sel.disabled = false;
  }
});

$("#usersTable").addEventListener("click", async (e) => {
  const btn = e.target.closest("[data-delete-user]");
  if (!btn) return;
  const u = users.find((x) => String(x.id) === btn.dataset.deleteUser);
  if (!confirm(`Remove ${u.name}? Their ${u.eventCount} event(s) will be deleted too. This cannot be undone.`)) return;
  try {
    await api("DELETE", `/api/users/${u.id}`);
    users = users.filter((x) => x !== u);
    events = (await api("GET", "/api/events")).events;
    renderUsers();
    renderAll();
    toast("User removed");
  } catch (err) {
    toast(err.message);
  }
});

/* ---------- Event form ---------- */
function addNeedRow(item = { name: "", qty: 1, ready: false }) {
  const row = document.createElement("div");
  row.className = "need-row";
  row.innerHTML = `
    <input type="text" class="n-name" placeholder="Item name" value="${esc(item.name)}" required />
    <input type="number" class="n-qty" min="1" value="${Number(item.qty) || 1}" />
    <input type="checkbox" class="n-ready" ${item.ready ? "checked" : ""} title="Mark as ready / secured" />
    <button type="button" class="icon-btn n-remove" aria-label="Remove">✕</button>`;
  row.querySelector(".n-remove").onclick = () => { row.remove(); toggleNeedsEmpty(); };
  $("#needsRows").appendChild(row);
  toggleNeedsEmpty();
  return row;
}
function toggleNeedsEmpty() {
  $("#needsEmpty").classList.toggle("hidden", $("#needsRows").children.length > 0);
}

function openForm(ev = null) {
  $("#eventForm").reset();
  $("#needsRows").innerHTML = "";
  $("#modalTitle").textContent = ev ? "Edit Event" : "New Event";
  $("#deleteBtn").classList.toggle("hidden", !ev);
  $("#eventId").value = ev?.id || "";
  $("#fName").value = ev?.name || "";
  $("#fDate").value = ev?.date || toYMD(today());
  $("#fTime").value = ev?.time || "";
  $("#fVenue").value = ev?.venue || "";
  $("#fClient").value = ev?.client || "";
  $("#fCategory").value = ev?.category || "Wedding";
  $("#fRemind").value = String(ev?.remindDays || 3);
  $("#fNotes").value = ev?.notes || "";
  if (ev) ev.needs.forEach((n) => addNeedRow(n));
  else ["Tables", "Chairs", "Tents", "Utensils"].forEach((name) => addNeedRow({ name, qty: 1, ready: false }));
  toggleNeedsEmpty();
  showModal("#eventModal");
  setTimeout(() => $("#fName").focus(), 50);
}

$("#quickAdd").addEventListener("click", (e) => {
  const chip = e.target.closest(".chip");
  if (!chip) return;
  const name = chip.dataset.item;
  const existing = [...$$("#needsRows .n-name")].find((i) => name && i.value.trim().toLowerCase() === name.toLowerCase());
  if (existing) {
    const qty = existing.parentElement.querySelector(".n-qty");
    qty.focus(); qty.select();
    return;
  }
  const row = addNeedRow({ name, qty: 1, ready: false });
  (name ? row.querySelector(".n-qty") : row.querySelector(".n-name")).focus();
});

$("#eventForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id = $("#eventId").value;
  const submitBtn = e.submitter || $("#eventForm [type=submit]");
  const needs = [...$$("#needsRows .need-row")]
    .map((r) => ({
      name: r.querySelector(".n-name").value.trim(),
      qty: Math.max(1, parseInt(r.querySelector(".n-qty").value, 10) || 1),
      ready: r.querySelector(".n-ready").checked,
    }))
    .filter((n) => n.name);

  const data = {
    name: $("#fName").value.trim(),
    date: $("#fDate").value,
    time: $("#fTime").value,
    venue: $("#fVenue").value.trim(),
    client: $("#fClient").value.trim(),
    category: $("#fCategory").value,
    remindDays: Number($("#fRemind").value),
    notes: $("#fNotes").value.trim(),
    needs,
  };

  submitBtn.disabled = true;
  try {
    const { event } = id
      ? await api("PUT", `/api/events/${id}`, data)
      : await api("POST", "/api/events", data);
    replaceEvent(event);
    hideModals();
    renderAll();
    toast(id ? "Event updated" : "Event added");
  } catch (err) {
    toast(err.message);
  } finally {
    submitBtn.disabled = false;
  }
});

$("#deleteBtn").addEventListener("click", async () => {
  const id = $("#eventId").value;
  const ev = events.find((x) => x.id === id);
  if (!ev || !confirm(`Delete "${ev.name}"? This cannot be undone.`)) return;
  try {
    await api("DELETE", `/api/events/${id}`);
    events = events.filter((x) => x.id !== id);
    hideModals();
    renderAll();
    toast("Event deleted");
  } catch (err) {
    toast(err.message);
  }
});

/* ---------- Detail view ---------- */
let detailId = null;
function openDetail(id) {
  const ev = events.find((x) => x.id === id);
  if (!ev) return;
  detailId = id;
  const p = needsProgress(ev);
  $("#detailTitle").textContent = ev.name;
  $("#detailBody").innerHTML = `
    <div style="margin-bottom:14px">${statusPill(ev)} <span class="pill later">${esc(ev.category)}</span></div>
    <div class="detail-grid">
      <div><span>Date</span>${formatDate(ev.date)}</div>
      <div><span>Time</span>${ev.time ? formatTime(ev.time) : "—"}</div>
      <div><span>Venue</span>${esc(ev.venue) || "—"}</div>
      <div><span>Client / Organizer</span>${esc(ev.client) || "—"}</div>
      <div><span>Reminder</span>${ev.remindDays} day${ev.remindDays > 1 ? "s" : ""} before</div>
      <div><span>Needs ready</span>${p.ready} of ${p.total}</div>
      ${isAdmin() ? `<div><span>Created by</span>${esc(ev.createdBy) || "—"}</div>` : ""}
    </div>
    ${ev.notes ? `<p style="white-space:pre-wrap;background:var(--bg);padding:10px 12px;border-radius:8px">${esc(ev.notes)}</p>` : ""}
    <h3 style="margin:16px 0 6px">Needs checklist</h3>
    <div class="progress" style="margin-bottom:8px"><div style="width:${p.pct}%"></div></div>
    ${ev.needs.length
      ? `<ul class="check-list">${ev.needs.map((n, i) => `
          <li class="${n.ready ? "done" : ""}">
            <input type="checkbox" data-need="${i}" ${n.ready ? "checked" : ""} />
            <span class="item-name">${esc(n.name)}</span>
            <span class="qty">× ${n.qty}</span>
          </li>`).join("")}</ul>`
      : `<p class="muted">No needs listed.</p>`}`;
  showModal("#detailModal");
}

$("#detailBody").addEventListener("change", async (e) => {
  const i = e.target.dataset.need;
  if (i === undefined) return;
  const ev = events.find((x) => x.id === detailId);
  const need = ev.needs[i];
  e.target.disabled = true;
  try {
    const { event } = await api("PATCH", `/api/events/${ev.id}/needs/${need.id}`, { ready: e.target.checked });
    replaceEvent(event);
    openDetail(event.id);
    renderAll();
  } catch (err) {
    e.target.checked = !e.target.checked;
    e.target.disabled = false;
    toast(err.message);
  }
});
$("#detailEditBtn").addEventListener("click", () => {
  const ev = events.find((x) => x.id === detailId);
  hideModals();
  openForm(ev);
});

/* ---------- Modals, tabs, misc ---------- */
function showModal(sel) { hideModals(); $(sel).classList.remove("hidden"); }
function hideModals() { $$(".modal").forEach((m) => m.classList.add("hidden")); }
$$(".modal").forEach((m) => m.addEventListener("click", (e) => {
  if (e.target === m || e.target.closest("[data-close]")) hideModals();
}));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { hideModals(); $("#notifPanel").classList.add("hidden"); } });

// Click anything with data-open to see that event
document.addEventListener("click", (e) => {
  const el = e.target.closest("[data-open]");
  if (el) { $("#notifPanel").classList.add("hidden"); openDetail(el.dataset.open); }
});

// Click an empty calendar day to create an event on it
$("#calGrid").addEventListener("dblclick", (e) => {
  const cell = e.target.closest(".cal-cell");
  if (!cell || e.target.closest("[data-open]")) return;
  openForm();
  $("#fDate").value = cell.dataset.date;
});

$("#tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".tab");
  if (!tab) return;
  $$(".tab").forEach((t) => t.classList.toggle("active", t === tab));
  $$(".view").forEach((v) => v.classList.toggle("active", v.id === `view-${tab.dataset.view}`));
  if (tab.dataset.view === "users") loadUsers();
});

$("#newEventBtn").addEventListener("click", () => openForm());
$("#searchInput").addEventListener("input", renderEvents);
$("#filterSelect").addEventListener("change", renderEvents);
$("#prevMonth").addEventListener("click", () => { calMonth.setMonth(calMonth.getMonth() - 1); renderCalendar(); });
$("#nextMonth").addEventListener("click", () => { calMonth.setMonth(calMonth.getMonth() + 1); renderCalendar(); });

$("#bellBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const panel = $("#notifPanel");
  panel.classList.toggle("hidden");
  if (!panel.classList.contains("hidden")) markNotificationsSeen();
});
document.addEventListener("click", (e) => {
  if (!e.target.closest(".bell-wrap")) $("#notifPanel").classList.add("hidden");
});
$("#enablePushBtn").addEventListener("click", async (e) => {
  e.stopPropagation();
  if (!("Notification" in window)) return;
  await Notification.requestPermission();
  renderNotifications();
});

let toastTimer;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.add("hidden"), 2200);
}

/* ---------- User & logout ---------- */
$("#logoutBtn").addEventListener("click", async () => {
  try { await api("POST", "/api/logout"); } catch { /* ignore */ }
  window.location.href = "/login.html";
});

/* ---------- Start ---------- */
async function start() {
  $("#dashUpcoming").innerHTML = `<div class="loading">Loading events…</div>`;
  try {
    const [{ user }, data] = await Promise.all([api("GET", "/api/me"), api("GET", "/api/events")]);
    currentUser = user;
    $("#userName").textContent = user.name;
    $("#userRole").textContent = user.role === "admin" ? "Admin" : "Client";
    $("#userRole").className = `pill ${user.role}`;
    $("#usersTab").classList.toggle("hidden", !isAdmin());
    if (!isAdmin()) {
      $("#needsTitle").textContent = "Total Needs: My Upcoming Events";
      $("#searchInput").placeholder = "Search my events, venues…";
    }
    $("#userAvatar").textContent = user.name.split(/\s+/).map((w) => w[0]).slice(0, 2).join("").toUpperCase();
    events = data.events;
    renderAll();
  } catch (err) {
    $("#dashUpcoming").innerHTML = `<div class="empty-state">${esc(err.message)}</div>`;
    return;
  }
  // Pull other users' changes every minute (also refreshes reminders after midnight)
  setInterval(async () => {
    if (!$("#eventModal").classList.contains("hidden")) return; // don't disturb someone mid-edit
    try {
      events = (await api("GET", "/api/events")).events;
      if (detailId && !$("#detailModal").classList.contains("hidden")) {
        if (events.some((e) => e.id === detailId)) openDetail(detailId); else hideModals();
      }
    } catch { /* keep showing what we have */ }
    renderAll();
  }, 60 * 1000);
}
start();
