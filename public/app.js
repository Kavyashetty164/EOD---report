let currentUser = null;
let calYear, calMonth; // calMonth 1-12

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// Local calendar date (the original used toISOString(), which is UTC and gives the wrong day after local midnight)
function localISO(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function todayISO() {
  return localISO(new Date());
}
function fmtDate(iso) {
  return new Date(iso + 'T00:00:00').toLocaleDateString([], { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
function qs(obj) {
  return Object.entries(obj).filter(([, v]) => v !== undefined && v !== null && v !== '')
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join('&');
}

async function api(path, opts = {}) {
  let res;
  try {
    res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      credentials: 'same-origin',
      ...opts
    });
  } catch {
    throw new Error('Cannot reach the server. Check your connection.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && currentUser && path !== '/api/login') sessionExpired();
    throw new Error(data.error || 'Request failed');
  }
  return data;
}

// ---------------- UI helpers: toasts + modal ----------------
function toast(msg, type = 'success') {
  const el = document.createElement('div');
  el.className = 'toast' + (type === 'error' ? ' error' : '');
  el.textContent = msg;
  $('#toasts').appendChild(el);
  setTimeout(() => el.remove(), type === 'error' ? 5500 : 3000);
}
let modalLocked = false;
function openModal(html, { locked = false } = {}) {
  modalLocked = locked;
  $('#modalBox').innerHTML = html;
  $('#modalRoot').classList.remove('hidden');
  const first = $('#modalBox input, #modalBox select, #modalBox textarea');
  if (first) first.focus();
}
function closeModal() {
  $('#modalRoot').classList.add('hidden');
  $('#modalBox').innerHTML = '';
  $('#modalBox').onclick = null;
  modalLocked = false;
}
$('#modalRoot').addEventListener('mousedown', (e) => { if (e.target.id === 'modalRoot' && !modalLocked) closeModal(); });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !modalLocked && !$('#modalRoot').classList.contains('hidden')) closeModal(); });
function confirmDialog(title, message, confirmText = 'Confirm', danger = false) {
  return new Promise((resolve) => {
    openModal(`<h3>${escapeHtml(title)}</h3><p class="lead">${escapeHtml(message)}</p>
      <div class="modal-actions">
        <button class="btn-ghost" data-m="no" type="button">Cancel</button>
        <button class="${danger ? 'btn-danger' : ''}" data-m="yes" type="button">${escapeHtml(confirmText)}</button>
      </div>`);
    $('#modalBox').onclick = (e) => {
      const b = e.target.closest('[data-m]');
      if (!b) return;
      closeModal();
      resolve(b.dataset.m === 'yes');
    };
  });
}
function setBusy(btn, busy, label) {
  if (!btn) return;
  if (busy) { btn.dataset.label = btn.textContent; btn.textContent = label || 'Please wait…'; }
  else if (btn.dataset.label) { btn.textContent = btn.dataset.label; }
  btn.disabled = busy;
}
function sessionExpired() {
  currentUser = null;
  closeModal();
  showLogin();
  toast('Your session has ended. Please sign in again.', 'error');
}
const emptyState = (title, msg) => `<div class="empty-state"><b>${escapeHtml(title)}</b>${escapeHtml(msg)}</div>`;
const STATUS_LIST = ['Completed', 'In Progress', 'Pending', 'Blocked'];
const statusChip = (st) => `<span class="status-chip status-${escapeHtml(st).replace(/\s/g, '')}">${escapeHtml(st)}</span>`;
const taskCache = new Map();
let teamUsers = [];

// ---------------- Clock ----------------
function tickClock() {
  const now = new Date();
  $('#clockTime').textContent = now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  $('#clockDate').textContent = now.toLocaleDateString([], { weekday: 'short', year: 'numeric', month: 'short', day: 'numeric' });
}
setInterval(tickClock, 1000);
tickClock();

// ---------------- Auth ----------------
async function checkSession() {
  const { user } = await api('/api/me');
  if (user) {
    currentUser = user;
    showApp();
  } else {
    showLogin();
  }
}

function showLogin() {
  $('#loginScreen').classList.remove('hidden');
  $('#app').classList.add('hidden');
  $('#loginPassword').value = '';
}

async function showApp() {
  $('#loginScreen').classList.add('hidden');
  $('#app').classList.remove('hidden');
  $('#loggedInAsBadge').textContent = currentUser.name;
  if (currentUser.role === 'admin') {
    $$('.admin-only').forEach(el => el.classList.remove('hidden'));
  } else {
    $$('.admin-only').forEach(el => el.classList.add('hidden'));
  }
  const today = todayISO();
  $('#eodDate').value = today;
  $('#exportFrom').value = today;
  $('#exportTo').value = today;
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth() + 1;

  await loadTeamLine();
  activateTab('eod');
  if (currentUser.mustChangePassword) openPasswordModal({ forced: true });
}

