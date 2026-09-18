// 端到端冒烟测试：用 jsdom 把真实页面跑起来，模拟真人点击，验证核心链路。
// 覆盖：渲染 / 打卡 / 跳过（local 隔离）/ 手记 / 待办 / 自定义点 / 导出 / 导出码往返导入 / 撤销
// 运行：node tests/ui.smoke.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const ROOT = path.join(import.meta.dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<script type="module"[\s\S]*?<\/script>/g, '');

const dom = new JSDOM(html, { url: 'https://example.test/trip/', pretendToBeVisual: true });
const { window } = dom;

/* ---- 补齐 jsdom 没实现的部分 ---- */
window.matchMedia = window.matchMedia || (() => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
window.scrollTo = () => {};
const blobs = [];
window.URL.createObjectURL = (blob) => { blobs.push(blob); return 'blob:mock'; };
window.URL.revokeObjectURL = () => {};
let clipboard = '';
Object.defineProperty(window.navigator, 'clipboard', { value: { writeText: async (t) => { clipboard = t; } }, configurable: true });

// Node 24 有些全局是只读的（navigator 等），必须用 defineProperty 覆盖
for (const k of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'Event', 'MouseEvent', 'Node', 'FileReader']) {
  Object.defineProperty(globalThis, k, { value: window[k], writable: true, configurable: true });
}
// Node 的 URL 没有 createObjectURL，补上；Blob 用 Node 自带的（有 .text()）
globalThis.URL.createObjectURL = (blob) => { blobs.push(blob); return 'blob:mock'; };
globalThis.URL.revokeObjectURL = () => {};
globalThis.fetch = async (url) => {
  if (String(url).includes('trip.json')) {
    return { ok: true, status: 200, json: async () => JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'trip.json'), 'utf8')) };
  }
  return { ok: false, status: 404, json: async () => ({}) };
};

// jsdom 里所有元素尺寸都是 0，画册模式的河流布局会提前退出。给一个手机大小的桩，
// 好让布局与曲线计算真的跑一遍（这样"不报错"才是有意义的断言）。
Object.defineProperty(window.Element.prototype, 'clientWidth', { get() { return 390; }, configurable: true });
Object.defineProperty(window.Element.prototype, 'offsetHeight', { get() { return 4200; }, configurable: true });

const tick = () => new Promise((r) => setTimeout(r, 8));
// 异步动作（gzip 打包、写剪贴板、读文件）不能靠"猜一个等待时间"，必须轮询到条件成立
async function waitFor(predicate, ms = 2000) {
  const t0 = Date.now();
  for (;;) {
    try { if (predicate()) return true; } catch { /* 条件自身可能暂时抛错 */ }
    if (Date.now() - t0 > ms) return false;
    await tick();
  }
}
const $ = (sel) => window.document.querySelector(sel);
const $$ = (sel) => [...window.document.querySelectorAll(sel)];
async function click(target) {
  const el = typeof target === 'string' ? $(target) : target;
  assert.ok(el, `找不到元素：${target}`);
  el.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await tick();
}
const records = () => JSON.parse(window.localStorage.getItem('dtrip.records.v1') || '[]');
const find = (id) => records().find((r) => r.id === id);
const setInput = (name, value) => {
  const el = $(`#sheet [data-input="${name}"]`);
  assert.ok(el, `弹层里没有 ${name} 输入框`);
  if (el.type === 'checkbox') el.checked = value; else el.value = value;
};

const results = [];
const step = (name, fn) => results.push([name, fn]);

/* ---- 导入被测应用 ---- */
const { boot, state } = await import('../app/ui.js');
const core = await import('../app/core.js');
await boot();
await tick();

step('渲染：顶部栏与今日视图', () => {
  const tb = $('#topbar').textContent;
  assert.match(tb, /大兴安岭/, '顶部栏应显示行程标题');
  assert.match(tb, /待同步|已同步|离线/, '顶部栏应显示同步状态');
  const view = $('#view').textContent;
  assert.match(view, /DAY 1/);
  assert.match(view, /哈尔滨/, '第一天路线应含哈尔滨');
  assert.match(view, /美希酒店/, '第一天住宿应渲染出来');
  assert.equal($$('#tabbar button').length, 4);
});

