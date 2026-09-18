// 核心逻辑单元测试：node --test tests/
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  SCHEMA_VERSION, CODE_GZIP, CODE_RAW,
  checkId, overrideId, statusId, noteId,
  makeRecord, mergeRecords, buildEnvelope, validateEnvelope,
  encodeCode, decodeCode,
  toISODate, todayISO, shiftISODate, daysBetween, formatCN, atTime, latestDeparture,
  indexById, stopState, pendingCount,
  DEFAULT_SCOPE, SCOPE_LOCAL,
} from '../app/core.js';

const TRIP = 'daxinganling-2026-09';
const rec = (over = {}) => makeRecord({ tripId: TRIP, deviceId: 'dev-a', at: 1000, ...over });

test('确定性 id：同一件事在不同设备算出同一个 id', () => {
  assert.equal(checkId('d1-s1'), 'check:d1-s1');
  assert.equal(overrideId('d3-s2', 'time'), 'ovr:d3-s2:time');
  assert.equal(statusId('d3-s2'), 'status:d3-s2');
  assert.equal(noteId('abc'), 'note:abc');
});

test('跳过/推迟默认只留本机，其余默认共享', () => {
  assert.equal(DEFAULT_SCOPE.status, SCOPE_LOCAL);
  assert.equal(DEFAULT_SCOPE.check, 'shared');
  assert.equal(DEFAULT_SCOPE.note, 'shared');
});

test('合并：并集，同 id 取较新的那份', () => {
  const local = [rec({ id: checkId('d1-s1'), kind: 'check', target: 'd1-s1', payload: { done: true, actual: '09:00' }, at: 1000 })];
  const incoming = [rec({ id: checkId('d1-s1'), kind: 'check', target: 'd1-s1', payload: { done: true, actual: '09:34' }, at: 2000, deviceId: 'dev-b' })];
  const { records, stats } = mergeRecords(local, incoming);
  assert.equal(records.length, 1);
  assert.equal(records[0].payload.actual, '09:34');
  assert.equal(stats.updated, 1);
  assert.equal(stats.added, 0);
});

test('合并：本地较新时不回退', () => {
  const local = [rec({ id: overrideId('d3-s2', 'time'), kind: 'override', target: 'd3-s2', payload: { value: '10:00' }, at: 5000 })];
  const incoming = [rec({ id: overrideId('d3-s2', 'time'), kind: 'override', target: 'd3-s2', payload: { value: '09:00' }, at: 3000, deviceId: 'dev-b' })];
  const { records, stats } = mergeRecords(local, incoming);
  assert.equal(records[0].payload.value, '10:00');
  assert.equal(stats.keptLocal, 1);
});

test('合并：时间戳相同但内容不同 → 记为冲突', () => {
  const local = [rec({ id: overrideId('d3-s2', 'time'), kind: 'override', target: 'd3-s2', payload: { value: '10:00' }, at: 4000 })];
  const incoming = [rec({ id: overrideId('d3-s2', 'time'), kind: 'override', target: 'd3-s2', payload: { value: '11:00' }, at: 4000, deviceId: 'dev-b' })];
  const { stats, conflictIds } = mergeRecords(local, incoming);
  assert.equal(stats.conflicts, 1);
  assert.deepEqual(conflictIds, ['ovr:d3-s2:time']);
});

test('合并：导入永不删除本地记录（本地独有记录全部保留）', () => {
  const local = [
    rec({ id: noteId('n1'), kind: 'note', payload: { text: '我的私有草稿', day: '2026-09-21' } }),
    rec({ id: checkId('d2-s1'), kind: 'check', target: 'd2-s1', payload: { done: true } }),
  ];
  const { records } = mergeRecords(local, []);
  assert.equal(records.length, 2);
});