$('#loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('#loginError').textContent = '';
  try {
    const { user } = await api('/api/login', {
      method: 'POST',
      body: JSON.stringify({
        name: $('#loginName').value.trim(),
        password: $('#loginPassword').value
      })
    });
    currentUser = user;
    await showApp();
  } catch (err) {
    $('#loginError').textContent = err.message;
  }
});

$('#logoutBtn').addEventListener('click', async () => {
  try { await api('/api/logout', { method: 'POST' }); } catch { /* session is gone either way */ }
  currentUser = null;
  showLogin();
});

// ---------------- Tabs ----------------
const TAB_LOADERS = {
  eod: () => loadEodLog(),
  reports: () => loadReports(),
  calendar: () => loadCalendar(),
  performance: () => loadPerformance(),
  admin: () => loadAdmin()
};

function activeTab() {
  const b = document.querySelector('.tab-btn.active');
  return b ? b.dataset.tab : 'eod';
}

function activateTab(name) {
  $$('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === name));
  $$('.tab-panel').forEach(p => p.classList.add('hidden'));
  $('#tab-' + name).classList.remove('hidden');
  return TAB_LOADERS[name]();
}

function refreshCurrentTab() { return TAB_LOADERS[activeTab()](); }

$$('.tab-btn').forEach(btn => {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
});

// ---------------- Team line ----------------
async function loadTeamLine() {
  try {
    const { users } = await api('/api/team');
    teamUsers = users;
    const names = users.filter(u => u.status === 'active').map(u => u.name);
    $('#teamLine').textContent = 'Shared EOD — ' + names.join(' · ');
    const sel = $('#fUser');
    const keep = sel.value;
    sel.innerHTML = '<option value="">Everyone</option>' +
      users.map(u => `<option value="${u.id}">${escapeHtml(u.name)}${u.status === 'disabled' ? ' (disabled)' : ''}</option>`).join('');
    sel.value = keep;
  } catch {
    $('#teamLine').textContent = 'Shared EOD — signed in as ' + currentUser.name;
  }
}

// ---------------- Shared task rendering ----------------
function taskItemHtml(t) {
  const canEdit = t.userId === currentUser.id;
  const canRemove = canEdit || currentUser.role === 'admin';
  taskCache.set(t.id, t);
  return `
    <div class="task-item">
      <div class="task-item-head">
        <span>#${t.id} · ${escapeHtml(t.userName)}</span>
        <span class="status-chip status-${t.status.replace(/\s/g, '')}">${escapeHtml(t.status)}</span>
      </div>
      <div class="task-text">${escapeHtml(t.task)}</div>
      ${t.description ? `<div class="task-remarks">${escapeHtml(t.description)}</div>` : ''}
      ${t.remarks ? `<div class="task-remarks">Remarks: ${escapeHtml(t.remarks)}</div>` : ''}
      ${canEdit || canRemove ? `<div class="task-actions">
        ${canEdit ? `<button class="remove-link edit-link" data-edit="${t.id}">edit</button>` : ''}
        ${canRemove ? `<button class="remove-link" data-id="${t.id}">remove</button>` : ''}
      </div>` : ''}
    </div>`;
}

// Works for any container holding task items (EOD log, calendar day panel)
function bindTaskActions(container) {
  container.querySelectorAll('[data-edit]').forEach(btn => {
    btn.addEventListener('click', () => {
      const t = taskCache.get(Number(btn.dataset.edit));
      if (t) openEditModal(t);
    });
  });
  container.querySelectorAll('.remove-link[data-id]').forEach(btn => {
    btn.addEventListener('click', () => deleteTask(Number(btn.dataset.id)));
  });
}

async function deleteTask(id) {
  const t = taskCache.get(id);
  const ok = await confirmDialog('Remove this task?',
    t ? `"${t.task}" (${fmtDate(t.date)}) will be permanently removed.` : 'This task will be permanently removed.', 'Remove', true);
  if (!ok) return;
  try {
    await api('/api/tasks/' + id, { method: 'DELETE' });
    toast('Task removed.');
    refreshCurrentTab();
  } catch (err) { toast(err.message, 'error'); }
}

function openEditModal(t) {
  const opt = (st) => `<option${t.status === st ? ' selected' : ''}>${st}</option>`;
  openModal(`<form id="editForm" novalidate>
    <h3>Edit task</h3><p class="lead">Update this EOD entry.</p>
    <div class="modal-row">
      <div><label>DATE</label><input type="date" id="eDate" value="${escapeHtml(t.date)}" required /></div>
      <div><label>STATUS</label><select id="eStatus">${STATUS_LIST.map(opt).join('')}</select></div>
    </div>
    <label>TASK / WORK DONE</label><input type="text" id="eTask" maxlength="200" value="${escapeHtml(t.task)}" required />
    <label>WORK DESCRIPTION</label><textarea id="eDesc" rows="3" maxlength="2000">${escapeHtml(t.description || '')}</textarea>
    <label>REMARKS</label><input type="text" id="eRemarks" maxlength="1000" value="${escapeHtml(t.remarks || '')}" />
    <p class="error-text" id="editError" role="alert"></p>
    <div class="modal-actions"><button type="button" class="btn-ghost" id="editCancel">Cancel</button><button type="submit" id="editSave">Save changes</button></div>
  </form>`);
  $('#editCancel').onclick = closeModal;
  $('#editForm').onsubmit = async (e) => {
    e.preventDefault();
    setBusy($('#editSave'), true, 'Saving…');
    try {
      await api('/api/tasks/' + t.id, {
        method: 'PUT',
        body: JSON.stringify({
          date: $('#eDate').value, status: $('#eStatus').value, task: $('#eTask').value,
          description: $('#eDesc').value, remarks: $('#eRemarks').value
        })
      });
      closeModal();
      toast('Task updated.');
      refreshCurrentTab();
    } catch (err) {
      $('#editError').textContent = err.message;
      setBusy($('#editSave'), false);
    }
  };
}

// ---------------- EOD Log ----------------
$('#eodDate').addEventListener('change', loadEodLog);

$('#logTaskBtn').addEventListener('click', async () => {
  const task = $('#taskInput').value.trim();
  if (!task) { toast('Please enter the task / work done.', 'error'); $('#taskInput').focus(); return; }
  if (!$('#eodDate').value) { toast('Please choose a date.', 'error'); return; }
  const btn = $('#logTaskBtn');
  setBusy(btn, true, 'Saving…');
  try {
    await api('/api/tasks', {
      method: 'POST',
      body: JSON.stringify({
        date: $('#eodDate').value,
        task,
        status: $('#statusInput').value,
        description: $('#descInput').value.trim(),
        remarks: $('#remarksInput').value.trim()
      })
    });
    $('#taskInput').value = '';
    $('#descInput').value = '';
    $('#remarksInput').value = '';
    toast('Task logged.');
    await loadEodLog();
  } catch (err) {
    toast(err.message, 'error');
  } finally {
    setBusy(btn, false);
  }
});
$('#taskInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#logTaskBtn').click(); });

