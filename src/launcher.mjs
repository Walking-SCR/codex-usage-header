/**
 * Codex Quota Header 启动器和 CDP 注入器。
 *
 * 桌面应用必须使用仅限本机回环的 Chromium 调试端口启动。
 * 启动器会在需要时启动应用、注入组件、验证 DOM 挂载，然后退出。
 *
 * 安全提示：CDP 调试端口（默认 9229）仅绑定 127.0.0.1，但本机任意进程
 * 连接后都可操控渲染目标。这是 CDP 机制本身的特性，详见 SECURITY.md。
 */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { getMonitorStatus, isMonitorProcess, isPidAlive, monitorCodeHash } from './monitor-lock.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INJECTED_SCRIPT_PATH = join(__dirname, 'injected.js');
const MONITOR_PATH = join(__dirname, 'monitor.mjs');
const ASSET_DIR = join(__dirname, '..', 'assets');
const DESIGN_DIR = join(ASSET_DIR, 'ui-quota');
const DESIGN_ICONS = {
  logo: 'icons/common/app-logo.svg',
  settings: 'icons/header/settings.svg',
  export: 'icons/header/export.svg',
  stats: 'icons/header/stats.svg',
  refresh: 'icons/header/refresh.svg',
  clock: 'icons/quota/clock.svg',
  calendar: 'icons/quota/calendar.svg',
  coupon: 'icons/coupon/coupon.svg',
  lightning: 'icons/coupon/lightning.svg',
  info: 'icons/coupon/info.svg',
  sparkle: 'icons/google-ai-pro/sparkle.svg',
  eye: 'icons/common/eye.svg',
  chevronDown: 'icons/common/chevron-down.svg',
  tokenChart: 'icons/token/token-chart.svg',
  couponWave: 'backgrounds/coupon-wave.svg',
};
const DEFAULT_PORT = 9229;
const READY_TIMEOUT_MS = 12000;

function readIconDataUrl(name) {
  const data = readFileSync(join(ASSET_DIR, `${name}.svg`));
  return `data:image/svg+xml;base64,${data.toString('base64')}`;
}

function readImageDataUrl(name, extension, mimeType) {
  const data = readFileSync(join(ASSET_DIR, `${name}.${extension}`));
  return `data:${mimeType};base64,${data.toString('base64')}`;
}

export function locateExecutable() {
  if (process.platform === 'darwin') {
    const candidates = [
      '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
      `${process.env.HOME}/Applications/ChatGPT.app/Contents/MacOS/ChatGPT`,
    ];
    return candidates.find(existsSync) ?? candidates[0];
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const candidates = [
      join(localAppData, 'Programs', 'ChatGPT', 'ChatGPT.exe'),
      join(programFiles, 'ChatGPT', 'ChatGPT.exe'),
    ];
    return candidates.find(existsSync) ?? candidates[0];
  }

  return null;
}

export function getDesktopAppProcessInfo(port = DEFAULT_PORT) {
  if (process.platform !== 'darwin') return { running: false, hasCdpFlag: false };
  const candidates = [
    '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
    `${process.env.HOME}/Applications/ChatGPT.app/Contents/MacOS/ChatGPT`,
  ];
  try {
    const processes = execFileSync('/bin/ps', ['-ax', '-o', 'command='], { encoding: 'utf8' });
    const lines = processes.split('\n');
    let running = false;
    let hasCdpFlag = false;
    for (const rawLine of lines) {
      const command = rawLine.trim();
      const isCandidate = candidates.some(candidate => command === candidate || command.startsWith(`${candidate} `));
      if (isCandidate) {
        running = true;
        if (command.includes(`--remote-debugging-port=${port}`) || command.includes('--remote-debugging-port=')) {
          hasCdpFlag = true;
        }
      }
    }
    return { running, hasCdpFlag };
  } catch {
    return { running: false, hasCdpFlag: false };
  }
}

export function isDesktopAppRunning() {
  return getDesktopAppProcessInfo().running;
}

