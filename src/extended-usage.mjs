/**
 * codex-usage-header 的扩展用量协调器：
 * 1. 通过本地 CLIProxyAPI 获取并缓存 Gemini AI Pro 多账号配额。
 * 2. 通过本地 Codex 会话 rollout 日志增量汇总 Token 用量。
 * 凭证或 Token 不会传递给渲染器，也不会写入日志。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
  statSync,
  readdirSync,
  openSync,
  readSync,
  closeSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { exportQuotaSnapshot, readPoolStatus } from './dynamic-priority-adapter.mjs';
import { getAccountHealth } from './account-health.mjs';
import { getDataDir, getRollupStoragePath, getSessionsDir } from './platform-paths.mjs';

export const SCHEMA_VERSION = 1;
export const TIMEZONE = 'Asia/Shanghai';
export const MAX_DAYS_RETENTION = 32;
export const ROLLING_SAVE_INTERVAL_MS = 60000;
const TOKEN_FAMILY_ORDER = ['GPT', 'Gemini', 'GLM', 'DeepSeek', 'Claude', 'MiniMax', 'Other'];
const dateKeyFormatters = new Map();
export const DEFAULT_CLI_PROXY_URL = 'http://127.0.0.1:8317';
export const GOOGLE_QUOTA_ENDPOINT = 'https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary';
export const GOOGLE_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

export function getAntigravityCredentials() {
  if (process.env.ANTIGRAVITY_CLIENT_ID && process.env.ANTIGRAVITY_CLIENT_SECRET) {
    return {
      clientId: process.env.ANTIGRAVITY_CLIENT_ID,
      clientSecret: process.env.ANTIGRAVITY_CLIENT_SECRET,
    };
  }
  const routerPath = join(homedir(), '.config/codex-cli-model-bridge/codex-model-router.mjs');
  if (existsSync(routerPath)) {
    try {
      const text = readFileSync(routerPath, 'utf8');
      const idMatch = text.match(/ANTIGRAVITY_CLIENT_ID\s*=\s*["']([^"']+)["']/);
      const secretMatch = text.match(/ANTIGRAVITY_CLIENT_SECRET\s*=\s*["']([^"']+)["']/);
      if (idMatch && secretMatch) {
        return { clientId: idMatch[1], clientSecret: secretMatch[1] };
      }
    } catch { /* 忽略异常 */ }
  }
  return { clientId: '', clientSecret: '' };
}

export function toShanghaiDate(timestamp) {
  return toDateKey(timestamp, TIMEZONE);
}

export function toDateKey(timestamp, timezone = TIMEZONE) {
  const d = new Date(timestamp);
  let formatter = dateKeyFormatters.get(timezone);
  if (!formatter) {
    try {
      formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: timezone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    } catch {
      timezone = TIMEZONE;
      formatter = dateKeyFormatters.get(timezone) || new Intl.DateTimeFormat('en-CA', {
        timeZone: TIMEZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      });
    }
    dateKeyFormatters.set(timezone, formatter);
  }
  return formatter.format(d);
}

export function shiftDateKey(dateKey, dayOffset) {
  const [year, month, day] = String(dateKey).split('-').map(Number);
  const shifted = new Date(Date.UTC(year, month - 1, day + dayOffset));
  return shifted.toISOString().slice(0, 10);
}

export function formatTokenCount(tokens, locale = 'en-US') {
  if (!Number.isFinite(tokens) || tokens <= 0) return '0';
  const isZh = locale === 'zh-CN' || locale === 'zh';

  if (isZh) {
    if (tokens >= 1e8) {
      const val = (tokens / 1e8).toFixed(2).replace(/\.?0+$/, '');
      return `${val}亿`;
    }
    if (tokens >= 1e4) {
      const val = (tokens / 1e4).toFixed(1).replace(/\.?0+$/, '');
      return `${val}万`;
    }
    return String(tokens);
  }

  if (tokens >= 1e9) {
    const val = (tokens / 1e9).toFixed(2).replace(/\.?0+$/, '');
    return `${val}B`;
  }
  if (tokens >= 1e6) {
    const val = (tokens / 1e6).toFixed(2).replace(/\.?0+$/, '');
    return `${val}M`;
  }
  if (tokens >= 1e3) {
    const val = (tokens / 1e3).toFixed(1).replace(/\.?0+$/, '');
    return `${val}K`;
  }
  return String(tokens);
}

export function classifyModel(model) {
  const m = String(model || '').toLowerCase();
  if (/^(?:gpt-|codex-|o[134](?:-|$))/i.test(m)) return 'GPT';
  if (/^gemini-/i.test(m)) return 'Gemini';
  if (/^glm[-_]/i.test(m)) return 'GLM';
  if (/^deepseek[-_]/i.test(m)) return 'DeepSeek';
  if (/^claude[-_]/i.test(m)) return 'Claude';
  if (/^(?:minimax|abab)[-_]/i.test(m)) return 'MiniMax';
  return 'Other';
}

export function formatGeminiCountdown(secondsRemaining) {
  if (!Number.isFinite(secondsRemaining) || secondsRemaining <= 0) {
    return { zh: '即将重置', en: 'resets soon' };
  }
  if (secondsRemaining < 60) {
    return { zh: '即将重置', en: 'resets soon' };
  }
  if (secondsRemaining < 86400) {
    const hours = Math.floor(secondsRemaining / 3600);
    const mins = Math.floor((secondsRemaining % 3600) / 60);
    if (hours === 0) {
      return { zh: `${mins}min后重置`, en: `resets in ${mins}m` };
    }
    return { zh: `${hours}h${mins}min后重置`, en: `resets in ${hours}h ${mins}m` };
  }
  const days = Math.floor(secondsRemaining / 86400);
  return { zh: `${days}天后重置`, en: `resets in ${days}d` };
}