async function loadEodLog() {
  const date = $('#eodDate').value;
  if (!date) return;
  let tasks;
  try {
    ({ tasks } = await api('/api/tasks?' + qs({ date })));
  } catch (err) { toast(err.message, 'error'); return; }

  // group by user
  const byUser = {};
  tasks.forEach(t => {
    if (!byUser[t.userName]) byUser[t.userName] = [];
    byUser[t.userName].push(t);
  });

  const container = $('#memberCards');
  container.innerHTML = '';

  // show current user first, then others who have tasks today
  const names = Object.keys(byUser).filter(n => n !== currentUser.name);
  names.unshift(currentUser.name);

  names.forEach(name => {
    const list = (byUser[name] || []).slice().sort((a, b) => a.id - b.id);
    const done = list.filter(t => t.status === 'Completed').length;
    const card = document.createElement('div');
    card.className = 'member-card';
    card.innerHTML = `
      <div class="member-card-head">
        <span>${escapeHtml(name)}</span>
        <span class="count">${done}/${list.length} done</span>
      </div>
      <div class="task-list"></div>
    `;
    const listEl = card.querySelector('.task-list');
    listEl.innerHTML = list.length === 0
      ? '<div class="empty-note">No tasks logged yet.</div>'
      : list.map(taskItemHtml).join('');
    container.appendChild(card);
  });
  bindTaskActions(container);

  // my numbers for the day (employee dashboard strip)
  const mine = byUser[currentUser.name] || [];
  const count = (st) => mine.filter(t => t.status === st).length;
  $('#myStats').innerHTML = [
    ['Completed', count('Completed'), 'c-completed'],
    ['In progress', count('In Progress'), 'c-progress'],
    ['Pending', count('Pending'), 'c-pending'],
    ['Blocked', count('Blocked'), 'c-blocked']
  ].map(([l, n, c]) => `<div class="perf-card ${c}"><div class="lbl">${l.toUpperCase()}</div><div class="pct">${n}</div><div class="sub">your tasks on this date</div></div>`).join('');

  // summary bar
  const dateLabel = new Date(date + 'T00:00:00').toLocaleDateString([], { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
  let summaryHtml = `<span>${dateLabel}</span>`;
  let teamDone = 0, teamTotal = 0;
  names.forEach(name => {
    const list = byUser[name] || [];
    const done = list.filter(t => t.status === 'Completed').length;
    teamDone += done;
    teamTotal += list.length;
    summaryHtml += `<span>${escapeHtml(name)}: <b>${done}/${list.length}</b></span>`;
  });
  summaryHtml += `<span>Team total: <b>${teamDone}/${teamTotal}</b></span>`;
  $('#summaryBar').innerHTML = summaryHtml;
}

// ---------------- Reports (history, filters, export) ----------------
const PAGE_SIZE = 15;
let reportRows = [], reportPage = 1;

function reportFilters() {
  return {
    from: $('#fFrom').value, to: $('#fTo').value, userId: $('#fUser').value,
    status: $('#fStatus').value, q: $('#fSearch').value.trim()
  };
}
function rangeOk(f) {
  if (f.from && f.to && f.from > f.to) { toast('"From" date must not be after "To" date.', 'error'); return false; }
  return true;
}
let searchTimer;
['#fFrom', '#fTo', '#fUser', '#fStatus'].forEach(s => $(s).addEventListener('change', () => { reportPage = 1; loadReports(); }));
$('#fSearch').addEventListener('input', () => { clearTimeout(searchTimer); searchTimer = setTimeout(() => { reportPage = 1; loadReports(); }, 300); });
$('#fReset').addEventListener('click', () => {
  ['#fFrom', '#fTo', '#fUser', '#fStatus', '#fSearch'].forEach(s => { $(s).value = ''; });
  reportPage = 1;
  loadReports();
});
$('#fExport').addEventListener('click', () => downloadCsv(reportFilters(), $('#fExport')));

async function downloadCsv(filters, btn) {
  if (!rangeOk(filters)) return;
  const label = btn.textContent;
  setBusy(btn, true, 'Exporting…');
  try {
    const res = await fetch('/api/export?' + qs(filters), { credentials: 'same-origin' });
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      if (res.status === 401) { sessionExpired(); return; }
      throw new Error(data.error || 'Export failed');
    }
    const blob = await res.blob();
    const m = /filename="([^"]+)"/.exec(res.headers.get('Content-Disposition') || '');
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = m ? m[1] : 'eod-reports.csv';
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
    toast('CSV exported.');
  } catch (err) { toast(err.message, 'error'); }
  finally { setBusy(btn, false); btn.textContent = label; }
}

