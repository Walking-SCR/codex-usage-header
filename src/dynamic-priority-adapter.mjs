/**
 * 动态排权用量插件独立适配器 (Dynamic Priority Bridge Adapter - Final Polished Edition)
 * 
 * 视觉规范：
 * 1. 实际路由账号标记为 Apple System Green (#34C759)；查看选中态与路由排序相互独立
 * 2. 不显示 P1、P2 机械代号，备选账号按序显示为「备1」、「备2」；冷却账号显示「❄ 冷却」
 * 3. 页面卡片不堆砌静态规则文字；「↻ 重排」按钮支持悬停 Tooltip 显示当前完整排队队列与调度规则
 * 4. 彻底移除「自动排权」标签，界面清爽透气
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { getAccountHealth } from './account-health.mjs';
import { getCliProxyApiAuthDir } from './platform-paths.mjs';

const DEFAULT_AUTH_DIR = getCliProxyApiAuthDir();
const QUOTA_SNAPSHOT_NAME = 'quota-snapshot.json';
const POOL_STATUS_NAME = 'pool-status.json';
const poolStatusCache = new Map();

function parseRecoveryTime(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value > 1e12 ? value : value * 1000;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * 导出用量插件抓取到的各账号指标至共享快照
 */
export function exportQuotaSnapshot(accounts = [], options = {}) {
  const authDir = options.authDir || DEFAULT_AUTH_DIR;
  const snapshotPath = join(authDir, QUOTA_SNAPSHOT_NAME);

  if (!Array.isArray(accounts) || accounts.length === 0) {
    return { ok: false, reason: 'empty_accounts' };
  }

  const snapshot = {
    updatedAt: new Date().toISOString(),
    accounts: {},
  };

  for (const acc of accounts) {
    if (!acc || !acc.email) continue;
    const email = String(acc.email).trim().toLowerCase();
    const rows = Array.isArray(acc.rows) ? acc.rows : [];

    const gem5h = rows.find(r => r && (r.label === 'Gemini 5h' || r.window === '5h'));
    const gem7d = rows.find(r => r && (r.label === 'Gemini 7d' || r.window === '7d'));
    const resetAtSeconds = row => {
      const value = Number(row?.resetTime ?? row?.reset_time);
      if (Number.isFinite(value) && value > 0) return value > 1e12 ? Math.floor(value / 1000) : Math.floor(value);
      return null;
    };

    snapshot.accounts[email] = {
      tier: acc.tier || 'standard-tier',
      disabled: Boolean(acc.disabled),
      status: acc.status || 'active',
      gemini5hRemaining: Number.isFinite(gem5h?.remainingPercent) ? gem5h.remainingPercent : null,
      gemini5hResetSeconds: Number.isFinite(gem5h?.secondsRemaining) ? gem5h.secondsRemaining : null,
      gemini5hResetAt: resetAtSeconds(gem5h),
      gemini7dRemaining: Number.isFinite(gem7d?.remainingPercent) ? gem7d.remainingPercent : null,
      gemini7dResetSeconds: Number.isFinite(gem7d?.secondsRemaining) ? gem7d.secondsRemaining : null,
      gemini7dResetAt: resetAtSeconds(gem7d),
    };
  }

  try {
    mkdirSync(authDir, { recursive: true });
    const tmpPath = `${snapshotPath}.tmp.${process.pid}.${Date.now()}`;
    const payload = JSON.stringify(snapshot, null, 2);
    writeFileSync(tmpPath, payload, { mode: 0o600 });
    renameSync(tmpPath, snapshotPath);
    if (process.platform !== 'win32') {
      try { chmodSync(snapshotPath, 0o600); } catch { /* ignore */ }
    }
    return { ok: true, snapshotPath, count: Object.keys(snapshot.accounts).length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/**
 * 读取当前排权状态，并将机械序号转换为人性化排队语义：
 * 主力 -> 使用中
 * 候补 -> 备选1, 备选2 ...
 * 冷却 -> ❄ 冷却
 */
export function readPoolStatus(options = {}) {
  const authDir = options.authDir || DEFAULT_AUTH_DIR;
  const statusPath = join(authDir, POOL_STATUS_NAME);

  const fallback = {
    available: false,
    updatedAt: null,
    mode: 'inactive',
    primaryAccount: null,
    rankings: [],
    accountMap: {},
  };

  if (!existsSync(statusPath)) {
    poolStatusCache.delete(statusPath);
    return fallback;
  }

  try {
    const stat = statSync(statusPath);
    const cached = poolStatusCache.get(statusPath);
    if (cached && cached.ino === stat.ino && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
      return cached.value;
    }
    const raw = readFileSync(statusPath, 'utf8');
    const data = JSON.parse(raw);
    const rankings = (Array.isArray(data.rankings) ? data.rankings : [])
      .filter(item => item && typeof item.email === 'string')
      .map(item => {
        const health = getAccountHealth({}, item);
        const retryAt = parseRecoveryTime(item.next_retry_after || item.quota?.next_recover_at);
        const status = String(item.status || '').toUpperCase();
        return { email: item.email.trim(), priority: Number(item.priority) || 0,
          status, reason: health.code, httpStatus: health.httpStatus,
          recoveryAt: health.state === 'cooling' || status === 'FIVE_HOUR_EXHAUSTED' || status === 'WEEKLY_EXHAUSTED' ? retryAt : null };
      });
    const primaryAccount = Object.prototype.hasOwnProperty.call(data, 'primaryAccount')
      ? data.primaryAccount
      : (rankings[0]?.email || null);
    const accountMap = {};

    let fallbackIndex = 1;
    for (let i = 0; i < rankings.length; i++) {
      const item = rankings[i];
      if (item && item.email) {
        const norm = item.email.toLowerCase();
        let rankLabel = '';
        if (item.status === 'FIVE_HOUR_EXHAUSTED') {
          rankLabel = '5h用尽';
        } else if (item.status === 'WEEKLY_EXHAUSTED') {
          rankLabel = '7d用尽';
        } else if (item.status === 'COOLING') {
          rankLabel = '❄ 冷却';
        } else if (item.email.toLowerCase() === String(primaryAccount || '').toLowerCase()) {
          rankLabel = '使用中';
        } else {
          rankLabel = `备选${fallbackIndex}`;
          fallbackIndex++;
        }

        accountMap[norm] = {
          ...item,
          rankLabel,
          isPrimary: item.email.toLowerCase() === String(primaryAccount || '').toLowerCase(),
        };
      }
    }

    const value = {
      available: true,
      updatedAt: data.updatedAt || null,
      mode: data.mode || 'auto',
      primaryAccount,
      rankings,
      accountMap,
    };
    poolStatusCache.set(statusPath, { ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs, value });
    return value;
  } catch {
    return fallback;
  }
}

/**
 * 触发异步重新排权
 */
export function triggerRebalance(options = {}) {
  const scriptPath = options.scriptPath || join(
    homedir(),
    '.codex',
    'skills',
    'codex-autoheal-bridge',
    'scripts',
    'antigravity_pool.py'
  );
  const pythonBin = options.pythonBin || process.env.CODEX_BRIDGE_PYTHON || process.env.PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const model = options.model || 'gemini-3.8-flash-high';

  return new Promise((resolve) => {
    if (!existsSync(scriptPath)) {
      return resolve({ ok: false, error: 'script_not_found', path: scriptPath });
    }

    const args = [scriptPath, 'rebalance', '--apply'];
    if (model) args.push('--model', model);

    execFile(pythonBin, args, { timeout: 10000, windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        return resolve({ ok: false, error: error.message, stderr });
      }
      resolve({ ok: true, output: stdout.trim() });
    });
  });
}

/**
 * 格式化账号 Tab 内嵌文字；路由主账号、备选序号与冷却状态均取自调度快照。
 */
export function formatAccountTabHtml(rawLabel, email, poolStatus = {}, isSelected = false) {
  const label = rawLabel || (email ? email.split('@')[0] : 'Account');
  if (!poolStatus.available || !email) {
    return label;
  }

  const norm = String(email).trim().toLowerCase();
  const info = poolStatus.accountMap?.[norm];
  if (!info) {
    return label;
  }

  const primaryEmail = String(poolStatus.primaryAccount || '').trim().toLowerCase();
  const isInUse = ['COOLING', 'FIVE_HOUR_EXHAUSTED', 'WEEKLY_EXHAUSTED', 'BLOCKED'].includes(info.status)
    ? false
    : primaryEmail
      ? norm === primaryEmail
      : Boolean(info.isPrimary || info.rankLabel === '使用中');
  let tag = isInUse ? '' : (info.status === 'COOLING' ? '❄ 冷却' : info.status === 'FIVE_HOUR_EXHAUSTED' ? '5h用尽' : info.status === 'WEEKLY_EXHAUSTED' ? '7d用尽' : info.rankLabel);
  if (/^备选(\d+)$/.test(tag || '')) tag = tag.replace(/^备选(\d+)$/, '备$1');

  const rankTag = tag ? ` · ${tag}` : '';
  const health = getAccountHealth({}, info);
  const activeDot = health.state === 'unavailable'
    ? '<span class="quota-tab-dot is-error" aria-hidden="true"></span>'
    : isInUse ? '<span class="quota-tab-dot"></span>' : '';

  return `${activeDot}${label}${rankTag}`;
}

/**
 * 生成「重排」按钮及其悬停 Tooltip 内容
 */
export function renderRebalanceButton(poolStatus = {}) {
  let tooltipText = '排序规则：先按 7 天额度重置剩余时间从短到长；周窗口相同时，优先 5 小时即将重置。5 小时耗尽的账号排在可用账号之后。';

  if (poolStatus.available && Array.isArray(poolStatus.rankings) && poolStatus.rankings.length > 0) {
    let backupIndex = 1;
    const queueList = poolStatus.rankings.map(r => {
      const name = r.email ? r.email.split('@')[0] : r.email;
      const isPrimary = Boolean(poolStatus.primaryAccount) && r.email.toLowerCase() === poolStatus.primaryAccount.toLowerCase();
      const statusLabel = r.status === 'FIVE_HOUR_EXHAUSTED'
        ? '5h用尽'
        : r.status === 'WEEKLY_EXHAUSTED'
          ? '7d用尽'
          : r.status === 'COOLING'
            ? '冷却中'
            : (isPrimary ? '使用中' : `备选${backupIndex++}`);
      const reset = r.reset ? ` · ${r.reset}` : '';
      return `${name} (${statusLabel}${reset})`;
    }).join(' → ');

    tooltipText = `排队顺序：${queueList}\n排序规则：先按 7 天额度重置剩余时间从短到长；周窗口相同时，优先 5 小时即将重置。5 小时耗尽的账号排在可用账号之后。`;
  }

  const accessibleLabel = `重排。${tooltipText}`.replace(/"/g, '&quot;');

  return `<div class="quota-rebalance-wrap">` +
    `<button type="button" class="quota-rebalance-pill-btn" aria-label="${accessibleLabel}" title="${tooltipText.replace(/"/g, '&quot;')}">` +
      `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="quota-rebalance-icon">` +
        `<path d="M21.5 2v6h-6M21.34 15.57a10 10 0 1 1-.57-8.38l5.67-5.67"/>` +
      `</svg>` +
      `<span>重排</span>` +
    `</button>` +
    `<div class="quota-rebalance-tooltip">${tooltipText.replace(/\n/g, '<br/>')}</div>` +
  `</div>`;
}

/**
 * 样式规则：绿色选中 Tab (#34C759)、轻量无横幅设计、悬停浮窗
 */
export const MINIMAL_ROUTING_CSS = `
.quota-extension-account-tab.is-active {
  background: #34C759 !important;
  color: #FFFFFF !important;
  box-shadow: 0 1px 3px rgba(52, 199, 89, 0.3) !important;
}
.quota-tab-dot {
  width: 5px;
  height: 5px;
  background-color: #FFFFFF;
  border-radius: 50%;
  display: inline-block;
  margin-right: 5px;
  vertical-align: middle;
}
.quota-rebalance-wrap {
  position: relative;
  display: inline-flex;
  align-items: center;
  margin-left: 8px;
}
.quota-rebalance-pill-btn {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 4px 10px;
  border-radius: 14px;
  border: 1px solid rgba(0, 0, 0, 0.1);
  background: #FFFFFF;
  color: #1D1D1F;
  font-size: 11px;
  font-weight: 500;
  cursor: pointer;
  transition: all 0.15s ease;
  box-shadow: 0 1px 2px rgba(0, 0, 0, 0.04);
}
.quota-rebalance-pill-btn:hover {
  background: #F5F5F7;
  border-color: rgba(0, 0, 0, 0.18);
}
.quota-rebalance-pill-btn:active {
  transform: scale(0.96);
}
.quota-rebalance-icon {
  color: #1D1D1F;
}
.quota-rebalance-pill-btn.is-loading .quota-rebalance-icon {
  animation: quota-spin 0.8s linear infinite;
}
.quota-rebalance-wrap:hover .quota-rebalance-tooltip {
  opacity: 1;
  visibility: visible;
  transform: translateY(-6px);
}
.quota-rebalance-tooltip {
  position: absolute;
  bottom: 100%;
  right: 0;
  transform: translateY(0);
  opacity: 0;
  visibility: hidden;
  transition: all 0.2s cubic-bezier(0.16, 1, 0.3, 1);
  background: rgba(255, 255, 255, 0.96);
  backdrop-filter: blur(20px);
  -webkit-backdrop-filter: blur(20px);
  border: 1px solid rgba(0, 0, 0, 0.08);
  border-radius: 8px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.12);
  padding: 8px 12px;
  font-size: 11px;
  line-height: 1.5;
  color: #1D1D1F;
  white-space: nowrap;
  pointer-events: none;
  z-index: 1000;
}
@keyframes quota-spin {
  from { transform: rotate(0deg); }
  to { transform: rotate(360deg); }
}
`;
