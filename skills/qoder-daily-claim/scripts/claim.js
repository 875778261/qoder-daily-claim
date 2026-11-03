#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { checkForUpdate } = require('./update-check');

const BASE = 'https://openapi.qoder.com.cn';
const CLIENT_TYPE = '10';
const APP_DIR = path.join(process.env.LOCALAPPDATA || os.homedir(), 'qoder-daily-claim');
const LOG_DIR = process.env.QODER_CHECKIN_LOG_DIR || path.join(APP_DIR, 'logs');
const STATE_FILE = path.join(APP_DIR, 'state.json');

class AppError extends Error {
  constructor(message, exitCode = 1) {
    super(message);
    this.exitCode = exitCode;
  }
}

class ApiError extends Error {
  constructor(status, body) {
    super(`HTTP ${status}`);
    this.status = status;
    this.body = body;
  }
}

function timestamp() {
  return new Date().toISOString();
}

function localDateKey(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function localTimestamp(now = new Date()) {
  const pad = (value) => String(value).padStart(2, '0');
  return `${localDateKey(now)} ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
}

function formatLocal(iso) {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? localTimestamp(date) : String(iso);
}

function log(level, message, extra) {
  const label = { INFO: '信息', WARN: '警告', ERROR: '错误' }[level] || level;
  const line = `[${localTimestamp()}] [${label}] ${message}`;
  console.log(line);
  try {
    fs.mkdirSync(LOG_DIR, { recursive: true });
    const detail = extra ? ` ${JSON.stringify(extra)}` : '';
    fs.appendFileSync(path.join(LOG_DIR, `claim-${localDateKey()}.log`), `${line}${detail}\n`);
  } catch {
    // Logging must never break a claim.
  }
}

function parseArgs(argv) {
  const opts = { dryRun: false, force: false, verbose: false, dataDir: null, checkinDir: null, help: false };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--dry-run') opts.dryRun = true;
    else if (arg === '--force') opts.force = true;
    else if (arg === '--verbose') opts.verbose = true;
    else if (arg === '--data-dir') opts.dataDir = argv[++i];
    else if (arg === '--checkin-dir') opts.checkinDir = argv[++i];
    else if (arg === '--help' || arg === '-h') opts.help = true;
    else throw new AppError(`未知参数：${arg}`, 1);
  }
  return opts;
}

function printHelp() {
  console.log(`Qoder CN 每日 Credits 自动领取

用法：
  node claim.js [选项]

选项：
  --dry-run          只列出活动，不执行领取（忽略本地领取记录）
  --force            忽略本地领取记录，对已领取活动再次调用（接口幂等）
  --verbose          输出调试信息
  --data-dir <目录>  指定 Qoder CN 数据目录（默认自动探测）
  --checkin-dir <目录>  指定领取记录目录（默认 skill 目录下 checkin-logs）
  -h, --help         显示帮助

退出码：
  0  成功（含今日已领或暂无可领）
  1  接口或网络错误
  2  登录态缺失/过期，需要重新登录 Qoder CN
`);
}

function scanForQoderDirs() {
  const roots = [process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean);
  const found = [];
  for (const root of roots) {
    let entries;
    try {
      entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || !/qoder/i.test(entry.name)) continue;
      found.push(path.join(root, entry.name));
    }
  }
  return found;
}

function resolveDataDir(explicit) {
  const candidates = [
    explicit,
    process.env.QODER_DATA_DIR,
    process.env.APPDATA && path.join(process.env.APPDATA, 'com.qodercn.app.stable'),
    process.env.APPDATA && path.join(process.env.APPDATA, 'QoderCN'),
    ...scanForQoderDirs(),
  ].filter(Boolean);

  for (const candidate of candidates) {
    try {
      const dir = fs.realpathSync(candidate);
      if (fs.existsSync(path.join(dir, 'auth.v1.dat'))) return dir;
    } catch {
      // Try the next candidate.
    }
  }
  throw new AppError('没有找到 Qoder CN 的登录信息。请先打开并登录 Qoder CN 桌面端，然后再试一次。', 2);
}

function unprotectWithDpapi(blob) {
  const tmp = path.join(os.tmpdir(), `qoder-checkin-${process.pid}-${Date.now()}.b64`);
  fs.writeFileSync(tmp, blob.toString('base64'), { mode: 0o600 });
  const escaped = tmp.replace(/'/g, "''");
  const ps = [
    'Add-Type -AssemblyName System.Security;',
    `$b=[Convert]::FromBase64String((Get-Content -Raw -LiteralPath '${escaped}'));`,
    '$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);',
    "[BitConverter]::ToString($p).Replace('-','')",
  ].join(' ');
  try {
    const output = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', ps], {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
    });
    const key = Buffer.from(output.trim(), 'hex');
    if (key.length !== 32) throw new AppError(`DPAPI 返回的密钥长度异常：${key.length}`, 2);
    return key;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError('无法读取 Qoder CN 的登录信息。请确认当前 Windows 用户和 Qoder CN 的登录用户一致，或重新打开 Qoder CN 后再试。', 2);
  } finally {
    try {
      fs.rmSync(tmp, { force: true });
    } catch {
      // Best effort cleanup.
    }
  }
}

function decryptAuth(raw, key) {
  if (raw.subarray(0, 3).toString() !== 'v10') {
    throw new AppError('Qoder CN 的登录信息格式不受支持，请升级 Qoder CN 客户端后再试。', 2);
  }
  const nonce = raw.subarray(3, 15);
  const tag = raw.subarray(raw.length - 16);
  const ciphertext = raw.subarray(15, raw.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  try {
    return JSON.parse(plain.toString('utf8'));
  } finally {
    plain.fill(0);
  }
}

function loadAuth(dataDir) {
  const localStatePath = path.join(dataDir, 'Local State');
  if (!fs.existsSync(localStatePath)) {
    throw new AppError('没有找到 Qoder CN 的登录信息，请先打开并登录 Qoder CN 桌面端。', 2);
  }
  const localState = JSON.parse(fs.readFileSync(localStatePath, 'utf8'));
  const encodedKey = localState?.os_crypt?.encrypted_key;
  if (!encodedKey) throw new AppError('Qoder CN 的登录信息不完整，请重新登录 Qoder CN。', 2);

  const encryptedKey = Buffer.from(encodedKey, 'base64');
  if (encryptedKey.subarray(0, 5).toString() !== 'DPAPI') {
    throw new AppError('当前系统无法读取 Qoder CN 的登录信息。', 2);
  }

  const key = unprotectWithDpapi(encryptedKey.subarray(5));
  try {
    const raw = fs.readFileSync(path.join(dataDir, 'auth.v1.dat'));
    const auth = decryptAuth(raw, key);
    if (!auth?.token) throw new AppError('登录信息已失效，请打开 Qoder CN 重新登录。', 2);
    return auth;
  } finally {
    key.fill(0);
  }
}

function assertTokenFresh(auth) {
  const expiresAt = Date.parse(auth.expiresAt);
  if (Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
    throw new AppError('登录已过期，请打开 Qoder CN 重新登录后再试。', 2);
  }
}

async function api(pathname, { token, method = 'GET' } = {}) {
  const response = await fetch(`${BASE}${pathname}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      'Cosy-ClientType': CLIENT_TYPE,
      Accept: 'application/json',
    },
  });
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!response.ok) throw new ApiError(response.status, body);
  return body;
}

