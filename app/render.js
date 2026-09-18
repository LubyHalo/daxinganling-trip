// 渲染层：纯函数，输入"视图模型"，输出 HTML 字符串。不含任何事件与状态。
// 速查模式：高对比、系统字体、大字号、信息紧凑——为车内强光与单手操作优化。

import { MANUAL } from './manual.js';

const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const TYPE_LABEL = { sight: '景点', food: '吃', activity: '玩', transit: '途经' };
const TYPE_ICON = { sight: '⛰', food: '🍜', activity: '🎯', transit: '↦' };

export const escHtml = esc;

/* ---------------- 顶部栏 ---------------- */

export function topbar(vm) {
  const status = vm.online
    ? (vm.pending > 0 ? `待同步 ${vm.pending}` : '已同步')
    : '离线';
  const cls = !vm.online ? 'dot off' : vm.pending > 0 ? 'dot warn' : 'dot ok';
  return `
    <div class="tb-left">
      <div class="tb-title">${esc(vm.trip.meta.title)}</div>
      <div class="tb-sub"><span class="${cls}"></span>${esc(vm.todayLabel)} · ${esc(status)}</div>
    </div>
    <div class="tb-right">
      <button class="ico" data-act="theme" title="切换配色">${vm.theme === 'dark' ? '☾' : vm.theme === 'light' ? '☀' : '◐'}</button>
      <button class="ico" data-act="sync" title="同步与备份">⇄</button>
      <button class="ico" data-act="settings" title="设置">⋯</button>
    </div>`;
}

export function storageWarning() {
  return `<div class="banner warn">⚠ 浏览器拒绝本地存储（可能是无痕模式）：现在写的内容不会被保存。请改用普通窗口打开。</div>`;
}

export function updateBanner() {
  return `<div class="banner info">有新版本可用 <button class="link" data-act="reload">立即更新</button></div>`;
}

/* ---------------- 今天 ---------------- */

export function viewToday(vm) {
  const parts = [];
  const today = vm.todayDay;
  if (vm.phase === 'before') parts.push(countdownCard(`距出发还有 <b>${vm.daysToStart}</b> 天`, `${vm.trip.meta.start} 舟山起飞`, '天气、防火证、租车认证别忘确认'));
  if (vm.phase === 'after') parts.push(countdownCard('行程已结束', '把路上的手记导出留个纪念', ''));
  if (today && today.vehicle && today.vehicle.countdown) parts.push(vehicleHero(today.vehicle));
  for (const f of vm.flightCards) {
    // 归程那天由「归程时刻表」负责提示，避免和航班卡片重复
    if (today && today.vehicle && today.vehicle.returnPlan && f.date === today.date) continue;
    parts.push(flightCard(f));
  }
  if (vm.phase !== 'after') parts.push(weatherCard(vm));

  if (today) {
    parts.push(`<h2 class="sec">今天 · ${esc(vm.todayLabel)}</h2>`);
    parts.push(dayCard(vm, today, { expanded: true }));
    const carried = vm.deferredIntoToday;
    if (carried.length) {
      parts.push(`<h2 class="sec">从别的日子推迟过来的</h2>`);
      parts.push(carried.map((x) => stopRow(vm, x.stop, x.day, { carriedFrom: x.day })).join(''));
    }
  } else {
    parts.push(`<h2 class="sec">行程还没开始</h2>`);
    parts.push(dayCard(vm, vm.days[0], { expanded: true, preview: true }));
  }

  const todos = vm.allTodos.filter((t) => !t.done);
  if (todos.length) {
    parts.push(`<h2 class="sec">还没办的事 <span class="muted">${todos.length}</span></h2>`);
    parts.push(`<div class="card rows">${todos.map((t) => todoRow(t)).join('')}</div>`);
  }
  return parts.join('');
}

function vehicleHero(v) {
  const line = v.events.map((e) => `${e.label} ${e.time}${e.place ? ` · ${e.place}` : ''}`).join('　');
  return `<div class="card hero"><div class="hero-t">${esc(v.countdown)}</div><div class="hero-s">${esc(line)}</div><div class="hero-f">${esc(v.vendor)} ${esc(v.model)}</div></div>`;
}

/* ---------------- 天气 ---------------- */

