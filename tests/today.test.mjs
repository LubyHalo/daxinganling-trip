// 日期相关逻辑测试：用假时钟把"今天"分别设成出发前一天 / 出发日 / 途中 / 归程日 / 结束后，
// 验证今天视图、航班倒计时、归程倒推、推迟到今天的显示。
// 运行：node tests/today.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';

const ROOT = path.join(import.meta.dirname, '..');
const REAL_DATE = globalThis.Date;
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/<script type="module"[\s\S]*?<\/script>/g, '');
const TRIP = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'trip.json'), 'utf8'));

function fakeClock(isoLocal) {
  const fixed = new REAL_DATE(isoLocal).getTime();
  class FakeDate extends REAL_DATE {
    constructor(...args) { if (args.length === 0) super(fixed); else super(...args); }
    static now() { return fixed; }
  }
  globalThis.Date = FakeDate;
}

async function bootAt(isoLocal, { seed = [] } = {}) {
  fakeClock(isoLocal);
  const dom = new JSDOM(html, { url: 'https://example.test/trip/', pretendToBeVisual: true });
  const { window } = dom;
  window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {} });
  window.scrollTo = () => {};
  window.URL.createObjectURL = () => 'blob:mock';
  window.URL.revokeObjectURL = () => {};
  if (seed.length) window.localStorage.setItem('dtrip.records.v1', JSON.stringify(seed));
  for (const k of ['window', 'document', 'navigator', 'localStorage', 'HTMLElement', 'Event', 'MouseEvent', 'Node', 'FileReader']) {
    Object.defineProperty(globalThis, k, { value: window[k], writable: true, configurable: true });
  }
  globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => TRIP });
  const mod = await import(`../app/ui.js?case=${encodeURIComponent(isoLocal)}-${seed.length}`);
  await mod.boot();
  await new Promise((r) => setTimeout(r, 8));
  return { window, state: mod.state };
}

const results = [];
async function check(name, fn) {
  try { await fn(); console.log(`✔ ${name}`); results.push(true); }
  catch (err) { console.log(`✖ ${name}\n   ${err.message}`); results.push(false); }
}
const text = (window) => window.document.getElementById('view').textContent;
const $ = (window, sel) => window.document.querySelector(sel);

/* ---- 出发前一天（2026-09-18）---- */
let vt = await bootAt('2026-09-18T12:00:00');
await check('出发前一天：显示倒计时、航班卡片与第一天预览（含取车信息）', () => {
  const t = text(vt.window);
  assert.match(t, /距出发还有/, '应显示距出发倒计时');
  assert.match(t, /FU6717/, '应显示去程航班');
  assert.match(t, /还有 1 天/, '航班卡片应显示还有 1 天');
  assert.match(t, /DAY 1/, '应预览第一天');
  assert.match(t, /美希酒店/);
  assert.match(t, /15:30/, '预览第一天时应能看到 15:30 取车');
  assert.match(t, /预计 18:30 抵达齐齐哈尔/);
});

/* ---- 出发日（2026-09-19 08:00）---- */
vt = await bootAt('2026-09-19T08:00:00');
await check('出发日：今天视图锁定 DAY 1，并给出航班与取车倒推', () => {
  const t = text(vt.window);
  assert.match(t, /今天 · 9月19日 周六/, '应显示今天标题');
  assert.match(t, /FU6717/);
  assert.match(t, /距 10:00 起飞还有 2 小时 0 分钟/, '倒计时应精确到分钟');
  assert.match(t, /06:00/, '应给出建议出发时间（10:00 起飞的 4 小时倒推）');
  assert.match(t, /距取车还有 7 小时 30 分钟/, '应显示距取车倒计时（08:00 → 15:30）');
  assert.match(t, /哈尔滨太平机场服务点/, '应显示取车地点');
  assert.match(t, /神州租车/, '应显示租车公司');
  const card = $(vt.window, '.day.is-today');
  assert.ok(card, '今天的日程卡应有 is-today 标记');
  assert.match(card.textContent, /米家烤肉/, '今天应显示当天的餐厅');
  assert.match(card.textContent, /预计 18:30 抵达齐齐哈尔/, '取车 15:30 + 3 小时车程应算出抵达时间');
  assert.match(card.textContent, /身份认证/, '取车日应提醒提前完成认证');
});

/* ---- 途中（2026-09-21）---- */
const seed = [{
  id: 'status:d2-s1', kind: 'status', trip: TRIP.meta.id, target: 'd2-s1', scope: 'local',
  payload: { value: 'deferred', to: '2026-09-21' }, updated_at: 1, device_id: 'dev-t', deleted: false, deleted_at: null,
}];
vt = await bootAt('2026-09-21T09:30:00', { seed });
await check('途中：显示当天行程，且带出"从别的日子推迟过来的"', () => {
  const t = text(vt.window);
  assert.match(t, /今天 · 9月21日 周一/);
  assert.match(t, /莫尔格勒河|莫日格勒河/, '应显示当天的景点');
  assert.match(t, /从别的日子推迟过来的/, '应显示推迟过来的分组');
  assert.match(t, /来自 9月20日/, '应标明来源日期');
});

/* ---- 归程日（2026-09-27 10:00）---- */
vt = await bootAt('2026-09-27T10:00:00');
await check('归程日：自驾到机场还车，按车程倒推出发时间（不再是公共交估算）', () => {
  const t = text(vt.window);
  assert.match(t, /FU6718/, '应显示回程航班号');
  assert.match(t, /18:50/);
  assert.match(t, /还车/, '应显示还车步骤');
  assert.match(t, /15:30/, '应显示 15:30 还车');
  assert.match(t, /归程时刻表/, '应显示归程时刻表');
  assert.match(t, /建议 11:30 前从齐齐哈尔出发/, '15:30 还车 − 3.5 小时车程 − 30 分缓冲 = 11:30');
  assert.ok(!/14:50/.test(t), '不应再出现按公共交通假设算出的 14:50（回归测试）');
  assert.match(t, /今天 · 9月27日 周日/);
});

/* ---- 结束后（2026-09-28）---- */
vt = await bootAt('2026-09-28T10:00:00');
await check('行程结束后：提示已结束，不再显示航班卡片', () => {
  const t = text(vt.window);
  assert.match(t, /行程已结束/);
  assert.equal($(vt.window, '.card.flight'), null, '结束后不应再渲染航班卡片');
});

globalThis.Date = REAL_DATE;
const pass = results.filter(Boolean).length;
console.log(`\n日期测试：${pass} 通过 / ${results.length - pass} 失败`);
process.exit(pass === results.length ? 0 : 1);
