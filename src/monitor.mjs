/**
 * 单实例用量调度器。渲染器目标只提交命令，
 * 并通过本机 CDP Runtime.evaluate 接收脱敏快照。
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AppServerClient } from './account-client.mjs';
import { ExtendedUsageCoordinator } from './extended-usage.mjs';
import { triggerRebalance } from './dynamic-priority-adapter.mjs';
import { readFailoverStatus, triggerToggleFailoverMode } from './failover-mode-adapter.mjs';
import { evaluateInTarget, fetchCdpTargets, launchAndInject, selectUsageTargets, subscribeToCdpBinding } from './launcher.mjs';
import { acquireMonitorLock, releaseMonitorLock, monitorCodeHash, MONITOR_LOCK_PATH } from './monitor-lock.mjs';
import { getSettingsPath, getSkillPath } from './platform-paths.mjs';

const DEFAULT_CDP_PORT = 9229;
const TARGET_DISCOVERY_RETRY_MS = 2000;
const IDLE_REFRESH_MS = 180000;
const ACTIVE_TARGET_POLL_MS = 5000;
const IDLE_TARGET_POLL_MS = 15000;
const COMMAND_BINDING_NAME = 'codexUsageHeaderCommandV1';
const MAX_NATIVE_COMMANDS = 256;
const PLUGIN_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SETTINGS_PATH = getSettingsPath();

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

// 单实例锁：已有活锁时直接退出，绝不删除活进程持有的锁；
// 过期锁（持有者已死）由 monitor-lock.mjs 安全替换。
function acquireLock() {
  const result = acquireMonitorLock({ installDir: PLUGIN_ROOT, lockPath: MONITOR_LOCK_PATH, codeHash: monitorCodeHash(PLUGIN_ROOT) });
  if (!result.acquired) {
    console.error(`[Codex Quota Header] monitor already running (pid ${result.pid}); this instance exits.`);
    return false;
  }
  return true;
}

function releaseLock() { releaseMonitorLock(MONITOR_LOCK_PATH); }

function readSettings() {
  const skillPath = getSkillPath();
  const skillInstalled = existsSync(skillPath);
  try {
    const value = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    return {
      refreshIntervalSeconds: Number(value.refreshIntervalSeconds) === 60 ? 60 : 30,
      timezone: isValidTimeZone(value.timezone) ? value.timezone : 'Asia/Shanghai',
      enableGoogleAiPro: Boolean(value.enableGoogleAiPro),
      enableTokenUsage: Boolean(value.enableTokenUsage),
      enableResetCredits: Boolean(value.enableResetCredits),
      enableDynamicPriority: skillInstalled && Boolean(value.enableDynamicPriority),
      skillInstalled,
    };
  } catch {
    return {
      refreshIntervalSeconds: 30,
      timezone: 'Asia/Shanghai',
      enableGoogleAiPro: false,
      enableTokenUsage: false,
      enableResetCredits: false,
      enableDynamicPriority: false,
      skillInstalled,
    };
  }
}

function persistSettings(settings) {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify({
    schemaVersion: 1,
    refreshIntervalSeconds: settings.refreshIntervalSeconds,
    timezone: settings.timezone || 'Asia/Shanghai',
    enableGoogleAiPro: Boolean(settings.enableGoogleAiPro),
    enableTokenUsage: Boolean(settings.enableTokenUsage),
    enableResetCredits: Boolean(settings.enableResetCredits),
    enableDynamicPriority: Boolean(settings.enableDynamicPriority),
  }, null, 2));
}

function isValidTimeZone(value) {
  if (typeof value !== 'string' || !value.trim()) return false;
  try { new Intl.DateTimeFormat('en-US', { timeZone: value }).format(); return true; }
  catch { return false; }
}

export class ExpiredResetTracker {
  constructor() {
    this.accounts = new Map();
  }

  getEntry(email) {
    let entry = this.accounts.get(email);
    if (!entry) {
      entry = { attempt: 0, nextRetryAt: 0, lastResetTime: null, lastError: null };
      this.accounts.set(email, entry);
    }
    return entry;
  }

  checkAccount(account, nowMs = Date.now()) {
    if (!account?.email) return false;
    const nowSec = Math.floor(nowMs / 1000);
    const expiredRows = (account.rows || []).filter(r => !r.unavailable && r.resetTime && r.resetTime <= nowSec);
    if (expiredRows.length === 0) {
      this.accounts.delete(account.email);
      return false;
    }

    const entry = this.getEntry(account.email);
    const earliestResetTime = Math.min(...expiredRows.map(r => r.resetTime));

    if (entry.lastResetTime !== null && entry.lastResetTime !== earliestResetTime) {
      entry.attempt = 0;
      entry.nextRetryAt = 0;
    }
    entry.lastResetTime = earliestResetTime;

    return nowMs >= entry.nextRetryAt;
  }

  recordResult(account, error, nowMs = Date.now()) {
    if (!account?.email) return;
    const entry = this.getEntry(account.email);
    const nowSec = Math.floor(nowMs / 1000);
    const stillExpired = (account.rows || []).some(r => !r.unavailable && r.resetTime && r.resetTime <= nowSec);

    if (!stillExpired && !error) {
      this.accounts.delete(account.email);
      return;
    }

    entry.attempt += 1;
    let delayMs = 8000;

    if (error?.httpStatus === 429 || error?.code === 'rate_limited' || account.health?.code === 'rate_limited') {
      entry.lastError = 'rate_limit';
      delayMs = Math.min(300000, 30000 * Math.pow(2, entry.attempt - 1));
    } else if (error?.code === 'timeout' || error?.message?.includes?.('timeout') || error?.code === 'ECONNRESET') {
      entry.lastError = 'network';
      delayMs = Math.min(120000, 10000 * Math.pow(2, entry.attempt - 1));
    } else {
      entry.lastError = 'unchanged_time';
      delayMs = Math.min(120000, 8000 * Math.pow(2, entry.attempt - 1));
    }

    entry.nextRetryAt = nowMs + delayMs;
  }
}

async function inspectTarget(target) {
  return evaluateInTarget(target.webSocketDebuggerUrl, `(() => {
    let commands = [];
    if (Array.isArray(window.__codexUsageHeaderCommands__) && window.__codexUsageHeaderCommands__.length) {
      commands = window.__codexUsageHeaderCommands__.splice(0);
    } else if (window.__codexUsageHeaderCommand__) {
      commands = [window.__codexUsageHeaderCommand__];
    }
    window.__codexUsageHeaderCommand__ = null;
    return {
      mounted: Boolean(document.querySelector('codex-usage-header-host')),
      hidden: document.hidden,
      commands,
    };
  })()`);
}

async function pushUsage(target, payload, metadata = {}) {
  const serialized = JSON.stringify(payload).replace(/</g, '\\u003c');
  const serializedMetadata = JSON.stringify(metadata).replace(/</g, '\\u003c');
  await evaluateInTarget(target.webSocketDebuggerUrl, `window.__codexUsageHeaderAppServerDiagnostics__ = ${JSON.stringify(metadata.appServer || null)}; window.__codexUsageHeaderSetUsage__?.(${serialized}, ${serializedMetadata})`);
}

function classifyUsageError(error) {
  const message = String(error?.message || '');
  const code = typeof error?.code === 'number' ? error.code : null;
  if (code === -32600 || code === -32602) return { kind: 'protocol', code };
  if (/auth|login|unauthorized|forbidden|\b401\b|\b403\b/i.test(message)) return { kind: 'auth', code };
  if (/timeout/i.test(message)) return { kind: 'timeout', code };
  if (/app_server|broken pipe|epipe|econnreset|closed|exited|not_running|spawn_failed/i.test(message)) return { kind: 'server', code };
  return { kind: 'unknown', code };
}

async function pushUsageError(target, errorInfo, metadata = {}) {
  const serialized = JSON.stringify(errorInfo).replace(/</g, '\\u003c');
  const serializedMetadata = JSON.stringify(metadata).replace(/</g, '\\u003c');
  await evaluateInTarget(target.webSocketDebuggerUrl,
    `window.__codexUsageHeaderSetUsageError__?.(${serialized}, ${serializedMetadata})`);
}

async function pushExtendedUsage(target, payload) {
  const serialized = JSON.stringify(payload).replace(/</g, '\\u003c');
  await evaluateInTarget(target.webSocketDebuggerUrl,
    `window.__codexUsageHeaderSetExtendedUsage__?.(${serialized})`);
}

async function pushCommandAck(target, ack) {
  const serialized = JSON.stringify(ack).replace(/</g, '\\u003c');
  await evaluateInTarget(target.webSocketDebuggerUrl,
    `window.__codexUsageHeaderSetCommandAck__?.(${serialized})`);
}

export function parseNativeCommand(payload, target) {
  if (typeof payload !== 'string' || Buffer.byteLength(payload, 'utf8') > 16 * 1024) return null;
  let message;
  try { message = JSON.parse(payload); } catch { return null; }
  if (message?.type === 'lifecycle') {
    return {
      kind: 'lifecycle',
      visible: message.visible === true,
      resync: message.resync === true,
      target,
    };
  }
  const command = message?.type === 'command' ? message.command : null;
  if (!command || typeof command !== 'object'
    || typeof command.id !== 'string' || command.id.length > 128
    || !['settings', 'refresh', 'rebalance', 'toggleFailoverMode'].includes(command.kind)) return null;
  return {
    id: command.id,
    kind: command.kind,
    payload: command.payload && typeof command.payload === 'object' ? command.payload : {},
    manual: command.manual === true,
    createdAt: Number(command.createdAt) || Date.now(),
    target,
  };
}

async function run(cdpPort) {
  if (!acquireLock()) return;
  const settings = readSettings();
  let notificationPending = false;
  let wakeMonitorWait = null;
  let monitorWakeRequested = false;
  const notifyMonitor = () => {
    const wake = wakeMonitorWait;
    wakeMonitorWait = null;
    if (wake) wake();
    else monitorWakeRequested = true;
  };
  const client = new AppServerClient({
    onNotification: message => {
      if (message.method === 'account/rateLimits/updated') {
        notificationPending = true;
        notifyMonitor();
      }
    },
  });
  const bindingSubscriptions = new Map();
  const visibleByTarget = new Map();
  const pendingNativeCommands = [];
  const waitForMonitor = milliseconds => {
    if (monitorWakeRequested) {
      monitorWakeRequested = false;
      return Promise.resolve();
    }
    return new Promise(resolve => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      monitorWakeRequested = false;
      clearTimeout(timer);
      if (wakeMonitorWait === finish) wakeMonitorWait = null;
      resolve();
    };
    const timer = setTimeout(finish, milliseconds);
    wakeMonitorWait = finish;
    });
  };
  try {
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
    await launchAndInject(cdpPort, { launchIfNeeded: true });
    const extendedCoordinator = new ExtendedUsageCoordinator({ settings });
    extendedCoordinator.init();
    const expiredResetTracker = new ExpiredResetTracker();
    let nextTokensAt = 0;
    let nextGeminiAt = 0;
    let extendedRevision = 0;
    const deliveredExtendedRevision = new Map();
    let lastExtendedSignature = '';
    let cachedExtendedSnapshot = null;
    let lastExtendedSnapshotAt = 0;
    let snapshotBuiltForRevision = -1;
    let tokenScanInFlight = null;
    let geminiRefreshInFlight = null;
    let nextRefreshAt = 0;
    let revision = 0;
    let inFlight = null;
    let inFlightContext = null;
    const completedUsageResults = [];
    const seenCommands = new Set();
    const enqueueNativeMessage = (target, payload) => {
      const item = parseNativeCommand(payload, target);
      if (!item) return;
      if (pendingNativeCommands.length >= MAX_NATIVE_COMMANDS) pendingNativeCommands.shift();
      pendingNativeCommands.push(item);
      notifyMonitor();
    };
    const bindTarget = async target => {
      const key = target.id || target.webSocketDebuggerUrl;
      if (bindingSubscriptions.has(key)) return;
      let connected = true;
      const unsubscribe = await subscribeToCdpBinding(
        target.webSocketDebuggerUrl,
        COMMAND_BINDING_NAME,
        params => {
          if (params?.disconnected) {
            connected = false;
            const current = bindingSubscriptions.get(key);
            bindingSubscriptions.delete(key);
            visibleByTarget.delete(key);
            current?.();
            notifyMonitor();
            return;
          }
          if (params?.name === COMMAND_BINDING_NAME) enqueueNativeMessage(target, params.payload);
        },
      );
      if (connected) bindingSubscriptions.set(key, unsubscribe);
      else unsubscribe();
    };
    // P2：命令去重缓存上限 2000，超限时淘汰最早的 500 条，防止长期运行无界增长
    const rememberCommand = id => {
      seenCommands.add(id);
      if (seenCommands.size > 2000) {
        const iterator = seenCommands.values();
        for (let i = 0; i < 500; i++) {
          const oldest = iterator.next();
          if (oldest.done) break;
          seenCommands.delete(oldest.value);
        }
      }
    };
    const beginUsageRead = (manualRequests, refreshMs, shouldRefreshAgain) => {
      if (inFlight) {
        for (const command of manualRequests) {
          inFlightContext?.manualIds.set(command.target.id || command.target.webSocketDebuggerUrl, command.id);
        }
        if (shouldRefreshAgain && inFlightContext) inFlightContext.refreshAgain = true;
        return;
      }
      const context = { manualIds: new Map(), refreshMs, refreshAgain: Boolean(shouldRefreshAgain) };
      for (const command of manualRequests) {
        context.manualIds.set(command.target.id || command.target.webSocketDebuggerUrl, command.id);
      }
      inFlightContext = context;
      nextRefreshAt = Date.now() + refreshMs;
      const request = client.readRateLimits({ excludeResetCreditDetails: !settings.enableResetCredits });
      inFlight = request;
      request.then(value => {
        if (inFlight !== request) return;
        completedUsageResults.push({ value, context, fetchedAt: Date.now() });
        inFlight = null;
        inFlightContext = null;
        nextRefreshAt = Date.now() + (context.refreshAgain ? 0 : context.refreshMs);
        notifyMonitor();
      }, error => {
        if (inFlight !== request) return;
        completedUsageResults.push({ error, context, fetchedAt: Date.now() });
        inFlight = null;
        inFlightContext = null;
        nextRefreshAt = Date.now() + (context.refreshAgain ? 0 : 5000);
        notifyMonitor();
      });
    };
    // 保持单个所有者运行，并由 CDP 目标列表驱动可用性判断。
    // 这里执行同步进程扫描可能阻塞事件循环，使渲染器命令得不到处理，
    // 从而导致手动刷新看起来没有响应。
    while (true) {
      let targets;
      try { targets = selectUsageTargets(await fetchCdpTargets(cdpPort)); } catch { await sleep(TARGET_DISCOVERY_RETRY_MS); continue; }
      if (targets.length === 0) { await sleep(TARGET_DISCOVERY_RETRY_MS); continue; }
      const activeTargetKeys = new Set(targets.map(target => target.id || target.webSocketDebuggerUrl));
      for (const [key, unsubscribe] of bindingSubscriptions) {
        if (activeTargetKeys.has(key)) continue;
        unsubscribe();
        bindingSubscriptions.delete(key);
        visibleByTarget.delete(key);
      }
      await Promise.all(targets.map(target => bindTarget(target).catch(() => {})));
      let inspections = await Promise.all(targets.map(async target => {
        try { return { target, state: await inspectTarget(target) }; } catch { return null; }
      }));
      let valid = inspections.filter(Boolean);
      if (valid.some(item => !item.state.mounted)) {
        try {
          await launchAndInject(cdpPort, { launchIfNeeded: false });
          targets = selectUsageTargets(await fetchCdpTargets(cdpPort));
          inspections = await Promise.all(targets.map(async target => {
            try { return { target, state: await inspectTarget(target) }; } catch { return null; }
          }));
          valid = inspections.filter(Boolean);
        } catch { /* 目标可能正处于路由切换过程中 */ }
      }
      const commands = valid.flatMap(item => (item.state.commands || (item.state.command ? [item.state.command] : [])).map(cmd => ({ ...cmd, target: item.target })));
      const nativeCommands = pendingNativeCommands.splice(0);
      let lifecycleResync = false;
      for (const item of nativeCommands.filter(command => command.kind === 'lifecycle')) {
        const key = item.target.id || item.target.webSocketDebuggerUrl;
        visibleByTarget.set(key, item.visible);
        if (item.resync) lifecycleResync = true;
      }
      for (const item of valid) {
        const key = item.target.id || item.target.webSocketDebuggerUrl;
        visibleByTarget.set(key, !item.state.hidden);
      }
      commands.push(...nativeCommands.filter(command => command.kind !== 'lifecycle'));
      const uniqueCommands = new Map();
      for (const command of commands) {
        if (command?.id) uniqueCommands.set(command.id, command);
      }
      commands.splice(0, commands.length, ...uniqueCommands.values());
      if (lifecycleResync) {
        nextRefreshAt = 0;
        nextTokensAt = 0;
        nextGeminiAt = 0;
      }
      for (const command of commands) {
        if (command.kind !== 'settings' || !command.id || seenCommands.has(command.id)) continue;
        const seconds = Number(command.payload?.refreshIntervalSeconds);
        if (seconds === 30 || seconds === 60) {
          settings.refreshIntervalSeconds = seconds;
        }
        if (typeof command.payload?.enableGoogleAiPro === 'boolean') {
          settings.enableGoogleAiPro = command.payload.enableGoogleAiPro;
          if (settings.enableGoogleAiPro) {
            nextGeminiAt = 0;
          }
        }
        if (typeof command.payload?.enableTokenUsage === 'boolean') {
          settings.enableTokenUsage = command.payload.enableTokenUsage;
          if (settings.enableTokenUsage) {
            nextTokensAt = 0;
          }
        }
        if (typeof command.payload?.enableResetCredits === 'boolean') {
          settings.enableResetCredits = command.payload.enableResetCredits;
          if (settings.enableResetCredits) {
            nextRefreshAt = 0;
          }
        }
        if (typeof command.payload?.enableDynamicPriority === 'boolean') {
          settings.enableDynamicPriority = settings.skillInstalled && command.payload.enableDynamicPriority;
          extendedCoordinator.updateSettings(settings);
          nextGeminiAt = 0;
        }
        persistSettings(settings);
        extendedCoordinator.updateSettings(settings);
        extendedRevision += 1;
        rememberCommand(command.id);
        nextRefreshAt = 0;
      }
      const failoverCommands = commands.filter(command => command.kind === 'toggleFailoverMode' && command.id && !seenCommands.has(command.id));
      for (const command of failoverCommands) {
        rememberCommand(command.id);
        triggerToggleFailoverMode().then(async result => {
          await pushCommandAck(command.target, {
            id: command.id,
            kind: 'toggleFailoverMode',
            success: Boolean(result?.ok ?? true),
          }).catch(() => {});
          nextGeminiAt = 0;
          nextRefreshAt = 0;
          extendedRevision += 1;
          notifyMonitor();
        }).catch(async () => {
          await pushCommandAck(command.target, {
            id: command.id,
            kind: 'toggleFailoverMode',
            success: false,
          }).catch(() => {});
          extendedRevision += 1;
          notifyMonitor();
        });
      }

      const rebalanceCommands = commands.filter(command => command.kind === 'rebalance' && command.id && !seenCommands.has(command.id));
      for (const command of rebalanceCommands) {
        rememberCommand(command.id);
        triggerRebalance().then(async result => {
          await pushCommandAck(command.target, {
            id: command.id,
            kind: 'rebalance',
            success: Boolean(result?.ok),
          }).catch(() => {});
          extendedRevision += 1;
          notifyMonitor();
        }).catch(async () => {
          await pushCommandAck(command.target, { id: command.id, kind: 'rebalance', success: false }).catch(() => {});
          extendedRevision += 1;
          notifyMonitor();
        });
        nextGeminiAt = 0;
      }
      const refreshCommands = commands.filter(command => command.kind === 'refresh' && command.id && !seenCommands.has(command.id));
      for (const command of refreshCommands) rememberCommand(command.id);
      const manualRequests = refreshCommands.filter(command => command.manual);
      const anyVisible = valid.some(item => visibleByTarget.get(item.target.id || item.target.webSocketDebuggerUrl) !== false);
      const tokensIntervalMs = anyVisible ? 30000 : 180000;
      const geminiIntervalMs = anyVisible ? 180000 : 600000;
      const refreshMs = anyVisible ? settings.refreshIntervalSeconds * 1000 : IDLE_REFRESH_MS;

      if (settings.enableTokenUsage && Date.now() >= nextTokensAt && !tokenScanInFlight) {
        nextTokensAt = Date.now() + tokensIntervalMs;
        tokenScanInFlight = extendedCoordinator.scanTokensIncremental()
          .then(changed => { if (changed) extendedRevision += 1; })
          .catch(() => {})
          .finally(() => {
            tokenScanInFlight = null;
            notifyMonitor();
          });
      }

      const geminiEnabled = Boolean(settings.enableGoogleAiPro || settings.enableDynamicPriority);
      if (geminiEnabled && Date.now() >= nextGeminiAt && !geminiRefreshInFlight) {
        nextGeminiAt = Date.now() + geminiIntervalMs;
        geminiRefreshInFlight = extendedCoordinator.refreshGemini().then(() => {
          extendedRevision += 1;
        }).catch(() => {}).finally(() => {
          geminiRefreshInFlight = null;
          notifyMonitor();
        });
      }

      if (geminiEnabled && !geminiRefreshInFlight) {
        const currentAnti = extendedCoordinator.getSnapshot()?.antigravity;
        const expiredAccount = (currentAnti?.accounts || []).find(acc =>
          expiredResetTracker.checkAccount(acc)
        );
        if (expiredAccount) {
          geminiRefreshInFlight = extendedCoordinator.refreshGemini(expiredAccount.email)
            .then(() => {
              const updatedAnti = extendedCoordinator.getSnapshot()?.antigravity;
              const updatedAcc = (updatedAnti?.accounts || []).find(a => a.email === expiredAccount.email) || expiredAccount;
              expiredResetTracker.recordResult(updatedAcc, null);
              extendedRevision += 1;
            })
            .catch((err) => {
              expiredResetTracker.recordResult(expiredAccount, err);
            })
            .finally(() => {
              geminiRefreshInFlight = null;
              notifyMonitor();
            });
        }
      }

      if (refreshCommands.length > 0) {
        if (settings.enableTokenUsage && !tokenScanInFlight) {
          tokenScanInFlight = extendedCoordinator.scanTokensIncremental()
            .then(changed => { if (changed) extendedRevision += 1; })
            .catch(() => {})
            .finally(() => {
              tokenScanInFlight = null;
              notifyMonitor();
            });
        }
        if (geminiEnabled && !geminiRefreshInFlight) {
          geminiRefreshInFlight = extendedCoordinator.refreshGemini()
            .then(() => { extendedRevision += 1; })
            .catch(() => {})
            .finally(() => {
              geminiRefreshInFlight = null;
              notifyMonitor();
            });
        }
      }

      const shouldRefresh = Date.now() >= nextRefreshAt || notificationPending || refreshCommands.length > 0 || lifecycleResync;
      const refreshAgain = notificationPending || lifecycleResync;
      if (shouldRefresh) {
        notificationPending = false;
        beginUsageRead(manualRequests, refreshMs, refreshAgain);
      }
      for (const result of completedUsageResults.splice(0)) {
        revision += result.error ? 0 : 1;
        const serializedDiagnostics = JSON.stringify(client.getDiagnostics()).replace(/</g, '\\u003c');
        await Promise.all(valid.map(async item => {
          const key = item.target.id || item.target.webSocketDebuggerUrl;
          const requestId = result.context.manualIds.get(key) || null;
          if (result.error) {
            const errorInfo = classifyUsageError(result.error);
            await evaluateInTarget(item.target.webSocketDebuggerUrl, `window.__codexUsageHeaderAppServerDiagnostics__ = ${serializedDiagnostics}`);
            await pushUsageError(item.target, errorInfo, { requestId, fetchedAt: result.fetchedAt });
            return;
          }
          await pushUsage(item.target, result.value, {
            requestId,
            fetchedAt: result.fetchedAt,
            revision,
            appServer: client.getDiagnostics(),
          });
        }).map(promise => promise.catch(() => {})));
      }

      if (!cachedExtendedSnapshot
        || snapshotBuiltForRevision !== extendedRevision
        || Date.now() - lastExtendedSnapshotAt >= 1500) {
        const nextSnapshot = extendedCoordinator.getSnapshot();
        nextSnapshot.failover = readFailoverStatus();
        nextSnapshot.inFlight = {
          tokens: Boolean(tokenScanInFlight),
          gemini: Boolean(geminiRefreshInFlight),
        };
        const extendedSignature = JSON.stringify({
          failover: [nextSnapshot.failover?.mode, nextSnapshot.failover?.lifecycle_state, nextSnapshot.failover?.external_model],
          pool: nextSnapshot.antigravity.poolStatus?.primaryAccount || null,
          accounts: (nextSnapshot.antigravity.accounts || []).map(account => [
            account.id,
            account.status,
            account.health?.code || 'ok',
            (account.rows || []).map(row => [row.label, row.remainingPercent, row.resetTime, row.unavailable]),
          ]),
          tokens: [nextSnapshot.tokens.status, ...['today', 'days7', 'days30', 'allTime'].map(range => {
            const value = nextSnapshot.tokens.ranges?.[range];
            return [range, value?.total, (value?.items || []).map(item => [item.key, item.tokens, (item.models || []).map(model => [model.id, model.tokens])])];
          })],
        });
        if (extendedSignature !== lastExtendedSignature) {
          lastExtendedSignature = extendedSignature;
          extendedRevision += 1;
        }
        cachedExtendedSnapshot = nextSnapshot;
        lastExtendedSnapshotAt = Date.now();
        snapshotBuiltForRevision = extendedRevision;
      }
      const extendedSnapshot = cachedExtendedSnapshot;
      await Promise.all(valid.map(async item => {
        const key = item.target.id || item.target.webSocketDebuggerUrl;
        if (deliveredExtendedRevision.get(key) === extendedRevision) return;
        await pushExtendedUsage(item.target, extendedSnapshot);
        deliveredExtendedRevision.set(key, extendedRevision);
      }).map(promise => promise.catch(() => {})));

      await waitForMonitor(anyVisible ? ACTIVE_TARGET_POLL_MS : IDLE_TARGET_POLL_MS);
    }
  } finally {
    notifyMonitor();
    for (const unsubscribe of bindingSubscriptions.values()) unsubscribe();
    bindingSubscriptions.clear();
    client.close();
    releaseLock();
  }
}

const portIndex = process.argv.indexOf('--port');
const cdpPort = Number(portIndex >= 0 ? process.argv[portIndex + 1] : DEFAULT_CDP_PORT);
// 仅作为脚本直接运行时启动；被 import 时无副作用（便于测试/复用）。
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  run(cdpPort).catch(() => { releaseLock(); process.exitCode = 1; });
}