step('待办排版：当天内不重复日期，跨天列表用短日期（回归测试）', () => {
  const inDay = $$('.day .todo-block .todo');
  assert.ok(inDay.length > 0, '当天的待办块应存在');
  for (const t of inDay) {
    assert.equal(t.querySelector('.todo-date'), null, '当天行程里的待办不必重复显示日期（上面就是日期）');
  }
  const crossDay = $$('.todo').filter((t) => !t.closest('.day'));
  assert.ok(crossDay.length > 0, '跨天的「还没办的事」卡片应存在');
  for (const t of crossDay) {
    const d = t.querySelector('.todo-date');
    assert.ok(d, '跨天待办必须显示是哪天的');
    assert.match(d.textContent.trim(), /^\d{1,2}\.\d{1,2}$/, `日期应为 9.20 这种短格式，实际是「${d.textContent.trim()}」`);
  }
  const first = crossDay[0];
  assert.ok(first.querySelector('.todo-text'), '待办文字要有独立元素，才能只让文字伸缩、日期固定');
  assert.ok(!/\d+月\d+日/.test(first.textContent), '跨天待办里不该再出现「9月20日 周六」这种长日期');
});

step('打卡：产生确定性 id 的记录，并记录实际时间', async () => {
  const btn = $('[data-act="quick-check"]');
  const stopId = btn.dataset.id;
  await click(btn);
  const rec = find(`check:${stopId}`);
  assert.ok(rec, '应写入 check 记录');
  assert.equal(rec.kind, 'check');
  assert.equal(rec.payload.done, true);
  assert.match(rec.payload.actual, /^\d{2}:\d{2}$/, '应记录实际打卡时间');
  assert.equal(rec.scope, 'shared');
  const row = $$('.stop').find((li) => li.querySelector('[data-act="quick-check"]').dataset.id === stopId);
  assert.ok(row.classList.contains('done'), '打卡后该行应有完成样式');
  assert.equal(row.querySelector('[data-act="quick-check"]').textContent, '取消');
});

step('跳过：默认只留本机（scope=local）', async () => {
  const stopId = $('[data-act="quick-check"]').dataset.id;
  await click($$('[data-act="open-stop"]').find((b) => b.dataset.id === stopId));
  assert.ok($('#sheet').innerHTML.includes('跳过这个点'), '操作面板应出现');
  await click('[data-act="do-skip"]');
  const rec = find(`status:${stopId}`);
  assert.ok(rec, '应写入 status 记录');
  assert.equal(rec.payload.value, 'skipped');
  assert.equal(rec.scope, 'local', '跳过默认必须只留本机');
});

step('改时间：字段级覆盖，不动其他字段', async () => {
  const stopId = $('[data-act="quick-check"]').dataset.id;
  await click($$('[data-act="open-stop"]').find((b) => b.dataset.id === stopId));
  setInput('time', '08:15');
  setInput('notify', true);
  await click('[data-act="save-stop"]');
  const rec = find(`ovr:${stopId}:time`);
  assert.ok(rec, '应写入 override 记录');
  assert.equal(rec.payload.value, '08:15');
  assert.equal(rec.scope, 'shared');
  assert.match($('#view').textContent, /08:15/, '新时间应立即渲染出来');
});

step('手记：写一条并带上地点与日期', async () => {
  const noteBtn = $('[data-act="add-note"]');
  const target = noteBtn.dataset.target || undefined;
  await click(noteBtn);
  setInput('text', '草原上的风比想象中大，晚上加了外套。');
  await click('[data-act="save-note"]');
  const note = records().find((r) => r.kind === 'note' && !r.deleted);
  assert.ok(note, '应写入手记记录');
  assert.match(note.id, /^note:/);
  assert.equal(note.scope, 'shared');
  assert.match(note.payload.text, /草原上的风/);
  assert.match(note.payload.day, /^\d{4}-\d{2}-\d{2}$/, '手记必须带日期锚点以便按天分组');
  void target;
});

step('逐日视图：默认折叠，点开某天可展开', async () => {
  await click('#tabbar [data-view="days"]');
  const view = $('#view').textContent;
  assert.match(view, /DAY 1/);
  assert.match(view, /DAY 9/);
  assert.ok(!$$('.todo').length, '默认应全部折叠，不渲染待办');
  await click('[data-act="toggle-day"][data-date="2026-09-20"]');
  assert.match($('#view').textContent, /办防火证/, '展开 9.20 后应看到防火证待办');
});

step('待办：勾选防火证这类事项', async () => {
  const todo = $('.todo');
  assert.ok(todo, '展开后应出现待办');
  const id = todo.dataset.id;
  await click(todo);
  const rec = find(id);
  assert.ok(rec, '勾选待办应写入 check 记录');
  assert.equal(rec.payload.done, true);
  assert.equal(todo.closest('.todo').firstElementChild.checked, true, '复选框应保持勾选');
});

