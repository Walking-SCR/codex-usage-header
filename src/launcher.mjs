/**
 * Codex Quota Header 启动器和 CDP 注入器。
 *
 * 桌面应用必须使用仅限本机回环的 Chromium 调试端口启动。
 * 启动器会在需要时启动应用、注入组件、验证 DOM 挂载，然后退出。
 *
 * 安全提示：CDP 调试端口（默认 9229）仅绑定 127.0.0.1，但本机任意进程
 * 连接后都可操控渲染目标。这是 CDP 机制本身的特性，详见 SECURITY.md。
 */
import { spawn, execFile, execFileSync } from 'node:child_process';
import { readFileSync, existsSync, realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { createHash } from 'node:crypto';
import { getMonitorStatus, isMonitorProcess, isPidAlive, monitorCodeHash } from './monitor-lock.mjs';
import { getAccountHealth } from './account-health.mjs';
import { desktopExecutableCandidates } from './desktop-runtime.mjs';
import { getDataDir } from './platform-paths.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const INJECTED_SCRIPT_PATH = join(__dirname, 'injected.js');
const MONITOR_PATH = join(__dirname, 'monitor.mjs');
const ASSET_DIR = join(__dirname, '..', 'assets');
const DESIGN_DIR = join(ASSET_DIR, 'ui-quota');
const DESIGN_ICONS = {
  logo: 'icons/common/app-logo.svg',
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
export const CLIENT_PORT_MAP = {
  codex: 9229,
  claude: 9230,
  antigravity: 9231,
};
export const DEFAULT_CDP_PORTS = [9229, 9230, 9231];
const READY_TIMEOUT_MS = 12000;
const CDP_EVALUATION_TIMEOUT_MS = 8000;
const CDP_INJECTION_TIMEOUT_MS = 20000;
const CDP_INJECTION_RETRY_DELAY_MS = 300;

function readIconDataUrl(name) {
  const data = readFileSync(join(ASSET_DIR, `${name}.svg`));
  return `data:image/svg+xml;base64,${data.toString('base64')}`;
}

function readImageDataUrl(name, extension, mimeType) {
  const data = readFileSync(join(ASSET_DIR, `${name}.${extension}`));
  return `data:${mimeType};base64,${data.toString('base64')}`;
}

export function locateExecutable() {
  const candidates = desktopExecutableCandidates();
  return candidates.find(existsSync) ?? candidates[0];
}

export function locateClientExecutable(client = 'codex') {
  const norm = String(client || 'codex').toLowerCase();
  if (norm === 'claude') {
    const candidates = [
      '/Applications/Claude.app/Contents/MacOS/Claude',
      join(process.env.HOME || '', 'Applications/Claude.app/Contents/MacOS/Claude'),
    ];
    return candidates.find(existsSync) ?? candidates[0];
  }
  if (norm === 'antigravity') {
    const candidates = [
      '/Applications/Antigravity.app/Contents/MacOS/Antigravity',
      '/Applications/Antigravity IDE.app/Contents/MacOS/Electron',
      '/Applications/Antigravity IDE.app/Contents/MacOS/Antigravity',
      join(process.env.HOME || '', 'Applications/Antigravity.app/Contents/MacOS/Antigravity'),
    ];
    return candidates.find(existsSync) ?? candidates[0];
  }
  return locateExecutable();
}

export function getDesktopAppProcessInfo(port = DEFAULT_PORT, client = 'codex') {
  if (process.platform === 'darwin') {
    const norm = String(client || 'codex').toLowerCase();
    const candidates = norm === 'codex'
      ? desktopExecutableCandidates()
      : [locateClientExecutable(norm)].filter(Boolean);
    try {
      const processes = execFileSync('/bin/ps', ['-axww', '-o', 'command='], { encoding: 'utf8' });
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

  if (process.platform === 'win32') {
    try {
      const script = 'Get-CimInstance Win32_Process -Filter "Name=\'ChatGPT.exe\' or Name=\'Codex.exe\'" | Select-Object -ExpandProperty CommandLine';
      const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', script], {
        encoding: 'utf8',
        timeout: 3000,
      });
      const lines = output.split(/\r?\n/).map(line => line.trim()).filter(Boolean);
      if (lines.length === 0) {
        return { running: false, hasCdpFlag: false };
      }
      let hasCdpFlag = false;
      for (const command of lines) {
        if (command.includes(`--remote-debugging-port=${port}`) || command.includes('--remote-debugging-port=')) {
          hasCdpFlag = true;
        }
      }
      return { running: true, hasCdpFlag };
    } catch {
      return { running: false, hasCdpFlag: false };
    }
  }

  return { running: false, hasCdpFlag: false };
}

export function isDesktopAppRunning() {
  return getDesktopAppProcessInfo().running;
}

export function parsePsElapsedSeconds(etimeStr) {
  const s = String(etimeStr || '').trim();
  if (!s) return Infinity;
  const dashParts = s.split('-');
  let days = 0;
  let timePart = s;
  if (dashParts.length === 2) {
    days = Number(dashParts[0]);
    if (!Number.isFinite(days)) return Infinity;
    timePart = dashParts[1];
  }
  const parts = timePart.split(':').map(Number);
  if (parts.some(n => !Number.isFinite(n))) return Infinity;
  let secs = 0;
  if (parts.length === 3) secs = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) secs = parts[0] * 60 + parts[1];
  else if (parts.length === 1) secs = parts[0];
  else return Infinity;
  return days * 86400 + secs;
}

export async function findUninstrumentedCodexProcessesAsync(port = DEFAULT_PORT) {
  if (process.platform !== 'darwin') return [];
  const candidates = desktopExecutableCandidates();
  try {
    const { stdout } = await execFileAsync('/bin/ps', ['-axww', '-o', 'pid=,etime=,command='], { encoding: 'utf8', timeout: 3000 });
    const found = [];
    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.trim();
      if (!line) continue;
      const match = line.match(/^(\d+)\s+(\S+)\s+(.+)$/);
      if (!match) continue;
      const pid = Number(match[1]);
      const etime = match[2];
      const command = match[3].trim();
      const matchedCandidate = candidates.find(candidate => command === candidate || command.startsWith(`${candidate} `));
      if (!matchedCandidate) continue;
      if (command.includes(`--remote-debugging-port=${port}`) || command.includes('--remote-debugging-port=')) {
        return [];
      }
      found.push({
        pid,
        elapsedSeconds: parsePsElapsedSeconds(etime),
        executable: matchedCandidate,
      });
    }
    return found;
  } catch {
    return [];
  }
}

