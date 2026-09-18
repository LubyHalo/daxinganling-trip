// 交互层：状态管理、事件绑定、同步流程、撤销。
// 所有持久化都走 store.js，所有合并逻辑都走 core.js（那里有单元测试）。

import {
  checkId, overrideId, statusId, noteId, customId, newUuid,
  makeRecord, mergeRecords, buildEnvelope, encodeCode, decodeCode, validateEnvelope,
  indexById, getAll, stopState, pendingCount, pad2,
  SCOPE_LOCAL, SCOPE_SHARED, DEFAULT_SCOPE,
  todayISO, shiftISODate, daysBetween, formatCN, nowHHMM, latestDeparture,
} from './core.js';
import { loadRecords, saveRecords, loadMeta, saveMeta, storageStatus, exportFilename, clearAll } from './store.js';
import * as R from './render.js';

const TRIP_URL = 'data/trip.json';

const state = {
  trip: null,
  records: [],
  meta: null,
  theme: 'auto',
  online: navigator.onLine,
  today: todayISO(),
  view: 'today',
  expanded: new Set(),
  sheet: null, // { kind, ctx }
  customType: 'food',
  swWaiting: null,
  lastAction: null,
  toastTimer: null,
};

/* ---------------- 启动 ---------------- */

export async function boot() {
  state.meta = loadMeta();
  state.theme = state.meta.theme;
  state.records = loadRecords();

  try {
    const res = await fetch(TRIP_URL, { cache: 'no-cache' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    state.trip = await res.json();
  } catch (err) {
    document.getElementById('view').innerHTML =
      `<div class="card empty">行程数据加载失败：${R.escHtml(err.message)}<br>请连网重新打开一次，让应用把数据缓存到本地。</div>`;
    return;
  }

  // 默认展开今天那天
  const td = state.trip.days.find((d) => d.date === state.today);
  if (td) state.expanded.add(td.date);

  applyTheme();
  bindEvents();
  registerSW();
  render();
  // 跨零点时自动换天
  setInterval(() => {
    const t = todayISO();
    if (t !== state.today) { state.today = t; render(); }
  }, 60000);
}

/* ---------------- 视图模型 ---------------- */

function dateLabelOf(iso) {
  return formatCN(iso) || iso || '';
}

function effStop(stop, day) {
  const ov = (field) => {
    const r = getAll(state.index, overrideId(stop.id, field));
    return r ? r.payload.value : undefined;
  };
  const time = ov('time');
  const note = ov('note');
  const name = ov('name');
  return {
    ...stop,
    time: time === undefined ? stop.time : time,
    note: note === undefined ? stop.note : note,
    name: name === undefined ? stop.name : name,
    overridden: [time, note, name].some((v) => v !== undefined),
    state: stopState(state.index, stop.id, state.today),
  };
}

/* ---------- 租车 / 归程时刻表 ---------- */

const HHMMtoMin = (hhmm) => {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
};

const minToHHMM = (mins) => {
  const m = ((Math.round(mins) % 1440) + 1440) % 1440;
  return `${pad2(Math.floor(m / 60))}:${pad2(m % 60)}`;
};

/**
 * 把那一天的租车事件算成可直接渲染的东西：
 * 取车/还车时间地点、取车日的预计抵达时间、当天的事件倒计时、以及归程日的时刻表。
 * 归程"建议出发时间"用 还车时间 − 车程 − 缓冲 推算——之前按公共交通假设给出的
 * 14:50 是错的，自驾还车才是真正的约束。
 */
function buildVehicleFor(date) {
  const v = state.trip.meta.vehicle;
  if (!v) return null;
  const events = (v.events || [])
    .filter((e) => String(e.at).slice(0, 10) === date)
    .map((e) => ({ ...e, time: String(e.at).slice(11, 16) }));
  const leg = (v.legs || []).find((l) => l.date === date) || null;
  if (!events.length && !leg) return null;

  const pickup = events.find((e) => e.kind === 'pickup') || null;
  const dropoff = events.find((e) => e.kind === 'dropoff') || null;
  const prep = pickup ? (v.prep || []) : [];
  const driveHours = leg && leg.hours ? leg.hours : null;

  let arrivalTime = null;
  if (pickup && driveHours) {
    const start = HHMMtoMin(pickup.time);
    if (start !== null) arrivalTime = minToHHMM(start + driveHours * 60);
  }

  let countdown = null;
  if (state.today === date && events.length) {
    const next = events
      .map((e) => ({ e, diff: Math.round((new Date(e.at).getTime() - Date.now()) / 60000) }))
      .find((x) => x.diff > 0);
    if (next) {
      const h = Math.floor(next.diff / 60);
      countdown = `距${next.e.label}还有 ${h > 0 ? `${h} 小时 ` : ''}${next.diff % 60} 分钟`;
    } else {
      countdown = `${events[events.length - 1].label}时间已到`;
    }
  }

  let returnPlan = null;
  const flight = (state.trip.meta.flights || []).find((f) => f.date === date);
  if (dropoff && flight) {
    const dropMin = HHMMtoMin(dropoff.time);
    const buf = v.departureBufferMin == null ? 30 : v.departureBufferMin;
    const leaveMin = dropMin - (driveHours || 3.5) * 60 - buf;
    const depMin = HHMMtoMin(flight.dep);
    const slack = depMin - dropMin;
    returnPlan = {
      leaveBy: minToHHMM(leaveMin),
      from: leg ? leg.from : '齐齐哈尔',
      steps: [
        { label: `从${leg ? leg.from : '齐齐哈尔'}出发`, time: minToHHMM(leaveMin),
          note: `按 ${driveHours || 3.5} 小时车程 + ${buf} 分钟缓冲估算，请以实时导航为准` },
        { label: dropoff.label, time: dropoff.time, place: dropoff.place, note: `${v.vendor} · ${v.model}` },
        { label: `起飞 ${flight.no}`, time: flight.dep, place: `→ ${flight.to}`,
          note: `还车后仍有约 ${Math.floor(slack / 60)} 小时 ${pad2(slack % 60)} 分缓冲` },
      ],
    };
  }

  return { vendor: v.vendor, order: v.order, model: v.model, events, leg, prep, arrivalTime, countdown, returnPlan, hasDropoff: Boolean(dropoff) };
}

function customsFor(date) {
  return state.records
    .filter((r) => r.kind === 'custom' && !r.deleted && r.payload && r.payload.day === date)
    .map((r) => ({
      id: r.id,
      name: r.payload.name || '（未命名）',
      type: r.payload.type || 'food',
      time: r.payload.time || null,
      note: r.payload.note || null,
      isCustom: true,
      overridden: false,
      state: stopState(state.index, r.id, state.today),
    }))
    .sort((a, b) => String(a.time || '99:99').localeCompare(String(b.time || '99:99')));
}

function buildViewModel() {
  state.index = indexById(state.records);
  const trip = state.trip;
  const days = trip.days.map((d) => {
    const base = d.stops.map((s) => effStop(s, d));
    const all = [...base, ...customsFor(d.date)];
    let stay = d.stay;
    if (stay) {
      const ovName = getAll(state.index, overrideId(`stay:${d.date}`, 'name'));
      const ovPhone = getAll(state.index, overrideId(`stay:${d.date}`, 'phone'));
      stay = { ...stay,
        name: ovName ? ovName.payload.value : stay.name,
        phone: ovPhone ? ovPhone.payload.value : stay.phone };
    }
    return {
      ...d,
      stay,
      dateLabel: dateLabelOf(d.date),
      isToday: d.date === state.today,
      stops: all,
      vehicle: buildVehicleFor(d.date),
      todos: (d.todos || []).map((text, i) => {
        const id = checkId(`${d.n}-todo-${i + 1}`);
        const r = getAll(state.index, id);
        return { id, text, done: Boolean(r && r.payload.done), dateLabel: dateLabelOf(d.date), day: d.date };
      }),
    };
  });

  const phase = state.today < trip.meta.start ? 'before' : state.today > trip.meta.end ? 'after' : 'during';
  const todayDay = days.find((d) => d.isToday) || null;

  const deferredIntoToday = [];
  for (const d of days) {
    for (const s of d.stops) {
      if (s.state.deferredTo && s.state.deferredTo === state.today && d.date !== state.today) {
        deferredIntoToday.push({ stop: s, day: d });
      }
    }
  }

  const flightCards = [];
  for (const f of trip.meta.flights || []) {
    if (state.today > f.date) continue;
    const card = { ...f, dateLabel: dateLabelOf(f.date) };
    if (state.today === f.date) {
      const depTs = new Date(`${f.date}T${f.dep}:00`).getTime();
      const diffMin = Math.round((depTs - Date.now()) / 60000);
      if (diffMin > 0) {
        const h = Math.floor(diffMin / 60);
        card.countdown = `距 ${f.dep} 起飞还有 ${h > 0 ? `${h} 小时 ` : ''}${diffMin % 60} 分钟`;
      } else {
        card.countdown = '航班已起飞';
      }
      const lb = latestDeparture(f.dep, 4, f.date);
      // 归程那天真正的约束是「还车时间」，不是通用转场时间——那时由归程时刻表负责提示
      const hasDropoff = ((trip.meta.vehicle && trip.meta.vehicle.events) || [])
        .some((e) => e.kind === 'dropoff' && String(e.at).slice(0, 10) === f.date);
      if (lb && !hasDropoff) card.leaveBy = { ...lb, fromCity: f.from };
    } else {
      card.countdown = `还有 ${daysBetween(state.today, f.date)} 天`;
    }
    flightCards.push(card);
  }

  const notes = state.records
    .filter((r) => r.kind === 'note' && !r.deleted && r.payload && String(r.payload.text || '').trim())
    .map((r) => ({
      ...r,
      timeLabel: r.payload.at ? nowHHMM(new Date(r.payload.at)) : nowHHMM(new Date(r.updated_at)),
    }))
    .sort((a, b) => (a.payload.at || a.updated_at) - (b.payload.at || b.updated_at));

  const shared = notes.filter((n) => n.scope !== SCOPE_LOCAL);
  const localScopedNotes = notes.filter((n) => n.scope === SCOPE_LOCAL);
  const groups = new Map();
  for (const n of shared) {
    const day = n.payload.day || state.today;
    if (!groups.has(day)) groups.set(day, []);
    groups.get(day).push(n);
  }
  const noteGroups = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([day, list]) => ({ day, notes: list }));

  const allTodos = days.flatMap((d) => d.todos.map((t) => ({ ...t, dateLabel: d.dateLabel })));

  let backupHint;
  if (!state.meta.lastExportAt) {
    backupHint = '还没导出过。建议现在就导出一次，发给同伴或发给自己存档——数据只在这台手机里。';
  } else {
    const d = daysBetween(todayISO(new Date(state.meta.lastExportAt)), state.today);
    backupHint = `上次导出：${formatCN(todayISO(new Date(state.meta.lastExportAt)))}（${d === 0 ? '今天' : `${d} 天前`}）${d >= 3 ? ' ⚠ 已超过 3 天，记得再导一次。' : ''}`;
  }

  return {
    trip, days, phase, todayDay, deferredIntoToday, flightCards, allTodos,
    records: state.records, meta: state.meta, theme: state.theme, online: state.online,
    today: state.today,
    offlineReady: state.offlineReady,
    todayLabel: formatCN(state.today),
    daysToStart: daysBetween(state.today, trip.meta.start),
    expanded: state.expanded,
    pending: pendingCount(state.records, state.meta.lastExportAt || 0),
    localCount: state.records.filter((r) => r.scope === SCOPE_LOCAL && !r.deleted).length,
    notes, noteGroups, localScopedNotes, backupHint,
    dateLabelOf,
    notesOf: (stopId) => notes.filter((n) => n.target === stopId),
  };
}

/* ---------------- 渲染 ---------------- */

function render() {
  const vm = buildViewModel();
  const banners = [];
  if (!storageStatus.ok) banners.push(R.storageWarning());
  if (state.swWaiting) banners.push(R.updateBanner());
  document.getElementById('topbar').innerHTML = R.topbar(vm) + banners.join('');
  const view = document.getElementById('view');
  view.innerHTML = state.view === 'today' ? R.viewToday(vm) : state.view === 'days' ? R.viewDays(vm) : R.viewNotes(vm);
  for (const b of document.querySelectorAll('#tabbar button')) {
    b.classList.toggle('on', b.dataset.view === state.view);
  }
  renderSheet(vm);
}

function renderSheet(vm) {
  const host = document.getElementById('sheet');
  if (!state.sheet) { host.hidden = true; host.innerHTML = ''; return; }
  const { kind, ctx } = state.sheet;
  let inner = '';
  if (kind === 'stop') {
    const day = vm.days.find((d) => d.date === ctx.date);
    const stop = day && day.stops.find((s) => s.id === ctx.id);
    if (!stop) { state.sheet = null; return renderSheet(vm); }
    inner = R.sheetStop(vm, stop, day);
  } else if (kind === 'note') {
    const note = ctx.id ? vm.notes.find((n) => n.id === ctx.id) : null;
    inner = R.sheetNote(vm, note, ctx);
  } else if (kind === 'sync') inner = R.sheetSync(vm);
  else if (kind === 'settings') inner = R.sheetSettings(vm);
  else if (kind === 'about') inner = R.sheetAbout(vm);
  else if (kind === 'wipe') inner = R.sheetWipeConfirm();
  else if (kind === 'custom') inner = R.sheetCustom(vm, ctx.date);
  else if (kind === 'stay') {
    const day = vm.days.find((d) => d.date === ctx.date);
    inner = R.sheetEditStay(vm, day);
  }
  host.hidden = false;
  host.innerHTML = R.sheet(inner);
  const seg = host.querySelectorAll('.seg-b');
  if (kind === 'custom' && seg.length) {
    seg.forEach((b) => b.classList.toggle('on', b.dataset.v === state.customType));
  }
}

/* ---------------- 记录写入 ---------------- */

function putRecord(rec) {
  const i = state.records.findIndex((r) => r.id === rec.id);
  const prev = i >= 0 ? state.records[i] : null;
  state.lastAction = { id: rec.id, prev };
  if (i >= 0) state.records[i] = rec;
  else state.records.push(rec);
  saveRecords(state.records);
  return prev;
}

function mk(kind, id, target, payload, scope) {
  return makeRecord({
    id, kind, target, payload,
    tripId: state.trip.meta.id,
    deviceId: state.meta.deviceId,
    scope: scope || DEFAULT_SCOPE[kind] || SCOPE_SHARED,
  });
}

function toggleCheck(stopId, dayDate, force) {
  const cur = getAll(state.index, checkId(stopId));
  const done = force !== undefined ? force : !(cur && cur.payload.done);
  const payload = done ? { done: true, at: Date.now(), actual: nowHHMM() } : { done: false };
  putRecord(mk('check', checkId(stopId), stopId, payload));
  toast(done ? `已打卡 ${nowHHMM()}` : '已取消打卡');
  render();
}

function toggleSkip(stopId) {
  const cur = getAll(state.index, statusId(stopId));
  const skipped = !(cur && cur.payload.value === 'skipped');
  putRecord(mk('status', statusId(stopId), stopId, skipped ? { value: 'skipped' } : { value: 'none' }));
  toast(skipped ? '已跳过（只影响你的手机）' : '已恢复');
  render();
}

function toggleDefer(stopId, dayDate) {
  const cur = getAll(state.index, statusId(stopId));
  const active = cur && cur.payload.value === 'deferred';
  const to = shiftISODate(dayDate, 1);
  putRecord(mk('status', statusId(stopId), stopId, active ? { value: 'none' } : { value: 'deferred', to }));
  toast(active ? '已取消推迟' : `已推迟到 ${dateLabelOf(to)}（只影响你的手机）`);
  render();
}

function saveStopEdits(stopId, dayDate, fields, notify) {
  const day = state.trip.days.find((d) => d.date === dayDate);
  const base = day.stops.find((s) => s.id === stopId);
  const scope = notify ? SCOPE_SHARED : SCOPE_LOCAL;
  const source = { time: base ? base.time : null, note: base ? base.note : null, name: base ? base.name : null };
  let changed = 0;
  for (const key of ['time', 'note', 'name']) {
    const raw = fields[key];
    if (key === 'name' && !raw) continue; // 名称不允许被清空
    const val = raw === '' ? null : raw;
    const id = overrideId(stopId, key);
    const cur = getAll(state.index, id);
    if (val === source[key]) {
      if (cur) { putRecord({ ...cur, deleted: true, deleted_at: Date.now(), updated_at: Date.now() }); changed += 1; }
      continue;
    }
    if (cur && cur.payload.value === val && cur.scope === scope) continue;
    putRecord(mk('override', id, stopId, { value: val }, scope));
    changed += 1;
  }
  toast(changed ? '已保存修改' : '没有变化');
  state.sheet = null;
  render();
}

function saveStayEdits(date, fields, notify) {
  const day = state.trip.days.find((d) => d.date === date);
  const base = day.stay || { name: '', phone: '' };
  const scope = notify ? SCOPE_SHARED : SCOPE_LOCAL;
  for (const key of ['name', 'phone']) {
    const val = fields[key] === '' ? null : fields[key];
    if (val === base[key]) continue;
    putRecord(mk('override', overrideId(`stay:${date}`, key), `stay:${date}`, { value: val }, scope));
  }
  toast('住宿信息已更新');
  state.sheet = null;
  render();
}

function saveNote(noteRecId, ctx, fields) {
  const now = Date.now();
  if (noteRecId) {
    const cur = state.records.find((r) => r.id === noteRecId);
    putRecord({ ...cur, payload: { ...cur.payload, text: fields.text, at: now }, scope: fields.local ? SCOPE_LOCAL : SCOPE_SHARED, updated_at: now });
  } else {
    const id = noteId(newUuid());
    putRecord(mk('note', id, ctx.target || null, {
      text: fields.text, at: now, day: ctx.date || state.today, place: ctx.place || null,
    }, fields.local ? SCOPE_LOCAL : SCOPE_SHARED));
  }
  toast('手记已保存');
  state.sheet = null;
  render();
}

function toggleNoteScope(id) {
  const cur = state.records.find((r) => r.id === id);
  putRecord({ ...cur, scope: cur.scope === SCOPE_LOCAL ? SCOPE_SHARED : SCOPE_LOCAL, updated_at: Date.now() });
  toast(cur.scope === SCOPE_LOCAL ? '这条会同步给同伴' : '这条只留本机');
  render();
}

function softDelete(id, msg) {
  const cur = state.records.find((r) => r.id === id);
  if (!cur) return;
  putRecord({ ...cur, deleted: true, deleted_at: Date.now(), updated_at: Date.now() });
  toast(msg || '已删除', true);
  state.sheet = null;
  render();
}

function saveCustom(date, fields) {
  const id = customId(newUuid());
  putRecord(mk('custom', id, id, {
    day: date, name: fields.name, type: state.customType, time: fields.time || null, note: fields.note || null,
  }, SCOPE_SHARED));
  toast('已加到这一天的行程里');
  state.sheet = null;
  render();
}

function toggleTodo(id) {
  const cur = getAll(state.index, id);
  putRecord(mk('check', id, id, cur && cur.payload.done ? { done: false } : { done: true, at: Date.now() }));
  render();
}

function undo() {
  const a = state.lastAction;
  if (!a) return;
  if (a.prev) putRecord(a.prev);
  else { state.records = state.records.filter((r) => r.id !== a.id); saveRecords(state.records); }
  state.lastAction = null;
  toast('已撤销');
  render();
}

/* ---------------- 同步 ---------------- */

function envelope() {
  return buildEnvelope({ tripId: state.trip.meta.id, deviceId: state.meta.deviceId, records: state.records });
}

async function exportFile() {
  const env = envelope();
  const blob = new Blob([JSON.stringify(env, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = exportFilename('trip-sync');
  document.body.appendChild(a);
  a.click();
  a.remove();
  state.meta.lastExportAt = Date.now();
  saveMeta(state.meta);
  toast(`已导出 ${env.count} 条记录`);
  render();
}

async function copyCode() {
  const code = await encodeCode(envelope());
  try {
    await navigator.clipboard.writeText(code);
    toast(`同步码已复制（${code.length} 字）`);
  } catch {
    state.sheet = { kind: 'sync', ctx: {} };
    render();
    const ta = document.querySelector('#sheet [data-input="code"]');
    if (ta) { ta.value = code; ta.select(); }
    toast('复制失败，已把同步码放进文本框，手动全选复制');
  }
  state.meta.lastExportAt = Date.now();
  saveMeta(state.meta);
  render();
}

function summarize(stats) {
  const parts = [`新增 ${stats.added} 条`, `更新 ${stats.updated} 条`];
  if (stats.keptLocal) parts.push(`本机较新保留 ${stats.keptLocal} 条`);
  if (stats.conflicts) parts.push(`⚠ 同一时间戳冲突 ${stats.conflicts} 条（已按对方版本采用）`);
  if (stats.rejectedLocalScope) parts.push(`忽略对方 ${stats.rejectedLocalScope} 条“仅本机”记录`);
  return parts.join(' · ');
}

async function importText(text) {
  const env = await decodeCode(text);
  validateEnvelope(env, state.trip.meta.id);
  const { records, stats } = mergeRecords(state.records, env.records);
  state.records = records;
  saveRecords(state.records);
  const summary = { text: `${summarize(stats)}（来自 ${env.device || '未知设备'}，数据时间 ${new Date(env.exported_at).toLocaleString()}）`, at: Date.now() };
  state.meta.lastImportAt = Date.now();
  state.meta.lastImportSummary = summary;
  saveMeta(state.meta);
  state.sheet = { kind: 'sync', ctx: {} };
  render();
  toast('导入完成');
  return stats;
}

function importFile(file) {
  const reader = new FileReader();
  reader.onload = async () => {
    try {
      await importText(String(reader.result || ''));
    } catch (err) {
      toast(`导入失败：${err.message}`);
    }
  };
  reader.readAsText(file);
}

/* ---------------- 提示条 ---------------- */

function toast(msg, withUndo = false) {
  const el = document.getElementById('toast');
  el.innerHTML = `<span>${R.escHtml(msg)}</span>${withUndo ? '<button class="link" data-act="undo">撤销</button>' : ''}`;
  el.hidden = false;
  el.classList.add('show');
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { el.classList.remove('show'); el.hidden = true; }, withUndo ? 5000 : 2200);
}

/* ---------------- 主题 / SW ---------------- */

function applyTheme() {
  const root = document.documentElement;
  if (state.theme === 'auto') root.removeAttribute('data-theme');
  else root.setAttribute('data-theme', state.theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', state.theme === 'dark' ? '#0d1f19' : '#12352a');
}

function setTheme(v) {
  state.theme = v;
  state.meta.theme = v;
  saveMeta(state.meta);
  applyTheme();
  render();
}

function registerSW() {
  if (!('serviceWorker' in navigator)) return;
  checkOfflineReady();
  navigator.serviceWorker.register('sw.js').then((reg) => {
    const check = () => {
      if (reg.waiting) { state.swWaiting = reg.waiting; render(); }
    };
    check();
    checkOfflineReady();
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        if (nw.state === 'installed') { checkOfflineReady(); }
        if (nw.state === 'installed' && navigator.serviceWorker.controller) { state.swWaiting = nw; render(); }
      });
    });
  }).catch(() => {});
}