step('自定义点：加一个餐厅', async () => {
  const addBtn = $('[data-act="add-custom"]');
  assert.ok(addBtn, '展开的那天应有「加一个点」按钮');
  const date = addBtn.dataset.date;
  await click(addBtn);
  setInput('name', '路边小馆子');
  setInput('note', '临时加的');
  await click('[data-act="pick-type"][data-v="food"]');
  assert.equal($('#sheet [data-input="name"]').value, '路边小馆子', '切换类型不能清掉已输入的名称（回归测试）');
  assert.ok($('#sheet [data-input="note"]').value.includes('临时加的'), '切换类型不能清掉已输入的备注');
  await click('[data-act="save-custom"]');
  const custom = records().find((r) => r.kind === 'custom' && !r.deleted);
  assert.ok(custom, '应写入 custom 记录');
  assert.equal(custom.payload.name, '路边小馆子');
  assert.equal(custom.payload.day, date, '自定义点用日期做锚点');
  assert.match($('#view').textContent, /路边小馆子/, '新加的点应出现在当天行程里');
});

step('导出：本地记录不进入导出数据，且待同步归零', async () => {
  await click('[data-act="sync"]');
  await click('[data-act="export-file"]');
  assert.ok(await waitFor(() => blobs.length >= 1), '应生成导出文件');
  const envelope = JSON.parse(await blobs[0].text());
  assert.equal(envelope.trip, 'daxinganling-2026-09');
  assert.ok(envelope.records.length > 0);
  assert.ok(!envelope.records.some((r) => r.scope === 'local'), '导出数据绝不能包含 local 记录');
  assert.ok(!envelope.records.some((r) => r.kind === 'status'), '跳过记录默认不应导出');
  const meta = JSON.parse(window.localStorage.getItem('dtrip.meta.v1'));
  assert.ok(meta.lastExportAt > 0, '应记录上次导出时间');
});

step('同步码：复制出的文本可被解析回同样内容', async () => {
  await click('[data-act="sync"]');
  await click('[data-act="copy-code"]');
  const got = await waitFor(() => clipboard.length > 20);
  assert.ok(got, `剪贴板应有同步码（2 秒内没等到；当前长度 ${clipboard.length}）`);
  assert.match(clipboard, /^(DGZ1:|DJ1:)/);
  const env = await core.decodeCode(clipboard);
  const exported = JSON.parse(await blobs[0].text());
  assert.equal(env.records.length, exported.records.length,
    `剪贴板 ${env.records.length} 条 vs 导出文件 ${exported.records.length} 条`);
});

step('导入：合并同伴的新记录并更新较旧版本', async () => {
  const localCheck = records().find((r) => r.kind === 'check' && r.target && r.target.startsWith('d1'));
  const foreign = core.buildEnvelope({
    tripId: 'daxinganling-2026-09',
    deviceId: 'dev-other',
    records: [
      core.makeRecord({ id: 'note:from-other', kind: 'note', tripId: 'daxinganling-2026-09', deviceId: 'dev-other',
        payload: { text: '同伴写的：黑山头的日落太值了', day: '2026-09-21', place: '黑山头', at: Date.now() } }),
      core.makeRecord({ id: localCheck.id, kind: 'check', target: localCheck.target, tripId: 'daxinganling-2026-09', deviceId: 'dev-other',
        payload: { done: true, at: Date.now() + 60000, actual: '07:40' } }),
    ],
  });
  const code = await core.encodeCode(foreign);
  await click('[data-act="sync"]');
  setInput('code', code);
  await click('[data-act="import-code"]');
  assert.ok(await waitFor(() => records().some((r) => r.id === 'note:from-other')), '同伴的手记应被导入');
  const merged = records();
  const check = merged.find((r) => r.id === localCheck.id);
  assert.equal(check.payload.actual, '07:40', '较新的版本应覆盖本机版本');
  assert.ok(merged.some((r) => r.kind === 'status' && r.scope === 'local'), '导入绝不能删掉本机的 local 记录');
  assert.match($('#sheet').textContent, /新增 1 条|更新 1 条/, '应显示导入结果摘要');
  const meta = JSON.parse(window.localStorage.getItem('dtrip.meta.v1'));
  assert.ok(meta.lastImportSummary && meta.lastImportSummary.text.length > 0);
});

step('手记视图：按天分组并显示导入的手记', async () => {
  await click('#tabbar [data-view="notes"]');
  const text = $('#view').textContent;
  assert.match(text, /同伴写的/);
  assert.match(text, /9月21日/, '应按天分组');
});