export function fetchCdpTargets(port = DEFAULT_PORT) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json/list`, { timeout: 2000 }, res => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) {
          reject(new Error(`cdp_http_${res.statusCode}`));
          return;
        }
        try {
          const targets = JSON.parse(data);
          resolve(Array.isArray(targets) ? targets : []);
        } catch (error) {
          reject(new Error(`cdp_invalid_json: ${error.message}`));
        }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('cdp_timeout'));
    });
  });
}

function isRendererTarget(target) {
  if (!target?.webSocketDebuggerUrl) return false;
  if (!['page', 'webview'].includes(target.type)) return false;
  const haystack = `${target.title || ''} ${target.url || ''}`.toLowerCase();
  return haystack.includes('codex')
    || haystack.includes('chatgpt')
    || haystack.includes('index.html')
    || haystack.includes('app://');
}

export function selectRendererTargets(targets) {
  const renderers = targets.filter(isRendererTarget);
  if (renderers.length > 0) return renderers;
  return targets.filter(target => target?.webSocketDebuggerUrl && ['page', 'webview'].includes(target.type));
}

export function selectUsageTargets(targets) {
  return selectRendererTargets(targets).filter(target => (target.url || '').toLowerCase() === 'app://-/index.html');
}

const cdpSocketPool = new Map();

export function closeAllCdpSockets() {
  for (const [wsUrl, entry] of cdpSocketPool.entries()) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    try { entry.ws.close(); } catch {}
    cdpSocketPool.delete(wsUrl);
  }
}

function resetIdleTimer(entry, wsUrl) {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  entry.idleTimer = setTimeout(() => {
    if (entry.pending.size === 0) {
      try { entry.ws.close(); } catch {}
      cdpSocketPool.delete(wsUrl);
    }
  }, 1200);
}

function getOrCreateCdpSocket(wsUrl) {
  let entry = cdpSocketPool.get(wsUrl);
  if (entry && (entry.ws.readyState === WebSocket.OPEN || entry.ws.readyState === WebSocket.CONNECTING)) {
    resetIdleTimer(entry, wsUrl);
    return entry;
  }
  if (entry) {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    try { entry.ws.close(); } catch {}
    cdpSocketPool.delete(wsUrl);
  }

  const ws = new WebSocket(wsUrl);
  entry = {
    ws,
    nextId: 1,
    pending: new Map(),
    readyPromise: null,
    idleTimer: null,
  };

  entry.readyPromise = new Promise((resolve, reject) => {
    ws.onopen = () => resolve(entry);
    ws.onerror = err => reject(err);
  });

  ws.onmessage = event => {
    try {
      const message = JSON.parse(event.data);
      if (message.id === undefined) return;
      const waiter = entry.pending.get(message.id);
      if (!waiter) return;
      entry.pending.delete(message.id);
      resetIdleTimer(entry, wsUrl);
      if (message.error) {
        waiter.reject(new Error(`cdp_eval_failed: ${JSON.stringify(message.error)}`));
        return;
      }
      if (message.result?.exceptionDetails) {
        const description = message.result.exceptionDetails.exception?.description
          || message.result.exceptionDetails.text
          || 'renderer_exception';
        waiter.reject(new Error(`renderer_eval_failed: ${description}`));
        return;
      }
      waiter.resolve(message.result?.result?.value);
    } catch (err) {}
  };

  ws.onclose = () => {
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    cdpSocketPool.delete(wsUrl);
    for (const waiter of entry.pending.values()) {
      waiter.reject(new Error('cdp_websocket_closed'));
    }
    entry.pending.clear();
  };

  cdpSocketPool.set(wsUrl, entry);
  resetIdleTimer(entry, wsUrl);
  return entry;
}

export async function evaluateInTarget(wsUrl, expression, timeoutMs = 6000) {
  const entry = getOrCreateCdpSocket(wsUrl);
  if (entry.ws.readyState !== WebSocket.OPEN) {
    await entry.readyPromise;
  }

  return new Promise((resolve, reject) => {
    const id = entry.nextId++;
    const timer = setTimeout(() => {
      entry.pending.delete(id);
      reject(new Error('cdp_evaluation_timeout'));
    }, timeoutMs);

    entry.pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });

    try {
      entry.ws.send(JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: {
          expression,
          awaitPromise: true,
          returnByValue: true,
        },
      }));
    } catch (err) {
      clearTimeout(timer);
      entry.pending.delete(id);
      reject(err);
    }
  });
}

// 挂载状态探针：区分「已注入/等待顶栏/已挂载/挂载失败」四态。
// mountable 为顶栏中可用的锚点 placement（字符串）或 null（顶栏尚未出现）。
const MOUNT_PROBE_SNIPPET = `(() => {
  const debug = window.__codexUsageHeaderDebug__;
  const element = document.querySelector('codex-usage-header-host');
  let mountable = null;
  try { mountable = debug?.getMountPoint?.()?.placement || null; } catch { mountable = null; }
  return {
    installed: Boolean(window.__codexUsageHeaderInstalled__),
    version: window.__codexUsageHeaderInstalled__ || null,
    contentHash: window.__codexUsageHeaderContentHash__ || null,
    mounted: Boolean(element && element.isConnected),
    placement: element?.dataset?.placement || null,
    mountable,
    url: location.href,
    title: document.title,
  };
})()`;

export async function probeMountState(wsUrl) {
  return evaluateInTarget(wsUrl, MOUNT_PROBE_SNIPPET);
}

// 挂载状态分类（纯函数）：installed+mounted=已挂载；installed+无锚点=等待顶栏；
// installed+有锚点却未挂载=挂载失败；无 installed=注入失败。
export function classifyMountProbe(probe) {
  if (!probe?.installed) return 'not-installed';
  if (probe.mounted) return 'mounted';
  return probe.mountable ? 'failed' : 'waiting';
}

// 注入后按四态返回，绝不把「未挂载」包装成成功：
//   mounted —— 组件已挂载；waiting —— 已注入、顶栏尚未出现（页面观察器会继续尝试）；
//   failed  —— 已注入、顶栏存在锚点却挂载不上（明确错误）。
// 只有安装标记都没立起来时才抛错（注入本身失败）。
export async function injectScriptIntoTarget(wsUrl, scriptCode) {
  await evaluateInTarget(wsUrl, scriptCode);
  const deadline = Date.now() + 4000;
  let probe;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 150));
    probe = await probeMountState(wsUrl);
    if (probe?.mounted) return { ...probe, status: 'mounted' };
    if (!probe?.installed) break;
  }
  probe = probe ?? await probeMountState(wsUrl).catch(() => null);
  const status = classifyMountProbe(probe);
  if (status === 'not-installed') {
    throw new Error(`component_not_installed: ${JSON.stringify(probe)}`);
  }
  if (status === 'failed') {
    return { ...probe, status, error: 'mount_point_available_but_not_mounted' };
  }
  return { ...probe, status };
}

async function waitForTargets(port, timeoutMs = READY_TIMEOUT_MS) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    try {
      const targets = await fetchCdpTargets(port);
      if (targets.length > 0) return targets;
    } catch (error) {
      lastError = error;
    }
    await new Promise(resolve => setTimeout(resolve, 300));
  }
  throw new Error(`cdp_not_ready: ${lastError?.message || 'no_targets'}`);
}

function launchDesktopApp(executable, port) {
  if (!executable || !existsSync(executable)) {
    throw new Error(`desktop_executable_not_found: ${executable || 'unsupported_platform'}`);
  }
  const child = spawn(executable, [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
  ], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
}

// 解析注入脚本的运行时版本（RUNTIME_VERSION 常量）
export function readScriptVersion() {
  const source = readFileSync(INJECTED_SCRIPT_PATH, 'utf8');
  const match = source.match(/const RUNTIME_VERSION = '([^']+)'/);
  return match ? match[1] : null;
}

export async function getStatus(port = DEFAULT_PORT) {
  const installDir = join(__dirname, '..');
  let scriptVersion = null;
  let scriptContentHash = null;
  try {
    scriptVersion = readScriptVersion();
    scriptContentHash = buildInjectableScript().contentHash;
  } catch { /* 忽略版本读取异常 */ }
  const monitor = getMonitorStatus();
  const runtimeSource = { installDir, scriptVersion, scriptContentHash, monitor };
  try {
    const targets = await fetchCdpTargets(port);
    const renderers = selectUsageTargets(targets);
    const mounted = [];
    for (const target of renderers) {
      try {
        const result = await evaluateInTarget(target.webSocketDebuggerUrl, `(() => {
          const element = document.querySelector('codex-usage-header-host');
          return {
            installed: Boolean(window.__codexUsageHeaderInstalled__),
            sourceDir: window.__codexUsageHeaderSource__ || null,
            contentHash: window.__codexUsageHeaderContentHash__ || null,
            mounted: Boolean(element && element.isConnected),
            placement: element?.dataset?.placement || null,
            title: document.title,
            url: location.href,
          };
        })()`);
        if (result && result.installed && !result.mounted) {
          // 已注入但未挂载：顶栏尚未出现算 waiting，顶栏存在却挂不上算 failed
          try {
            const point = await evaluateInTarget(target.webSocketDebuggerUrl,
              '(() => { try { return window.__codexUsageHeaderDebug__?.getMountPoint?.()?.placement || null; } catch { return null; } })()');
            result.status = point ? 'failed' : 'waiting';
          } catch {
            result.status = 'unknown';
          }
        } else {
          result.status = result?.mounted ? 'mounted' : (result?.installed ? 'waiting' : 'absent');
        }
        mounted.push(result);
      } catch {
        // 单个不可访问的渲染器不应隐藏正常的目标页面。
      }
    }
    return {
      ...runtimeSource,
      appRunning: isDesktopAppRunning(),
      cdpAvailable: true,
      port,
      rendererCount: renderers.length,
      installedCount: mounted.filter(item => item?.installed).length,
      mountedCount: mounted.filter(item => item?.mounted).length,
      waitingCount: mounted.filter(item => item?.status === 'waiting').length,
      failedCount: mounted.filter(item => item?.status === 'failed').length,
      targets: mounted,
    };
  } catch {
    return {
      ...runtimeSource,
      appRunning: isDesktopAppRunning(),
      cdpAvailable: false,
      port,
      rendererCount: 0,
      installedCount: 0,
      mountedCount: 0,
      waitingCount: 0,
      failedCount: 0,
      targets: [],
    };
  }
}

export function statusExitCode(status) {
  if (status.failedCount > 0) return 2;
  return status.mountedCount > 0 || status.waitingCount > 0 ? 0 : 2;
}

// 计算注入脚本的内容哈希并填入占位符：任何代码改动都会改变哈希，
// 渲染器内的版本守卫据此判断是否需要 teardown + 重装（无需手动升版本）。
export function buildInjectableScript() {
  const scriptSource = readFileSync(INJECTED_SCRIPT_PATH, 'utf8');
  const hash = createHash('sha256').update(scriptSource);
  hash.update(readFileSync(join(DESIGN_DIR, 'design.css')));
  for (const path of Object.values(DESIGN_ICONS)) hash.update(readFileSync(join(DESIGN_DIR, path)));
  const contentHash = hash.digest('hex');
  const scriptCode = scriptSource.includes('__INJECTED_CONTENT_HASH__')
    ? scriptSource.replace('__INJECTED_CONTENT_HASH__', contentHash)
    : scriptSource;
  return { scriptCode, contentHash };
}

export async function launchAndInject(port = DEFAULT_PORT, { launchIfNeeded = true } = {}) {
  const { scriptCode, contentHash } = buildInjectableScript();
  let targets;

  try {
    targets = await fetchCdpTargets(port);
  } catch {
    const procInfo = getDesktopAppProcessInfo(port);
    if (procInfo.running) {
      if (procInfo.hasCdpFlag) {
        // 应用已开启 CDP 调试参数正在运行或冷启动中，等待其调试端口就绪，绝不误判
        try {
          targets = await waitForTargets(port, READY_TIMEOUT_MS);
        } catch {
          throw new Error('cdp_port_unreachable');
        }
      } else {
        // 确实存在未带调试端口启动的旧进程
        throw new Error('app_running_without_cdp');
      }
    } else {
      if (!launchIfNeeded) throw new Error('cdp_unavailable');
      const executable = locateExecutable();
      console.log(`[Codex Quota Header] Launching desktop app on localhost CDP port ${port}...`);
      launchDesktopApp(executable, port);
      targets = await waitForTargets(port);
    }
  }

  const renderers = selectUsageTargets(targets);
  if (renderers.length === 0) throw new Error('no_renderer_targets');

  const icons = {
    refresh: readIconDataUrl('refresh'),
    database: readIconDataUrl('database'),
    clock: readIconDataUrl('clock'),
    resetCredit: readImageDataUrl('reset-credit', 'png', 'image/png'),
  };
  const designIcons = Object.fromEntries(Object.entries(DESIGN_ICONS).map(([key, path]) => {
    const data = readFileSync(join(DESIGN_DIR, path));
    return [key, `data:image/svg+xml;base64,${data.toString('base64')}`];
  }));
  const designCss = readFileSync(join(DESIGN_DIR, 'design.css'), 'utf8');
  const bootstrap = `window.__codexUsageHeaderIcons__ = ${JSON.stringify(icons)}; window.__codexUsageHeaderDesignIcons__ = ${JSON.stringify(designIcons)}; window.__codexUsageHeaderDesignCSS__ = ${JSON.stringify(designCss)}; window.__codexUsageHeaderSource__ = ${JSON.stringify(join(__dirname, '..'))};`;

  const results = [];
  for (const target of renderers) {
    try {
      const verification = await injectScriptIntoTarget(target.webSocketDebuggerUrl, `${bootstrap}\n${scriptCode}`);
      results.push({ target: target.title || target.url, ...verification });
    } catch (error) {
      results.push({ target: target.title || target.url, status: 'failed', error: error.message });
    }
  }
  const mountedCount = results.filter(item => item.status === 'mounted').length;
  const waitingCount = results.filter(item => item.status === 'waiting').length;
  const failedCount = results.filter(item => item.status === 'failed').length;

  // 允许「已注入、等待顶栏」的中间态，但绝不把 mountedCount=0 宣称为成功。
  if (mountedCount === 0 && waitingCount === 0) {
    throw new Error(`injection_failed: ${JSON.stringify(results.filter(item => item.status === 'failed'))}`);
  }
  return { port, results, mountedCount, waitingCount, failedCount, contentHash };
}

// 启动用量监控：区分「新监控已启动」与「现有监控继续运行」，消除虚假成功日志。
// 若现有监控来自另一个安装目录，则受控交接：先停止旧进程，再启动新进程。
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

export async function stopUsageMonitor(pluginRoot = join(__dirname, '..')) {
  const existing = getMonitorStatus();
  if (!existing.running) return { stopped: false, reason: 'not-running' };
  if (!isMonitorProcess(existing.pid, pluginRoot)) {
    return { stopped: false, reason: 'monitor-identity-mismatch', pid: existing.pid };
  }
  try { process.kill(existing.pid, 'SIGTERM'); }
  catch (error) {
    if (error?.code === 'ESRCH') return { stopped: true, pid: existing.pid };
    throw error;
  }
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (!isPidAlive(existing.pid)) return { stopped: true, pid: existing.pid };
    await sleep(50);
  }
  return { stopped: false, reason: 'monitor-did-not-exit', pid: existing.pid };
}

export async function startUsageMonitor(port = DEFAULT_PORT) {
  const pluginRoot = join(__dirname, '..');
  const codeHash = monitorCodeHash(pluginRoot);
  const existing = getMonitorStatus();
  if (existing.running) {
    const sameSource = existing.installDir === pluginRoot;
    if (sameSource && existing.codeHash === codeHash && isMonitorProcess(existing.pid, pluginRoot)) {
      return { started: false, pid: existing.pid, reason: 'already-running' };
    }
    const source = existing.installDir || (isMonitorProcess(existing.pid, pluginRoot) ? pluginRoot : null);
    if (!source) throw new Error(`monitor_source_unknown: ${existing.pid}`);
    console.log(`[Codex Quota Header] Handing over monitor ${existing.pid} from ${source} to ${pluginRoot}.`);
    const stopped = await stopUsageMonitor(source);
    if (!stopped.stopped) throw new Error(`monitor_handoff_failed: ${stopped.reason}`);
  }
  const child = spawn(process.execPath, [MONITOR_PATH, '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  for (let attempt = 0; attempt < 80; attempt += 1) {
    const status = getMonitorStatus();
    if (status.running && status.pid === child.pid && status.installDir === pluginRoot && status.codeHash === codeHash) {
      return { started: true, pid: child.pid, reason: 'started' };
    }
    if (status.running && status.pid !== child.pid && isMonitorProcess(status.pid, status.installDir)) {
      return { started: false, pid: status.pid, reason: 'already-running' };
    }
    if (!isPidAlive(child.pid)) break;
    await sleep(50);
  }
  throw new Error(`monitor_start_failed: ${child.pid || 'no-pid'}`);
}

function parseCliArgs(argv) {
  const options = { port: DEFAULT_PORT, mode: 'launch' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--status') options.mode = 'status';
    else if (arg === '--inject-only') options.mode = 'inject-only';
    else if (arg === '--teardown') options.mode = 'teardown';
    else if (arg === '--help' || arg === '-h') options.mode = 'help';
    else if (arg === '--port') {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1024 || value > 65535) {
        throw new Error('invalid_port');
      }
      options.port = value;
      index += 1;
    } else {
      throw new Error(`unknown_argument: ${arg}`);
    }
  }
  return options;
}

function printHelp() {
  console.log(`Usage: codex-header [options]