function campaignsOf(body) {
  if (Array.isArray(body?.campaigns)) return body.campaigns;
  if (Array.isArray(body?.data?.campaigns)) return body.data.campaigns;
  if (Array.isArray(body?.data)) return body.data;
  return [];
}

function isCreditsClaim(campaign) {
  return campaign?.actionType === 'CLAIM_BENEFIT' && campaign?.benefit?.kind === 'CREDITS';
}

function timeState(campaign, now) {
  if (typeof campaign.startAt === 'number' && campaign.startAt * 1000 > now) return 'not-started';
  if (typeof campaign.endAt === 'number' && campaign.endAt * 1000 <= now) return 'ended';
  return 'open';
}

function campaignSummary(campaign) {
  return {
    campaignKey: campaign.campaignKey,
    campaignId: campaign.campaignId,
    claimStatus: campaign.claimStatus,
    amount: campaign.benefit?.amount ?? null,
  };
}

function sanitizeError(error) {
  if (error instanceof ApiError) {
    const body = typeof error.body === 'string' ? error.body : JSON.stringify(error.body ?? '');
    return `HTTP ${error.status}: ${body.slice(0, 300)}`;
  }
  return String(error?.message || error).slice(0, 300);
}

function friendlyError(error) {
  if (error instanceof ApiError) {
    if (error.status === 401 || error.status === 403) return '登录状态已失效，请打开 Qoder CN 重新登录。';
    return `Qoder 服务暂时不可用（HTTP ${error.status}），请稍后重试。`;
  }
  return sanitizeError(error);
}

