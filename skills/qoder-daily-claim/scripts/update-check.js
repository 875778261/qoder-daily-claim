'use strict';

const fs = require('fs');
const path = require('path');

const REPO_URL = 'https://github.com/875778261/qoder-daily-claim';
const RELEASES_API = 'https://api.github.com/repos/875778261/qoder-daily-claim/releases/latest';
const VERSION_FILE = path.resolve(__dirname, '..', 'VERSION');
const CACHE_FILE = 'update-check.json';
const CHECK_INTERVAL_OK = 24 * 60 * 60 * 1000;
const CHECK_INTERVAL_FAIL = 60 * 60 * 1000;
const REQUEST_TIMEOUT = 2000;
const SKILL_NAME = 'qoder-daily-claim';

function readCurrentVersion() {
  try {
    return fs.readFileSync(VERSION_FILE, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

function parseVersion(value) {
  const match = String(value || '').match(/^v?(\d+)\.(\d+)\.(\d+)/i);
  return match ? [Number(match[1]), Number(match[2]), Number(match[3])] : null;
}

function isNewer(latest, current) {
  const next = parseVersion(latest);
  const now = parseVersion(current);
  if (!next || !now) return false;
  for (let i = 0; i < 3; i += 1) {
    if (next[i] !== now[i]) return next[i] > now[i];
  }
  return false;
}

function cleanTag(value) {
  const tag = String(value || '').trim();
  return /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(tag) ? tag : null;
}

function displayVersion(value) {
  return /^v/i.test(value) ? value : `v${value}`;
}

function updateMessage(latest, current) {
  return `发现新版本 ${displayVersion(latest)}（当前 ${displayVersion(current)}），更新方法：让 agent 根据 ${REPO_URL} ${latest} 更新 ${SKILL_NAME}`;
}

function readCache(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

function writeCache(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
  } catch {
    // A failed cache write must never affect the claim.
  }
}

async function checkForUpdate({ dataDir, fetchImpl = globalThis.fetch, now = Date.now() } = {}) {
  if (process.env.QODER_NO_UPDATE_CHECK === '1') return null;
  if (!dataDir || typeof fetchImpl !== 'function') return null;

  const current = readCurrentVersion();
  if (!current) return null;

  const cacheFile = path.join(dataDir, CACHE_FILE);
  const cache = readCache(cacheFile);
  if (cache && cache.checkedAt) {
    const age = now - Date.parse(cache.checkedAt);
    const ttl = cache.ok ? CHECK_INTERVAL_OK : CHECK_INTERVAL_FAIL;
    if (Number.isFinite(age) && age >= 0 && age < ttl) {
      return cache.ok && cache.latest && isNewer(cache.latest, current)
        ? updateMessage(cache.latest, current)
        : null;
    }
  }

  let ok = false;
  let latest = null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT);
  try {
    const response = await fetchImpl(RELEASES_API, {
      headers: {
        Accept: 'application/vnd.github+json',
        'User-Agent': SKILL_NAME,
      },
      signal: controller.signal,
    });
    if (response.status === 404) {
      ok = true;
    } else if (response.ok) {
      const body = await response.json();
      latest = cleanTag(body?.tag_name || body?.name);
      ok = Boolean(latest);
    }
  } catch {
    // Offline, timeout or API errors are ignored; the claim must not be affected.
  } finally {
    clearTimeout(timer);
  }

  writeCache(cacheFile, { checkedAt: new Date(now).toISOString(), ok, latest });
  return ok && latest && isNewer(latest, current) ? updateMessage(latest, current) : null;
}

module.exports = {
  checkForUpdate,
  isNewer,
  parseVersion,
  cleanTag,
  updateMessage,
  readCurrentVersion,
};
