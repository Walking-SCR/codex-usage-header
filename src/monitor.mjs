/**
 * 单实例用量调度器。渲染器目标只提交命令，
 * 并通过本机 CDP Runtime.evaluate 接收脱敏快照。
 */
import { openSync, closeSync, readFileSync, unlinkSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { AppServerClient } from './account-client.mjs';
import { ExtendedUsageCoordinator } from './extended-usage.mjs';
import { evaluateInTarget, fetchCdpTargets, launchAndInject, selectUsageTargets } from './launcher.mjs';

const DEFAULT_CDP_PORT = 9229;
const POLL_MS = 750;
const IDLE_REFRESH_MS = 180000;
const LOCK_PATH = join(tmpdir(), 'codex-usage-header-monitor.lock');
const SETTINGS_PATH = join(process.env.HOME || tmpdir(), 'Library/Application Support/Codex Quota Header/settings.json');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function acquireLock() {
  try {
    const fd = openSync(LOCK_PATH, 'wx');
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch {
    try { process.kill(Number(readFileSync(LOCK_PATH, 'utf8')), 0); return false; } catch {
      try { unlinkSync(LOCK_PATH); } catch { /* 忽略过期锁清理异常 */ }
      return acquireLock();
    }
  }
}

function releaseLock() { try { unlinkSync(LOCK_PATH); } catch { /* 锁已经释放时忽略异常 */ } }

function readSettings() {
  try {
    const value = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8'));
    return {
      refreshIntervalSeconds: Number(value.refreshIntervalSeconds) === 60 ? 60 : 30,
      enableGoogleAiPro: Boolean(value.enableGoogleAiPro),
      enableTokenUsage: Boolean(value.enableTokenUsage),
      enableResetCredits: Boolean(value.enableResetCredits),
    };
  } catch {
    return { refreshIntervalSeconds: 30, enableGoogleAiPro: false, enableTokenUsage: false, enableResetCredits: false };
  }
}

function persistSettings(settings) {
  mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
  writeFileSync(SETTINGS_PATH, JSON.stringify({
    schemaVersion: 1,
    refreshIntervalSeconds: settings.refreshIntervalSeconds,
    enableGoogleAiPro: Boolean(settings.enableGoogleAiPro),
    enableTokenUsage: Boolean(settings.enableTokenUsage),
    enableResetCredits: Boolean(settings.enableResetCredits),
  }, null, 2));
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
  await evaluateInTarget(target.webSocketDebuggerUrl, `window.__codexUsageHeaderSetUsage__?.(${serialized}, ${serializedMetadata})`);
}

async function pushRefreshError(target, requestId, message) {
  await evaluateInTarget(target.webSocketDebuggerUrl,
    `window.__codexUsageHeaderSetRefreshError__?.(${JSON.stringify(requestId)}, ${JSON.stringify(message)})`);
}

async function pushExtendedUsage(target, payload) {
  const serialized = JSON.stringify(payload).replace(/</g, '\\u003c');
  await evaluateInTarget(target.webSocketDebuggerUrl,
    `window.__codexUsageHeaderSetExtendedUsage__?.(${serialized})`);
}

async function run(cdpPort) {
  if (!acquireLock()) return;
  const settings = readSettings();
  let notificationPending = false;
  const client = new AppServerClient({
    onNotification: message => {
      if (message.method === 'account/rateLimits/updated') notificationPending = true;
    },
  });
  try {
    mkdirSync(dirname(SETTINGS_PATH), { recursive: true });
    await launchAndInject(cdpPort, { launchIfNeeded: true });
    const extendedCoordinator = new ExtendedUsageCoordinator();
    extendedCoordinator.init();
    let nextTokensAt = 0;
    let nextGeminiAt = 0;
    let lastExpiredAutoRefresh = 0;
    let extendedRevision = 0;
    const deliveredExtendedRevision = new Map();
    let nextRefreshAt = 0;
    let payload = null;
    let revision = 0;
    let inFlight = null;
    const deliveredRevision = new Map();
    const seenCommands = new Set();
    // 保持单个所有者运行，并由 CDP 目标列表驱动可用性判断。
    // 这里执行同步进程扫描可能阻塞事件循环，使渲染器命令得不到处理，
    // 从而导致手动刷新看起来没有响应。
    while (true) {
      let targets;
      try { targets = selectUsageTargets(await fetchCdpTargets(cdpPort)); } catch { await sleep(POLL_MS); continue; }
      if (targets.length === 0) { await sleep(POLL_MS); continue; }
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
        persistSettings(settings);
        seenCommands.add(command.id);
        nextRefreshAt = 0;
      }
      const refreshCommands = commands.filter(command => command.kind === 'refresh' && command.id && !seenCommands.has(command.id));
      for (const command of refreshCommands) seenCommands.add(command.id);
      const manualRequests = refreshCommands.filter(command => command.manual);
      const anyVisible = valid.some(item => !item.state.hidden);
      const tokensIntervalMs = anyVisible ? 30000 : 180000;
      const geminiIntervalMs = anyVisible ? 180000 : 600000;
      const refreshMs = anyVisible ? settings.refreshIntervalSeconds * 1000 : IDLE_REFRESH_MS;

      if (Date.now() >= nextTokensAt) {
        extendedCoordinator.scanTokensIncremental();
        extendedRevision += 1;
        nextTokensAt = Date.now() + tokensIntervalMs;
      }

      if (Date.now() >= nextGeminiAt) {
        nextGeminiAt = Date.now() + geminiIntervalMs;
        extendedCoordinator.refreshGemini().then(() => {
          extendedRevision += 1;
        }).catch(() => {});
      }

      const currentAnti = extendedCoordinator.getSnapshot()?.antigravity;
      const nowSec = Math.floor(Date.now() / 1000);
      const hasExpiredReset = (currentAnti?.accounts || []).some(acc =>
        (acc.rows || []).some(r => !r.unavailable && r.resetTime && r.resetTime <= nowSec)
      );
      if (hasExpiredReset && Date.now() - lastExpiredAutoRefresh > 10000) {
        lastExpiredAutoRefresh = Date.now();
        try {
          await extendedCoordinator.refreshGemini();
          extendedRevision += 1;
        } catch {}
      }

      if (refreshCommands.length > 0) {
        extendedCoordinator.scanTokensIncremental();
        try {
          await extendedCoordinator.refreshGemini();
        } catch {}
        extendedRevision += 1;
      }

      const shouldRefresh = Date.now() >= nextRefreshAt || notificationPending || refreshCommands.length > 0;
      let refreshed = false;
      let refreshError = null;
      if (shouldRefresh) {
        notificationPending = false;
        if (!inFlight) inFlight = client.readRateLimits({ excludeResetCreditDetails: !settings.enableResetCredits }).finally(() => { inFlight = null; });
        try {
          payload = await inFlight;
          revision += 1;
          refreshed = true;
          nextRefreshAt = Date.now() + refreshMs;
        } catch (error) {
          refreshError = error;
          nextRefreshAt = Date.now() + 5000;
        }
      }
      if (refreshError && manualRequests.length > 0) {
        await Promise.all(manualRequests.map(command => pushRefreshError(
          command.target,
          command.id,
          '刷新失败，请确认 Codex 已登录',
        ).catch(() => {})));
      }
      if (payload) {
        await Promise.all(valid.map(async item => {
          const key = item.target.id || item.target.webSocketDebuggerUrl;
          if (!refreshed && deliveredRevision.get(key) === revision) return;
          const manual = manualRequests.find(command => command.target === item.target);
          await pushUsage(item.target, payload, {
            requestId: manual?.id || null,
            fetchedAt: Date.now(),
            revision,
          });
          deliveredRevision.set(key, revision);
        }).map(promise => promise.catch(() => {})));
      }

      const extendedSnapshot = extendedCoordinator.getSnapshot();
      await Promise.all(valid.map(async item => {
        const key = item.target.id || item.target.webSocketDebuggerUrl;
        if (deliveredExtendedRevision.get(key) === extendedRevision) return;
        await pushExtendedUsage(item.target, extendedSnapshot);
        deliveredExtendedRevision.set(key, extendedRevision);
      }).map(promise => promise.catch(() => {})));

      await sleep(POLL_MS);
    }
  } finally {
    client.close();
    releaseLock();
  }
}

const portIndex = process.argv.indexOf('--port');
const cdpPort = Number(portIndex >= 0 ? process.argv[portIndex + 1] : DEFAULT_CDP_PORT);
run(cdpPort).catch(() => { releaseLock(); process.exitCode = 1; });