/** 离线是否真的就绪：本地必须已经有一份应用缓存。这是整套方案最关键的状态，
    所以它必须能被用户看见，而不是靠相信。 */
async function checkOfflineReady() {
  if (!('caches' in window)) { state.offlineReady = null; return; }
  try {
    const keys = await caches.keys();
    state.offlineReady = keys.some((k) => k.startsWith('dtrip-'));
  } catch {
    state.offlineReady = null;
  }
  render();
}

/* ---------------- 事件 ---------------- */

function sheetFields() {
  const host = document.getElementById('sheet');
  const get = (name) => {
    const el = host.querySelector(`[data-input="${name}"]`);
    if (!el) return '';
    return el.type === 'checkbox' ? el.checked : el.value.trim();
  };
  return get;
}

function bindEvents() {
  document.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-act]');
    if (!el) return;
    const act = el.dataset.act;
    const ctx = state.sheet ? state.sheet.ctx : {};

    switch (act) {
      case 'tab': state.view = el.dataset.view; render(); window.scrollTo({ top: 0 }); break;
      case 'theme': setTheme(state.theme === 'auto' ? 'light' : state.theme === 'light' ? 'dark' : 'auto'); break;
      case 'toggle-day': {
        const d = el.dataset.date;
        if (state.expanded.has(d)) state.expanded.delete(d); else state.expanded.add(d);
        render();
        break;
      }
      case 'open-stop': state.sheet = { kind: 'stop', ctx: { id: el.dataset.id, date: el.dataset.date } }; render(); break;
      case 'quick-check': toggleCheck(el.dataset.id, el.dataset.date); break;
      case 'do-check': toggleCheck(ctx.id, ctx.date); break;
      case 'do-skip': toggleSkip(ctx.id); break;
      case 'do-defer': toggleDefer(ctx.id, ctx.date); break;
      case 'save-stop': {
        const f = sheetFields();
        saveStopEdits(ctx.id, ctx.date, { time: f('time'), note: f('note'), name: f('name') }, f('notify'));
        break;
      }
      case 'add-note':
        state.sheet = { kind: 'note', ctx: { date: el.dataset.date || state.today, target: el.dataset.target || '', place: el.dataset.place || '' } };
        render();
        break;
      case 'edit-note':
        state.sheet = { kind: 'note', ctx: { id: el.dataset.id } };
        render();
        break;
      case 'save-note': {
        const f = sheetFields();
        const text = String(f('text') || '').trim();
        if (!text) { toast('内容不能为空'); return; }
        saveNote(el.dataset.id || null, { date: el.dataset.date || ctx.date, target: el.dataset.target || ctx.target, place: el.dataset.place || ctx.place }, { text, local: f('local') });
        break;
      }
      case 'scope-note': toggleNoteScope(el.dataset.id); break;
      case 'del-note': softDelete(el.dataset.id, '手记已删除'); break;
      case 'add-custom': state.sheet = { kind: 'custom', ctx: { date: el.dataset.date } }; state.customType = 'food'; render(); break;
      case 'pick-type': {
        // 只切换选中态，绝不重绘弹层——否则用户已经输入的名称会被清掉
        state.customType = el.dataset.v;
        for (const b of document.querySelectorAll('#sheet .seg-b')) {
          b.classList.toggle('on', b.dataset.v === state.customType);
        }
        break;
      }
      case 'save-custom': {
        const f = sheetFields();
        if (!f('name')) { toast('名称不能为空'); return; }
        saveCustom(el.dataset.date, { name: f('name'), time: f('time'), note: f('note') });
        break;
      }
      case 'del-custom': softDelete(el.dataset.id, '已删掉这个点'); break;
      case 'edit-stay': state.sheet = { kind: 'stay', ctx: { date: el.dataset.date } }; render(); break;
      case 'save-stay': {
        const f = sheetFields();
        saveStayEdits(el.dataset.date, { name: f('name'), phone: f('phone') }, f('notify'));
        break;
      }
      case 'todo': toggleTodo(el.dataset.id); break;
      case 'sync': state.sheet = { kind: 'sync', ctx: {} }; render(); break;
      case 'settings': state.sheet = { kind: 'settings', ctx: {} }; render(); break;
      case 'about': state.sheet = { kind: 'about', ctx: {} }; render(); break;
      case 'close-sheet': state.sheet = null; render(); break;
      case 'export-file': await exportFile(); break;
      case 'copy-code': await copyCode(); break;
      case 'import-code': {
        const f = sheetFields();
        try { await importText(String(f('code') || '')); } catch (err) { toast(`导入失败：${err.message}`); }
        break;
      }
      case 'import-file': {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json,text/plain';
        input.addEventListener('change', () => { if (input.files && input.files[0]) importFile(input.files[0]); });
        input.click();
        break;
      }
      case 'set-theme': setTheme(el.dataset.v); break;
      case 'wipe': state.sheet = { kind: 'wipe', ctx: {} }; render(); break;
      case 'wipe-confirm':
        clearAll();
        toast('已清除，页面即将重新加载');
        setTimeout(() => location.reload(), 800);
        break;
      case 'undo': undo(); break;
      case 'reload':
        if (state.swWaiting) state.swWaiting.postMessage({ type: 'SKIP_WAITING' });
        setTimeout(() => location.reload(), 300);
        break;
      default: break;
    }
  });

  for (const b of document.querySelectorAll('#tabbar button')) b.dataset.act = 'tab';

  window.addEventListener('online', () => { state.online = true; render(); });
  window.addEventListener('offline', () => { state.online = false; render(); });

  const mq = window.matchMedia('(prefers-color-scheme: dark)');
  if (mq.addEventListener) mq.addEventListener('change', () => { if (state.theme === 'auto') applyTheme(); });
}

// pick-type 需要重绘弹层
function viewModel() { return buildViewModel(); }

export { state };