async function loadReports() {
  const f = reportFilters();
  if (!rangeOk(f)) return;
  $('#reportsTable').innerHTML = '<div class="loading-note">Loading reports…</div>';
  try {
    ({ tasks: reportRows } = await api('/api/tasks?' + qs(f)));
  } catch (err) {
    $('#reportsTable').innerHTML = emptyState('Could not load reports', err.message);
    return;
  }
  reportRows.forEach(t => taskCache.set(t.id, t));
  reportPage = Math.min(reportPage, Math.max(1, Math.ceil(reportRows.length / PAGE_SIZE)));
  renderReports();
}

function renderReports() {
  const rows = reportRows;
  if (!rows.length) {
    $('#reportsTable').innerHTML = emptyState('No reports found', 'Adjust the filters or log a task in the EOD LOG tab.');
    $('#reportsPager').innerHTML = '';
    return;
  }
  const start = (reportPage - 1) * PAGE_SIZE, slice = rows.slice(start, start + PAGE_SIZE);
  $('#reportsTable').innerHTML = `<table><thead><tr><th>DATE</th><th>EMPLOYEE</th><th>TASK</th><th>STATUS</th><th>REMARKS</th><th></th></tr></thead><tbody>${
    slice.map(t => {
      const own = t.userId === currentUser.id, canRemove = own || currentUser.role === 'admin';
      return `<tr>
        <td class="nowrap">${escapeHtml(fmtDate(t.date))}</td>
        <td class="nowrap">${escapeHtml(t.userName)}</td>
        <td><div>${escapeHtml(t.task)}</div>${t.description ? `<div class="cell-sub">${escapeHtml(t.description)}</div>` : ''}</td>
        <td>${statusChip(t.status)}</td>
        <td class="cell-sub">${escapeHtml(t.remarks || '')}</td>
        <td><div class="row-actions">
          ${own ? `<button class="remove-link edit-link" data-edit="${t.id}">edit</button>` : ''}
          ${canRemove ? `<button class="remove-link" data-id="${t.id}">remove</button>` : ''}
        </div></td></tr>`;
    }).join('')
  }</tbody></table>`;
  bindTaskActions($('#reportsTable'));
  const pages = Math.ceil(rows.length / PAGE_SIZE);
  $('#reportsPager').innerHTML = `<span>Showing ${start + 1}–${start + slice.length} of ${rows.length}</span>${pages > 1 ? `<span class="pg">
    <button class="btn-ghost" data-pg="-1" ${reportPage <= 1 ? 'disabled' : ''}>Previous</button>
    <span>Page ${reportPage} / ${pages}</span>
    <button class="btn-ghost" data-pg="1" ${reportPage >= pages ? 'disabled' : ''}>Next</button></span>` : ''}`;
  $('#reportsPager').querySelectorAll('[data-pg]').forEach(b => b.addEventListener('click', () => {
    reportPage += Number(b.dataset.pg);
    renderReports();
  }));
}