export function weatherCard(vm) {
  const w = vm.weatherToday;
  const btn = `<button class="mini" data-act="refresh-weather">${vm.weatherLoading ? '更新中…' : '更新'}</button>`;
  const head = `<div class="wx-top">
      <span class="wx-icon">${w ? esc(w.icon) : '🌤️'}</span>
      <span class="wx-main">
        <b>${w ? `${esc(w.label)}${vm.weatherTodayLine ? `　${esc(vm.weatherTodayLine)}` : ''}` : '天气还没获取'}</b>
        <span class="wx-sub">${w && w.place ? `${esc(w.place)} · ` : ''}${esc(vm.weatherStamp)}</span>
      </span>
      ${btn}
    </div>`;
  const alerts = (vm.weatherTodayAlerts || []).map((a) => `<div class="wx-alert">⚠ ${esc(a)}</div>`).join('');
  const tomorrow = vm.weatherTomorrow
    ? `<div class="wx-next">明天　${esc(vm.weatherTomorrow.icon)} ${esc(vm.weatherTomorrow.label)}${vm.weatherTomorrowSummary ? ` · ${esc(vm.weatherTomorrowSummary)}` : ''}</div>`
    : '';
  const hint = !w
    ? '<div class="hint">天气需要联网才能获取，断网时看到的是上次联网的数据。</div>'
    : (vm.weatherStale ? `<div class="hint">${vm.weatherLoading ? '正在更新…' : '数据可能已过时，有网时点「更新」。'}</div>` : '');
  return `<div class="card wx">${head}${alerts}${tomorrow}${hint}</div>`;
}

/* ---------------- 租车与归程时刻表 ---------------- */

export function vehicleBlock(day) {
  const v = day.vehicle;
  if (!v) return '';
  const rows = v.events.map((e) => `<div class="veh-row">
      <span class="veh-t">${esc(e.time)}</span>
      <span class="veh-l">${esc(e.label)}</span>
      <span class="veh-p">${esc(e.place || '')}</span>
    </div>`).join('');
  const bits = [];
  if (v.driveNote) {
    bits.push(`<div class="hint">${esc(v.driveNote)}${v.arrivalTime ? ` · 取车后预计 <b>${esc(v.arrivalTime)}</b> 抵达${esc(v.arrivalCity || '')}` : ''}</div>`);
  } else if (v.arrivalTime) {
    bits.push(`<div class="hint">取车后预计 <b>${esc(v.arrivalTime)}</b> 抵达${esc(v.arrivalCity || '')}</div>`);
  }
  const prep = v.prep && v.prep.length ? `<ul class="plain">${v.prep.map((p) => `<li>${esc(p)}</li>`).join('')}</ul>` : '';
  return `<div class="vehicle">
    <div class="blk-t">租车 · ${esc(v.vendor)} · ${esc(v.model)}</div>
    ${rows}${bits.join('')}${prep}
  </div>`;
}

export function returnPlanBlock(plan) {
  if (!plan) return '';
  const steps = plan.steps.map((s) => `<li>
      <span class="tl-t">${esc(s.time)}</span>
      <span class="tl-l">${esc(s.label)}${s.place ? ` · ${esc(s.place)}` : ''}</span>
      ${s.note ? `<span class="tl-n">${esc(s.note)}</span>` : ''}
    </li>`).join('');
  return `<div class="return-plan">
    <div class="blk-t">归程时刻表（估算）</div>
    <ol class="tl">${steps}</ol>
    <div class="hint strong">建议 <b>${esc(plan.leaveBy)}</b> 前从${esc(plan.from)}出发——这是按车程倒推的估算值，请以实时导航为准。</div>
  </div>`;
}

function countdownCard(title, sub, foot) {
  return `<div class="card hero"><div class="hero-t">${title}</div><div class="hero-s">${esc(sub)}</div>${foot ? `<div class="hero-f">${esc(foot)}</div>` : ''}</div>`;
}

function flightCard(f) {
  const rows = [];
  rows.push(`<div class="fl-no">${esc(f.no)} <span class="muted">${esc(f.from)} → ${esc(f.to)}</span></div>`);
  rows.push(`<div class="fl-time">${esc(f.dateLabel)} ${esc(f.dep)} 起飞</div>`);
  if (f.countdown) rows.push(`<div class="fl-cd">${f.countdown}</div>`);
  if (f.leaveBy) {
    rows.push(f.leaveBy.passed
      ? `<div class="fl-warn">建议 ${esc(f.leaveBy.hhmm)} 前从${esc(f.fromCity)}出发的时间已过——确认已经在路上</div>`
      : `<div class="fl-warn">建议 <b>${esc(f.leaveBy.hhmm)}</b> 前从${esc(f.fromCity)}出发（${esc(f.leaveBy.note)}）</div>`);
  }
  return `<div class="card flight">${rows.join('')}</div>`;
}

