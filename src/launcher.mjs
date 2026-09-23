/**
 * Codex Quota Header 启动器和 CDP 注入器。
 *
 * 桌面应用必须使用仅限本机回环的 Chromium 调试端口启动。
 * 启动器会在需要时启动应用、注入组件、验证 DOM 挂载，然后退出。
 */
import { spawn, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INJECTED_SCRIPT_PATH = join(__dirname, 'injected.js');
const MONITOR_PATH = join(__dirname, 'monitor.mjs');
const ASSET_DIR = join(__dirname, '..', 'assets');
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

export async function injectScriptIntoTarget(wsUrl, scriptCode) {
  await evaluateInTarget(wsUrl, scriptCode);
  const deadline = Date.now() + 4000;
  let verification;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 150));
    verification = await evaluateInTarget(wsUrl, `(() => {
      const element = document.querySelector('codex-usage-header-host');
      return {
        installed: Boolean(window.__codexUsageHeaderInstalled__),
        mounted: Boolean(element && element.isConnected),
        placement: element?.dataset?.placement || null,
        url: location.href,
        title: document.title,
      };
    })()`);
    if (verification?.mounted) return verification;
    if (verification?.installed && verification?.url === 'app://-/index.html') {
      return { ...verification, placement: 'deferred-safe-anchor' };
    }
  }
  throw new Error(`component_not_mounted: ${JSON.stringify(verification)}`);
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

export async function getStatus(port = DEFAULT_PORT) {
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
            mounted: Boolean(element && element.isConnected),
            placement: element?.dataset?.placement || null,
            title: document.title,
            url: location.href,
          };
        })()`);
        mounted.push(result);
      } catch {
        // 单个不可访问的渲染器不应隐藏正常的目标页面。
      }
    }
    return {
      appRunning: isDesktopAppRunning(),
      cdpAvailable: true,
      port,
      rendererCount: renderers.length,
      installedCount: mounted.filter(item => item?.installed).length,
      mountedCount: mounted.filter(item => item?.mounted).length,
      targets: mounted,
    };
  } catch {
    return {
      appRunning: isDesktopAppRunning(),
      cdpAvailable: false,
      port,
      rendererCount: 0,
      installedCount: 0,
      mountedCount: 0,
      targets: [],
    };
  }
}

export async function launchAndInject(port = DEFAULT_PORT, { launchIfNeeded = true } = {}) {
  const scriptCode = readFileSync(INJECTED_SCRIPT_PATH, 'utf8');
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
  const bootstrap = `window.__codexUsageHeaderIcons__ = ${JSON.stringify(icons)};`;

  const successes = [];
  const failures = [];
  for (const target of renderers) {
    try {
      const verification = await injectScriptIntoTarget(target.webSocketDebuggerUrl, `${bootstrap}\n${scriptCode}`);
      successes.push({ target: target.title || target.url, ...verification });
    } catch (error) {
      failures.push({ target: target.title || target.url, error: error.message });
    }
  }

  if (successes.length === 0) {
    throw new Error(`injection_failed: ${JSON.stringify(failures)}`);
  }
  return { port, successes, failures };
}

export function startUsageMonitor(port = DEFAULT_PORT) {
  const child = spawn(process.execPath, [MONITOR_PATH, '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  return child.pid;
}

function parseCliArgs(argv) {
  const options = { port: DEFAULT_PORT, mode: 'launch' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--status') options.mode = 'status';
    else if (arg === '--inject-only') options.mode = 'inject-only';
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
  if (options.mode === 'status') {
    const status = await getStatus(options.port);
    console.log(JSON.stringify(status, null, 2));
    process.exitCode = status.installedCount > 0 || status.mountedCount > 0 ? 0 : 2;
    return;
  }

  const result = await launchAndInject(options.port, {
    launchIfNeeded: options.mode !== 'inject-only',
  });
  const monitorPid = startUsageMonitor(options.port);
  console.log(`[Codex Quota Header] Mounted in ${result.successes.length} renderer(s).`);
  console.log(`[Codex Quota Header] Live usage monitor started (pid ${monitorPid}).`);
  for (const success of result.successes) {
    console.log(`  ✓ ${success.title || success.target} (${success.placement})`);
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