// ---------------- Calendar ----------------
let calSelected = null;

$('#prevMonth').addEventListener('click', () => {
  calMonth--;
  if (calMonth < 1) { calMonth = 12; calYear--; }
  loadCalendar();
});
$('#nextMonth').addEventListener('click', () => {
  calMonth++;
  if (calMonth > 12) { calMonth = 1; calYear++; }
  loadCalendar();
});
$('#todayBtn').addEventListener('click', () => {
  const now = new Date();
  calYear = now.getFullYear();
  calMonth = now.getMonth() + 1;
  calSelected = todayISO();
  loadCalendar();
});

async function loadCalendar() {
  let byDay;
  try {
    ({ byDay } = await api(`/api/calendar?year=${calYear}&month=${calMonth}`));
  } catch (err) { toast(err.message, 'error'); return; }
  const monthNames = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  $('#calTitle').textContent = `${monthNames[calMonth - 1]} ${calYear}`;

  const grid = $('#calGrid');
  grid.innerHTML = '';
  ['Mon','Tue','Wed','Thu','Fri','Sat','Sun'].forEach(d => {
    const lbl = document.createElement('div');
    lbl.className = 'cal-day-label';
    lbl.textContent = d;
    grid.appendChild(lbl);
  });

  const firstDay = new Date(calYear, calMonth - 1, 1);
  // JS getDay: 0=Sun..6=Sat -> convert to Mon-first index
  let startOffset = (firstDay.getDay() + 6) % 7;
  const daysInMonth = new Date(calYear, calMonth, 0).getDate();
  const todayStr = todayISO();
  if (!calSelected) calSelected = todayStr;

  for (let i = 0; i < startOffset; i++) {
    const empty = document.createElement('div');
    empty.className = 'cal-cell empty';
    grid.appendChild(empty);
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dd = String(day).padStart(2, '0');
    const mm = String(calMonth).padStart(2, '0');
    const dateStr = `${calYear}-${mm}-${dd}`;
    const cell = document.createElement('div');
    cell.className = 'cal-cell clickable' + (dateStr === todayStr ? ' today' : '') + (dateStr === calSelected ? ' selected' : '');
    cell.dataset.date = dateStr;
    cell.setAttribute('role', 'button');
    cell.tabIndex = 0;
    const stats = byDay[dd];
    cell.innerHTML = `<div class="day-num">${day}</div>` +
      (stats ? `<div class="todo-count has">${stats.done}/${stats.total} to-dos</div>` : '');
    grid.appendChild(cell);
  }
  await loadCalDay();
}

function selectCalDay(cell) {
  calSelected = cell.dataset.date;
  $$('#calGrid .cal-cell').forEach(c => c.classList.toggle('selected', c === cell));
  loadCalDay();
}
$('#calGrid').addEventListener('click', (e) => { const c = e.target.closest('.cal-cell[data-date]'); if (c) selectCalDay(c); });
$('#calGrid').addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' && e.key !== ' ') return;
  const c = e.target.closest('.cal-cell[data-date]');
  if (c) { e.preventDefault(); selectCalDay(c); }
});