/* ---------------- 逐日行程 ---------------- */

export function viewDays(vm) {
  return `<h2 class="sec">全程 ${vm.days.length} 天</h2>
  <section class="river" id="river">${vm.days.map((d) => dayCard(vm, d, {})).join('')}</section>`;
}

export function dayCard(vm, day, opts = {}) {  const open = opts.expanded || vm.expanded.has(day.date);
  const cls = ['card', 'day'];
  if (day.isToday) cls.push('is-today');
  if (opts.preview) cls.push('preview');
  const head = `
    <button class="day-head" data-act="toggle-day" data-date="${esc(day.date)}">
      <span class="d-num">DAY ${day.n}</span>
      <span class="d-title">${esc(day.title || '')}</span>
      <span class="d-date">${esc(day.dateLabel)}${day.isToday ? ' · 今天' : ''}</span>
      <span class="d-caret">${open ? '▾' : '▸'}</span>
    </button>`;
  if (!open) {
    const s = day.stops.filter((x) => x.state.done).length;
    return `<article class="${cls.join(' ')}" id="day-${esc(day.date)}">${head}<div class="d-collapsed">${esc(day.route.join(' ⇢ '))}${day.stops.length ? ` · 已打卡 ${s}/${day.stops.length}` : ''}</div></article>`;
  }
  const body = [];
  body.push(`<div class="route">${day.route.map(esc).join(' <span class="ar">⇢</span> ')}${day.driveHours ? `<span class="drive">车程约 ${esc(String(day.driveHours))} 小时</span>` : ''}</div>`);
  if (day.vehicle) body.push(vehicleBlock(day));
  if (day.vehicle && day.vehicle.returnPlan) body.push(returnPlanBlock(day.vehicle.returnPlan));
  if (day.weather) {
    body.push(`<div class="wx-line"><span class="wx-i">${esc(day.weather.icon)}</span>${esc(day.weather.label)}${day.weatherSummary ? ` · ${esc(day.weatherSummary)}` : ''}</div>`);
    if (day.weatherAlerts.length) body.push(`<div class="wx-inline-alert">⚠ ${day.weatherAlerts.map(esc).join('；')}</div>`);
  }
  if (day.stops.length) body.push(`<ul class="stops">${day.stops.map((s) => stopLi(vm, s, day)).join('')}</ul>`);
  else body.push(`<div class="empty-line">这天没有安排景点</div>`);
  if (day.stay) {
    const st = day.stay;
    body.push(`<div class="stay">
      <span class="k">住</span>
      <span class="v">${esc(st.name)}</span>
      ${st.phone ? `<a class="tel" href="tel:${esc(st.phone)}">拨号</a>` : ''}
      ${st.booked ? '<span class="chip ok">已订</span>' : '<span class="chip warn">未订</span>'}
      <button class="mini" data-act="edit-stay" data-date="${esc(day.date)}">改</button>
    </div>`);
  }
  if (day.todos.length) body.push(`<div class="todo-block"><div class="blk-t">待办</div>${day.todos.map((t) => todoRow(t, { showDate: false })).join('')}</div>`);
  if (day.intel.length) {
    body.push(`<details class="intel"><summary>情报 ${day.intel.length} 条</summary><ul>${day.intel.map((i) => `<li>${esc(i)}</li>`).join('')}</ul></details>`);
  }
  body.push(`<div class="day-foot"><button class="mini" data-act="add-custom" data-date="${esc(day.date)}">＋ 加一个点</button><button class="mini" data-act="add-note" data-date="${esc(day.date)}">✎ 记手记</button></div>`);
  return `<article class="${cls.join(' ')}" id="day-${esc(day.date)}">${vm.mode === 'album' ? `<span class="ghost" aria-hidden="true">${String(day.n).padStart(2, '0')}</span>` : ''}${head}<div class="day-body">${body.join('')}</div></article>`;
}

