// 资产完整性测试：保证"离线可用"这件事没有漏洞。
// 预缓存清单里有一个文件不存在，cache.addAll 会整体失败——那样草原上就打不开了。
// 运行：node tests/assets.test.mjs
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';

const ROOT = path.join(import.meta.dirname, '..');
const results = [];
function check(name, fn) {
  try { fn(); console.log(`✔ ${name}`); results.push(true); }
  catch (err) { console.log(`✖ ${name}\n   ${err.message}`); results.push(false); }
}

const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

check('Service Worker 预缓存的每个文件都真实存在', () => {
  const sw = read('sw.js');
  const list = sw.match(/const ASSETS = \[([\s\S]*?)\];/)[1]
    .split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
  assert.ok(list.length >= 10, `预缓存清单太少：${list.length}`);
  const missing = list.filter((p) => !fs.existsSync(path.join(ROOT, p === './' ? 'index.html' : p)));
  assert.deepEqual(missing, [], `预缓存清单里有不存在的文件：${missing.join(', ')}`);
  console.log(`   （清单 ${list.length} 项，全部存在）`);
});

check('index.html 引用的资源都存在', () => {
  const html = read('index.html');
  const refs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1]).filter((u) => !/^(https?:|data:|#)/.test(u));
  assert.ok(refs.length >= 5, `引用太少，可能没解析到：${refs.length}`);
  const missing = refs.filter((r) => !fs.existsSync(path.join(ROOT, r)));
  assert.deepEqual(missing, [], `缺失：${missing.join(', ')}`);
});

check('每个模块的 import 路径都能解析到真实文件', () => {
  const files = ['app/main.js', 'app/ui.js', 'app/render.js', 'app/store.js', 'app/core.js'];
  const bad = [];
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) {
      const target = path.join(ROOT, path.dirname(f), m[1]);
      if (!fs.existsSync(target)) bad.push(`${f} → ${m[1]}`);
    }
  }
  assert.deepEqual(bad, [], `无法解析的 import：${bad.join(', ')}`);
});

check('manifest 合法且图标文件存在', () => {
  const mf = JSON.parse(read('manifest.webmanifest'));
  assert.equal(mf.display, 'standalone');
  assert.equal(mf.start_url, './');
  assert.ok(mf.icons.length >= 2);
  const missing = mf.icons.filter((i) => !fs.existsSync(path.join(ROOT, i.src))).map((i) => i.src);
  assert.deepEqual(missing, [], `图标缺失：${missing.join(', ')}`);
  assert.ok(mf.icons.some((i) => i.purpose === 'maskable'), '应有一个 maskable 图标');
  assert.ok(mf.icons.some((i) => i.sizes === '192x192') && mf.icons.some((i) => i.sizes === '512x512'), 'PWA 安装需要 192 与 512');
});

check('全应用零外部依赖：没有任何 CDN / 外链', () => {
  const files = ['index.html', 'app.css', 'sw.js', 'manifest.webmanifest', 'app/main.js', 'app/ui.js', 'app/render.js', 'app/store.js', 'app/core.js'];
  const hits = [];
  for (const f of files) {
    const src = read(f);
    for (const m of src.matchAll(/https?:\/\/[^\s'"()<>]+/g)) {
      const url = m[0];
      if (/^https?:\/\/(example\.test|localhost)/.test(url)) continue;
      if (/schemas|w3\.org|github\.com|developer\.mozilla/.test(url)) continue; // 注释里的说明链接
      hits.push(`${f}: ${url}`);
    }
  }
  assert.deepEqual(hits, [], `发现外部依赖（断网会挂）：\n   ${hits.join('\n   ')}`);
});

check('行程数据基本结构完整', () => {
  const trip = JSON.parse(read('data/trip.json'));
  assert.equal(trip.days.length, 9);
  assert.equal(trip.meta.flights.length, 2);
  const ids = trip.days.flatMap((d) => d.stops.map((s) => s.id));
  assert.equal(new Set(ids).size, ids.length, 'stop id 不能重复（手记靠它当锚点）');
  for (const d of trip.days) {
    assert.match(d.date, /^\d{4}-\d{2}-\d{2}$/);
    for (const s of d.stops) assert.ok(['sight', 'food', 'activity', 'transit'].includes(s.type), `未知类型 ${s.type}`);
  }
  assert.ok(trip.meta.openQuestions.length >= 5);
});

check('租车信息结构完整（归程时刻表依赖它）', () => {
  const v = JSON.parse(read('data/trip.json')).meta.vehicle;
  assert.ok(v, 'meta.vehicle 必须存在');
  assert.equal(v.events.length, 2);
  const kinds = v.events.map((e) => e.kind).join(',');
  assert.equal(kinds, 'pickup,dropoff');
  for (const e of v.events) assert.match(e.at, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/, `时间格式应为本地时间：${e.at}`);
  const returnLeg = v.events.find((e) => e.kind === 'dropoff');
  assert.ok(returnLeg, '必须有还车事件');
  assert.ok(v.departureBufferMin > 0);
});

check('车程数据只有一处来源，且归程那天必须有', () => {
  const trip = JSON.parse(read('data/trip.json'));
  const byDate = Object.fromEntries(trip.days.map((d) => [d.date, d]));
  assert.equal(byDate['2026-09-26'].driveHours, 7.5, '9.26 根河→齐齐哈尔 用户核实为 7 小时多，按 7.5 计');
  assert.equal(byDate['2026-09-27'].driveHours, 3.5, '9.27 齐齐哈尔→机场 3–3.5 小时');
  assert.equal(byDate['2026-09-19'].driveHours, 3, '9.19 机场→齐齐哈尔 约 3 小时');
  for (const d of trip.days) {
    if (d.driveHours != null) assert.ok(d.driveHours > 0 && d.driveHours < 20, `${d.date} 车程数值不合理：${d.driveHours}`);
  }
  // 车程不能再重复存在于 vehicle.legs，否则两处数据会打架
  const legs = trip.meta.vehicle.legs || [];
  assert.equal(legs.length, 0, 'vehicle.legs 已废弃，车程统一放在 days[].driveHours');
});

const pass = results.filter(Boolean).length;
console.log(`\n资产测试：${pass} 通过 / ${results.length - pass} 失败`);
process.exit(pass === results.length ? 0 : 1);