step('删除 + 撤销：软删除后可以恢复', async () => {
  const noteRow = $$('.note').find((n) => n.textContent.includes('同伴写的'));
  await click(noteRow.querySelector('[data-act="del-note"]'));
  const note = records().find((r) => r.id === 'note:from-other');
  assert.equal(note.deleted, true, '必须是软删除');
  assert.ok(note.deleted_at > 0);
  await click('[data-act="undo"]');
  const back = records().find((r) => r.id === 'note:from-other');
  assert.equal(back.deleted, false, '撤销应恢复');
});

step('索引页：分类查看 → 搜索过滤 → 跳回当天', async () => {
  await click('#tabbar [data-view="index"]');
  const list = $('#index-list');
  assert.ok(list, '索引页应有列表容器');
  assert.match(list.textContent, /美希酒店/, '默认「全部」应列出住宿');
  assert.match(list.textContent, /米家烤肉/, '默认「全部」应包含餐厅');
  assert.match(list.textContent, /办防火证/, '默认「全部」应包含待办');

  await click('[data-act="seg"][data-v="todo"]');
  assert.match($('#index-list').textContent, /办防火证/);
  assert.ok(!/美希酒店/.test($('#index-list').textContent), '切到待办后不应再出现住宿');

  await click('[data-act="seg"][data-v="food"]');
  assert.match($('#index-list').textContent, /米家烤肉/);
  assert.ok(!/莫尔格勒河/.test($('#index-list').textContent), '美食分类里不应出现景点');

  await click('[data-act="seg"][data-v="all"]');
  const input = $('[data-input="query"]');
  input.value = '美希';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  await tick();
  const filtered = $('#index-list').textContent;
  assert.match(filtered, /美希酒店/);
  assert.ok(!/米家烤肉/.test(filtered), '搜索应过滤掉不匹配项');
  assert.equal($('[data-input="query"]').value, '美希', '输入过程中搜索框不能被重绘清空（回归测试）');

  await click('[data-act="goto-day"]');
  assert.equal(state.view, 'days', '「看当天」应切到行程页');
  assert.ok($('#day-2026-09-19 .day-body'), '并展开那一天');
});

step('画册模式：行程页挂上河流时间轴，切回速查即卸载', async () => {
  await click('[data-act="settings"]');
  await click('[data-act="set-mode"][data-v="album"]');
  assert.equal(window.document.documentElement.getAttribute('data-mode'), 'album');
  const meta = JSON.parse(window.localStorage.getItem('dtrip.meta.v1'));
  assert.equal(meta.mode, 'album', '显示模式应持久化');

  await click('#tabbar [data-view="days"]');
  assert.ok($('.river'), '行程页应有河流容器');
  assert.ok($('.river-svg'), '画册模式应挂上 SVG 河流');
  assert.equal($$('.river-dot').length, 9, '9 天应有 9 个节点');
  assert.ok($('.river-path').getAttribute('d').startsWith('M '), '应生成曲线路径');
  assert.ok($('.ghost'), '画册模式应显示天数水印');

  await click('[data-act="settings"]');
  await click('[data-act="set-mode"][data-v="quick"]');
  await click('#tabbar [data-view="days"]');
  assert.equal(window.document.documentElement.getAttribute('data-mode'), 'quick');
  assert.equal($('.river-svg'), null, '速查模式不应挂河流（省性能）');
});

step('主题切换与设置页', async () => {
  await click('[data-act="settings"]');
  assert.match($('#sheet').textContent, /还没确认的信息/, '设置页应列出待确认信息');
  assert.match($('#sheet').textContent, /离线缓存/, '设置页应显示离线缓存状态（让用户能亲眼确认离线已就绪）');
  await click('[data-act="set-theme"][data-v="dark"]');
  assert.equal(window.document.documentElement.getAttribute('data-theme'), 'dark');
  const meta = JSON.parse(window.localStorage.getItem('dtrip.meta.v1'));
  assert.equal(meta.theme, 'dark', '主题选择应持久化');
});

/* ---- 执行 ---- */
let pass = 0;
let fail = 0;
for (const [name, fn] of results) {
  try {
    await fn();
    console.log(`✔ ${name}`);
    pass += 1;
  } catch (err) {
    console.log(`✖ ${name}\n   ${err.message}`);
    fail += 1;
  }
}
console.log(`\n冒烟测试：${pass} 通过 / ${fail} 失败（今天=${state.today}，视图=${state.view}）`);
process.exit(fail === 0 ? 0 : 1);