function stopLi(vm, stop, day) {
  const st = stop.state;
  const cls = ['stop'];
  if (st.done) cls.push('done');
  if (st.skipped) cls.push('skipped');
  const meta = [];
  if (stop.time) meta.push(`<span class="t">计划 ${esc(stop.time)}</span>`);
  if (st.actual) meta.push(`<span class="t actual">实际 ${esc(st.actual)}</span>`);
  if (st.deferredTo) meta.push(`<span class="t defer">推迟到 ${esc(vm.dateLabelOf(st.deferredTo))}</span>`);
  if (st.skipped) meta.push('<span class="t skip">已跳过</span>');
  if (stop.isCustom) meta.push('<span class="t custom">我加的</span>');
  if (stop.overridden) meta.push('<span class="t ov">已改</span>');
  return `<li class="${cls.join(' ')}">
    <button class="stop-main" data-act="open-stop" data-id="${esc(stop.id)}" data-date="${esc(day.date)}">
      <span class="ic">${st.done ? '✓' : TYPE_ICON[stop.type] || '•'}</span>
      <span class="nm">${esc(stop.name)}</span>
      <span class="tag">${TYPE_LABEL[stop.type] || esc(stop.type)}</span>
      ${stop.note ? `<span class="nt">${esc(stop.note)}</span>` : ''}
      ${meta.length ? `<span class="mt">${meta.join('')}</span>` : ''}
    </button>
    <button class="quick" data-act="quick-check" data-id="${esc(stop.id)}" data-date="${esc(day.date)}">${st.done ? '取消' : '打卡'}</button>
  </li>`;
}

function stopRow(vm, stop, day, opts = {}) {
  const prefix = opts.carriedFrom ? `<div class="carried">来自 ${esc(vm.dateLabelOf(opts.carriedFrom.date))} · ${esc(opts.carriedFrom.title || '')}</div>` : '';
  return `<div class="card rows">${prefix}<ul class="stops">${stopLi(vm, stop, day)}</ul></div>`;
}

/** 9.20 这种短日期：待办列表里足够明确，又不抢文字的宽度 */
function shortDate(iso) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  return m ? `${Number(m[2])}.${Number(m[3])}` : '';
}

/**
 * 待办行。日期只在跨天的地方显示（「还没办的事」卡片、索引页）——
 * 在当天行程里它上面就是日期，重复显示只会挤掉文字。
 */
function todoRow(t, opts = {}) {
  const showDate = opts.showDate !== false && Boolean(t.day || t.dateLabel);
  const label = t.day ? shortDate(t.day) : esc(t.dateLabel || '');
  return `<label class="todo ${t.done ? 'done' : ''}" data-act="todo" data-id="${esc(t.id)}">
    <input type="checkbox" ${t.done ? 'checked' : ''}>
    <span class="todo-text">${esc(t.text)}</span>
    ${showDate ? `<span class="todo-date">${label}</span>` : ''}
  </label>`;
}

/* ---------------- 手记 ---------------- */

export function viewNotes(vm) {
  const parts = [];
  parts.push(`<div class="notes-head">
    <h2 class="sec">手记 <span class="muted">${vm.notes.length}</span></h2>
    <div class="row">
      <button class="btn primary" data-act="add-note" data-date="${esc(vm.today)}">写一条</button>
      <button class="btn" data-act="sync">同步 / 备份</button>
    </div>
  </div>`);

  if (!vm.notes.length) {
    parts.push(`<div class="card empty">还没有手记。路上想到什么、吃到什么、谁说了什么话，随手记下来，回来就是一份完整的旅行。</div>`);
  }
  for (const g of vm.noteGroups) {
    parts.push(`<h3 class="note-day">${esc(vm.dateLabelOf(g.day))}${g.day === vm.today ? ' · 今天' : ''}</h3>`);
    parts.push(`<div class="card rows">${g.notes.map((n) => noteRow(vm, n)).join('')}</div>`);
  }
  if (vm.localScopedNotes.length) {
    parts.push(`<h3 class="note-day">只留在本机的手记</h3>`);
    parts.push(`<div class="card rows">${vm.localScopedNotes.map((n) => noteRow(vm, n)).join('')}</div>`);
  }
  return parts.join('');
}