async function loadCalDay() {
  const panel = $('#calDayPanel');
  const prefix = `${calYear}-${String(calMonth).padStart(2, '0')}-`;
  if (!calSelected || !calSelected.startsWith(prefix)) { panel.classList.add('hidden'); return; }
  let tasks;
  try {
    ({ tasks } = await api('/api/tasks?' + qs({ date: calSelected })));
  } catch (err) { toast(err.message, 'error'); return; }
  const byUser = {};
  tasks.forEach(t => (byUser[t.userName] = byUser[t.userName] || []).push(t));
  const names = Object.keys(byUser).sort();
  panel.classList.remove('hidden');
  panel.innerHTML = `<div class="panel"><h3>${escapeHtml(fmtDate(calSelected))} — ${tasks.length} task${tasks.length === 1 ? '' : 's'}</h3>` +
    (names.length ? `<div class="card-grid" id="calDayCards" style="margin-top:0"></div>` : emptyState('No reports on this date', 'Nothing was logged for this day.')) + '</div>';
  if (names.length) {
    const wrap = $('#calDayCards');
    names.forEach(name => {
      const list = byUser[name].slice().sort((a, b) => a.id - b.id);
      const done = list.filter(t => t.status === 'Completed').length;
      const card = document.createElement('div');
      card.className = 'member-card';
      card.innerHTML = `<div class="member-card-head"><span>${escapeHtml(name)}</span><span class="count">${done}/${list.length} done</span></div>
        <div class="task-list">${list.map(taskItemHtml).join('')}</div>`;
      wrap.appendChild(card);
    });
    bindTaskActions(wrap);
  }
}

// ---------------- Performance ----------------
const STATUS_COLORS = { Completed: '#33e39a', 'In Progress': '#4f8cff', Pending: '#f0a63a', Blocked: '#e5484d' };
const perfCharts = {};
function drawChart(id, config) {
  if (perfCharts[id]) perfCharts[id].destroy();
  perfCharts[id] = new Chart($('#' + id), config);
}
if (window.Chart) {
  Chart.defaults.color = '#8a93a1';
  Chart.defaults.borderColor = '#262b33';
  Chart.defaults.font.family = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif';
}

$('#perfApply').addEventListener('click', loadPerformance);
$('#perfAll').addEventListener('click', () => { $('#perfFrom').value = ''; $('#perfTo').value = ''; loadPerformance(); });

