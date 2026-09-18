// 纯逻辑层：记录模型、合并算法、同步码编解码、日期工具。
// 刻意不依赖 DOM，可在 Node 中用 node --test 直接单元测试。

export const SCHEMA_VERSION = 1;
export const CODE_GZIP = 'DGZ1:'; // gzip + base64
export const CODE_RAW = 'DJ1:'; // 纯 JSON + base64（浏览器不支持压缩时的兜底）

/* ---------------- 记录 id：同一件事在所有人手机上算出同一个 id ---------------- */

export const checkId = (target) => `check:${target}`;
export const overrideId = (target, field) => `ovr:${target}:${field}`;
export const statusId = (target) => `status:${target}`;
export const noteId = (uuid) => `note:${uuid}`;
export const customId = (uuid) => `custom:${uuid}`;

export function newUuid() {
  const c = globalThis.crypto;
  if (c && typeof c.randomUUID === 'function') return c.randomUUID();
  return `u${Date.now().toString(36)}${Math.random().toString(36).slice(2, 10)}`;
}

export const SCOPE_LOCAL = 'local';
export const SCOPE_SHARED = 'shared';

/** 各类记录的默认可见范围：跳过/推迟默认只留本机 */
export const DEFAULT_SCOPE = {
  check: SCOPE_SHARED,
  note: SCOPE_SHARED,
  override: SCOPE_SHARED,
  status: SCOPE_LOCAL,
  custom: SCOPE_SHARED,
};

export function makeRecord({
  id,
  kind,
  tripId,
  target = null,
  scope = SCOPE_SHARED,
  payload = {},
  deviceId,
  at = Date.now(),
  deleted = false,
}) {
  return {
    id,
    kind,
    trip: tripId,
    target,
    scope,
    payload,
    updated_at: at,
    device_id: deviceId || 'unknown',
    deleted: Boolean(deleted),
    deleted_at: deleted ? at : null,
  };
}

export function isValidRecord(r) {
  return Boolean(
    r && typeof r === 'object' && typeof r.id === 'string' && r.id.length > 0 &&
    typeof r.kind === 'string' && r.payload && typeof r.payload === 'object'
  );
}

const byUpdatedAsc = (a, b) => (a.updated_at || 0) - (b.updated_at || 0) || String(a.id).localeCompare(String(b.id));

const sameContent = (a, b) =>
  Boolean(a.deleted) === Boolean(b.deleted) && JSON.stringify(a.payload) === JSON.stringify(b.payload);

/**
 * 无后端合并：按 id 做并集，同 id 取 updated_at 更新的那份。
 * 铁律：绝不因为导入而删除本地记录（只有本地自己的删除动作才会删）。
 * 别人的 local 记录一律拒收（防御性检查）。
 */
export function mergeRecords(localList = [], incomingList = []) {
  const byId = new Map();
  for (const r of localList) if (isValidRecord(r)) byId.set(r.id, r);

  const stats = { added: 0, updated: 0, keptLocal: 0, identical: 0, conflicts: 0, rejectedLocalScope: 0, rejectedInvalid: 0 };
  const conflictIds = [];

  for (const inc of incomingList) {
    if (!isValidRecord(inc)) { stats.rejectedInvalid += 1; continue; }
    if (inc.scope === SCOPE_LOCAL) { stats.rejectedLocalScope += 1; continue; }

    const cur = byId.get(inc.id);
    if (!cur) { byId.set(inc.id, inc); stats.added += 1; continue; }
    if (sameContent(cur, inc)) { stats.identical += 1; continue; }

    const a = Number(cur.updated_at) || 0;
    const b = Number(inc.updated_at) || 0;
    if (b > a) { byId.set(inc.id, inc); stats.updated += 1; }
    else if (b < a) { stats.keptLocal += 1; }
    else { byId.set(inc.id, inc); stats.conflicts += 1; conflictIds.push(inc.id); }
  }

  return { records: [...byId.values()].sort(byUpdatedAsc), stats, conflictIds };
}

/* ---------------- 导出/导入信封与同步码 ---------------- */

export function buildEnvelope({ tripId, deviceId, records = [], now = Date.now() }) {
  const shared = records.filter((r) => isValidRecord(r) && r.scope !== SCOPE_LOCAL);
  return {
    v: SCHEMA_VERSION,
    trip: tripId,
    device: deviceId,
    exported_at: now,
    count: shared.length,
    records: shared,
  };
}

export function validateEnvelope(env, tripId) {
  if (!env || typeof env !== 'object') throw new Error('同步码内容无法识别');
  if (env.v !== SCHEMA_VERSION) throw new Error(`同步码版本不匹配（对方 v${env.v}，本机 v${SCHEMA_VERSION}），请双方都更新到最新版再同步`);
  if (tripId && env.trip !== tripId) throw new Error(`这份数据属于其他行程（${env.trip}），已拒绝导入`);
  if (!Array.isArray(env.records)) throw new Error('同步码里没有记录列表');
  return env;
}