function noteRow(vm, n) {
  const place = n.payload.place ? `<span class="chip">${esc(n.payload.place)}</span>` : '';
  const local = n.scope === 'local' ? '<span class="chip warn">仅本机</span>' : '';
  return `<div class="note">
    <div class="n-head"><span class="n-time">${esc(n.timeLabel)}</span>${place}${local}</div>
    <div class="n-text">${esc(n.payload.text)}</div>
    <div class="n-act">
      <button class="mini" data-act="edit-note" data-id="${esc(n.id)}">改</button>
      <button class="mini" data-act="scope-note" data-id="${esc(n.id)}">${n.scope === 'local' ? '同步给大家' : '改为仅本机'}</button>
      <button class="mini danger" data-act="del-note" data-id="${esc(n.id)}">删</button>
    </div>
  </div>`;
}

/* ---------------- 索引（按类型随时查） ---------------- */

const SEGMENTS = [
  { id: 'all', label: '全部' },
  { id: 'stay', label: '住宿' },
  { id: 'food', label: '美食' },
  { id: 'sight', label: '景点' },
  { id: 'todo', label: '待办' },
  { id: 'tips', label: '贴士' },
];

const inSightGroup = (type) => type === 'sight' || type === 'activity' || type === 'transit';

function segCount(vm, id) {
  if (id === 'stay') return vm.days.filter((d) => d.stay).length;
  if (id === 'food') return vm.days.reduce((n, d) => n + d.stops.filter((s) => s.type === 'food').length, 0);
  if (id === 'sight') return vm.days.reduce((n, d) => n + d.stops.filter((s) => inSightGroup(s.type)).length, 0);
  if (id === 'todo') return vm.allTodos.length;
  if (id === 'tips') return vm.trip.tips.length;
  return 0;
}

export function viewIndex(vm) {
  const chips = SEGMENTS.map((s) => `<button class="chip-b ${s.id === vm.segment ? 'on' : ''}" data-act="seg" data-v="${s.id}">${esc(s.label)}<span class="n">${segCount(vm, s.id)}</span></button>`).join('');
  return `<div class="index-head">
    <input class="search" type="search" data-input="query" value="${esc(vm.query || '')}" placeholder="搜住宿、餐厅、景点、待办…" autocomplete="off">
    <div class="chips">${chips}</div>
  </div>
  <div id="index-list">${indexList(vm)}</div>`;
}

export function indexList(vm) {
  const q = String(vm.query || '').trim().toLowerCase();
  const seg = vm.segment || 'all';
  const hit = (...parts) => !q || parts.filter(Boolean).join(' ').toLowerCase().includes(q);
  const rows = [];

  if (seg === 'all' || seg === 'stay') {
    for (const day of vm.days) {
      const st = day.stay;
      if (!st || !hit(st.name, day.dateLabel, st.addr)) continue;
      rows.push(`<li class="ix-row stay-row">
        <div class="ix-main">
          <span class="ix-nm">${esc(st.name)}</span>
          <span class="ix-sub">${esc(day.dateLabel)} · 住 · ${esc(day.title || '')}</span>
        </div>
        <span class="ix-chips">
          ${st.phone ? `<a class="tel" href="tel:${esc(st.phone)}">拨号</a>` : ''}
          ${st.booked ? '<span class="chip ok">已订</span>' : '<span class="chip warn">未订</span>'}
          <button class="mini" data-act="goto-day" data-date="${esc(day.date)}">看当天</button>
        </span>
      </li>`);
    }
  }

  if (seg === 'all' || seg === 'food' || seg === 'sight') {
    for (const day of vm.days) {
      for (const stop of day.stops) {
        const inSeg = seg === 'food' ? stop.type === 'food' : seg === 'sight' ? inSightGroup(stop.type) : true;
        if (!inSeg) continue;
        if (!hit(stop.name, day.dateLabel, stop.note)) continue;
        const state = [];
        if (stop.state.done) state.push('<span class="chip ok">已打卡</span>');
        if (stop.state.skipped) state.push('<span class="chip warn">已跳过</span>');
        if (stop.time) state.push(`<span class="chip">${esc(stop.time)}</span>`);
        if (stop.isCustom) state.push('<span class="chip">我加的</span>');
        rows.push(`<li class="ix-row">
          <button class="ix-main" data-act="open-stop" data-id="${esc(stop.id)}" data-date="${esc(day.date)}">
            <span class="ix-nm">${esc(TYPE_ICON[stop.type] || '•')} ${esc(stop.name)}</span>
            <span class="ix-sub">${esc(day.dateLabel)} · ${esc(TYPE_LABEL[stop.type] || '')}${stop.note ? ` · ${esc(stop.note)}` : ''}</span>
          </button>
          <span class="ix-chips">${state.join('')}</span>
        </li>`);
      }
    }
  }

  if (seg === 'all' || seg === 'todo') {
    for (const t of vm.allTodos) {
      if (!hit(t.text, t.dateLabel)) continue;
      rows.push(`<li class="ix-row todo-row">${todoRow(t)}</li>`);
    }
  }

  if (seg === 'all' || seg === 'tips') {
    for (const tip of vm.trip.tips) {
      if (!hit(tip.title, tip.text)) continue;
      rows.push(`<li class="ix-row tip-row"><div class="ix-main"><span class="ix-nm">${esc(tip.title)}</span><span class="ix-sub">${esc(tip.text)}</span></div></li>`);
    }
  }

  if (!rows.length) return `<div class="card empty">没有匹配的内容。换个词，或者点上面的分类看看。</div>`;
  return `<ul class="ix-list">${rows.join('')}</ul>`;
}