async function loadPerformance() {
  const f = { from: $('#perfFrom').value, to: $('#perfTo').value };
  if (!rangeOk(f)) return;
  let data;
  try {
    data = await api('/api/performance?' + qs(f));
  } catch (err) { toast(err.message, 'error'); return; }
  const { performance, totals, daily } = data;
  const container = $('#perfCards');
  container.innerHTML = '';
  if (!performance.length) container.innerHTML = emptyState('No performance data', 'Reports will appear here once they are logged.');
  performance.forEach(p => {
    const card = document.createElement('div');
    card.className = 'perf-card';
    card.innerHTML = `
      <div>${escapeHtml(p.name)}</div>
      <div class="pct">${p.pct}%</div>
      <div class="sub">${p.done}/${p.total} tasks completed</div>
      <div class="progress-track"><div class="progress-fill" style="width:${p.pct}%"></div></div>
      <div class="sub" style="margin:12px 0 0">${p.inProgress} in progress · ${p.pending} pending · ${p.blocked} blocked</div>
    `;
    container.appendChild(card);
  });

  if (!window.Chart) return;
  const keys = [['Completed', 'completed'], ['In Progress', 'inProgress'], ['Pending', 'pending'], ['Blocked', 'blocked']];
  drawChart('perfStatusChart', {
    type: 'doughnut',
    data: { labels: keys.map(k => k[0]), datasets: [{ data: keys.map(k => totals[k[1]]), backgroundColor: keys.map(k => STATUS_COLORS[k[0]]), borderColor: '#14171c', borderWidth: 3 }] },
    options: { responsive: true, maintainAspectRatio: false, cutout: '64%', plugins: { legend: { position: 'bottom' } } }
  });
  drawChart('perfDailyChart', {
    data: {
      labels: daily.map(d => new Date(d.date + 'T00:00:00').toLocaleDateString([], { day: 'numeric', month: 'short' })),
      datasets: [
        { type: 'bar', label: 'Tasks', data: daily.map(d => d.total), backgroundColor: 'rgba(79,140,255,0.55)', borderRadius: 3, yAxisID: 'y' },
        { type: 'line', label: 'Completed %', data: daily.map(d => d.pct), borderColor: '#33e39a', backgroundColor: '#33e39a', tension: 0.3, pointRadius: 3, yAxisID: 'y1' }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false, interaction: { mode: 'index', intersect: false },
      plugins: { legend: { position: 'bottom' } },
      scales: {
        x: { grid: { display: false } },
        y: { beginAtZero: true, ticks: { precision: 0 } },
        y1: { position: 'right', min: 0, max: 100, grid: { drawOnChartArea: false }, ticks: { callback: v => v + '%' } }
      }
    }
  });
}

$('#exportBtn').addEventListener('click', () => {
  downloadCsv({ from: $('#exportFrom').value, to: $('#exportTo').value }, $('#exportBtn'));
});

// ---------------- Admin ----------------
$('#createUserBtn').addEventListener('click', async () => {
  $('#adminError').textContent = '';
  const name = $('#newUserName').value.trim();
  const password = $('#newUserPassword').value;
  const role = $('#newUserRole').value;
  if (!name || !password) {
    $('#adminError').textContent = 'Name and password are required.';
    return;
  }
  if (password.length < 8) {
    $('#adminError').textContent = 'Password must be at least 8 characters.';
    return;
  }
  const btn = $('#createUserBtn');
  setBusy(btn, true, 'Creating…');
  try {
    await api('/api/users', { method: 'POST', body: JSON.stringify({ name, password, role }) });
    $('#newUserName').value = '';
    $('#newUserPassword').value = '';
    $('#newUserRole').value = 'member';
    toast(`Account "${name}" created. They will be asked to change the password at first login.`);
    await loadAdmin();
    await loadTeamLine();
  } catch (err) {
    $('#adminError').textContent = err.message;
    toast(err.message, 'error');
  } finally { setBusy(btn, false); }
});

async function loadAdmin() {
  let users, stats;
  try {
    [{ users }, stats] = await Promise.all([api('/api/users'), api('/api/stats')]);
  } catch (err) { toast(err.message, 'error'); return; }

  // dashboard numbers
  const t = stats.totals;
  $('#adminStats').innerHTML = [
    ['Employees', stats.employees.total, `${stats.employees.active} active`, ''],
    ['Reports submitted', t.total, '', ''],
    ['Completed', t.completed, `${t.pct}% completion`, 'c-completed'],
    ['In progress', t.inProgress, '', 'c-progress'],
    ['Pending', t.pending, '', 'c-pending'],
    ['Blocked', t.blocked, '', 'c-blocked']
  ].map(([l, n, sub, c]) => `<div class="perf-card ${c}"><div class="lbl">${l.toUpperCase()}</div><div class="pct">${n}</div><div class="sub">${escapeHtml(sub) || '&nbsp;'}</div></div>`).join('');

  // employee-wise overview
  const ov = $('#adminOverview');
  ov.innerHTML = stats.byEmployee.length ? stats.byEmployee.map(r => `
    <div class="user-row overview-row">
      <div class="user-meta"><b>${escapeHtml(r.name)}</b>${r.status === 'disabled' ? ' <span class="status-disabled">· disabled</span>' : ''}</div>
      <div class="num"><b>${r.total}</b>reports</div>
      <div class="num"><b>${r.completed}</b>done</div>
      <div class="num"><b>${r.inProgress + r.pending}</b>open</div>
      <div class="num"><b>${r.blocked}</b>blocked</div>
      <div class="overview-bar"><div class="progress-track"><div class="progress-fill" style="width:${r.pct}%"></div></div><b>${r.pct}%</b></div>
      <button class="btn-ghost" data-view-user="${r.id}">View reports</button>
    </div>`).join('') : emptyState('No employees yet', 'Create accounts with the form below.');
  ov.querySelectorAll('[data-view-user]').forEach(b => b.addEventListener('click', () => {
    ['#fFrom', '#fTo', '#fStatus', '#fSearch'].forEach(s => { $(s).value = ''; });
    $('#fUser').value = b.dataset.viewUser;
    reportPage = 1;
    activateTab('reports');
  }));

  // account list
  const list = $('#usersList');
  list.innerHTML = '';
  users.forEach(u => {
    const me = u.id === currentUser.id;
    const row = document.createElement('div');
    row.className = 'user-row';
    row.innerHTML = `
      <div class="user-meta"><b>${escapeHtml(u.name)}</b>${me ? ' (you)' : ''} · ${u.role} ·
        <span class="status-${u.status}">${u.status === 'active' ? 'Active' : 'Disabled'}</span> · ${u.reportCount} report${u.reportCount === 1 ? '' : 's'}
      </div>
      <div class="user-actions">
        <button class="btn-ghost" data-act="reset" data-id="${u.id}">Reset password</button>
        ${me ? '' : `<button class="btn-ghost" data-act="role" data-id="${u.id}" data-next="${u.role === 'admin' ? 'member' : 'admin'}">${u.role === 'admin' ? 'Make employee' : 'Make admin'}</button>
        <button data-act="status" data-id="${u.id}" data-next="${u.status === 'active' ? 'disabled' : 'active'}">${u.status === 'active' ? 'Disable' : 'Enable'}</button>`}
      </div>
    `;
    list.appendChild(row);
  });
  list.querySelectorAll('button[data-act]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const id = Number(btn.dataset.id), u = users.find(x => x.id === id);
      if (btn.dataset.act === 'reset') return openResetModal(u);
      try {
        if (btn.dataset.act === 'status') {
          if (btn.dataset.next === 'disabled' &&
              !(await confirmDialog('Disable this account?', `${u.name} will be signed out and unable to log in. Their reports are kept.`, 'Disable', true))) return;
          await api('/api/users/' + id, { method: 'PATCH', body: JSON.stringify({ status: btn.dataset.next }) });
          toast(btn.dataset.next === 'active' ? 'Account enabled.' : 'Account disabled.');
        } else {
          await api('/api/users/' + id, { method: 'PATCH', body: JSON.stringify({ role: btn.dataset.next }) });
          toast('Role updated.');
        }
        await loadAdmin();
        loadTeamLine();
      } catch (err) { toast(err.message, 'error'); }
    });
  });
}