function normalizeMatchText(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function parseRecoveryTime(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) return value > 1e12 ? value : value * 1000;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

export function matchGeminiStandardRow(groupName, bucketWindow) {
  const g = normalizeMatchText(groupName);
  const w = normalizeMatchText(bucketWindow);

  const isGeminiGroup = g.includes('gemini');
  const isClaudeGptGroup = g.includes('claude') || g.includes('gpt') || g.includes('3p') || g.includes('shared');

  const is5h = w === '5h' || w.includes('fivehour') || w.includes('5hour');
  const isWeekly = w === '7d' || w.includes('weekly') || w.includes('week') || w.includes('7day');

  if (isGeminiGroup && is5h) return 'Gemini 5h';
  if (isGeminiGroup && isWeekly) return 'Gemini 7d';
  if (isClaudeGptGroup && isWeekly) return 'Claude & GPT 7d';
  if (isClaudeGptGroup && is5h) return 'Claude & GPT 5h';
  return null;
}

export function isAccountAvailable(acc) {
  if (!acc || acc.disabled || acc.health?.state === 'unavailable' || acc.status === 'error' || acc.status === 'disabled') return false;
  const rows = acc.rows || [];
  if (!rows.length) return false;
  const gemini5h = rows.find(r => r.label === 'Gemini 5h');
  if (gemini5h && gemini5h.remainingPercent === 0) return false;
  const gemini7d = rows.find(r => r.label === 'Gemini 7d');
  if (gemini7d && gemini7d.remainingPercent === 0) return false;
  const valid = rows.filter(r => !r.unavailable && Number.isFinite(r.remainingPercent));
  return valid.length > 0 && valid.some(r => r.remainingPercent > 0);
}

export class GeminiQuotaManager {
  constructor(options = {}) {
    this.cliProxyUrl = options.cliProxyUrl || DEFAULT_CLI_PROXY_URL;
    this.authDir = options.authDir || join(homedir(), '.cli-proxy-api');
    this.configPath = options.configPath || join(this.authDir, 'config.yaml');
    this.quotaEndpoint = options.quotaEndpoint || GOOGLE_QUOTA_ENDPOINT;
    this.tokenEndpoint = options.tokenEndpoint || GOOGLE_TOKEN_ENDPOINT;
    const creds = getAntigravityCredentials();
    this.clientId = options.clientId || creds.clientId;
    this.clientSecret = options.clientSecret || creds.clientSecret;
    this.accountCaches = new Map();
    this.selectedAccount = null;
    this.routingHealthReadAt = null;
    this.routingHealthByAccount = new Map();
    this.enableDynamicPriority = Boolean(options.enableDynamicPriority);
    this.cache = {
      status: 'idle',
      plan: 'Gemini AI Pro',
      selectedAccount: null,
      accounts: [],
      rows: [
        { label: 'Gemini 5h', remainingPercent: null, countdown: null, unavailable: true },
        { label: 'Gemini 7d', remainingPercent: null, countdown: null, unavailable: true },
        { label: 'Claude & GPT 5h', remainingPercent: null, countdown: null, unavailable: true },
        { label: 'Claude & GPT 7d', remainingPercent: null, countdown: null, unavailable: true },
      ],
      fetchedAt: null,
      stale: false,
      error: null,
    };
    this.inFlight = null;
  }

  readManagementKey() {
    if (process.env.MANAGEMENT_PASSWORD) return process.env.MANAGEMENT_PASSWORD.trim();
    if (!existsSync(this.configPath)) return "admin123";
    try {
      const text = readFileSync(this.configPath, "utf8");
      const secretMatch = text.match(/secret-key:\s*["']?([^"'\r\n]+)["']?/);
      if (secretMatch && secretMatch[1] && !secretMatch[1].startsWith("$2")) return secretMatch[1].trim();
    } catch { /* 忽略异常 */ }
    return "admin123";
  }

  findAllAntigravityAuthFiles() {
    if (!existsSync(this.authDir)) return [];
    try {
      const files = readdirSync(this.authDir);
      return files
        .filter(f => f.startsWith('antigravity-') && f.endsWith('.json') && !f.includes('.bak'))
        .map(f => join(this.authDir, f));
    } catch {
      return [];
    }
  }

  /** 只读本地调用冷却记录；最多每五秒扫描一次，不探测模型、不写入凭证。 */
  readRoutingHealth(accounts, now = Date.now()) {
    if (this.routingHealthReadAt !== null && now - this.routingHealthReadAt < 5000) return this.routingHealthByAccount;
    this.routingHealthReadAt = now;
    const healthByAccount = new Map();
    try {
      for (const name of readdirSync(this.authDir).filter(name => name.endsWith('.cds'))) {
        const path = join(this.authDir, name);
        if (statSync(path).size > 2 * 1024 * 1024) continue;
        let data;
        try { data = JSON.parse(readFileSync(path, 'utf8')); } catch { continue; }
        if (String(data.provider || '').toLowerCase() !== 'antigravity') continue;
        for (const record of Array.isArray(data.records) ? data.records : []) {
          if (!record || typeof record !== 'object') continue;
          const authId = String(record.auth_id || data.auth_id || name.replace(/\.cds$/, '.json')).trim();
          const filename = authId.split(/[\\/]/).pop();
          const account = accounts.find(account => account.id === filename || String(account.email || '').toLowerCase() === authId.toLowerCase());
          if (!account) continue;
          const status = String(record.status || '').toUpperCase();
          const health = ['ACTIVE', 'READY', 'OK'].includes(status)
            ? getAccountHealth()
            : getAccountHealth({}, record);
          const retryAt = parseRecoveryTime(record.next_retry_after || record.quota?.next_recover_at);
          if (health.code === 'cooling' && retryAt && retryAt <= now) continue;
          const healthWithRecovery = health.state === 'cooling' && retryAt
            ? { ...health, recoveryAt: retryAt }
            : health;
          const previous = healthByAccount.get(account.email);
          const severity = { healthy: 0, unknown: 1, cooling: 2, unavailable: 3 };
          if (!previous || severity[health.state] >= severity[previous.state]) healthByAccount.set(account.email, healthWithRecovery);
        }
      }
    } catch { /* 状态文件可能在扫描过程中被 bridge 原子替换；下一轮再读 */ }
    this.routingHealthByAccount = healthByAccount;
    return healthByAccount;
  }

  async refreshAccessToken(authData, authFilePath) {
    if (!authData?.refresh_token || !this.clientId || !this.clientSecret) return authData?.access_token || null;
    return new Promise((resolve) => {
      const postData = new URLSearchParams({
        client_id: this.clientId,
        client_secret: this.clientSecret,
        grant_type: 'refresh_token',
        refresh_token: authData.refresh_token,
      }).toString();

      const req = httpsRequest(this.tokenEndpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Content-Length': Buffer.byteLength(postData),
        },
        timeout: 10000,
      }, (res) => {
        let body = '';
        res.on('data', chunk => { body += chunk; });
        res.on('end', () => {
          try {
            if (res.statusCode === 200) {
              const parsed = JSON.parse(body);
              if (parsed.access_token) {
                authData.access_token = parsed.access_token;
                authData.expires_in = parsed.expires_in || 3599;
                authData.expired = new Date(Date.now() + (authData.expires_in * 1000)).toISOString();
                try { writeFileSync(authFilePath, JSON.stringify(authData, null, 2)); } catch { /* 忽略写回异常 */ }
                return resolve(parsed.access_token);
              }
            }
          } catch { /* 忽略刷新异常 */ }
          resolve(authData.access_token || null);
        });
      });
      req.on('error', () => resolve(authData.access_token || null));
      req.on('timeout', () => { req.destroy(); resolve(authData.access_token || null); });
      req.write(postData);
      req.end();
    });
  }

  async getAccessTokenForFile(authFilePath) {
    if (!authFilePath || !existsSync(authFilePath)) return null;
    try {
      const authData = JSON.parse(readFileSync(authFilePath, 'utf8'));
      const expiry = authData.expired ? new Date(authData.expired).getTime() : 0;
      if (expiry && expiry <= Date.now() + 180000) {
        return await this.refreshAccessToken(authData, authFilePath);
      }
      return authData.access_token || null;
    } catch {
      return null;
    }
  }

  async fetchQuotaFromGoogle(accessToken) {
    return new Promise((resolve, reject) => {
      const req = httpsRequest(this.quotaEndpoint, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Antigravity/2.15.0',
        },
        timeout: 15000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              resolve(JSON.parse(data));
            } catch (err) {
              reject(err);
            }
          } else {
            const health = getAccountHealth({ error: data, httpStatus: res.statusCode });
            reject(Object.assign(new Error(health.code), { code: health.code, httpStatus: res.statusCode }));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('Google API request timeout')); });
      req.write('{}');
      req.end();
    });
  }

  async fetchQuotaViaApiCall(accessToken) {
    const secretKey = this.readManagementKey();
    return new Promise((resolve, reject) => {
      const payload = JSON.stringify({
        url: this.quotaEndpoint,
        method: 'POST',
        data: '{}',
        header: {
          'Authorization': `Bearer ${accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'Antigravity/2.15.0',
        },
      });

      const req = httpRequest(`${this.cliProxyUrl}/v0/management/api-call`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${secretKey}`,
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(payload),
        },
        timeout: 15000,
      }, (res) => {
        let data = '';
        res.on('data', chunk => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode === 200) {
            try {
              const parsed = JSON.parse(data);
              if (parsed.status_code === 200) {
                resolve(typeof parsed.body === 'string' ? JSON.parse(parsed.body) : parsed.body);
              } else {
                const health = getAccountHealth({ error: parsed.body, httpStatus: parsed.status_code });
                reject(Object.assign(new Error(health.code), { code: health.code, httpStatus: parsed.status_code }));
              }
            } catch (err) {
              reject(err);
            }
          } else {
            reject(new Error(`api-call HTTP status ${res.statusCode}`));
          }
        });
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('api-call timeout')); });
      req.write(payload);
      req.end();
    });
  }

  parseRawQuotaPayload(data) {
    const standard = {
      'Gemini 5h': null,
      'Gemini 7d': null,
      'Claude & GPT 7d': null,
      'Claude & GPT 5h': null,
    };
    const extra = [];
    const groups = Array.isArray(data?.groups) ? data.groups : [];

    for (const group of groups) {
      const groupName = group.displayName || group.display_name || '';
      const buckets = Array.isArray(group.buckets) ? group.buckets : [];
      for (const bucket of buckets) {
        const windowName = bucket.window || '';
        const matchKey = matchGeminiStandardRow(groupName, windowName);

        const remainingRaw = bucket.remainingFraction ?? bucket.remaining_fraction;
        const percent = (remainingRaw !== null && remainingRaw !== undefined && Number.isFinite(Number(remainingRaw)))
          ? Math.max(0, Math.min(100, Math.round(Number(remainingRaw) * 100)))
          : null;

        const resetTimeRaw = bucket.resetTime || bucket.reset_time;
        const resetTimestamp = resetTimeRaw ? new Date(resetTimeRaw).getTime() : 0;
        let resetSeconds = resetTimestamp ? Math.max(0, Math.floor((resetTimestamp - Date.now()) / 1000)) : null;
        if (windowName === '5h' && Number.isFinite(resetSeconds)) {
          resetSeconds = Math.min(18000, resetSeconds);
        }

        const entry = {
          remainingPercent: percent,
          resetTime: resetTimestamp ? Math.floor(resetTimestamp / 1000) : null,
          secondsRemaining: resetSeconds,
          countdown: formatGeminiCountdown(resetSeconds),
          unavailable: percent === null,
        };

        if (matchKey && standard[matchKey] === null) {
          standard[matchKey] = { label: matchKey, ...entry };
        } else if (!matchKey) {
          let extraLabel = `${groupName} ${windowName}`.trim();
          if (extraLabel === 'Claude and GPT models 5h') extraLabel = 'Claude & GPT 5h';
          if (extraLabel === 'Claude and GPT models weekly') extraLabel = 'Claude & GPT 7d';
          if (!extra.some(e => e.label === extraLabel)) {
            extra.push({ label: extraLabel, ...entry });
          }
        }
      }
    }

    const rows = [
      standard['Gemini 5h'] || { label: 'Gemini 5h', remainingPercent: null, countdown: null, unavailable: true },
      standard['Gemini 7d'] || { label: 'Gemini 7d', remainingPercent: null, countdown: null, unavailable: true },
    ];

    if (standard['Claude & GPT 5h']) {
      rows.push(standard['Claude & GPT 5h']);
    }

    rows.push(
      standard['Claude & GPT 7d'] || { label: 'Claude & GPT 7d', remainingPercent: null, countdown: null, unavailable: true }
    );

    rows.push(...extra);
    return rows;
  }

  async fetchQuotaForFile(authFilePath) {
    const filename = authFilePath.split('/').pop();
    let email = filename.replace(/^antigravity-/, '').replace(/\.json$/, '');
    let label = email.split('@')[0] || email;
    let priority = 0;
    let disabled = false;

    try {
      const authData = JSON.parse(readFileSync(authFilePath, 'utf8'));
      if (authData.email) email = authData.email;
      if (authData.priority !== undefined) priority = Number(authData.priority) || 0;
      if (authData.disabled !== undefined) disabled = Boolean(authData.disabled);
      label = email.split('@')[0] || email;
    } catch { /* 忽略解析异常 */ }

    if (disabled) {
      return {
        id: filename,
        email,
        label,
        priority,
        disabled: true,
        status: 'disabled',
        rows: [
          { label: 'Gemini 5h', remainingPercent: null, countdown: null, unavailable: true },
          { label: 'Gemini 7d', remainingPercent: null, countdown: null, unavailable: true },
          { label: 'Claude & GPT 5h', remainingPercent: null, countdown: null, unavailable: true },
          { label: 'Claude & GPT 7d', remainingPercent: null, countdown: null, unavailable: true },
        ],
        fetchedAt: null,
        stale: false,
        error: null,
      };
    }

    try {
      const token = await this.getAccessTokenForFile(authFilePath);
      if (!token) throw new Error('Token unavailable');

      let data;
      try {
        data = await this.fetchQuotaViaApiCall(token);
      } catch {
        data = await this.fetchQuotaFromGoogle(token);
      }

      const rows = this.parseRawQuotaPayload(data);
      const res = {
        id: filename,
        email,
        label,
        priority,
        disabled,
        status: disabled ? 'disabled' : 'ready',
        rows,
        fetchedAt: Date.now(),
        stale: false,
        error: null,
      };
      this.accountCaches.set(email, res);
      return res;
    } catch (err) {
      const health = getAccountHealth({ error: err.message || String(err), httpStatus: err.httpStatus });
      const prev = this.accountCaches.get(email);
      if (prev && prev.rows && prev.rows.some(r => !r.unavailable)) {
        return {
          ...prev,
          priority,
          disabled,
          status: disabled ? 'disabled' : health.state === 'unavailable' ? 'error' : prev.status,
          stale: true,
          error: health.code,
          errorCode: health.code,
          httpStatus: err.httpStatus || null,
        };
      }
      return {
        id: filename,
        email,
        label,
        priority,
        disabled,
        status: disabled ? 'disabled' : 'error',
        rows: [
          { label: 'Gemini 5h', remainingPercent: null, countdown: null, unavailable: true },
          { label: 'Gemini 7d', remainingPercent: null, countdown: null, unavailable: true },
          { label: 'Claude & GPT 5h', remainingPercent: null, countdown: null, unavailable: true },
          { label: 'Claude & GPT 7d', remainingPercent: null, countdown: null, unavailable: true },
        ],
        fetchedAt: null,
        stale: false,
        error: health.code,
        errorCode: health.code,
        httpStatus: err.httpStatus || null,
      };
    }
  }

  async fetchQuota() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const authFiles = this.findAllAntigravityAuthFiles();
        if (authFiles.length === 0) throw new Error('Antigravity auth files not found');

        const accountResults = await mapWithConcurrency(authFiles, 2, f => this.fetchQuotaForFile(f));

        accountResults.sort((a, b) => (b.priority || 0) - (a.priority || 0));

        if (this.enableDynamicPriority) {
          try {
            exportQuotaSnapshot(accountResults, { authDir: this.authDir });
          } catch { /* 忽略导出快照异常 */ }
        }

        for (const acc of accountResults) {
          this.accountCaches.set(acc.email, acc);
        }

        const manualAccount = this.selectedAccount ? accountResults.find(a => a.email === this.selectedAccount) : null;
        const isManualValid = manualAccount && isAccountAvailable(manualAccount);
        const active = (isManualValid ? manualAccount : accountResults.find(isAccountAvailable)) || accountResults[0];

        this.cache = {
          status: accountResults.some(a => a.status === 'ready') ? 'ready' : 'error',
          plan: 'Gemini AI Pro',
          selectedAccount: active?.email || null,
          accounts: accountResults,
          rows: active?.rows || [],
          fetchedAt: Date.now(),
          stale: active?.stale || false,
          error: active?.error || null,
        };
        return this.cache;
      } catch (err) {
        if (this.cache.rows && this.cache.rows.some(r => !r.unavailable)) {
          this.cache = {
            ...this.cache,
            stale: true,
            error: String(err.message || err),
          };
          return this.cache;
        }
        this.cache = {
          status: 'error',
          plan: 'Gemini AI Pro',
          selectedAccount: null,
          accounts: [],
          rows: [
            { label: 'Gemini 5h', remainingPercent: null, countdown: null, unavailable: true },
            { label: 'Gemini 7d', remainingPercent: null, countdown: null, unavailable: true },
            { label: 'Claude & GPT 5h', remainingPercent: null, countdown: null, unavailable: true },
            { label: 'Claude & GPT 7d', remainingPercent: null, countdown: null, unavailable: true },
          ],
          fetchedAt: null,
          stale: false,
          error: String(err.message || err),
        };
        return this.cache;
      } finally {
        this.inFlight = null;
      }
    })();
    return this.inFlight;
  }

  getSnapshot() {
    const updateRows = (rows) => rows.map(row => {
      if (!row.resetTime) return row;
      let secondsRemaining = Math.max(0, row.resetTime - Math.floor(Date.now() / 1000));
      if (row.label && row.label.includes('5h')) {
        secondsRemaining = Math.min(18000, secondsRemaining);
      }
      return {
        ...row,
        secondsRemaining,
        countdown: formatGeminiCountdown(secondsRemaining),
      };
    });

    const poolStatus = this.enableDynamicPriority ? readPoolStatus({ authDir: this.authDir }) : null;
    const routingHealth = this.readRoutingHealth(this.cache.accounts || []);
    const accounts = (this.cache.accounts || []).map(acc => {
      const account = { ...acc, health: undefined, routingHealth: routingHealth.get(acc.email), rows: updateRows(acc.rows || []) };
      const rank = poolStatus?.accountMap?.[String(acc.email || '').toLowerCase()];
      const health = getAccountHealth(account, rank);
      const recoveryAt = account.routingHealth?.recoveryAt || rank?.recoveryAt || null;
      return { ...account, health: recoveryAt ? { ...health, recoveryAt } : health, error: acc.error ? health.code : null };
    });

    accounts.sort((a, b) => (b.priority || 0) - (a.priority || 0));

    const manualAccount = this.selectedAccount ? accounts.find(a => a.email === this.selectedAccount) : null;
    const isManualValid = manualAccount && isAccountAvailable(manualAccount);
    const active = (isManualValid ? manualAccount : accounts.find(isAccountAvailable)) || accounts[0];

    return {
      status: this.cache.status,
      plan: this.cache.plan,
      selectedAccount: active?.email || null,
      accounts,
      rows: updateRows(active?.rows || this.cache.rows || []),
      fetchedAt: this.cache.fetchedAt,
      stale: active?.stale || this.cache.stale,
      error: active?.error || (this.cache.error ? getAccountHealth({ error: this.cache.error, status: 'error' }).code : null),
      enableDynamicPriority: this.enableDynamicPriority,
      poolStatus,
    };
  }
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      results[index] = await mapper(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

export class TokenRollupEngine {
  constructor(options = {}) {
    this.baseDir = options.baseDir || getDataDir();
    this.storagePath = options.storagePath || getRollupStoragePath();
    this.sessionsDir = options.sessionsDir || getSessionsDir();
    this.data = {
      schemaVersion: SCHEMA_VERSION,
      timezone: options.timezone || TIMEZONE,
      files: {},
      days: {},
      coverageStartedAt: null,
      earliestRecordedDate: null,
      historicalTotals: {},
      backfillComplete: false,
    };
    this.status = 'idle';
    this.dirty = false;
    this.lastSavedAt = 0;
    this.backfillInProgress = false;
    this.initialized = false;
    this.scanPromise = null;
    this.readChunkBytes = Math.max(4096, Number(options.readChunkBytes) || 256 * 1024);
    this.timezone = options.timezone || TIMEZONE;
    this.snapshotCache = null;
    this.snapshotRevision = 0;
    this.enabled = false;
  }

  init() {
    if (this.initialized) return;
    this.initialized = true;
    this.enabled = true;
    this.load();
    if (Object.keys(this.data.days).length === 0) {
      this.status = 'building';
      this.runBackfillWorker().catch(() => {});
    } else {
      this.status = 'ready';
      this.scanIncremental();
    }
  }

  load() {
    if (!existsSync(this.storagePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.storagePath, 'utf8'));
      if (raw.schemaVersion === SCHEMA_VERSION && raw.days && typeof raw.days === 'object') {
        if (raw.timezone && raw.timezone !== this.timezone) {
          this.data.timezone = this.timezone;
          this.status = 'building';
          return;
        }
        this.data = {
          schemaVersion: SCHEMA_VERSION,
          timezone: this.timezone,
          files: raw.files || {},
          days: raw.days || {},
          coverageStartedAt: raw.coverageStartedAt || null,
          earliestRecordedDate: raw.earliestRecordedDate || null,
          historicalTotals: raw.historicalTotals || {},
          backfillComplete: typeof raw.backfillComplete === 'boolean'
            ? raw.backfillComplete
            : Object.keys(raw.days).length > 0,
        };
      }
    } catch {
      // 状态文件损坏时重新建立。
    }
  }

  save(force = false) {
    if (!this.dirty && !force) return;
    const now = Date.now();
    if (!force && now - this.lastSavedAt < ROLLING_SAVE_INTERVAL_MS) return;

    try {
      mkdirSync(this.baseDir, { recursive: true });
      const tmpPath = `${this.storagePath}.tmp.${process.pid}`;
      const json = JSON.stringify(this.data, null, 2);
      writeFileSync(tmpPath, json, { mode: 0o600 });
      renameSync(tmpPath, this.storagePath);
      if (process.platform !== 'win32') {
        try { chmodSync(this.storagePath, 0o600); } catch { /* ignore */ }
      }
      this.dirty = false;
      this.lastSavedAt = now;
    } catch { /* 忽略磁盘写入错误 */ }
  }

  getEarliestDate() {
    if (this.data.earliestRecordedDate) return this.data.earliestRecordedDate;
    const sortedDays = Object.keys(this.data.days || {}).sort();
    if (sortedDays.length > 0) {
      this.data.earliestRecordedDate = sortedDays[0];
      this.dirty = true;
      return sortedDays[0];
    }
    return null;
  }

  pruneOldDays() {
    let changed = false;
    this.getEarliestDate();
    if (!this.data.historicalTotals) {
      this.data.historicalTotals = {};
    }

    const minTimestamp = Date.now() - (MAX_DAYS_RETENTION * 86400000);
    const minDate = toDateKey(minTimestamp, this.timezone);

    for (const date of Object.keys(this.data.days)) {
      if (date < minDate) {
        for (const [model, tokens] of Object.entries(this.data.days[date] || {})) {
          this.data.historicalTotals[model] = (this.data.historicalTotals[model] || 0) + (Number(tokens) || 0);
        }
        delete this.data.days[date];
        this.dirty = true;
        changed = true;
      }
    }

    if (this.data.files && typeof this.data.files === 'object') {
      for (const [filePath, record] of Object.entries(this.data.files)) {
        if (!existsSync(filePath)) {
          delete this.data.files[filePath];
          this.dirty = true;
          continue;
        }
        const mtime = record?.mtime;
        if (mtime && mtime < minTimestamp) {
          delete this.data.files[filePath];
          this.dirty = true;
        }
      }
    }
    if (changed) {
      this.snapshotRevision += 1;
      this.snapshotCache = null;
    }
  }

  processLine(line, fileRecord, dateFallback) {
    if (!line || !line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event.type === 'session_meta') {
        const model = event.payload?.model || event.payload?.base_instructions?.provenance?.model;
        if (model && typeof model === 'string') fileRecord.currentModel = model;
      } else if (event.type === 'turn_context') {
        const model = event.payload?.model;
        if (model && typeof model === 'string') fileRecord.currentModel = model;
      } else if (event.type === 'event_msg' && event.payload?.type === 'token_count') {
        const total = Number(event.payload?.info?.total_token_usage?.total_tokens ?? event.payload?.total_token_usage?.total_tokens);
        if (Number.isFinite(total)) {
          if (fileRecord.lastTotal === undefined || fileRecord.lastTotal === null) {
            fileRecord.lastTotal = total;
          } else {
            const delta = total - fileRecord.lastTotal;
            if (delta > 0) {
              const date = event.timestamp ? toDateKey(event.timestamp, this.timezone) : dateFallback;
              const model = fileRecord.currentModel || 'unknown';
              if (!this.data.days[date]) this.data.days[date] = {};
              this.data.days[date][model] = (this.data.days[date][model] || 0) + delta;
              fileRecord.lastTotal = total;
              this.dirty = true;
              this.snapshotRevision += 1;
              this.snapshotCache = null;
            } else if (delta < 0) {
              fileRecord.lastTotal = total;
            }
          }
        }
      }
    } catch { /* 忽略损坏的日志行 */ }
  }

  async scanFileIncremental(filePath) {
    if (!this.enabled) return;
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      delete this.data.files[filePath];
      return;
    }

    let record = this.data.files[filePath];
    const fileId = stat.ino || `${stat.birthtimeMs || stat.ctimeMs || 0}`;
    if (!record || record.inode !== fileId || stat.size < (record.offset || 0)) {
      record = {
        inode: fileId,
        offset: 0,
        lastTotal: undefined,
        currentModel: 'unknown',
        mtime: stat.mtimeMs,
      };
      this.data.files[filePath] = record;
    } else {
      record.mtime = stat.mtimeMs;
    }

    if (stat.size <= record.offset) return;

    const dateFallback = toDateKey(stat.mtimeMs || Date.now(), this.timezone);
    let fd;
    try {
      fd = openSync(filePath, 'r');
      const buffer = Buffer.allocUnsafe(this.readChunkBytes);
      const fileEnd = stat.size;
      let pending = Buffer.alloc(0);
      let readPosition = record.offset;
      while (readPosition < fileEnd) {
        if (!this.enabled) break;
        const bytesToRead = Math.min(this.readChunkBytes, fileEnd - readPosition);
        const bytesRead = readSync(fd, buffer, 0, bytesToRead, readPosition);
        if (bytesRead <= 0) break;
        readPosition += bytesRead;
        const chunk = pending.length
          ? Buffer.concat([pending, buffer.subarray(0, bytesRead)])
          : buffer.subarray(0, bytesRead);
        let lineStart = 0;
        for (let i = 0; i < chunk.length; i++) {
          if (chunk[i] !== 0x0a) continue;
          this.processLine(chunk.toString('utf8', lineStart, i), record, dateFallback);
          lineStart = i + 1;
        }
        pending = Buffer.from(chunk.subarray(lineStart));
        record.offset += lineStart;
        if (pending.length > 4 * 1024 * 1024) {
          // Avoid unbounded growth on malformed/non-JSONL input; skip to the next chunk boundary.
          record.offset += pending.length;
          pending = Buffer.alloc(0);
        }
        await new Promise(resolve => setImmediate(resolve));
      }
    } catch {
      // 保留已提交到完整换行处的偏移，下轮重读未完成尾行。
    } finally {
      if (fd !== undefined) try { closeSync(fd); } catch { /* 忽略关闭异常 */ }
    }
  }

  collectSessionFiles(recentOnly = false) {
    const results = new Set();
    if (!existsSync(this.sessionsDir)) return [];

    // 1. 所有已追踪的活跃会话文件必须优先纳入检查（避免长会话跨天时被漏掉）
    if (this.data.files) {
      for (const filePath of Object.keys(this.data.files)) {
        if (existsSync(filePath)) {
          results.add(filePath);
        }
      }
    }

    if (recentOnly) {
      // 2. 检查最近 7 天的日期子目录，发现新创建的会话
      const targetDays = new Set();
      for (let i = 0; i < 7; i++) {
        const dateStr = shiftDateKey(toDateKey(Date.now(), this.timezone), -i);
        targetDays.add(dateStr.replace(/-/g, '/'));
      }

      for (const dateRel of targetDays) {
        const dir = join(this.sessionsDir, dateRel);
        if (!existsSync(dir)) continue;
        try {
          const entries = readdirSync(dir, { withFileTypes: true });
          for (const entry of entries) {
            if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
              results.add(join(dir, entry.name));
            }
          }
        } catch {}
      }

      try {
        const rootEntries = readdirSync(this.sessionsDir, { withFileTypes: true });
        for (const entry of rootEntries) {
          if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
            results.add(join(this.sessionsDir, entry.name));
          }
        }
      } catch {}

      return [...results];
    }

    const queue = [this.sessionsDir];
    while (queue.length > 0) {
      const current = queue.shift();
      try {
        const entries = readdirSync(current, { withFileTypes: true });
        for (const entry of entries) {
          const full = join(current, entry.name);
          if (entry.isDirectory()) {
            queue.push(full);
          } else if (entry.isFile() && entry.name.startsWith('rollout-') && entry.name.endsWith('.jsonl')) {
            results.add(full);
          }
        }
      } catch { /* 忽略权限错误 */ }
    }
    return [...results];
  }

  async runBackfillWorker() {
    if (this.backfillInProgress) return;
    this.backfillInProgress = true;
    this.status = 'building';

    try {
      const files = this.collectSessionFiles(false);
      if (!this.data.coverageStartedAt) {
        this.data.coverageStartedAt = new Date().toISOString();
      }

      const chunkSize = 5;
      for (let i = 0; i < files.length; i += chunkSize) {
        const batch = files.slice(i, i + chunkSize);
        for (const file of batch) {
          if (!this.enabled) break;
          await this.scanFileIncremental(file);
        }
        if (!this.enabled) break;
        await new Promise(r => setImmediate(r));
      }

      this.pruneOldDays();
      this.data.backfillComplete = this.enabled;
      this.dirty = true;
      this.snapshotRevision += 1;
      this.snapshotCache = null;
      this.save(true);
      this.status = this.enabled ? 'ready' : 'disabled';
    } catch {
      this.status = this.enabled ? 'error' : 'disabled';
    } finally {
      this.backfillInProgress = false;
    }
  }

  scanIncremental() {
    if (!this.enabled) return Promise.resolve(false);
    if (this.backfillInProgress) return Promise.resolve(false);
    if (this.scanPromise) return this.scanPromise;
    this.scanPromise = (async () => {
      const startRevision = this.snapshotRevision;
      try {
      const files = this.collectSessionFiles(true);
      for (const file of files) {
        await this.scanFileIncremental(file);
      }
      this.pruneOldDays();
      this.save(false);
      this.status = 'ready';
      } catch {
        this.status = 'ready';
      }
      return this.snapshotRevision !== startRevision;
    })().finally(() => { this.scanPromise = null; });
    return this.scanPromise;
  }

  setEnabled(enabled) {
    const next = Boolean(enabled);
    const wasEnabled = this.enabled;
    this.enabled = next;
    if (!next) {
      this.status = 'disabled';
      return;
    }
    if (!this.initialized) this.init();
    else if (!wasEnabled) {
      this.status = Object.keys(this.data.days).length ? 'ready' : 'building';
      if (!this.data.backfillComplete) this.runBackfillWorker().catch(() => {});
      else this.scanIncremental();
    }
  }

  calculateRollup() {
    const todayDate = toDateKey(Date.now(), this.timezone);
    const getDates = (count) => {
      const dates = [];
      const today = toDateKey(Date.now(), this.timezone);
      for (let i = 0; i < count; i++) dates.push(shiftDateKey(today, -i));
      return new Set(dates);
    };

    const dates7 = getDates(7);
    const dates30 = getDates(30);

    this.getEarliestDate();
    const aggregates = {
      today: {},
      days7: {},
      days30: {},
      allTime: { ...(this.data.historicalTotals || {}) },
    };

    for (const [date, models] of Object.entries(this.data.days)) {
      const inToday = date === todayDate;
      const in7 = dates7.has(date);
      const in30 = dates30.has(date);

      for (const [model, tokens] of Object.entries(models)) {
        const count = Number(tokens) || 0;
        if (count <= 0) continue;
        if (inToday) aggregates.today[model] = (aggregates.today[model] || 0) + count;
        if (in7) aggregates.days7[model] = (aggregates.days7[model] || 0) + count;
        if (in30) aggregates.days30[model] = (aggregates.days30[model] || 0) + count;
        aggregates.allTime[model] = (aggregates.allTime[model] || 0) + count;
      }
    }

    const formatRange = (agg) => {
      const familyTotals = new Map();
      for (const [model, tokens] of Object.entries(agg)) {
        const family = classifyModel(model);
        const familyEntry = familyTotals.get(family) || { tokens: 0, models: [] };
        familyEntry.tokens += tokens;
        familyEntry.models.push({ id: model, tokens, formatted: formatTokenCount(tokens) });
        familyTotals.set(family, familyEntry);
      }

      const total = [...familyTotals.values()].reduce((sum, family) => sum + family.tokens, 0);
      const totalFormatted = formatTokenCount(total);
      const calcPct = (value, denominator) => denominator > 0 ? ((value / denominator) * 100).toFixed(1) + '%' : '—';
      const primaryFamilies = ['GPT', 'Gemini'];
      const additionalFamilies = TOKEN_FAMILY_ORDER
        .filter(family => !primaryFamilies.includes(family) && (familyTotals.get(family)?.tokens || 0) > 0)
        .sort((a, b) => familyTotals.get(b).tokens - familyTotals.get(a).tokens
          || TOKEN_FAMILY_ORDER.indexOf(a) - TOKEN_FAMILY_ORDER.indexOf(b));
      const orderedFamilies = [...primaryFamilies, ...additionalFamilies];
      const items = orderedFamilies.map(family => {
        const familyEntry = familyTotals.get(family) || { tokens: 0, models: [] };
        const key = family === 'Other' ? 'other' : family.toLowerCase();
        const models = familyEntry.models.sort((a, b) => b.tokens - a.tokens || a.id.localeCompare(b.id));
        return {
          key,
          label: family,
          tokens: familyEntry.tokens,
          formatted: formatTokenCount(familyEntry.tokens),
          percent: calcPct(familyEntry.tokens, total),
          models: models.map(model => ({ ...model, percent: calcPct(model.tokens, familyEntry.tokens) })),
        };
      });
      const summaryItems = items.length > 4
        ? [
          ...items.slice(0, 3),
          (() => {
            const overflowItems = items.slice(3);
            const tokens = overflowItems.reduce((sum, item) => sum + item.tokens, 0);
            return {
              key: 'overflow',
              label: 'Other models',
              modelCount: overflowItems.length,
              tokens,
              formatted: formatTokenCount(tokens),
              percent: calcPct(tokens, total),
            };
          })(),
        ]
        : items;

      return {
        total,
        totalFormatted,
        items,
        summaryItems,
      };
    };

    return {
      today: formatRange(aggregates.today),
      days7: formatRange(aggregates.days7),
      days30: formatRange(aggregates.days30),
      allTime: formatRange(aggregates.allTime),
    };
  }

  getSnapshot() {
    const today = toDateKey(Date.now(), this.timezone);
    const cacheKey = `${this.snapshotRevision}:${today}:${this.status}`;
    if (this.snapshotCache?.key === cacheKey) return this.snapshotCache.value;
    const ranges = this.calculateRollup();
    const value = {
      status: this.status,
      selectedRange: 'today',
      ranges,
      coverageStartedAt: this.data.coverageStartedAt,
      earliestRecordedDate: this.getEarliestDate(),
      error: null,
      timezone: this.timezone,
    };
    this.snapshotCache = { key: cacheKey, value };
    return value;
  }
}