/* ---------------- 贴士 ---------------- */

export function viewTips(vm) {
  return `<h2 class="sec">出行贴士</h2>
    <div class="card rows">${vm.trip.tips.map((t) => `<div class="tip"><div class="tip-t">${esc(t.title)}</div><div class="tip-x">${esc(t.text)}</div></div>`).join('')}</div>`;
}

/* ---------------- 使用手册 ---------------- */

export function viewHelp(vm) {
  const cards = MANUAL.map((s) => `<section class="card help-sec">
      <h2 class="help-t">${esc(s.title)}</h2>
      <ul class="help-list">${s.items.map((i) => `<li>${esc(i)}</li>`).join('')}</ul>
      ${s.note ? `<div class="help-note">${esc(s.note)}</div>` : ''}
    </section>`).join('');
  return `<div class="help-head">
      <h2 class="sec">使用手册</h2>
      <button class="mini" data-act="tab" data-view="today">回到今天</button>
    </div>
    <div class="card help-share">
      <div class="blk-t">把这个应用发给同伴</div>
      <div class="help-url">${esc(vm.url || '')}</div>
      <div class="row">
        <button class="btn primary" data-act="copy-link">复制链接</button>
        <button class="btn" data-act="sync">同步与备份</button>
      </div>
      <div class="hint">同伴也要先在有网时打开一次、添加到主屏幕，之后才能离线用。</div>
    </div>
    ${cards}`;
}

/* ---------------- 底部弹层 ---------------- */

export function sheet(inner) {
  return `<div class="sheet-mask" data-act="close-sheet"></div><div class="sheet"><div class="sheet-bar"></div>${inner}</div>`;
}

export function sheetStop(vm, stop, day) {
  const st = stop.state;
  const other = vm.notesOf(stop.id);
  return `<h3>${esc(stop.name)}</h3>
    <div class="sheet-sub">${esc(vm.dateLabelOf(day.date))} · ${TYPE_LABEL[stop.type] || stop.type}${st.done && st.actual ? ` · ${esc(st.actual)} 打卡` : ''}</div>
    <div class="acts">
      <button class="btn ${st.done ? '' : 'primary'}" data-act="do-check" data-id="${esc(stop.id)}" data-date="${esc(day.date)}">${st.done ? '取消打卡' : '打卡'}</button>
      <button class="btn" data-act="do-skip" data-id="${esc(stop.id)}">${st.skipped ? '取消跳过' : '跳过这个点'}</button>
      <button class="btn" data-act="do-defer" data-id="${esc(stop.id)}">${st.deferredTo ? '取消推迟' : '推迟到明天'}</button>
    </div>
    <div class="field"><label>计划时间</label><input type="time" value="${esc(stop.time || '')}" data-input="time"></div>
    <div class="field"><label>备注</label><input type="text" value="${esc(stop.note || '')}" placeholder="例如：改到 9:40 集合" data-input="note"></div>
    <div class="field"><label>名称</label><input type="text" value="${esc(stop.name)}" data-input="name"></div>
    <label class="switch"><input type="checkbox" data-input="notify"> 这些修改通知同伴（默认跳过/推迟只留本机）</label>
    <div class="sheet-foot">
      <button class="btn primary" data-act="save-stop" data-id="${esc(stop.id)}" data-date="${esc(day.date)}">保存修改</button>
      <button class="btn" data-act="add-note" data-date="${esc(day.date)}" data-target="${esc(stop.id)}" data-place="${esc(stop.name)}">在这里记一条手记</button>
      ${stop.isCustom ? `<button class="btn danger" data-act="del-custom" data-id="${esc(stop.id)}">删掉这个点</button>` : ''}
    </div>
    ${other.length ? `<div class="sheet-notes"><div class="blk-t">关于这里的手记</div>${other.map((n) => `<div class="note-mini">${esc(n.timeLabel)} ${esc(n.payload.text)}</div>`).join('')}</div>` : ''}`;
}