function statusText(status) {
  return {
    CLAIMED: '已经领取',
    CLAIMABLE: '可以领取',
  }[status] || '暂不可领取';
}

function printSummary(lines) {
  const width = 52;
  console.log('');
  console.log('='.repeat(width));
  for (const line of lines) console.log(line);
  console.log('='.repeat(width));
  console.log('');
}

async function updateNotice() {
  try {
    return await checkForUpdate({ dataDir: APP_DIR });
  } catch {
    return null;
  }
}

function shortReason(message) {
  const text = String(message || '').slice(0, 160);
  if (/HTTP (401|403)/.test(text)) return '登录状态已失效，请打开 Qoder CN 重新登录。';
  if (/^HTTP \d+/.test(text)) return 'Qoder 服务暂时不可用，请稍后重试。';
  return text;
}

function summarize(summary, opts) {
  const lines = [];
  const total = (items) => items.reduce((sum, item) => sum + Number(item.amount || 0), 0);
  const account = summary.account ? [`账号：${summary.account}`] : [];
  const finished = (item) => ['claimed', 'replayed', 'already-claimed'].includes(item.outcome);

  if (opts.dryRun) {
    const claimable = summary.campaigns.filter((item) => item.outcome === 'dry-run');
    const done = summary.campaigns.filter(finished);
    if (claimable.length) {
      lines.push('查询完成：今天还有 Credits 可以领取。');
      lines.push(`可领取：${total(claimable)} Credits`);
      lines.push('直接运行一次（不加 --dry-run）就会真正领取。');
    } else if (done.length) {
      lines.push('查询完成：今天的 Credits 已经领过了。');
      lines.push(`已领取：${total(done)} Credits`);
    } else {
      lines.push('查询完成：今天暂时没有可领取的 Credits。');
    }
    return lines.concat(account);
  }

  if (!summary.ok) {
    const done = summary.campaigns.filter(finished);
    lines.push(done.length ? '部分活动已完成，但有活动领取失败。' : '这次领取没有完成。');
    lines.push(...account);
    for (const item of summary.errors.slice(0, 3)) {
      lines.push(`原因：${shortReason(item.error)}`);
    }
    lines.push('建议：稍后重试；如果提示登录过期，请打开 Qoder CN 重新登录。');
    return lines;
  }

  const claimed = summary.campaigns.filter((item) => item.outcome === 'claimed');
  const replayed = summary.campaigns.filter((item) => item.outcome === 'replayed');
  const already = summary.campaigns.filter((item) => item.outcome === 'already-claimed');

  if (claimed.length) {
    lines.push(`领取成功：今天 +${total(claimed)} Credits。`);
    lines.push('Credits 已经到账，不需要再做其他操作。');
  } else if (replayed.length || already.length) {
    lines.push('今天已经领过了，本次没有重复发放。');
    lines.push(`此前已到账：${total(replayed.concat(already))} Credits。`);
  } else if (summary.campaigns.some((item) => item.outcome === 'no-credits-campaign')) {
    lines.push('今天没有找到可领取的 Credits 活动。');
    lines.push('可能活动还没开始或已经结束，晚些时候可以再试。');
  } else {
    lines.push('今天暂时没有可领取的 Credits。');
    lines.push('可能还没到领取时间，或活动已经结束。');
  }
  return lines.concat(account);
}