export class ExtendedUsageCoordinator {
  constructor(options = {}) {
    this.settings = options.settings || {};
    this.geminiManager = new GeminiQuotaManager({
      ...(options.gemini || {}),
      enableDynamicPriority: Boolean(this.settings.enableDynamicPriority),
    });
    this.tokenEngine = new TokenRollupEngine({ timezone: this.settings.timezone || TIMEZONE, ...(options.tokens || {}) });
    this.initialized = { tokens: false, gemini: false };
  }

  updateSettings(settings = {}) {
    this.settings = settings;
    if (settings.timezone && settings.timezone !== this.tokenEngine.timezone) {
      this.tokenEngine.timezone = settings.timezone;
      this.tokenEngine.data = {
        schemaVersion: SCHEMA_VERSION,
        timezone: settings.timezone,
        files: {}, days: {}, coverageStartedAt: null,
        earliestRecordedDate: null, historicalTotals: {}, backfillComplete: false,
      };
      this.tokenEngine.snapshotRevision += 1;
      this.tokenEngine.snapshotCache = null;
      this.tokenEngine.dirty = true;
      this.tokenEngine.save(true);
      this.tokenEngine.initialized = false;
      this.initialized.tokens = false;
    }
    if (this.geminiManager) {
      this.geminiManager.enableDynamicPriority = Boolean(settings.enableDynamicPriority);
    }
    const shouldRunGemini = Boolean(settings.enableGoogleAiPro || settings.enableDynamicPriority);
    this.tokenEngine.setEnabled(Boolean(settings.enableTokenUsage));
    if (settings.enableTokenUsage) this.initialized.tokens = true;
    if (shouldRunGemini) this.initGemini();
  }