test('合并：软删除会传播（较新的删除胜出）', () => {
  const del = rec({ id: noteId('n1'), kind: 'note', payload: { text: '' }, at: 9000, deleted: true, deviceId: 'dev-b' });
  const alive = rec({ id: noteId('n1'), kind: 'note', payload: { text: '原内容' }, at: 1000 });
  const { records, stats } = mergeRecords([alive], [del]);
  assert.equal(records[0].deleted, true);
  assert.equal(stats.updated, 1);
});

test('合并：删除更早、对方的新编辑更晚 → 记录复活（LWW 的已知取舍）', () => {
  const olderDel = rec({ id: noteId('n1'), kind: 'note', payload: { text: '' }, at: 1000, deleted: true });
  const newerEdit = rec({ id: noteId('n1'), kind: 'note', payload: { text: '我在你删掉之后又改了' }, at: 9000, deviceId: 'dev-b' });
  const { records } = mergeRecords([olderDel], [newerEdit]);
  assert.equal(records[0].deleted, false);
  assert.equal(records[0].payload.text, '我在你删掉之后又改了');
});

test('合并：拒收别人的 local 记录与非法记录', () => {
  const incoming = [
    rec({ id: statusId('d2-s3'), kind: 'status', target: 'd2-s3', scope: SCOPE_LOCAL, payload: { value: 'skipped' } }),
    { id: '', kind: 'note', payload: {} },
    null,
  ];
  const { records, stats } = mergeRecords([], incoming);
  assert.equal(records.length, 0);
  assert.equal(stats.rejectedLocalScope, 1);
  assert.equal(stats.rejectedInvalid, 2);
});

test('导出信封：必须剔除 local 记录', () => {
  const records = [
    rec({ id: checkId('d1-s1'), kind: 'check', target: 'd1-s1', payload: { done: true } }),
    rec({ id: statusId('d1-s1'), kind: 'status', target: 'd1-s1', scope: SCOPE_LOCAL, payload: { value: 'skipped' } }),
    rec({ id: noteId('n9'), kind: 'note', scope: SCOPE_LOCAL, payload: { text: '只给自己看' } }),
  ];
  const env = buildEnvelope({ tripId: TRIP, deviceId: 'dev-a', records });
  assert.equal(env.count, 1);
  assert.equal(env.records.length, 1);
  assert.equal(env.records[0].id, 'check:d1-s1');
});

test('信封校验：版本与行程不匹配要报错', () => {
  assert.throws(() => validateEnvelope({ v: 99, trip: TRIP, records: [] }, TRIP), /版本不匹配/);
  assert.throws(() => validateEnvelope({ v: SCHEMA_VERSION, trip: 'other', records: [] }, TRIP), /其他行程/);
  assert.throws(() => validateEnvelope({ v: SCHEMA_VERSION, trip: TRIP }, TRIP), /没有记录列表/);
  assert.doesNotThrow(() => validateEnvelope({ v: SCHEMA_VERSION, trip: TRIP, records: [] }, TRIP));
});

test('同步码：gzip 与未压缩两种格式都能往返', async () => {
  const env = buildEnvelope({
    tripId: TRIP, deviceId: 'dev-a',
    records: [rec({ id: noteId('n1'), kind: 'note', payload: { text: '奇乾的夜里没有信号，星星特别多。'.repeat(20), day: '2026-09-24' } })],
  });
  const code = await encodeCode(env);
  assert.ok(code.startsWith(CODE_GZIP) || code.startsWith(CODE_RAW));
  const back = await decodeCode(code);
  assert.equal(back.trip, TRIP);
  assert.equal(back.records.length, 1);
  assert.equal(back.records[0].payload.day, '2026-09-24');

  // 未压缩兜底格式
  const rawCode = CODE_RAW + Buffer.from(JSON.stringify(env)).toString('base64');
  const back2 = await decodeCode(rawCode);
  assert.equal(back2.records.length, 1);

  // 也接受直接粘贴 JSON 文件内容
  const back3 = await decodeCode(JSON.stringify(env));
  assert.equal(back3.records.length, 1);
});

