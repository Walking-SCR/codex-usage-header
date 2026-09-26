/**
 * 动态排权用量插件独立适配器 (Dynamic Priority Bridge Adapter - Final Polished Edition)
 * 
 * 视觉规范：
 * 1. 实际路由账号标记为 Apple System Green (#34C759)；查看选中态与路由排序相互独立
 * 2. 不显示 P1、P2 机械代号，备选账号按序显示为「备1」、「备2」；冷却账号显示「❄ 冷却」
 * 3. 页面卡片不堆砌静态规则文字；「↻ 重排」按钮支持悬停 Tooltip 显示当前完整排队队列与调度规则
 * 4. 彻底移除「自动排权」标签，界面清爽透气
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, renameSync, chmodSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

const DEFAULT_AUTH_DIR = join(homedir(), '.cli-proxy-api');
const QUOTA_SNAPSHOT_NAME = 'quota-snapshot.json';
const POOL_STATUS_NAME = 'pool-status.json';

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

    snapshot.accounts[email] = {
      tier: acc.tier || 'standard-tier',
      disabled: Boolean(acc.disabled),
      status: acc.status || 'active',
      gemini5hRemaining: Number.isFinite(gem5h?.remainingPercent) ? gem5h.remainingPercent : null,
      gemini5hResetSeconds: Number.isFinite(gem5h?.secondsRemaining) ? gem5h.secondsRemaining : null,
      gemini7dRemaining: Number.isFinite(gem7d?.remainingPercent) ? gem7d.remainingPercent : null,
      gemini7dResetSeconds: Number.isFinite(gem7d?.secondsRemaining) ? gem7d.secondsRemaining : null,
    };
  }

  try {
    mkdirSync(authDir, { recursive: true });
    const tmpPath = `${snapshotPath}.tmp.${process.pid}.${Date.now()}`;
    const payload = JSON.stringify(snapshot, null, 2);
    writeFileSync(tmpPath, payload, { mode: 0o600 });
    renameSync(tmpPath, snapshotPath);
    chmodSync(snapshotPath, 0o600);
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
    return fallback;
  }

  try {
    const raw = readFileSync(statusPath, 'utf8');
    const data = JSON.parse(raw);
    const rankings = Array.isArray(data.rankings) ? data.rankings : [];
    const accountMap = {};

    let fallbackIndex = 1;
    for (let i = 0; i < rankings.length; i++) {
      const item = rankings[i];
      if (item && item.email) {
        const norm = item.email.toLowerCase();
        let rankLabel = '';
        if (item.status === 'COOLING') {
          rankLabel = '❄ 冷却';
        } else if (i === 0) {
          rankLabel = '使用中';
        } else {
          rankLabel = `备选${fallbackIndex}`;
          fallbackIndex++;
        }

        accountMap[norm] = {
          ...item,
          rankLabel,
          isPrimary: i === 0,
        };
      }
    }

    return {
      available: true,
      updatedAt: data.updatedAt || null,
      mode: data.mode || 'auto',
      primaryAccount: data.primaryAccount || (rankings[0]?.email || null),
      rankings,
      accountMap,
    };
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
    '.codex/skills/codex-autoheal-bridge/scripts/antigravity_pool.py'
  );
  const pythonBin = options.pythonBin || process.env.CODEX_BRIDGE_PYTHON || process.env.PYTHON || 'python3';

  return new Promise((resolve) => {
    if (!existsSync(scriptPath)) {
      return resolve({ ok: false, error: 'script_not_found', path: scriptPath });
    }

    execFile(pythonBin, [scriptPath, 'rebalance', '--apply'], { timeout: 10000 }, (error, stdout, stderr) => {
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
  const isInUse = info.status === 'COOLING'
    ? false
    : primaryEmail
      ? norm === primaryEmail
      : Boolean(info.isPrimary || info.rankLabel === '使用中');
  let tag = isInUse ? '' : (info.status === 'COOLING' ? '❄ 冷却' : info.rankLabel);
  if (/^备选(\d+)$/.test(tag || '')) tag = tag.replace(/^备选(\d+)$/, '备$1');

  const rankTag = tag ? ` · ${tag}` : '';
  const activeDot = isInUse ? '<span class="quota-tab-dot"></span>' : '';

  return `${activeDot}${label}${rankTag}`;
}

/**
 * 生成「重排」按钮及其悬停 Tooltip 内容
 */
export function renderRebalanceButton(poolStatus = {}) {
  let tooltipText = '排队顺序：按临近重置与可用配额智能调度\n调度规则：优先临近重置 · Pro 高配额优先';

  if (poolStatus.available && Array.isArray(poolStatus.rankings) && poolStatus.rankings.length > 0) {
    const queueList = poolStatus.rankings.map((r, idx) => {
      const name = r.email ? r.email.split('@')[0] : r.email;
      const statusLabel = r.status === 'COOLING' ? '冷却中' : (idx === 0 ? '使用中' : `备选${idx}`);
      return `${name} (${statusLabel})`;
    }).join(' → ');

    tooltipText = `排队顺序：${queueList}\n调度规则：优先临近重置 (1h21m) · Pro 高配额优先`;
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
