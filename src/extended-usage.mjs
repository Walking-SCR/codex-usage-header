/**
 * Extended usage coordinator for codex-usage-header:
 * 1. Gemini AI Pro multi-account quota fetching and caching via local CLIProxyAPI.
 * 2. Incremental Token usage rollup from local Codex session rollout logs.
 * Zero credentials or tokens are ever sent to the renderer or logged.
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

export const SCHEMA_VERSION = 1;
export const TIMEZONE = 'Asia/Shanghai';
export const MAX_DAYS_RETENTION = 32;
export const ROLLING_SAVE_INTERVAL_MS = 60000;
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
    } catch { /* ignore */ }
  }
  return { clientId: '', clientSecret: '' };
}

export function toShanghaiDate(timestamp) {
  const d = new Date(timestamp);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: TIMEZONE,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(d);
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
  if (!acc || acc.status === 'error') return false;
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
    this.cache = {
      status: 'idle',
      plan: 'Gemini AI Pro',
      selectedAccount: null,
      accounts: [],
      rows: [
        { label: 'Gemini 5h', remainingPercent: null, countdown: null, unavailable: true },
        { label: 'Gemini 7d', remainingPercent: null, countdown: null, unavailable: true },
        { label: 'Claude & GPT 7d', remainingPercent: null, countdown: null, unavailable: true },
        { label: 'Claude & GPT 5h', remainingPercent: null, countdown: null, unavailable: true },
      ],
      fetchedAt: null,
      stale: false,
      error: null,
    };
    this.inFlight = null;
  }

  readManagementKey() {
    if (process.env.MANAGEMENT_PASSWORD) return process.env.MANAGEMENT_PASSWORD.trim();
    if (!existsSync(this.configPath)) return '';
    try {
      const text = readFileSync(this.configPath, 'utf8');
      const secretMatch = text.match(/secret-key:\s*["']?([^"'\r\n]+)["']?/);
      if (secretMatch && secretMatch[1]) return secretMatch[1].trim();
      const apiKeyMatch = text.match(/- ["']?(sk-[^"'\r\n]+)["']?/);
      if (apiKeyMatch && apiKeyMatch[1]) return apiKeyMatch[1].trim();
    } catch { /* ignore */ }
    return '';
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
                try { writeFileSync(authFilePath, JSON.stringify(authData, null, 2)); } catch { /* ignore */ }
                return resolve(parsed.access_token);
              }
            }
          } catch { /* ignore */ }
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
            reject(new Error(`Google API status ${res.statusCode}: ${data.slice(0, 100)}`));
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
                reject(new Error(`api-call upstream status ${parsed.status_code}`));
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
        const resetSeconds = resetTimestamp ? Math.max(0, Math.floor((resetTimestamp - Date.now()) / 1000)) : null;

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
      standard['Claude & GPT 7d'] || { label: 'Claude & GPT 7d', remainingPercent: null, countdown: null, unavailable: true },
    ];

    if (standard['Claude & GPT 5h']) {
      rows.push(standard['Claude & GPT 5h']);
    }

    rows.push(...extra);
    return rows;
  }

  async fetchQuotaForFile(authFilePath) {
    const filename = authFilePath.split('/').pop();
    let email = filename.replace(/^antigravity-/, '').replace(/\.json$/, '');
    let label = email.split('@')[0] || email;

    try {
      const authData = JSON.parse(readFileSync(authFilePath, 'utf8'));
      if (authData.email) email = authData.email;
      label = email.split('@')[0] || email;
    } catch { /* ignore */ }

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
        status: 'ready',
        rows,
        fetchedAt: Date.now(),
        stale: false,
        error: null,
      };
      this.accountCaches.set(email, res);
      return res;
    } catch (err) {
      const prev = this.accountCaches.get(email);
      if (prev && prev.rows && prev.rows.some(r => !r.unavailable)) {
        return {
          ...prev,
          stale: true,
          error: String(err.message || err),
        };
      }
      return {
        id: filename,
        email,
        label,
        status: 'error',
        rows: [
          { label: 'Gemini 5h', remainingPercent: null, countdown: null, unavailable: true },
          { label: 'Gemini 7d', remainingPercent: null, countdown: null, unavailable: true },
          { label: 'Claude & GPT 7d', remainingPercent: null, countdown: null, unavailable: true },
          { label: 'Claude & GPT 5h', remainingPercent: null, countdown: null, unavailable: true },
        ],
        fetchedAt: null,
        stale: false,
        error: String(err.message || err),
      };
    }
  }

  async fetchQuota() {
    if (this.inFlight) return this.inFlight;
    this.inFlight = (async () => {
      try {
        const authFiles = this.findAllAntigravityAuthFiles();
        if (authFiles.length === 0) throw new Error('Antigravity auth files not found');

        const accountResults = await Promise.all(
          authFiles.map(f => this.fetchQuotaForFile(f))
        );

        for (const acc of accountResults) {
          this.accountCaches.set(acc.email, acc);
        }

        const manualAccount = accountResults.find(a => a.email === this.selectedAccount);
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
            { label: 'Claude & GPT 7d', remainingPercent: null, countdown: null, unavailable: true },
            { label: 'Claude & GPT 5h', remainingPercent: null, countdown: null, unavailable: true },
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
      const secondsRemaining = Math.max(0, row.resetTime - Math.floor(Date.now() / 1000));
      return {
        ...row,
        secondsRemaining,
        countdown: formatGeminiCountdown(secondsRemaining),
      };
    });

    const accounts = (this.cache.accounts || []).map(acc => ({
      ...acc,
      rows: updateRows(acc.rows || []),
    }));

    const manualAccount = accounts.find(a => a.email === this.selectedAccount);
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
      error: active?.error || this.cache.error,
    };
  }
}