function openResetModal(u) {
  openModal(`<form id="resetForm" novalidate><h3>Reset password</h3>
    <p class="lead">Set a temporary password for <b>${escapeHtml(u.name)}</b>. They will be asked to change it at next login.</p>
    <label>TEMPORARY PASSWORD</label><input type="password" id="resetPw" autocomplete="new-password" />
    <p class="error-text" id="resetError" role="alert"></p>
    <div class="modal-actions"><button type="button" class="btn-ghost" id="resetCancel">Cancel</button><button type="submit" id="resetSave">Reset password</button></div></form>`);
  $('#resetCancel').onclick = closeModal;
  $('#resetForm').onsubmit = async (e) => {
    e.preventDefault();
    setBusy($('#resetSave'), true, 'Saving…');
    try {
      await api('/api/users/' + u.id, { method: 'PATCH', body: JSON.stringify({ password: $('#resetPw').value }) });
      closeModal();
      toast(`Password reset for ${u.name}.`);
    } catch (err) {
      $('#resetError').textContent = err.message;
      setBusy($('#resetSave'), false);
    }
  };
}

// ---------------- Change password ----------------
$('#pwBtn').addEventListener('click', () => openPasswordModal());

function openPasswordModal({ forced = false } = {}) {
  openModal(`<form id="pwForm" novalidate>
    <h3>${forced ? 'Choose a new password' : 'Change password'}</h3>
    <p class="lead">${forced ? 'Your password was set by an administrator (or is the default). Please choose your own to continue.' : 'Use at least 8 characters.'}</p>
    <label>CURRENT PASSWORD</label><input type="password" id="pwCur" autocomplete="current-password" />
    <label>NEW PASSWORD</label><input type="password" id="pwNew" autocomplete="new-password" />
    <label>CONFIRM NEW PASSWORD</label><input type="password" id="pwNew2" autocomplete="new-password" />
    <p class="error-text" id="pwError" role="alert"></p>
    <div class="modal-actions">
      ${forced ? '<button type="button" class="btn-ghost" id="pwLogout">Log out</button>' : '<button type="button" class="btn-ghost" id="pwCancel">Cancel</button>'}
      <button type="submit" id="pwSave">Update password</button>
    </div></form>`, { locked: forced });
  if ($('#pwCancel')) $('#pwCancel').onclick = closeModal;
  if ($('#pwLogout')) $('#pwLogout').onclick = () => { closeModal(); $('#logoutBtn').click(); };
  $('#pwForm').onsubmit = async (e) => {
    e.preventDefault();
    const cur = $('#pwCur').value, n1 = $('#pwNew').value, n2 = $('#pwNew2').value;
    if (n1 !== n2) { $('#pwError').textContent = 'The new passwords do not match.'; return; }
    setBusy($('#pwSave'), true, 'Saving…');
    try {
      const { user } = await api('/api/me/password', { method: 'POST', body: JSON.stringify({ currentPassword: cur, newPassword: n1 }) });
      currentUser = user;
      closeModal();
      toast('Password updated.');
    } catch (err) {
      $('#pwError').textContent = err.message;
      setBusy($('#pwSave'), false);
    }
  };
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

checkSession();