Options:
  --status          Report desktop/CDP/component status without changing state
  --inject-only     Inject only when the desktop app already exposes CDP
  --teardown        Remove the component from running renderers (used by uninstall)
  --port <number>   CDP port (default: ${DEFAULT_PORT})
  -h, --help        Show this help

For first launch, quit ChatGPT/Codex completely and run: codex-header`);
}

async function main() {
  const options = parseCliArgs(process.argv.slice(2));
  if (options.mode === 'help') {
    printHelp();
    return;
  }
  if (options.mode === 'teardown') {
    const pluginRoot = join(__dirname, '..');
    const monitor = getMonitorStatus();
    const monitorOwned = monitor.running && isMonitorProcess(monitor.pid, pluginRoot);
    if (monitor.running && monitor.installDir && monitor.installDir !== pluginRoot) {
      throw new Error(`teardown_refused_other_install: ${monitor.installDir}`);
    }
    if (monitor.running && !monitorOwned) throw new Error(`teardown_refused_unknown_monitor: ${monitor.pid}`);
    if (monitorOwned) {
      const stopped = await stopUsageMonitor(pluginRoot);
      if (!stopped.stopped) throw new Error(`teardown_monitor_failed: ${stopped.reason}`);
    }
    const targets = selectUsageTargets(await fetchCdpTargets(options.port).catch(() => []));
    let removed = 0;
    for (const target of targets) {
      try {
        const result = await evaluateInTarget(target.webSocketDebuggerUrl,
          `(() => { const source = window.__codexUsageHeaderSource__; if (source && source !== ${JSON.stringify(pluginRoot)}) return false; if (!source && ${!monitorOwned}) return false; window.__codexUsageHeaderTeardown__?.(); window.__codexUsageHeaderSource__ = null; return true; })()`);
        if (result) removed += 1;
      } catch { /* 单个目标失败不影响其他 */ }
    }
    console.log(`[Codex Quota Header] teardown complete: ${removed} renderer(s), monitor ${monitorOwned ? `stopped (pid ${monitor.pid})` : 'not running'}.`);
    return;
  }
  if (options.mode === 'status') {
    const status = await getStatus(options.port);
    console.log(JSON.stringify(status, null, 2));
    process.exitCode = statusExitCode(status);
    return;
  }

  const result = await launchAndInject(options.port, {
    launchIfNeeded: options.mode !== 'inject-only',
  });
  const monitor = await startUsageMonitor(options.port);
  if (monitor.started) {
    console.log(`[Codex Quota Header] Live usage monitor started (pid ${monitor.pid}).`);
  } else {
    console.log(`[Codex Quota Header] Monitor already running (pid ${monitor.pid}); keeping the existing instance.`);
  }
  const parts = [`已挂载 ${result.mountedCount}`];
  if (result.waitingCount > 0) parts.push(`等待顶栏 ${result.waitingCount}`);
  if (result.failedCount > 0) parts.push(`失败 ${result.failedCount}`);
  console.log(`[Codex Quota Header] 注入完成：${parts.join('，')}。`);
  for (const item of result.results) {
    const mark = item.status === 'mounted' ? '✓' : item.status === 'waiting' ? '…' : '✗';
    const extra = item.status === 'waiting'
      ? '（顶栏尚未出现，页面观察器会继续尝试挂载）'
      : item.status === 'failed'
        ? `（${item.error || '挂载失败'}）`
        : '';
    console.log(`  ${mark} [${item.status}] ${item.title || item.target}${item.placement ? ` (${item.placement})` : ''}${extra}`);
  }
  if (result.failedCount > 0) process.exitCode = 2;
  else if (result.mountedCount === 0 && result.waitingCount > 0) {
    console.log('[Codex Quota Header] 顶栏尚未出现，已进入等待挂载状态；打开任意对话页后组件会自动出现。');
    process.exitCode = 3;
  }
}

const entryPath = process.argv[1];
const isDirectRun = Boolean(entryPath && existsSync(entryPath)
  && realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url)));

if (isDirectRun) {
  main().catch(error => {
    if (error.message === 'app_running_without_cdp') {
      console.error('[Codex Quota Header] ChatGPT/Codex is running without the injection channel.');
      console.error('The window may be closed already, but the main ChatGPT process is still alive in the background.');
      console.error('Quit it with Command+Q and wait until the main process disappears from Activity Monitor, then run codex-header again.');
      process.exitCode = 10;
    } else {
      console.error(`[Codex Quota Header] ${error.message}`);
      process.exitCode = 1;
    }
  });
}