export function sheetNote(vm, note, preset = {}) {
  const isNew = !note;
  const text = note ? note.payload.text : '';
  return `<h3>${isNew ? '写一条手记' : '编辑手记'}</h3>
    <div class="sheet-sub">${esc(vm.dateLabelOf(preset.date || note?.payload.day || vm.today))}${preset.place ? ` · ${esc(preset.place)}` : ''}</div>
    <div class="field"><textarea rows="6" data-input="text" placeholder="今天看到了什么、吃了什么、谁说了什么话…">${esc(text)}</textarea></div>
    <label class="switch"><input type="checkbox" data-input="local" ${note && note.scope === 'local' ? 'checked' : ''}> 只留在我这台手机上（不同步给同伴）</label>
    <div class="sheet-foot"><button class="btn primary" data-act="save-note" data-id="${esc(note ? note.id : '')}" data-date="${esc(preset.date || '')}" data-target="${esc(preset.target || '')}" data-place="${esc(preset.place || '')}">保存</button></div>`;
}

export function sheetSync(vm) {
  const s = vm.meta.lastImportSummary;
  return `<h3>同步与备份</h3>
    <div class="sheet-sub">本机 ${vm.records.length} 条记录 · 其中 ${vm.pending} 条自上次分享后有改动 · ${vm.localCount} 条仅本机</div>
    <div class="sync-block">
      <div class="blk-t">1. 把我的改动发给同伴</div>
      <div class="row">
        <button class="btn primary" data-act="export-file">导出文件</button>
        <button class="btn" data-act="copy-code">复制同步码</button>
      </div>
      <div class="hint">微信里发文件或直接粘贴同步码都可以。</div>
    </div>
    <div class="sync-block">
      <div class="blk-t">2. 导入同伴的改动</div>
      <textarea rows="4" data-input="code" placeholder="把同伴发来的同步码粘贴到这里，或用下面的按钮选文件"></textarea>
      <div class="row">
        <button class="btn primary" data-act="import-code">导入粘贴内容</button>
        <button class="btn" data-act="import-file">选择文件</button>
      </div>
      <div class="hint">导入只会新增和更新，永远不会删掉你本机的内容。</div>
    </div>
    ${s ? `<div class="sync-block"><div class="blk-t">上次导入结果</div><div class="hint">${esc(s.text)}</div></div>` : ''}
    <div class="sync-block">
      <div class="blk-t">备份提醒</div>
      <div class="hint">${esc(vm.backupHint)}</div>
    </div>`;
}