  init() {
    if (this.settings.enableTokenUsage) this.initTokens();
    if (this.settings.enableGoogleAiPro || this.settings.enableDynamicPriority) this.initGemini();
  }

  initTokens() {
    if (this.initialized.tokens) return;
    this.initialized.tokens = true;
    this.tokenEngine.setEnabled(true);
  }

  initGemini() {
    if (this.initialized.gemini) return;
    this.initialized.gemini = true;
    this.geminiManager.fetchQuota().catch(() => {});
  }

  async refreshGemini() {
    if (!(this.settings.enableGoogleAiPro || this.settings.enableDynamicPriority)) return null;
    this.initGemini();
    return this.geminiManager.fetchQuota();
  }

  scanTokensIncremental() {
    if (!this.settings.enableTokenUsage) return Promise.resolve(false);
    this.initTokens();
    return this.tokenEngine.scanIncremental();
  }

  getSnapshot() {
    const geminiEnabled = Boolean(this.settings.enableGoogleAiPro || this.settings.enableDynamicPriority);
    const tokensEnabled = Boolean(this.settings.enableTokenUsage);
    return {
      antigravity: geminiEnabled ? this.geminiManager.getSnapshot() : disabledGeminiSnapshot(),
      tokens: tokensEnabled ? this.tokenEngine.getSnapshot() : disabledTokenSnapshot(),
      timezone: this.tokenEngine.timezone,
    };
  }
}

function disabledGeminiSnapshot() {
  return { status: 'disabled', plan: 'Gemini AI Pro', selectedAccount: null, accounts: [], rows: [], fetchedAt: null, stale: false, error: null, enableDynamicPriority: false, poolStatus: null };
}

function disabledTokenSnapshot() {
  return { status: 'disabled', selectedRange: 'today', ranges: null, coverageStartedAt: null, earliestRecordedDate: null, error: null };
}
