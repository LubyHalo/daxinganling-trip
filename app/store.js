// 持久化层：用户态记录与本地设置都放在 localStorage。
// 记录量在千级以内，localStorage 完全够用；而且它可读、可直接导出、不依赖任何后端。
// 私密模式 / 存储被禁用 / 配额写满时不能崩，必须降级并让界面提示用户。

import { newUuid, toISODate } from './core.js';

const K_RECORDS = 'dtrip.records.v1';
const K_META = 'dtrip.meta.v1';

export const storageStatus = { ok: true, reason: '' };

function safeGet(key) {
  try {
    return localStorage.getItem(key);
  } catch (err) {
    storageStatus.ok = false;
    storageStatus.reason = '浏览器不允许读写本地存储（可能开了无痕模式）';
    return null;
  }
}

function safeSet(key, value) {
  try {
    localStorage.setItem(key, value);
    return true;
  } catch (err) {
    storageStatus.ok = false;
    storageStatus.reason = String(err && err.message ? err.message : err);
    return false;
  }
}

export function loadRecords() {
  const raw = safeGet(K_RECORDS);
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}

export function saveRecords(records) {
  return safeSet(K_RECORDS, JSON.stringify(records));
}

export function loadMeta() {
  const raw = safeGet(K_META);
  let meta = {};
  if (raw) {
    try { meta = JSON.parse(raw) || {}; } catch { meta = {}; }
  }
  if (!meta.deviceId) {
    meta.deviceId = `dev-${newUuid().slice(0, 4)}`;
  }
  meta.theme = meta.theme || 'auto';
  meta.mode = meta.mode || 'quick';
  meta.lastExportAt = meta.lastExportAt || 0;
  meta.lastImportAt = meta.lastImportAt || 0;
  meta.lastImportSummary = meta.lastImportSummary || null;
  meta.backupHintShown = meta.backupHintShown || null;
  meta.installedAt = meta.installedAt || Date.now();
  return meta;
}

export function saveMeta(meta) {
  return safeSet(K_META, JSON.stringify(meta));
}

export function exportFilename(prefix = 'trip-sync') {
  return `${prefix}-${toISODate()}.json`;
}

/** 危险操作：清空全部本地数据（界面上必须二次确认） */
export function clearAll() {
  try {
    localStorage.removeItem(K_RECORDS);
    localStorage.removeItem(K_META);
    return true;
  } catch {
    return false;
  }
}