export class TokenRollupEngine {
  constructor(options = {}) {
    this.baseDir = options.baseDir || join(homedir(), 'Library/Application Support/Codex Quota Header');
    this.storagePath = options.storagePath || join(this.baseDir, 'token-rollup.json');
    this.sessionsDir = options.sessionsDir || join(homedir(), '.codex/sessions');
    this.data = {
      schemaVersion: SCHEMA_VERSION,
      timezone: TIMEZONE,
      files: {},
      days: {},
      coverageStartedAt: null,
    };
    this.status = 'idle';
    this.dirty = false;
    this.lastSavedAt = 0;
    this.backfillInProgress = false;
  }

  init() {
    this.load();
    if (Object.keys(this.data.days).length === 0) {
      this.status = 'building';
      this.runBackfillWorker().catch(() => {});
    } else {
      this.status = 'ready';
    }
  }

  load() {
    if (!existsSync(this.storagePath)) return;
    try {
      const raw = JSON.parse(readFileSync(this.storagePath, 'utf8'));
      if (raw.schemaVersion === SCHEMA_VERSION && raw.days && typeof raw.days === 'object') {
        this.data = {
          schemaVersion: SCHEMA_VERSION,
          timezone: raw.timezone || TIMEZONE,
          files: raw.files || {},
          days: raw.days || {},
          coverageStartedAt: raw.coverageStartedAt || null,
        };
      }
    } catch {
      // Corrupt state file will be rebuilt
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
      chmodSync(this.storagePath, 0o600);
      this.dirty = false;
      this.lastSavedAt = now;
    } catch { /* ignore disk write errors */ }
  }

  pruneOldDays() {
    const minTimestamp = Date.now() - (MAX_DAYS_RETENTION * 86400000);
    const minDate = toShanghaiDate(minTimestamp);

    for (const date of Object.keys(this.data.days)) {
      if (date < minDate) {
        delete this.data.days[date];
        this.dirty = true;
      }
    }
  }

