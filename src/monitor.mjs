/**
 * Background synchronizer for app:// renderers. Chromium blocks direct
 * cross-origin requests from the desktop app, so Node reads the local bridge
 * and pushes sanitized usage payloads through the existing localhost CDP port.
 */
import { openSync, closeSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureUsageBridge } from './usage-bridge.mjs';
import { evaluateInTarget, fetchCdpTargets, isDesktopAppRunning, launchAndInject, selectUsageTargets } from './launcher.mjs';

const DEFAULT_CDP_PORT = 9229;
const BRIDGE_PORT = 9230;
const POLL_MS = 750;
const USAGE_REFRESH_MS = 30000;
const LOCK_PATH = join(tmpdir(), 'codex-usage-header-monitor.lock');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function acquireLock() {
  try {
    const fd = openSync(LOCK_PATH, 'wx');
    writeFileSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch {
    try {
      const pid = Number(readFileSync(LOCK_PATH, 'utf8'));
      process.kill(pid, 0);
      return false;
    } catch {
      try { unlinkSync(LOCK_PATH); } catch { /* stale lock is harmless */ }
      return acquireLock();
    }
  }
}

function releaseLock() {
  try { unlinkSync(LOCK_PATH); } catch { /* already released */ }
}

async function readUsage({ fresh = false } = {}) {
  const suffix = fresh ? '?fresh=1' : '';
  const response = await fetch(`http://127.0.0.1:${BRIDGE_PORT}/usage${suffix}`, { headers: { Accept: 'application/json' } });
  if (!response.ok) throw new Error(`usage_bridge_${response.status}`);
  return response.json();
}

async function inspectTarget(target) {
  return evaluateInTarget(target.webSocketDebuggerUrl, `(() => ({
    mounted: Boolean(document.querySelector('codex-usage-header-v23')),
    request: window.__codexUsageHeaderRefreshRequested__
      ? (() => { const value = window.__codexUsageHeaderRefreshRequested__; window.__codexUsageHeaderRefreshRequested__ = null; return value; })()
      : null,
  }))()`);
}

async function pushUsage(target, payload, metadata = {}) {
  const serialized = JSON.stringify(payload).replace(/</g, '\\u003c');
  const serializedMetadata = JSON.stringify(metadata).replace(/</g, '\\u003c');
  await evaluateInTarget(target.webSocketDebuggerUrl, `window.__codexUsageHeaderSetUsage__?.(${serialized}, ${serializedMetadata})`);
}

async function pushRefreshError(target, requestId, message) {
  await evaluateInTarget(
    target.webSocketDebuggerUrl,
    `window.__codexUsageHeaderSetRefreshError__?.(${JSON.stringify(requestId)}, ${JSON.stringify(message)})`,
  );
}

async function run(cdpPort) {
  if (!acquireLock()) return;
  try {
    await ensureUsageBridge(BRIDGE_PORT);
    await launchAndInject(cdpPort, { launchIfNeeded: true });
    let nextRefreshAt = 0;
    let payload = null;
    let revision = 0;
    const deliveredRevision = new Map();
    while (isDesktopAppRunning()) {
      let targets;
      try { targets = selectUsageTargets(await fetchCdpTargets(cdpPort)); } catch { await sleep(POLL_MS); continue; }
      if (targets.length === 0) { await sleep(POLL_MS); continue; }
      const inspections = await Promise.all(targets.map(async target => {
        try { return { target, state: await inspectTarget(target) }; } catch { return null; }
      }));
      const validInspections = inspections.filter(Boolean);
      const requests = validInspections.filter(item => item.state?.request);
      const manualRequests = requests.filter(item => item.state.request?.manual);
      const shouldRefresh = Date.now() >= nextRefreshAt || requests.length > 0;
      let refreshed = false;
      let refreshError = null;
      if (shouldRefresh) {
        try {
          payload = await readUsage({ fresh: manualRequests.length > 0 });
          revision += 1;
          refreshed = true;
          nextRefreshAt = Date.now() + USAGE_REFRESH_MS;
        } catch (error) {
          refreshError = error;
          nextRefreshAt = Date.now() + 5000;
        }
      }
      if (refreshError && manualRequests.length > 0) {
        await Promise.all(manualRequests.map(item => pushRefreshError(
          item.target,
          item.state.request.id,
          '刷新失败，请检查本地额度服务',
        ).catch(() => {})));
      }
      if (payload) {
        await Promise.all(validInspections.map(async item => {
          const key = item.target.id || item.target.webSocketDebuggerUrl;
          const needsDelivery = refreshed || deliveredRevision.get(key) !== revision;
          if (!needsDelivery) return;
          await pushUsage(item.target, payload, {
            requestId: item.state.request?.id || null,
            fetchedAt: Date.now(),
            revision,
          });
          deliveredRevision.set(key, revision);
        }).map(promise => promise.catch(() => {})));
      }
      await sleep(POLL_MS);
    }
  } finally {
    releaseLock();
  }
}

const portIndex = process.argv.indexOf('--port');
const cdpPort = Number(portIndex >= 0 ? process.argv[portIndex + 1] : DEFAULT_CDP_PORT);
run(cdpPort).catch(() => { releaseLock(); process.exitCode = 1; });