test('同步码：压缩确实能显著减小体积', async () => {
  const records = Array.from({ length: 40 }, (_, i) =>
    rec({ id: noteId(`n${i}`), kind: 'note', payload: { text: `第 ${i} 天的手记内容，随便写点东西。`, day: '2026-09-21' } }));
  const env = buildEnvelope({ tripId: TRIP, deviceId: 'dev-a', records });
  const gz = await encodeCode(env);
  const raw = CODE_RAW + Buffer.from(JSON.stringify(env)).toString('base64');
  assert.ok(gz.length < raw.length, `压缩后应更短：${gz.length} vs ${raw.length}`);
});

test('同步码：坏输入要给出可读的报错', async () => {
  await assert.rejects(() => decodeCode('这是一段随手粘的微信聊天记录'), /不是本应用的同步码/);
  await assert.rejects(() => decodeCode('   '), /内容为空/);
});

test('日期工具：ISO 往返、跨月与星期', () => {
  assert.equal(shiftISODate('2026-09-19', 1), '2026-09-20');
  assert.equal(shiftISODate('2026-09-30', 1), '2026-10-01');
  assert.equal(shiftISODate('2026-09-01', -1), '2026-08-31');
  assert.equal(daysBetween('2026-09-18', '2026-09-19'), 1);
  assert.equal(daysBetween('2026-09-18', '2026-09-27'), 9);
  assert.equal(formatCN('2026-09-19'), '9月19日 周六');
  assert.equal(formatCN('2026-09-27'), '9月27日 周日');
  const d = new Date(2026, 8, 19, 10, 0, 0);
  assert.equal(toISODate(d), '2026-09-19');
  assert.equal(todayISO(d), '2026-09-19');
});

test('归程倒推：跨零点要退到前一天', () => {
  assert.deepEqual(latestDeparture('18:50', 4), { hhmm: '14:50', dayShift: 0, iso: null });
  const late = latestDeparture('02:00', 4, '2026-09-27');
  assert.equal(late.hhmm, '22:00');
  assert.equal(late.dayShift, -1);
  assert.equal(late.iso, '2026-09-26');
  assert.equal(latestDeparture('', 4), null);
});

test('站点状态：打卡 / 跳过 / 推迟', () => {
  const records = [
    rec({ id: checkId('d1-s1'), kind: 'check', target: 'd1-s1', payload: { done: true, at: 111, actual: '09:34' }, at: 111 }),
    rec({ id: statusId('d1-s2'), kind: 'status', target: 'd1-s2', payload: { value: 'skipped' }, at: 222 }),
    rec({ id: statusId('d1-s3'), kind: 'status', target: 'd1-s3', payload: { value: 'deferred', to: '2026-09-21' }, at: 333 }),
  ];
  const idx = indexById(records);
  const s1 = stopState(idx, 'd1-s1', '2026-09-21');
  assert.equal(s1.done, true);
  assert.equal(s1.actual, '09:34');
  assert.equal(stopState(idx, 'd1-s2', '2026-09-21').skipped, true);
  const s3 = stopState(idx, 'd1-s3', '2026-09-21');
  assert.equal(s3.deferredTo, '2026-09-21');
  assert.equal(s3.deferredToToday, true);
  assert.equal(stopState(idx, 'd9-s9', '2026-09-21').done, false);
});

test('软删除的记录不参与站点状态', () => {
  const idx = indexById([rec({ id: checkId('d1-s1'), kind: 'check', target: 'd1-s1', payload: { done: true }, at: 5, deleted: true })]);
  assert.equal(stopState(idx, 'd1-s1', '2026-09-21').done, false);
});

test('待同步条数：按上次导出时间统计', () => {
  const records = [
    rec({ id: 'a', kind: 'note', payload: { text: 'x' }, at: 1000 }),
    rec({ id: 'b', kind: 'note', payload: { text: 'y' }, at: 3000 }),
    rec({ id: 'c', kind: 'note', payload: { text: 'z' }, at: 5000, deleted: true }),
  ];
  assert.equal(pendingCount(records, 2000), 2);
  assert.equal(pendingCount(records, 5000), 0);
});