  processLine(line, fileRecord, dateFallback) {
    if (!line || !line.trim()) return;
    try {
      const event = JSON.parse(line);
      if (event.type === 'turn_context') {
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
              const date = event.timestamp ? toShanghaiDate(event.timestamp) : dateFallback;
              const model = fileRecord.currentModel || 'gpt-5.6-sol';
              if (!this.data.days[date]) this.data.days[date] = {};
              this.data.days[date][model] = (this.data.days[date][model] || 0) + delta;
              fileRecord.lastTotal = total;
              this.dirty = true;
            } else if (delta < 0) {
              fileRecord.lastTotal = total;
            }
          }
        }
      }
    } catch { /* ignore corrupted line */ }
  }

  scanFileIncremental(filePath) {
    let stat;
    try {
      stat = statSync(filePath);
    } catch {
      delete this.data.files[filePath];
      return;
    }

    let record = this.data.files[filePath];
    if (!record || record.inode !== stat.ino || stat.size < (record.offset || 0)) {
      record = {
        inode: stat.ino,
        offset: 0,
        lastTotal: undefined,
        currentModel: 'gpt-5.6-sol',
      };
      this.data.files[filePath] = record;
    }

    if (stat.size <= record.offset) return;

    const dateFallback = toShanghaiDate(stat.mtimeMs || Date.now());
    let fd;
    try {
      fd = openSync(filePath, 'r');
      const bytesToRead = stat.size - record.offset;
      const buf = Buffer.alloc(bytesToRead);
      const bytesRead = readSync(fd, buf, 0, bytesToRead, record.offset);
      closeSync(fd);

      const content = buf.toString('utf8', 0, bytesRead);
      const lines = content.split('\n');

      let validBytesLength = bytesRead;
      if (!content.endsWith('\n')) {
        const lastIncomplete = lines.pop();
        validBytesLength -= Buffer.byteLength(lastIncomplete, 'utf8');
      }

      for (const line of lines) {
        this.processLine(line, record, dateFallback);
      }
      record.offset += validBytesLength;
    } catch {
      if (fd !== undefined) {
        try { closeSync(fd); } catch { /* ignore */ }
      }
    }
  }

  collectSessionFiles() {
    const results = [];
    if (!existsSync(this.sessionsDir)) return results;

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
            results.push(full);
          }
        }
      } catch { /* ignore permission errors */ }
    }
    return results;
  }

  async runBackfillWorker() {
    if (this.backfillInProgress) return;
    this.backfillInProgress = true;
    this.status = 'building';

    try {
      const files = this.collectSessionFiles();
      if (!this.data.coverageStartedAt) {
        this.data.coverageStartedAt = new Date().toISOString();
      }

      const chunkSize = 5;
      for (let i = 0; i < files.length; i += chunkSize) {
        const batch = files.slice(i, i + chunkSize);
        for (const file of batch) {
          this.scanFileIncremental(file);
        }
        await new Promise(r => setImmediate(r));
      }

      this.pruneOldDays();
      this.save(true);
      this.status = 'ready';
    } catch {
      this.status = 'error';
    } finally {
      this.backfillInProgress = false;
    }
  }

  scanIncremental() {
    if (this.backfillInProgress) return;
    try {
      const files = this.collectSessionFiles();
      for (const file of files) {
        this.scanFileIncremental(file);
      }
      this.pruneOldDays();
      this.save(false);
      this.status = 'ready';
    } catch {
      this.status = 'ready';
    }
  }

  calculateRollup() {
    const todayDate = toShanghaiDate(Date.now());
    const getDates = (count) => {
      const dates = [];
      for (let i = 0; i < count; i++) {
        dates.push(toShanghaiDate(Date.now() - (i * 86400000)));
      }
      return new Set(dates);
    };

    const dates7 = getDates(7);
    const dates30 = getDates(30);

    const aggregates = {
      today: { gpt: 0, gemini: 0, other: 0 },
      days7: { gpt: 0, gemini: 0, other: 0 },
      days30: { gpt: 0, gemini: 0, other: 0 },
    };

    for (const [date, models] of Object.entries(this.data.days)) {
      const inToday = date === todayDate;
      const in7 = dates7.has(date);
      const in30 = dates30.has(date);

      if (!inToday && !in7 && !in30) continue;

      for (const [model, tokens] of Object.entries(models)) {
        const cat = classifyModel(model);
        const count = Number(tokens) || 0;
        if (inToday) {
          if (cat === 'GPT') aggregates.today.gpt += count;
          else if (cat === 'Gemini') aggregates.today.gemini += count;
          else aggregates.today.other += count;
        }
        if (in7) {
          if (cat === 'GPT') aggregates.days7.gpt += count;
          else if (cat === 'Gemini') aggregates.days7.gemini += count;
          else aggregates.days7.other += count;
        }
        if (in30) {
          if (cat === 'GPT') aggregates.days30.gpt += count;
          else if (cat === 'Gemini') aggregates.days30.gemini += count;
          else aggregates.days30.other += count;
        }
      }
    }

    const formatRange = (agg) => {
      const total = agg.gpt + agg.gemini + agg.other;
      const totalFormatted = formatTokenCount(total);
      const calcPct = (val) => total > 0 ? ((val / total) * 100).toFixed(1) + '%' : '—';

      const items = [
        { key: 'gpt', label: 'GPT', tokens: agg.gpt, formatted: formatTokenCount(agg.gpt), percent: calcPct(agg.gpt) },
        { key: 'gemini', label: 'Gemini', tokens: agg.gemini, formatted: formatTokenCount(agg.gemini), percent: calcPct(agg.gemini) },
      ];

      if (agg.other > 0) {
        items.push({
          key: 'other',
          label: 'Other',
          tokens: agg.other,
          formatted: formatTokenCount(agg.other),
          percent: calcPct(agg.other),
        });
      }

      return {
        total,
        totalFormatted,
        items,
      };
    };

    return {
      today: formatRange(aggregates.today),
      days7: formatRange(aggregates.days7),
      days30: formatRange(aggregates.days30),
    };
  }

  getSnapshot() {
    const ranges = this.calculateRollup();
    return {
      status: this.status,
      selectedRange: 'today',
      ranges,
      coverageStartedAt: this.data.coverageStartedAt,
      error: null,
    };
  }
}

export class ExtendedUsageCoordinator {
  constructor(options = {}) {
    this.geminiManager = new GeminiQuotaManager(options.gemini || {});
    this.tokenEngine = new TokenRollupEngine(options.tokens || {});
  }

  init() {
    this.tokenEngine.init();
    this.geminiManager.fetchQuota().catch(() => {});
  }

  async refreshGemini() {
    return this.geminiManager.fetchQuota();
  }

  scanTokensIncremental() {
    this.tokenEngine.scanIncremental();
  }

  getSnapshot() {
    return {
      antigravity: this.geminiManager.getSnapshot(),
      tokens: this.tokenEngine.getSnapshot(),
    };
  }
}