const b64encode = (bytes) => {
  if (typeof Buffer !== 'undefined') return Buffer.from(bytes).toString('base64');
  let s = '';
  for (let i = 0; i < bytes.length; i += 1) s += String.fromCharCode(bytes[i]);
  return btoa(s);
};

const b64decode = (str) => {
  if (typeof Buffer !== 'undefined') return new Uint8Array(Buffer.from(str, 'base64'));
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
};

async function gzipBytes(bytes) {
  if (typeof CompressionStream === 'undefined') return null;
  const stream = new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

async function gunzipBytes(bytes) {
  if (typeof DecompressionStream === 'undefined') throw new Error('这台手机的浏览器不支持解压同步码，请改用「导入文件」或让对方改用文件发给你');
  const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/** 生成同步码文本（可整段粘贴到微信） */
export async function encodeCode(envelope) {
  const bytes = new TextEncoder().encode(JSON.stringify(envelope));
  const gz = await gzipBytes(bytes);
  return gz ? CODE_GZIP + b64encode(gz) : CODE_RAW + b64encode(bytes);
}

/** 解析同步码文本；也接受直接粘贴的 JSON 文件内容 */
export async function decodeCode(text) {
  const raw = String(text || '').trim();
  if (!raw) throw new Error('内容为空');
  if (raw.startsWith('{')) return validateEnvelope(JSON.parse(raw));
  if (raw.startsWith(CODE_GZIP)) return validateEnvelope(JSON.parse(new TextDecoder().decode(await gunzipBytes(b64decode(raw.slice(CODE_GZIP.length))))));
  if (raw.startsWith(CODE_RAW)) return validateEnvelope(JSON.parse(new TextDecoder().decode(b64decode(raw.slice(CODE_RAW.length)))));
  throw new Error('这不是本应用的同步码（开头应为 DGZ1: 或 DJ1:）');
}

/* ---------------- 日期与倒计时 ---------------- */

export const pad2 = (n) => String(n).padStart(2, '0');

export function toISODate(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

export function todayISO(now = new Date()) {
  return toISODate(now);
}

export function parseISODate(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 整天差（b - a），用于"距出发还有 N 天" */
export function daysBetween(aISO, bISO) {
  const a = parseISODate(aISO);
  const b = parseISODate(bISO);
  if (!a || !b) return null;
  const ms = new Date(b.getFullYear(), b.getMonth(), b.getDate()) - new Date(a.getFullYear(), a.getMonth(), a.getDate());
  return Math.round(ms / 86400000);
}

export function shiftISODate(iso, days) {
  const d = parseISODate(iso);
  if (!d) return null;
  d.setDate(d.getDate() + days);
  return toISODate(d);
}

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];

export function formatCN(iso) {
  const d = parseISODate(iso);
  if (!d) return String(iso || '');
  return `${d.getMonth() + 1}月${d.getDate()}日 ${WEEK[d.getDay()]}`;
}

export function nowHHMM(now = new Date()) {
  return `${pad2(now.getHours())}:${pad2(now.getMinutes())}`;
}

/** 把 "HH:MM" 与日期合成时间戳（本地时区） */
export function atTime(iso, hhmm) {
  const d = parseISODate(iso);
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || ''));
  if (!d || !m) return null;
  d.setHours(Number(m[1]), Number(m[2]), 0, 0);
  return d.getTime();
}

/**
 * 归程"建议最晚离开时间"：起飞时间往前推 transferHours 小时（默认 4 小时，
 * 含约 2 小时机场提前量与城际转场时间）。这是估算值，界面必须标明。
 */
export function latestDeparture(depHHMM, transferHours = 4, iso = null) {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(depHHMM || ''));
  if (!m) return null;
  let mins = Number(m[1]) * 60 + Number(m[2]) - Math.round(transferHours * 60);
  let dayShift = 0;
  while (mins < 0) { mins += 1440; dayShift -= 1; }
  const hh = pad2(Math.floor(mins / 60));
  const mm = pad2(mins % 60);
  return { hhmm: `${hh}:${mm}`, dayShift, iso: iso ? shiftISODate(iso, dayShift) : null };
}

/* ---------------- 记录查询辅助 ---------------- */

export function indexById(records = []) {
  const m = new Map();
  for (const r of records) if (!r.deleted) m.set(r.id, r);
  return m;
}

export function getAll(index, id) {
  const r = index.get(id);
  return r && !r.deleted ? r : null;
}

export function stopState(index, stopId, todayIso) {
  const check = getAll(index, checkId(stopId));
  const status = getAll(index, statusId(stopId));
  const deferred = status && status.payload.value === 'deferred' ? status.payload.to || null : null;
  return {
    done: Boolean(check && check.payload.done !== false),
    checkAt: check ? check.payload.at || check.updated_at : null,
    actual: check ? check.payload.actual || null : null,
    skipped: Boolean(status && status.payload.value === 'skipped'),
    deferredTo: deferred,
    deferredToToday: Boolean(deferred && todayIso && deferred === todayIso),
  };
}

export function pendingCount(records = [], sinceTs = 0) {
  return records.filter((r) => (r.updated_at || 0) > sinceTs).length;
}