function writeState(state) {
  try {
    fs.mkdirSync(APP_DIR, { recursive: true });
    const tmp = `${STATE_FILE}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, STATE_FILE);
  } catch (error) {
    log('WARN', `状态文件写入失败：${sanitizeError(error)}`);
  }
}

// 活动日按北京时间 10:00 切换，09:59 仍属于前一天的轮次。
function activityDayKey(now = new Date()) {
  const shifted = new Date(now.getTime() + 8 * 3600 * 1000);
  const start = new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()));
  if (shifted.getUTCHours() < 10) start.setUTCDate(start.getUTCDate() - 1);
  return start.toISOString().slice(0, 10);
}

function resolveCheckinDir(opts) {
  if (opts.checkinDir) return path.resolve(opts.checkinDir);
  if (process.env.QODER_CHECKIN_DIR) return path.resolve(process.env.QODER_CHECKIN_DIR);
  // 计划任务的工作目录不可靠（通常是 system32），因此默认放在 skill 根目录。
  return path.resolve(__dirname, '..', 'checkin-logs');
}

function readMarker(file) {
  try {
    const marker = JSON.parse(fs.readFileSync(file, 'utf8'));
    return marker?.ok === true ? marker : null;
  } catch {
    return null;
  }
}

function writeMarker(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8');
    fs.renameSync(tmp, file);
    return true;
  } catch (error) {
    log('WARN', `领取记录写入失败：${sanitizeError(error)}`);
    return false;
  }
}

async function claimAll(opts) {
  const checkinDir = resolveCheckinDir(opts);
  const dayKey = activityDayKey();
  const markerFile = path.join(checkinDir, `${dayKey}.json`);

  if (!opts.force && !opts.dryRun) {
    const marker = readMarker(markerFile);
    if (marker) {
      log('INFO', '今天已经领过，跳过本次执行', {
        file: markerFile,
        account: marker.account,
        amount: marker.amount,
      });
      const lines = [
        '今天已经领过了，不需要重复领取。',
        `账号：${marker.account || '未知'}`,
        ...(marker.amount ? [`已领取：${marker.amount} Credits`] : []),
        ...(marker.checkedAt ? [`记录时间：${formatLocal(marker.checkedAt)}`] : []),
      ];
      const notice = await updateNotice();
      printSummary(lines);
      if (notice) console.log(`${notice}\n`);
      return { skipped: true, marker };
    }
  }

  const dataDir = resolveDataDir(opts.dataDir);
  log('INFO', opts.dryRun ? '开始查询今天的 Qoder Credits（仅查询，不会领取）' : '开始检查今天的 Qoder Credits', {
    dataDir,
    dryRun: opts.dryRun,
    force: opts.force,
    checkinDir,
  });

  const auth = loadAuth(dataDir);
  assertTokenFresh(auth);

  const account = auth.user?.name || null;
  log('INFO', `当前账号：${account || '未知'}`);

  const body = await api('/sash/api/v1/me/campaigns', { token: auth.token });
  const campaigns = campaignsOf(body);
  log('INFO', '正在检查今天的活动', { count: campaigns.length });

  const now = Date.now();
  const creditsCampaigns = campaigns.filter(isCreditsClaim);
  const summary = {
    ranAt: timestamp(),
    ok: true,
    dryRun: opts.dryRun,
    account,
    campaigns: [],
    errors: [],
  };

  if (creditsCampaigns.length === 0) {
    log('INFO', '今天没有可领取的 Credits 活动');
    summary.campaigns.push({ outcome: 'no-credits-campaign' });
  }

  for (const campaign of creditsCampaigns) {
    const base = campaignSummary(campaign);
    const label = campaign.campaignKey || campaign.campaignId;

    if (campaign.claimStatus === 'CLAIMED' && !opts.force) {
      summary.campaigns.push({ ...base, outcome: 'already-claimed' });
      log('INFO', '这个活动今天已经领过，跳过', { campaign: label, status: campaign.claimStatus });
      continue;
    }

    if (campaign.claimStatus !== 'CLAIMABLE' && !opts.force) {
      summary.campaigns.push({ ...base, outcome: 'not-claimable' });
      log('INFO', `这个活动暂时不能领取（${statusText(campaign.claimStatus)}）`, { campaign: label, status: campaign.claimStatus });
      continue;
    }

    const timeWindow = timeState(campaign, now);
    if (timeWindow !== 'open' && !opts.force) {
      summary.campaigns.push({ ...base, outcome: timeWindow });
      log('INFO', timeWindow === 'not-started' ? '这个活动还没有开始' : '这个活动已经结束', { campaign: label, window: timeWindow });
      continue;
    }

    if (opts.dryRun) {
      summary.campaigns.push({ ...base, outcome: 'dry-run' });
      log('INFO', `今天可以领取：${base.amount ?? '?'} Credits（仅查询，未领取）`, { campaign: label, amount: base.amount });
      continue;
    }

    try {
      const result = await api(`/sash/api/v1/me/campaigns/${encodeURIComponent(campaign.campaignId)}/claim`, {
        token: auth.token,
        method: 'POST',
      });
      if (result?.status !== 'CLAIMED') {
        throw new AppError('领取请求返回了意外的结果，请稍后重试。', 1);
      }
      const outcome = result.replayed ? 'replayed' : 'claimed';
      const item = {
        ...base,
        outcome,
        replayed: Boolean(result.replayed),
        grantId: result.grantId || null,
        amount: result.benefit?.amount ?? base.amount,
      };
      summary.campaigns.push(item);
      if (result.replayed) {
        log('INFO', '这个活动之前已经领过，本次不会重复发放', {
          campaign: label,
          amount: item.amount,
          grantId: item.grantId,
        });
      } else {
        log('INFO', `领取成功：+${item.amount ?? ''} Credits`, {
          campaign: label,
          amount: item.amount,
          grantId: item.grantId,
        });
      }

      try {
        const reward = await api(`/sash/api/v1/me/campaigns/${encodeURIComponent(campaign.campaignId)}/reward`, {
          token: auth.token,
        });
        log('INFO', `已确认奖励到账：${reward?.benefit?.amount ?? item.amount ?? '?'} Credits`, {
          campaign: label,
          status: reward?.status,
          grantId: reward?.grantId,
        });
      } catch (error) {
        log('WARN', '领取已成功，但暂时无法确认奖励状态', { campaign: label, error: sanitizeError(error) });
      }
    } catch (error) {
      const message = sanitizeError(error);
      summary.errors.push({ campaignKey: campaign.campaignKey, error: message });
      summary.campaigns.push({ ...base, outcome: 'error', error: message });
      log('ERROR', '这个活动领取失败', { campaign: label, error: message });
    }
  }

  summary.ok = summary.errors.length === 0;
  summary.checkinFile = markerFile;

  const claimed = summary.campaigns.filter((item) =>
    ['claimed', 'replayed', 'already-claimed'].includes(item.outcome)
  );
  if (!opts.dryRun && summary.ok && claimed.length > 0) {
    const written = writeMarker(markerFile, {
      date: dayKey,
      checkedAt: summary.ranAt,
      ok: true,
      account,
      amount: claimed.reduce((total, item) => total + Number(item.amount || 0), 0),
      campaigns: claimed.map((item) => ({
        campaignKey: item.campaignKey || null,
        outcome: item.outcome,
        amount: item.amount ?? null,
        grantId: item.grantId || null,
      })),
    });
    if (written) log('INFO', '已保存今天的领取记录', { file: markerFile });
  }

  writeState(summary);
  const notice = await updateNotice();
  printSummary(summarize(summary, opts));
  if (notice) console.log(`${notice}\n`);

  if (!summary.ok) process.exitCode = 1;
  return summary;
}

(async () => {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    log('ERROR', sanitizeError(error));
    process.exitCode = error.exitCode || 1;
    return;
  }

  if (opts.help) {
    printHelp();
    return;
  }

  if (process.platform !== 'win32') {
    log('ERROR', '这个功能目前只支持 Windows。');
    process.exitCode = 2;
    return;
  }

  if (typeof fetch !== 'function') {
    log('ERROR', '需要 Node.js 18 或更高版本，请升级后再试。');
    process.exitCode = 1;
    return;
  }

  try {
    await claimAll(opts);
  } catch (error) {
    const message = friendlyError(error);
    log('ERROR', message);
    writeState({ ranAt: timestamp(), ok: false, error: message });
    printSummary([
      '这次没有完成领取。',
      `原因：${message}`,
      '建议：稍后重试；如果提示登录过期，请打开 Qoder CN 重新登录。',
    ]);
    process.exitCode = error.exitCode || 1;
  }
})();