export function sheetSettings(vm) {
  const offline = vm.offlineReady === true
    ? '<span class="chip ok">已就绪</span> 断网也能打开、能打卡、能写手记。'
    : vm.offlineReady === false
      ? '<span class="chip warn">准备中</span> 保持联网几秒钟，缓存完就好。'
      : '<span class="chip">无法检测</span> 这台浏览器不支持离线缓存，请换 Safari / Chrome 打开。';
  return `<h3>设置</h3>
    <div class="sheet-sub">${esc(vm.trip.meta.title)}</div>
    <div class="sync-block"><div class="blk-t">离线缓存</div><div class="hint">${offline}</div></div>
    ${vm.trip.meta.vehicle ? `<div class="sync-block"><div class="blk-t">租车信息</div><ul class="plain">
      <li>${esc(vm.trip.meta.vehicle.vendor)} · ${esc(vm.trip.meta.vehicle.model)}</li>
      <li>订单号 ${esc(vm.trip.meta.vehicle.order)}</li>
      ${vm.trip.meta.vehicle.events.map((e) => `<li>${esc(String(e.at).slice(0, 10))} ${esc(String(e.at).slice(11, 16))} ${esc(e.label)} · ${esc(e.place)}</li>`).join('')}
    </ul></div>` : ''}
    <div class="field"><label>显示模式</label>
      <div class="seg">
        <button class="seg-b ${vm.mode === 'quick' ? 'on' : ''}" data-act="set-mode" data-v="quick">路上速查</button>
        <button class="seg-b ${vm.mode === 'album' ? 'on' : ''}" data-act="set-mode" data-v="album">旅行画册</button>
      </div>
      <div class="hint">速查模式：高对比大字号，车里好用。画册模式：纸质质感 + 河流时间轴，适合晚上回酒店翻看。两种模式看的是同一份数据。</div>
    </div>
    <div class="field"><label>配色</label>
      <div class="seg">
        <button class="seg-b ${vm.theme === 'auto' ? 'on' : ''}" data-act="set-theme" data-v="auto">跟随系统</button>
        <button class="seg-b ${vm.theme === 'light' ? 'on' : ''}" data-act="set-theme" data-v="light">白天</button>
        <button class="seg-b ${vm.theme === 'dark' ? 'on' : ''}" data-act="set-theme" data-v="dark">夜间</button>
      </div>
    </div>
    <div class="sync-block"><div class="blk-t">还没确认的信息</div><ul class="plain">${vm.trip.meta.openQuestions.map((q) => `<li>${esc(q)}</li>`).join('')}</ul></div>
    <div class="sync-block"><div class="blk-t">出行贴士</div><ul class="plain">${vm.trip.tips.map((t) => `<li><b>${esc(t.title)}</b> ${esc(t.text)}</li>`).join('')}</ul></div>
    <div class="sheet-foot">
      <button class="btn" data-act="help">使用手册</button>
      <button class="btn" data-act="about">关于数据</button>
      <button class="btn danger" data-act="wipe">清除本机全部数据</button>
    </div>`;
}

export function sheetAbout(vm) {
  return `<h3>关于数据</h3>
    <ul class="plain">
      <li>行程内容打包在应用里，断网也能看。</li>
      <li>你的打卡、手记、修改只存在这台手机的浏览器里，不上传任何服务器。</li>
      <li>所以：<b>换手机/清缓存会丢</b>。用「导出文件」定期备份，或发给同伴。</li>
      <li>行程骨架的改动由电脑端重新部署生效，你的手记不会被覆盖。</li>
      <li>本机标识：${esc(vm.meta.deviceId)}，导出数据里会带上它，便于分辨谁写的。</li>
    </ul>
    <div class="sheet-foot"><button class="btn primary" data-act="help">看使用手册</button><button class="btn" data-act="close-sheet">知道了</button></div>`;
}

export function sheetWipeConfirm() {
  return `<h3>确定清除？</h3>
    <div class="sheet-sub">会删掉本机全部打卡、手记和修改。这个动作无法撤销。</div>
    <div class="sheet-foot">
      <button class="btn" data-act="close-sheet">取消</button>
      <button class="btn danger" data-act="wipe-confirm">我已备份，确认清除</button>
    </div>`;
}

export function sheetCustom(vm, date) {
  return `<h3>加一个点</h3>
    <div class="sheet-sub">${esc(vm.dateLabelOf(date))} · 会同步给同伴</div>
    <div class="field"><label>名称</label><input type="text" data-input="name" placeholder="例如：路过的一家小馆子"></div>
    <div class="field"><label>类型</label>
      <div class="seg">
        <button class="seg-b on" data-act="pick-type" data-v="food">吃</button>
        <button class="seg-b" data-act="pick-type" data-v="sight">景点</button>
        <button class="seg-b" data-act="pick-type" data-v="activity">玩</button>
      </div>
    </div>
    <div class="field"><label>时间（可留空）</label><input type="time" data-input="time"></div>
    <div class="field"><label>备注</label><input type="text" data-input="note"></div>
    <div class="sheet-foot"><button class="btn primary" data-act="save-custom" data-date="${esc(date)}">保存</button></div>`;
}

export function sheetEditStay(vm, day) {
  return `<h3>改住宿</h3>
    <div class="sheet-sub">${esc(vm.dateLabelOf(day.date))}</div>
    <div class="field"><label>酒店名称</label><input type="text" value="${esc(day.stay ? day.stay.name : '')}" data-input="name"></div>
    <div class="field"><label>电话</label><input type="tel" value="${esc(day.stay && day.stay.phone ? day.stay.phone : '')}" data-input="phone"></div>
    <label class="switch"><input type="checkbox" data-input="notify" checked> 通知同伴</label>
    <div class="sheet-foot"><button class="btn primary" data-act="save-stay" data-date="${esc(day.date)}">保存</button></div>`;
}