export async function autoRelaunchCodexWithCdp(port = DEFAULT_PORT, processes = []) {
  if (process.platform !== 'darwin' || !Array.isArray(processes) || processes.length === 0) {
    return { ok: false, reason: 'invalid_state' };
  }
  const lockDir = join(process.env.TMPDIR || tmpdir(), 'codex-quota-header-launcher.lock');
  if (existsSync(lockDir)) {
    return { ok: false, reason: 'launcher_active' };
  }
  const executable = processes[0].executable || locateExecutable();
  if (!executable || !existsSync(executable)) {
    return { ok: false, reason: 'executable_not_found' };
  }
  const appName = executable.includes('/Codex.app/') ? 'Codex' : 'ChatGPT';
  const isFreshColdLaunch = processes.every(p => p.elapsedSeconds <= 8);

  if (isFreshColdLaunch) {
    // 刚冷启动的新进程（<=8s）：先发 SIGTERM，350ms 内若未退出直接发送 SIGKILL 快速回收，
    // 避免 Chromium 卡在半初始化子进程清理流程中拖慢重启 1.5s+。
    for (const p of processes) {
      if (isPidAlive(p.pid)) {
        try { process.kill(p.pid, 'SIGTERM'); } catch { /* ignore */ }
      }
    }
    const deadlineGrace = Date.now() + 350;
    while (Date.now() < deadlineGrace) {
      if (processes.every(p => !isPidAlive(p.pid))) break;
      await new Promise(r => setTimeout(r, 40));
    }
    if (processes.some(p => isPidAlive(p.pid))) {
      for (const p of processes) {
        if (isPidAlive(p.pid)) {
          try { process.kill(p.pid, 'SIGKILL'); } catch { /* ignore */ }
        }
      }
      const deadlineKill = Date.now() + 1500;
      while (Date.now() < deadlineKill) {
        if (processes.every(p => !isPidAlive(p.pid))) break;
        await new Promise(r => setTimeout(r, 40));
      }
    }
  } else {
    // 已运行较久的会话：异步通知优雅退出（不阻塞等待 4s），快速轮询并在超时后降级 SIGTERM
    try {
      execFile('/usr/bin/osascript', ['-e', `tell application "${appName}" to quit`], () => {});
    } catch { /* ignore */ }

    const deadline1 = Date.now() + 1200;
    while (Date.now() < deadline1) {
      if (processes.every(p => !isPidAlive(p.pid))) break;
      await new Promise(r => setTimeout(r, 60));
    }

    if (processes.some(p => isPidAlive(p.pid))) {
      for (const p of processes) {
        if (isPidAlive(p.pid)) {
          try { process.kill(p.pid, 'SIGTERM'); } catch { /* ignore */ }
        }
      }
      const deadline2 = Date.now() + 3000;
      while (Date.now() < deadline2) {
        if (processes.every(p => !isPidAlive(p.pid))) break;
        await new Promise(r => setTimeout(r, 60));
      }
    }
  }

  if (processes.some(p => isPidAlive(p.pid))) {
    return { ok: false, reason: 'quit_timeout' };
  }

  // 确认期间没有被其它进程抢先用 CDP 拉起
  const remaining = await findUninstrumentedCodexProcessesAsync(port);
  if (remaining.length > 0) {
    return { ok: false, reason: 'still_running' };
  }
  const info = getDesktopAppProcessInfo(port, 'codex');
  if (info.running && info.hasCdpFlag) {
    return { ok: true, alreadyInstrumented: true };
  }

  launchDesktopApp(executable, port);
  try {
    await waitForTargets(port, 8000);
    await launchAndInject(port, { launchIfNeeded: false, client: 'codex' });
  } catch { /* 即使端口尚在初始化，后续 monitor 轮询仍会接管注入 */ }
  return { ok: true, relaunched: true, executable };
}

const cdpHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 1, keepAliveMsecs: 10000 });

export function fetchCdpTargets(port = DEFAULT_PORT) {
  return new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json/list`, { agent: cdpHttpAgent, timeout: 2000 }, res => {
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
          const list = Array.isArray(targets) ? targets : [];
          for (const item of list) {
            if (item && typeof item === 'object') {
              Object.defineProperty(item, '_cdpPort', { value: port, enumerable: false, configurable: true });
            }
          }
          resolve(list);
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

export function getAntigravityActivePort() {
  const p = join(homedir(), 'Library/Application Support/Antigravity/DevToolsActivePort');
  try {
    if (!existsSync(p)) return null;
    const lines = readFileSync(p, 'utf8').split('\n');
    const port = Number(lines[0]?.trim());
    return Number.isInteger(port) && port > 1024 && port <= 65535 ? port : null;
  } catch { return null; }
}

export async function fetchAllCdpTargets(ports = DEFAULT_CDP_PORTS) {
  const dynamicPorts = new Set(Array.isArray(ports) ? ports : [ports]);
  const agPort = getAntigravityActivePort();
  if (agPort) dynamicPorts.add(agPort);
  const results = await Promise.all(
    [...dynamicPorts].map(port => fetchCdpTargets(port).catch(() => []))
  );
  return results.flat();
}

function isRendererTarget(target) {
  if (!target?.webSocketDebuggerUrl) return false;
  if (!['page', 'webview'].includes(target.type)) return false;
  const haystack = `${target.title || ''} ${target.url || ''}`.toLowerCase();
  return haystack.includes('codex')
    || haystack.includes('chatgpt')
    || haystack.includes('claude')
    || haystack.includes('antigravity')
    || haystack.includes('workbench')
    || haystack.includes('index.html')
    || haystack.includes('app://');
}

export function selectRendererTargets(targets) {
  const renderers = targets.filter(isRendererTarget);
  if (renderers.length > 0) return renderers;
  return targets.filter(target => target?.webSocketDebuggerUrl && ['page', 'webview'].includes(target.type));
}

export function selectUsageTargets(targets) {
  return targets.filter(target => {
    if (!target?.webSocketDebuggerUrl || !['page', 'webview'].includes(target.type)) return false;
    try {
      const url = new URL(target.url);
      if (url.protocol === 'devtools:' || url.protocol === 'chrome-extension:' || target.url === 'about:blank') {
        return false;
      }
      // 1. Codex 客户端 (app://-/...)
      if (url.protocol === 'app:' && url.hostname === '-') {
        const initialRoute = url.searchParams.get('initialRoute');
        // 明确排除设置、个人资料、头像浮层、独立弹窗等辅助窗口
        if (initialRoute && /^\/(?:settings|preferences|profile|auth|login|help|avatar-overlay|detached)(?:\/|$|\?)/i.test(initialRoute)) {
          return false;
        }
        const pathname = url.pathname.toLowerCase();
        // 支持根路径、index.html 以及各类单页工作区或对话路由
        const isUsagePath = ['/', '/index.html', '/work/index.html', '/chat/index.html', '/work', '/chat'].includes(pathname)
          || /^\/(?:work|threads?|chats?|projects?|new|local)(?:\/|$)/i.test(pathname);
        return isUsagePath;
      }
      // 2. Claude Desktop 客户端 (https://claude.ai/...)
      if (target.type === 'page' && url.protocol === 'https:' && (url.hostname === 'claude.ai' || url.hostname.endsWith('.claude.ai'))) {
        const pathname = url.pathname.toLowerCase();
        if (/^\/(?:settings|login|oauth|auth|logout|quicksilver|quick-entry)(?:\/|$)/i.test(pathname)) {
          return false;
        }
        if (/quick[\s_-]?entry|about|settings/i.test(target.title || '')) {
          return false;
        }
        return true;
      }
      // 3. Antigravity / Antigravity IDE 客户端
      if (target.type === 'page') {
        const pathname = url.pathname.toLowerCase();
        const combined = `${target.title || ''} ${target.url || ''}`.toLowerCase();
        if (/splash|wizard|onboarding|devtools/i.test(combined)) return false;
        if (url.protocol === 'vscode-file:' && pathname.includes('workbench.html')) {
          return true;
        }
        if (target._cdpPort === CLIENT_PORT_MAP.antigravity && ['file:', 'app:', 'http:', 'https:', 'vscode-file:'].includes(url.protocol)) {
          return true;
        }
        if (['file:', 'app:', 'http:', 'https:', 'vscode-file:'].includes(url.protocol) && /antigravity|workbench|jetski/i.test(combined)) {
          return true;
        }
      }
      return false;
    } catch { return false; }
  });
}

const cdpSocketPool = new Map();

export function closeCdpSocket(wsUrl) {
  const entry = cdpSocketPool.get(wsUrl);
  if (!entry) return;
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  cdpSocketPool.delete(wsUrl);
  try { entry.ws.close(); } catch {}
}

export function closeAllCdpSockets() {
  for (const wsUrl of cdpSocketPool.keys()) closeCdpSocket(wsUrl);
}

function resetIdleTimer(entry, wsUrl) {
  if (entry.idleTimer) clearTimeout(entry.idleTimer);
  if (entry.bindingListeners.size > 0) {
    entry.idleTimer = null;
    return;
  }
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
    bindingListeners: new Set(),
    readyPromise: null,
    idleTimer: null,
  };

  entry.readyPromise = new Promise((resolve, reject) => {
    ws.onopen = () => resolve(entry);
    ws.onerror = err => reject(err instanceof Error ? err : new Error(err?.message || 'cdp_websocket_error'));
  });

  ws.onmessage = event => {
    try {
      const message = JSON.parse(event.data);
      if (message.id === undefined) {
        if (message.method === 'Runtime.bindingCalled' && typeof message.params?.name === 'string') {
          for (const binding of [...entry.bindingListeners]) {
            if (binding.name !== message.params.name) continue;
            try { binding.listener(message.params); } catch { /* Listener failure must not break CDP. */ }
          }
        }
        return;
      }
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
    // 重试可能已经建立新连接；旧 socket 的延迟 close 不得摘除新连接。
    if (cdpSocketPool.get(wsUrl) === entry) cdpSocketPool.delete(wsUrl);
    for (const waiter of entry.pending.values()) {
      waiter.reject(new Error('cdp_websocket_closed'));
    }
    entry.pending.clear();
    for (const binding of [...entry.bindingListeners]) {
      try { binding.listener({ name: binding.name, disconnected: true }); } catch { /* teardown callback */ }
    }
    entry.bindingListeners.clear();
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.idleTimer = null;
  };

  cdpSocketPool.set(wsUrl, entry);
  resetIdleTimer(entry, wsUrl);
  return entry;
}

export async function evaluateInTarget(wsUrl, expression, timeoutMs = CDP_EVALUATION_TIMEOUT_MS) {
  const entry = getOrCreateCdpSocket(wsUrl);
  if (entry.ws.readyState !== WebSocket.OPEN) {
    await entry.readyPromise;
  }

  return new Promise((resolve, reject) => {
    const id = entry.nextId++;
    const timer = setTimeout(() => {
      entry.pending.delete(id);
      closeCdpSocket(wsUrl);
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

function sendCdpCommand(entry, wsUrl, method, params = {}, timeoutMs = CDP_EVALUATION_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const id = entry.nextId++;
    const timer = setTimeout(() => {
      entry.pending.delete(id);
      closeCdpSocket(wsUrl);
      reject(new Error(`cdp_${method}_timeout`));
    }, timeoutMs);
    entry.pending.set(id, {
      resolve: value => { clearTimeout(timer); resolve(value); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    try {
      entry.ws.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      clearTimeout(timer);
      entry.pending.delete(id);
      reject(error);
    }
  });
}

/**
 * Subscribe to a Runtime binding event. The subscribed CDP socket remains open
 * while at least one listener is registered; callers must unsubscribe on stop.
 */
export async function subscribeToCdpBinding(wsUrl, name, listener, timeoutMs = CDP_EVALUATION_TIMEOUT_MS) {
  if (!/^[$A-Z_a-z][$\w]*$/.test(name) || typeof listener !== 'function') {
    throw new TypeError('invalid_cdp_binding_subscription');
  }
  const entry = getOrCreateCdpSocket(wsUrl);
  if (entry.ws.readyState !== WebSocket.OPEN) await entry.readyPromise;
  const binding = { name, listener };
  entry.bindingListeners.add(binding);
  resetIdleTimer(entry, wsUrl);
  try {
    await sendCdpCommand(entry, wsUrl, 'Runtime.addBinding', { name }, timeoutMs);
  } catch (error) {
    // A previous monitor instance may have registered this binding on the
    // same renderer session. The existing binding is still valid.
    if (!/already exists|duplicate/i.test(String(error?.message || ''))) {
      entry.bindingListeners.delete(binding);
      resetIdleTimer(entry, wsUrl);
      throw error;
    }
  }
  return () => {
    entry.bindingListeners.delete(binding);
    resetIdleTimer(entry, wsUrl);
  };
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
function isRetryableCdpInjectionError(error) {
  return /cdp_evaluation_timeout|cdp_(?:socket|websocket)_(?:closed|error)|cdp_eval_failed/i.test(String(error?.message || error));
}

async function evaluateInjectionWithRetry(wsUrl, scriptCode) {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await evaluateInTarget(wsUrl, scriptCode, CDP_INJECTION_TIMEOUT_MS);
    } catch (error) {
      if (attempt === 1 || !isRetryableCdpInjectionError(error)) throw error;
      closeCdpSocket(wsUrl);
      await new Promise(resolve => setTimeout(resolve, CDP_INJECTION_RETRY_DELAY_MS));
    }
  }
}

const preloadRegistryByWsUrl = new Map();

async function registerPagePreload(wsUrl, scriptCode) {
  if (!scriptCode || scriptCode.length < 64) return;
  const hash = createHash('sha256').update(scriptCode).digest('hex');
  const existing = preloadRegistryByWsUrl.get(wsUrl);
  if (existing && existing.hash === hash) return;
  try {
    const entry = getOrCreateCdpSocket(wsUrl);
    if (entry.ws.readyState !== WebSocket.OPEN) await entry.readyPromise;
    await sendCdpCommand(entry, wsUrl, 'Page.enable', {}, 1500);
    if (existing?.identifier) {
      await sendCdpCommand(entry, wsUrl, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: existing.identifier }, 1500).catch(() => {});
    }
    const res = await sendCdpCommand(entry, wsUrl, 'Page.addScriptToEvaluateOnNewDocument', { source: scriptCode }, 2000);
    if (res?.identifier) {
      preloadRegistryByWsUrl.set(wsUrl, { identifier: res.identifier, hash });
    }
  } catch { /* 非 Page 域目标或测试桩环境下忽略预注入失败 */ }
}

async function removePagePreload(wsUrl) {
  const existing = preloadRegistryByWsUrl.get(wsUrl);
  if (!existing?.identifier) return;
  preloadRegistryByWsUrl.delete(wsUrl);
  try {
    const entry = getOrCreateCdpSocket(wsUrl);
    if (entry.ws.readyState !== WebSocket.OPEN) await entry.readyPromise;
    await sendCdpCommand(entry, wsUrl, 'Page.removeScriptToEvaluateOnNewDocument', { identifier: existing.identifier }, 1500);
  } catch { /* ignore */ }
}

export async function injectScriptIntoTarget(wsUrl, scriptCode) {
  await evaluateInjectionWithRetry(wsUrl, scriptCode);
  await registerPagePreload(wsUrl, scriptCode);
  const deadline = Date.now() + 6000;
  let probe;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 100));
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

export async function waitForTargets(port, timeoutMs = READY_TIMEOUT_MS, { checkExiting = false } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastError;
  let lastTargets = [];
  while (Date.now() < deadline) {
    try {
      const targets = await fetchCdpTargets(port);
      lastTargets = targets;
      if (targets.length > 0 && selectUsageTargets(targets).length > 0) return targets;
    } catch (error) {
      lastError = error;
    }
    if (checkExiting && !isDesktopAppRunning()) {
      throw new Error('desktop_app_exited_during_wait');
    }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  if (lastTargets.length > 0) return lastTargets;
  throw new Error(`cdp_not_ready: ${lastError?.message || 'no_targets'}`);
}

function launchDesktopApp(executable, port) {
  if (!executable || !existsSync(executable)) {
    throw new Error(`desktop_executable_not_found: ${executable || 'unsupported_platform'}`);
  }
  const args = [
    `--remote-debugging-port=${port}`,
    '--remote-debugging-address=127.0.0.1',
  ];
  const bundleMatch = process.platform === 'darwin' && executable.match(/^(.*?\.app)\/Contents\/MacOS\//);
  if (bundleMatch) {
    const child = spawn('/usr/bin/open', ['-a', bundleMatch[1], '--args', ...args], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return;
  }
  const child = spawn(executable, args, {
    detached: true,
    stdio: 'ignore',
    windowsHide: false,
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
            appServer: window.__codexUsageHeaderAppServerDiagnostics__ || null,
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
  if (status.mountedCount > 0) return 0;
  if (status.failedCount > 0) return 2;
  return status.waitingCount > 0 ? 0 : 2;
}

// 计算注入脚本的内容哈希并填入占位符：任何代码改动都会改变哈希，
// 渲染器内的版本守卫据此判断是否需要 teardown + 重装（无需手动升版本）。
export function buildInjectableScript() {
  const scriptSource = readFileSync(INJECTED_SCRIPT_PATH, 'utf8');
  const hash = createHash('sha256').update(scriptSource);
  hash.update(getAccountHealth.toString());
  hash.update(readFileSync(join(DESIGN_DIR, 'design.css')));
  for (const path of Object.values(DESIGN_ICONS)) hash.update(readFileSync(join(DESIGN_DIR, path)));
  const contentHash = hash.digest('hex');
  const scriptCode = scriptSource.includes('__INJECTED_CONTENT_HASH__')
    ? scriptSource.replace('__INJECTED_CONTENT_HASH__', contentHash)
    : scriptSource;
  return { scriptCode, contentHash };
}

let cachedHelperPid = null;

export function ensureClaudeOverlayHelper() {
  const helperBin = join(__dirname, '../bin/claude-overlay-helper');
  if (!existsSync(helperBin)) return false;
  if (cachedHelperPid && isPidAlive(cachedHelperPid)) return true;
  try {
    const running = execFileSync('/bin/ps', ['-ax', '-o', 'pid=,comm='], { encoding: 'utf8' })
      .split('\n')
      .map(line => line.trim().split(/\s+/))
      .find(parts => parts[1] && parts[1].includes('claude-overlay-helper'));
    if (running && running[0]) {
      cachedHelperPid = Number(running[0]);
      return true;
    }
    const child = spawn(helperBin, [], { detached: true, stdio: 'ignore' });
    child.unref();
    cachedHelperPid = child.pid || null;
    return true;
  } catch { return false; }
}

export async function launchAndInject(port = DEFAULT_PORT, { launchIfNeeded = true, client = 'codex' } = {}) {
  const { scriptCode, contentHash } = buildInjectableScript();
  let targets;

  try {
    targets = await fetchCdpTargets(port);
  } catch {
    const procInfo = getDesktopAppProcessInfo(port, client);
    if (procInfo.running) {
      if (procInfo.hasCdpFlag) {
        // 应用已开启 CDP 调试参数正在运行或冷启动中，等待其调试端口就绪，绝不误判
        try {
          targets = await waitForTargets(port, READY_TIMEOUT_MS, { checkExiting: true });
        } catch (waitErr) {
          // 若等待超时或应用在等待过程中退出（处于切换模式重启退出阶段）
          if (!getDesktopAppProcessInfo(port, client).running || waitErr?.message === 'desktop_app_exited_during_wait') {
            if (!launchIfNeeded) throw new Error('cdp_unavailable');
            const executable = locateClientExecutable(client);
            console.log(`[Codex Quota Header] Target app (${client}) was exiting and has terminated; relaunching on CDP port ${port}...`);
            launchDesktopApp(executable, port);
            targets = await waitForTargets(port);
          } else {
            throw new Error('cdp_port_unreachable');
          }
        }
      } else {
        // 确实存在未带调试端口启动的旧进程
        throw new Error('app_running_without_cdp');
      }
    } else {
      if (!launchIfNeeded) throw new Error('cdp_unavailable');
      const executable = locateClientExecutable(client);
      console.log(`[Codex Quota Header] Launching ${client} app on localhost CDP port ${port}...`);
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
  let initialSnapshot = null;
  try {
    const liveStatusFile = join(getDataDir(), 'live-status.json');
    if (existsSync(liveStatusFile)) {
      initialSnapshot = JSON.parse(readFileSync(liveStatusFile, 'utf8'));
    }
  } catch { /* ignore */ }
  const bootstrap = `window.__codexUsageHeaderAccountHealth__ = ${getAccountHealth.toString()}; window.__codexUsageHeaderIcons__ = ${JSON.stringify(icons)}; window.__codexUsageHeaderDesignIcons__ = ${JSON.stringify(designIcons)}; window.__codexUsageHeaderDesignCSS__ = ${JSON.stringify(designCss)}; window.__codexUsageHeaderSource__ = ${JSON.stringify(join(__dirname, '..'))}; window.__codexUsageHeaderInitialSnapshot__ = ${JSON.stringify(initialSnapshot)};`;

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
  const child = spawn(process.execPath, ['--no-warnings', '--max-old-space-size=192', MONITOR_PATH, '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
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
  const options = { port: DEFAULT_PORT, portExplicit: false, mode: 'launch', client: 'codex' };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--status') options.mode = 'status';
    else if (arg === '--inject-only') options.mode = 'inject-only';
    else if (arg === '--teardown') options.mode = 'teardown';
    else if (arg === '--help' || arg === '-h') options.mode = 'help';
    else if (arg === '--client') {
      const val = String(argv[index + 1] || '').toLowerCase();
      if (!['codex', 'claude', 'antigravity', 'all'].includes(val)) {
        throw new Error(`invalid_client: ${val}`);
      }
      options.client = val;
      if (!options.portExplicit && CLIENT_PORT_MAP[val]) {
        options.port = CLIENT_PORT_MAP[val];
      }
      index += 1;
    } else if (arg === '--port') {
      const value = Number(argv[index + 1]);
      if (!Number.isInteger(value) || value < 1024 || value > 65535) {
        throw new Error('invalid_port');
      }
      options.port = value;
      options.portExplicit = true;
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
  --client <name>   Target client: codex (9229) | claude (9230) | antigravity (9231) | all
  --status          Report desktop/CDP/component status without changing state
  --inject-only     Inject only when the desktop app already exposes CDP
  --teardown        Remove the component from running renderers (used by uninstall)
  --port <number>   CDP port (default: ${DEFAULT_PORT})
  -h, --help        Show this help

For first launch, quit the target app completely and run: codex-header [--client codex|claude|antigravity|all]`);
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
        await removePagePreload(target.webSocketDebuggerUrl).catch(() => {});
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

  if (options.client === 'all' || (options.mode === 'inject-only' && !options.portExplicit && options.client === 'codex')) {
    const agPort = getAntigravityActivePort() || CLIENT_PORT_MAP.antigravity;
    const clientEntries = options.client === 'all'
      ? [['codex', CLIENT_PORT_MAP.codex], ['claude', CLIENT_PORT_MAP.claude], ['antigravity', agPort]]
      : [['codex', 9229], ['claude', 9230], ['antigravity', agPort]];
    const allResults = [];
    for (const [clientName, clientPort] of clientEntries) {
      try {
        const res = await launchAndInject(clientPort, {
          launchIfNeeded: options.mode !== 'inject-only' && options.client === 'all',
          client: clientName,
        });
        allResults.push(res);
      } catch (err) {
        if (options.client === 'all' && options.mode !== 'inject-only') {
          console.error(`[Codex Quota Header] ${clientName} (${clientPort}) skipped: ${err.message}`);
        }
      }
    }
    if (allResults.length === 0) {
      throw new Error('cdp_unavailable');
    }
    const monitor = await startUsageMonitor(DEFAULT_PORT);
    if (monitor.started) {
      console.log(`[Codex Quota Header] Live usage monitor started (pid ${monitor.pid}).`);
    } else {
      console.log(`[Codex Quota Header] Monitor already running (pid ${monitor.pid}); keeping the existing instance.`);
    }
    for (const result of allResults) {
      const parts = [`端口 ${result.port} 已挂载 ${result.mountedCount}`];
      if (result.waitingCount > 0) parts.push(`等待顶栏 ${result.waitingCount}`);
      if (result.failedCount > 0) parts.push(`失败 ${result.failedCount}`);
      console.log(`[Codex Quota Header] 注入完成：${parts.join('，')}。`);
      for (const item of result.results) {
        const mark = item.status === 'mounted' ? '✓' : (item.status === 'waiting' ? '…' : '✗');
        console.log(`  ${mark} [${item.status}] ${item.target}${item.placement ? ` (${item.placement})` : ''}`);
      }
    }
    return;
  }

  if (options.client === 'claude') {
    ensureClaudeOverlayHelper();
    const proc = getDesktopAppProcessInfo(options.port, 'claude');
    if (!proc.running && options.mode !== 'inject-only') {
      const exec = locateClientExecutable('claude');
      launchDesktopApp(exec, options.port);
    }
    const monitor = await startUsageMonitor(DEFAULT_PORT);
    console.log(`[Codex Quota Header] Claude 顶栏悬浮胶囊已启动（智能吸附至窗口右上角，点击展开 590px 弹窗）。`);
    return;
  }

  const result = await launchAndInject(options.port, {
    launchIfNeeded: options.mode !== 'inject-only',
    client: options.client,
  });
  const monitor = await startUsageMonitor(DEFAULT_PORT);
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
  if (result.mountedCount > 0) {
    process.exitCode = 0;
  } else if (result.waitingCount > 0) {
    console.log('[Codex Quota Header] 顶栏尚未出现，已进入等待挂载状态；打开任意对话页后组件会自动出现。');
    process.exitCode = 3;
  } else if (result.failedCount > 0) {
    process.exitCode = 2;
  }
}

const entryPath = process.argv[1];
const isDirectRun = Boolean(entryPath && existsSync(entryPath)
  && realpathSync(entryPath) === realpathSync(fileURLToPath(import.meta.url)));

if (isDirectRun) {
  main().catch(error => {
    if (error.message === 'app_running_without_cdp') {
      console.error('[Codex Quota Header] ChatGPT/Codex is running without the injection channel.');
      if (process.platform === 'win32') {
        console.error('The window may be closed, but ChatGPT is still running in the background or system tray.');
        console.error('Please exit ChatGPT completely (right-click the tray icon to Quit or close via Task Manager), then run codex-header again.');
      } else {
        console.error('The window may be closed already, but the main ChatGPT process is still alive in the background.');
        console.error('Quit it with Command+Q and wait until the main process disappears from Activity Monitor, then run codex-header again.');
      }
      process.exitCode = 10;
    } else {
      console.error(`[Codex Quota Header] ${error.message}`);
      process.exitCode = 1;
    }
  }).finally(() => {
    closeAllCdpSockets();
    cdpHttpAgent.destroy();
    // 防止 WebSocket 异步关闭握手阻塞 CLI 进程退出
    setTimeout(() => process.exit(process.exitCode ?? 0), 50).unref();
  });
}
