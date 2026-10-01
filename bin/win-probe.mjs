#!/usr/bin/env node
/**
 * Codex Quota Header - Windows 11 x64 P0 可行性探针
 *
 * 核心立项门槛验证：
 * 1. Store/MSIX 版 ChatGPT 安装形态、实际进程与合法启动入口识别；
 * 2. Chromium 远程调试端口（默认 9229）仅监听 127.0.0.1，且未暴露于 0.0.0.0；
 * 3. 目标 Webview 页面可被 CDP 发现且支持 Runtime.evaluate 与事件绑定；
 * 4. 关键止损验证：顶栏必须位于可注入的 Web DOM 中，且可点击、悬停、不被原生 DWM 标题栏遮挡；
 *    若标题栏完全由 Windows 原生 WinUI/DWM 渲染而不可注入，严格按要求触发止损；
 * 5. 同一 Windows 用户身份下 `codex app-server --stdio` 协议与回退可用性。
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { release, arch, platform } from 'node:os';
import { join } from 'node:path';
import { desktopExecutableCandidates, locateCodexBinary } from '../src/desktop-runtime.mjs';

const DEFAULT_PORT = 9229;
const PROBE_TIMEOUT_MS = 10000;

function logHeader(text) {
  console.log(`\n\x1b[1;36m=== ${text} ===\x1b[0m`);
}

function logPass(text) {
  console.log(`  \x1b[32m✓\x1b[0m ${text}`);
}

function logWarn(text) {
  console.log(`  \x1b[33m!\x1b[0m ${text}`);
}

function logFail(text) {
  console.log(`  \x1b[31m✗\x1b[0m ${text}`);
}

function logInfo(text) {
  console.log(`  \x1b[90m-\x1b[0m ${text}`);
}

export function evaluatePortBindingFromNetstat(netstatOutput, port = DEFAULT_PORT) {
  if (!netstatOutput || typeof netstatOutput !== 'string') return 'UNKNOWN';
  const lines = netstatOutput.split(/\r?\n/).filter(line => /\bLISTENING\b/i.test(line));
  const localAddresses = [];
  for (const line of lines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length >= 2) {
      localAddresses.push(parts[1]);
    }
  }
  const exactPortPattern = new RegExp(`:(?:${port})$`);
  const matchedAddresses = localAddresses.filter(addr => exactPortPattern.test(addr));

  if (matchedAddresses.length === 0) {
    return 'UNKNOWN';
  }
  const boundToWildcard = matchedAddresses.some(addr => /^(?:0\.0\.0\.0|\[::\]|\*):/i.test(addr));
  const boundToLoopback = matchedAddresses.some(addr => /^(?:127\.0\.0\.1|\[::1\]|localhost):/i.test(addr));

  if (boundToWildcard) return 'FAIL';
  if (boundToLoopback) {
    const boundToOther = matchedAddresses.some(addr => !/^(?:127\.0\.0\.1|\[::1\]|localhost):/i.test(addr));
    return boundToOther ? 'FAIL' : 'PASS';
  }
  return 'FAIL';
}

export async function runProbe(options = {}) {
  const port = options.port || DEFAULT_PORT;
  const report = {
    timestamp: new Date().toISOString(),
    os: {
      platform: platform(),
      release: release(),
      arch: arch(),
      nodeVersion: process.version,
    },
    gates: {
      environment: { pass: false, details: null },
      packageDiscovery: { pass: false, details: null },
      processInspection: { pass: false, details: null },
      cdpPortSecurity: { pass: false, details: null },
      webviewInjectability: { pass: false, details: null },
      codexAppServer: { pass: false, details: null },
    },
    verdict: 'PENDING',
    verdictMessage: '',
  };

  logHeader('P0 探针 1/6: Windows 11 x64 与 Node 环境核验');
  const isWin = platform() === 'win32';
  const isX64 = arch() === 'x64';
  const nodeMajor = Number.parseInt(process.versions.node.split('.')[0], 10);
  const winRelease = Number.parseInt(release().split('.')[2] || '0', 10);
  const isWin11 = isWin && winRelease >= 22000;

  report.gates.environment = {
    pass: isWin && isX64 && nodeMajor >= 18,
    details: { isWin, isWin11, isX64, winRelease, nodeVersion: process.version },
  };

  if (!isWin) {
    logWarn(`当前平台为 ${platform()}（非 Windows 本机环境，探针将以模拟适配模式运行）`);
  } else {
    if (isWin11) logPass(`Windows 11 x64 检测通过 (Build ${winRelease})`);
    else logWarn(`Windows 平台但非 Windows 11 原生环境 (Build ${winRelease})`);
    if (isX64) logPass('x64 架构检测通过');
    else logFail(`非 x64 架构: ${arch()}`);
  }
  if (nodeMajor >= 18) logPass(`Node.js 版本满足要求 (${process.version})`);
  else logFail(`Node.js 版本低于 v18 (${process.version})`);

  logHeader('P0 探针 2/6: Store/MSIX 与独立安装包识别');
  const packageDetails = {
    appxPackage: null,
    executionAlias: null,
    standaloneCandidates: [],
    recommendedEntry: null,
  };

  if (isWin) {
    try {
      const psCommand = 'Get-AppxPackage -Name *ChatGPT* -ErrorAction SilentlyContinue | Select-Object -Property Name,Version,PackageFamilyName,InstallLocation | ConvertTo-Json -Compress';
      const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', psCommand], { encoding: 'utf8', timeout: 4000 }).trim();
      if (output) {
        packageDetails.appxPackage = JSON.parse(output);
        logPass(`检测到已安装 Store/MSIX 包: ${packageDetails.appxPackage.Name} (${packageDetails.appxPackage.Version})`);
        logInfo(`安装目录: ${packageDetails.appxPackage.InstallLocation}`);
      } else {
        logInfo('未检测到 Store/MSIX 版 ChatGPT 应用包');
      }
    } catch {
      logWarn('查询 Store/MSIX AppxPackage 失败');
    }
  }

  const candidates = desktopExecutableCandidates({ platform: isWin ? 'win32' : 'darwin' });
  const foundCandidates = candidates.filter(existsSync);
  packageDetails.standaloneCandidates = foundCandidates;

  const executionAlias = join(process.env.LOCALAPPDATA || '', 'Microsoft', 'WindowsApps', 'ChatGPT.exe');
  if (existsSync(executionAlias)) {
    packageDetails.executionAlias = executionAlias;
    packageDetails.recommendedEntry = executionAlias;
    logPass(`找到应用执行别名 (AppExecutionAlias): ${executionAlias}`);
  } else if (foundCandidates.length > 0) {
    packageDetails.recommendedEntry = foundCandidates[0];
    logPass(`找到桌面应用安装路径: ${foundCandidates[0]}`);
  } else {
    logWarn('未在预定义路径找到 ChatGPT 可执行文件，将依赖运行中进程或手动启动');
  }

  report.gates.packageDiscovery = {
    pass: Boolean(packageDetails.appxPackage || packageDetails.executionAlias || foundCandidates.length > 0),
    details: packageDetails,
  };

  logHeader('P0 探针 3/6: 实际运行进程与 CDP 调试参数检测');
  const processDetails = {
    running: false,
    hasCdpFlag: false,
    processes: [],
  };

  if (isWin) {
    try {
      const psCommand = 'Get-CimInstance Win32_Process -Filter "Name=\'ChatGPT.exe\' or Name=\'Codex.exe\'" | Select-Object -Property ProcessId,ParentProcessId,CommandLine | ConvertTo-Json -Compress';
      const output = execFileSync('powershell.exe', ['-NoProfile', '-Command', psCommand], { encoding: 'utf8', timeout: 4000 }).trim();
      if (output) {
        const parsed = JSON.parse(output);
        const list = Array.isArray(parsed) ? parsed : [parsed];
        processDetails.processes = list;
        processDetails.running = list.length > 0;
        processDetails.hasCdpFlag = list.some(item => String(item.CommandLine || '').includes('--remote-debugging-port'));
        logPass(`检测到正在运行的客户端进程: ${list.length} 个实例 (PID: ${list.map(p => p.ProcessId).join(', ')})`);
        if (processDetails.hasCdpFlag) {
          logPass('客户端已携带 --remote-debugging-port 调试参数启动');
        } else {
          logWarn('客户端正在运行但未携带 --remote-debugging-port 参数（需冷启动或带参启动）');
        }
      } else {
        logInfo('客户端未在运行');
      }
    } catch {
      logWarn('查询 Win32_Process 失败');
    }
  } else {
    logInfo('非 Windows 平台，跳过 CimInstance 进程核验');
  }

  report.gates.processInspection = {
    pass: processDetails.running ? processDetails.hasCdpFlag : true,
    details: processDetails,
  };

  logHeader(`P0 探针 4/6: CDP 端口连接与 127.0.0.1 本机回环绑定验证 (Port ${port})`);
  const cdpSecurity = {
    portOpen: false,
    securityStatus: 'UNKNOWN',
    boundOnlyToLoopback: false,
    targetsFound: 0,
    targets: [],
  };

  try {
    const versionData = await fetchHttpJson(`http://127.0.0.1:${port}/json/version`, 2000);
    const targets = await fetchHttpJson(`http://127.0.0.1:${port}/json/list`, 2000);
    cdpSecurity.portOpen = true;
    cdpSecurity.targetsFound = targets.length;
    cdpSecurity.targets = targets.map(t => ({ id: t.id, type: t.type, title: t.title, url: t.url, wsUrl: Boolean(t.webSocketDebuggerUrl) }));
    logPass(`CDP 端口已就绪: ${versionData.Browser || 'Chromium'}`);
    logPass(`发现 ${targets.length} 个调试目标 (${targets.filter(t => ['page', 'webview'].includes(t.type)).length} 个页面/Webview)`);

    if (isWin) {
      try {
        const netstatOutput = execFileSync('netstat.exe', ['-ano', '-p', 'TCP'], { encoding: 'utf8', timeout: 3000 });
        const status = evaluatePortBindingFromNetstat(netstatOutput, port);
        cdpSecurity.securityStatus = status;
        if (status === 'PASS') {
          cdpSecurity.boundOnlyToLoopback = true;
          logPass(`端口安全核验通过 [PASS]: 仅绑定 127.0.0.1 回环地址，未暴露于 0.0.0.0`);
        } else if (status === 'FAIL') {
          cdpSecurity.boundOnlyToLoopback = false;
          logFail(`严重安全告警 [FAIL]: 调试端口绑定到了 0.0.0.0 或公网接口！`);
        } else {
          cdpSecurity.boundOnlyToLoopback = false;
          logWarn(`端口监听状态不确定 [UNKNOWN]: 未能严格匹配到 127.0.0.1 独占监听`);
        }
      } catch (err) {
        cdpSecurity.securityStatus = 'UNKNOWN';
        cdpSecurity.boundOnlyToLoopback = false;
        logWarn(`netstat 执行异常 [UNKNOWN]: ${err.message}`);
      }
    } else {
      try {
        const lsofOutput = execFileSync('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN'], { encoding: 'utf8', timeout: 3000 });
        const hasWildcard = lsofOutput.includes(`*:${port}`) || lsofOutput.includes(`0.0.0.0:${port}`);
        const hasLoopback = lsofOutput.includes(`127.0.0.1:${port}`) || lsofOutput.includes(`localhost:${port}`);
        if (hasLoopback && !hasWildcard) {
          cdpSecurity.boundOnlyToLoopback = true;
          cdpSecurity.securityStatus = 'PASS';
          logPass('[非 Windows 环境] 端口仅绑定回环地址 [PASS]');
        } else if (hasWildcard) {
          cdpSecurity.boundOnlyToLoopback = false;
          cdpSecurity.securityStatus = 'FAIL';
          logFail('[非 Windows 环境] 端口绑定到了公网接口 [FAIL]');
        } else {
          cdpSecurity.boundOnlyToLoopback = false;
          cdpSecurity.securityStatus = 'UNKNOWN';
          logWarn('[非 Windows 环境] 端口绑定状态未知 [UNKNOWN]');
        }
      } catch {
        cdpSecurity.boundOnlyToLoopback = false;
        cdpSecurity.securityStatus = 'UNKNOWN';
        logWarn('[非 Windows 环境] 无法通过 lsof 验证端口绑定 [UNKNOWN]');
      }
    }
  } catch (error) {
    logWarn(`CDP 端口 ${port} 未连接或超时 (${error.message})`);
  }

  report.gates.cdpPortSecurity = {
    pass: cdpSecurity.portOpen && cdpSecurity.securityStatus === 'PASS',
    details: cdpSecurity,
  };

  logHeader('P0 探针 5/6: Webview 顶栏 DOM 与注入可行性核验（核心立项止损门槛）');
  const injectabilityDetails = {
    targetUrl: null,
    hasDomDocument: false,
    headerElementFound: false,
    headerTag: null,
    headerRect: null,
    systemCaptionButtonsInDom: false,
    probeMounted: false,
    clickEventHandled: false,
    nativeInputDispatched: false,
    isTrustedClick: false,
    isWebviewTitlebar: false,
  };

  if (cdpSecurity.portOpen && cdpSecurity.targets.length > 0) {
    const webviewTarget = cdpSecurity.targets.find(t => ['page', 'webview'].includes(t.type));
    if (webviewTarget && webviewTarget.wsUrl) {
      const fullTarget = (await fetchHttpJson(`http://127.0.0.1:${port}/json/list`, 2000)).find(t => t.id === webviewTarget.id);
      if (fullTarget?.webSocketDebuggerUrl) {
        injectabilityDetails.targetUrl = fullTarget.url;
        try {
          const interactionResult = await executeCdpInteractionProbe(fullTarget.webSocketDebuggerUrl, 5000);
          injectabilityDetails.hasDomDocument = true;
          injectabilityDetails.headerElementFound = Boolean(interactionResult.hasHeader);
          injectabilityDetails.headerTag = interactionResult.headerTag;
          injectabilityDetails.headerRect = interactionResult.headerRect;
          injectabilityDetails.systemCaptionButtonsInDom = Boolean(interactionResult.captionButtonsInDom);
          injectabilityDetails.probeMounted = Boolean(interactionResult.probeSuccess);
          injectabilityDetails.clickEventHandled = Boolean(interactionResult.clickReceived);
          injectabilityDetails.nativeInputDispatched = Boolean(interactionResult.nativeDispatched);
          injectabilityDetails.isTrustedClick = Boolean(interactionResult.isTrusted);
          injectabilityDetails.isWebviewTitlebar = Boolean(interactionResult.hasHeader && interactionResult.probeSuccess && interactionResult.clickReceived);

          logPass(`Webview DOM 文档连接成功: "${interactionResult.title || 'Untitled'}"`);
          if (interactionResult.hasHeader) {
            logPass(`找到可注入顶栏元素 <${interactionResult.headerTag}>: 尺寸 ${Math.round(interactionResult.headerRect?.width || 0)}x${Math.round(interactionResult.headerRect?.height || 0)}px (top: ${Math.round(interactionResult.headerRect?.top || 0)}px)`);
          } else {
            logWarn('页面内未检测到标准 <header> 或工具栏节点');
          }
          if (interactionResult.clickReceived) {
            if (interactionResult.isTrusted) {
              logPass('原生 CDP 鼠标点击事件派发与捕获成功 (Input.dispatchMouseEvent, isTrusted: true)');
            } else {
              logPass('探针点击事件捕获成功 (合成事件兜底响应)');
            }
          } else {
            logWarn('动态探针节点点击事件未被响应（可能被原生标题栏遮挡或事件吞没）');
          }
          if (interactionResult.captionButtonsInDom) {
            logInfo('系统窗口控制按钮位于 Web DOM 内部 (可测量真实 DOM 避让)');
          } else {
            logInfo('系统窗口控制按钮未在 DOM 内检测到（原生 DWM 标题栏模式）');
          }
        } catch (err) {
          logFail(`Webview DOM 注入评估失败: ${err.message}`);
        }
      }
    }
  } else {
    logInfo('CDP 未连接，跳过实时 DOM 注入交互探针');
  }

  report.gates.webviewInjectability = {
    pass: injectabilityDetails.isWebviewTitlebar,
    details: injectabilityDetails,
  };

  logHeader('P0 探针 6/6: 同一 Windows 用户身份下 codex app-server --stdio 协议核验');
  const appServerDetails = {
    codexBinaryFound: false,
    binaryPath: null,
    serverStarted: false,
    rateLimitsRead: false,
    error: null,
  };

  const codexBin = locateCodexBinary({ platform: isWin ? 'win32' : 'darwin' });
  if (codexBin) {
    appServerDetails.codexBinaryFound = true;
    appServerDetails.binaryPath = codexBin;
    logPass(`找到 Codex CLI 可执行入口: ${codexBin}`);

    try {
      const child = spawn(codexBin, ['app-server', '--stdio'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      const initPayload = JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: { clientInfo: { name: 'codex-p0-probe', version: '1.0.0' } },
      }) + '\n';

      const readLimitsPayload = JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'account/rateLimits',
        params: {},
      }) + '\n';

      const responsePromise = new Promise((resolve, reject) => {
        let buffer = '';
        const timer = setTimeout(() => {
          child.kill();
          reject(new Error('app-server 响应超时 (3000ms)'));
        }, 3000);

        child.stdout.on('data', chunk => {
          buffer += chunk.toString('utf8');
          if (buffer.includes('"id":1') && !buffer.includes('"id":2')) {
            child.stdin.write(readLimitsPayload);
          }
          if (buffer.includes('"id":2')) {
            clearTimeout(timer);
            child.kill();
            resolve(buffer);
          }
        });

        child.stderr.on('data', () => {});
        child.on('error', err => {
          clearTimeout(timer);
          reject(err);
        });
      });

      child.stdin.write(initPayload);
      const serverResponse = await responsePromise;
      appServerDetails.serverStarted = true;
      appServerDetails.rateLimitsRead = true;
      logPass('`codex app-server --stdio` 初始化与 account/rateLimits 请求交互成功');
    } catch (err) {
      appServerDetails.error = err.message;
      logWarn(`codex app-server --stdio 交互未成功 (${err.message})；将依赖协议回退通道`);
    }
  } else {
    logWarn('未在 PATH 或标准路径找到 `codex` CLI 命令；将依赖 App Server 自动发现或本地 fallback');
  }

  report.gates.codexAppServer = {
    pass: appServerDetails.serverStarted || appServerDetails.codexBinaryFound,
    details: appServerDetails,
  };

  // 综合判定结论
  logHeader('P0 探针综合判定与立项止损结论');

  if (cdpSecurity.portOpen && !injectabilityDetails.isWebviewTitlebar) {
    report.verdict = 'STOP_NATIVE_TITLEBAR_UNINJECTABLE';
    report.verdictMessage = '【P0 止损触发】客户端已开启调试端口，但顶栏不在可注入的 Web DOM 页面中，或标题栏由原生 DWM/WinUI 渲染不可操控。按方案规范停止“内嵌顶栏版”，不硬做悬浮窗或入侵修改 MSIX。';
    logFail(report.verdictMessage);
  } else if (!cdpSecurity.portOpen) {
    report.verdict = 'WAITING_CDP_LAUNCH';
    report.verdictMessage = '客户端未开启 CDP 调试参数（--remote-debugging-port=9229）。请关闭当前已打开的客户端（注意托盘完全退出），带参启动后重跑探针：\n   node bin/win-probe.mjs --port 9229';
    logWarn(report.verdictMessage);
  } else if (injectabilityDetails.isWebviewTitlebar) {
    report.verdict = 'PASS_READY_FOR_P1';
    report.verdictMessage = '【P0 验证通过】Windows 客户端支持仅限 127.0.0.1 的 CDP 调试通道，顶栏位于可注入 DOM 树中，探针动态交互正常。可以推进 P1 原生核心版！';
    logPass(report.verdictMessage);
  } else {
    report.verdict = 'UNKNOWN';
    report.verdictMessage = '探针未获得完整判定状态，请核验客户端环境配置。';
    logWarn(report.verdictMessage);
  }

  if (options.reportPath) {
    writeFileSync(options.reportPath, JSON.stringify(report, null, 2), 'utf8');
    logInfo(`探针完整报告已写入: ${options.reportPath}`);
  }

  return report;
}

function fetchHttpJson(url, timeoutMs = 2000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, res => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        if (res.statusCode !== 200) return reject(new Error(`http_${res.statusCode}`));
        try { resolve(JSON.parse(body)); }
        catch (err) { reject(err); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout')));
  });
}

export function executeCdpInteractionProbe(wsUrl, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const WS = globalThis.WebSocket;
    if (!WS) {
      return reject(new Error('WebSocket is not available on globalThis in current Node runtime'));
    }
    const ws = new WS(wsUrl);
    let nextId = 1;
    const callbacks = new Map();

    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('cdp_interaction_timeout'));
    }, timeoutMs);

    function sendCommand(method, params = {}) {
      return new Promise((res, rej) => {
        const id = nextId++;
        callbacks.set(id, { resolve: res, reject: rej });
        try {
          ws.send(JSON.stringify({ id, method, params }));
        } catch (err) {
          callbacks.delete(id);
          rej(err);
        }
      });
    }

    const onOpen = async () => {
      try {
        const step1Eval = await sendCommand('Runtime.evaluate', {
          expression: `
            (() => {
              const header = document.querySelector('header')
                || document.querySelector('[data-app-shell-header-toolbar="true"]')
                || document.querySelector('[role="toolbar"]')
                || document.querySelector('nav');
              const headerRect = header ? header.getBoundingClientRect() : null;
              const captionButtons = document.querySelectorAll('.caption-buttons, [data-caption-buttons], .window-controls, [data-window-controls]');

              const old = document.getElementById('__codex_p0_probe__');
              if (old) old.remove();

              let probeSuccess = false;
              let clickTarget = null;
              try {
                const probe = document.createElement('div');
                probe.id = '__codex_p0_probe__';
                const posX = headerRect && headerRect.width > 120 ? Math.round(headerRect.left + 80) : 40;
                const posY = headerRect && headerRect.height > 20 ? Math.round(headerRect.top + Math.min(15, headerRect.height / 2)) : 15;
                probe.style.cssText = 'position:fixed;top:' + posY + 'px;left:' + posX + 'px;width:16px;height:16px;z-index:2147483647;opacity:0.01;pointer-events:auto;background:red;';
                window.__codex_p0_click_count = 0;
                window.__codex_p0_last_event_is_trusted = false;
                probe.addEventListener('click', (e) => {
                  window.__codex_p0_click_count++;
                  window.__codex_p0_last_event_is_trusted = Boolean(e.isTrusted);
                });
                (header || document.body).appendChild(probe);
                const r = probe.getBoundingClientRect();
                probeSuccess = Boolean(document.getElementById('__codex_p0_probe__'));
                clickTarget = { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
              } catch {
                probeSuccess = false;
              }

              return {
                title: document.title,
                url: location.href,
                hasHeader: Boolean(header),
                headerTag: header ? header.tagName.toLowerCase() : null,
                headerRect: headerRect ? { width: headerRect.width, height: headerRect.height, top: headerRect.top, left: headerRect.left } : null,
                captionButtonsInDom: captionButtons.length > 0,
                probeSuccess,
                clickTarget,
              };
            })()
          `,
          awaitPromise: true,
          returnByValue: true,
        });

        const initialData = step1Eval?.result?.value || {};
        let nativeDispatched = false;

        if (initialData.probeSuccess && initialData.clickTarget) {
          try {
            await sendCommand('Input.dispatchMouseEvent', {
              type: 'mousePressed',
              x: initialData.clickTarget.x,
              y: initialData.clickTarget.y,
              button: 'left',
              clickCount: 1,
            });
            await sendCommand('Input.dispatchMouseEvent', {
              type: 'mouseReleased',
              x: initialData.clickTarget.x,
              y: initialData.clickTarget.y,
              button: 'left',
              clickCount: 1,
            });
            nativeDispatched = true;
          } catch {
            nativeDispatched = false;
          }
        }

        const step4Eval = await sendCommand('Runtime.evaluate', {
          expression: `
            (() => {
              const probe = document.getElementById('__codex_p0_probe__');
              const count = window.__codex_p0_click_count || 0;
              const isTrusted = Boolean(window.__codex_p0_last_event_is_trusted);
              if (probe) probe.remove();
              delete window.__codex_p0_click_count;
              delete window.__codex_p0_last_event_is_trusted;
              return { clickReceived: count > 0, clickCount: count, isTrusted };
            })()
          `,
          awaitPromise: true,
          returnByValue: true,
        });

        const finalData = step4Eval?.result?.value || {};
        clearTimeout(timer);
        try { ws.close(); } catch {}
        resolve({
          ...initialData,
          nativeDispatched,
          clickReceived: Boolean(finalData.clickReceived),
          clickCount: finalData.clickCount || 0,
          isTrusted: Boolean(finalData.isTrusted),
        });
      } catch (err) {
        clearTimeout(timer);
        try { ws.close(); } catch {}
        reject(err);
      }
    };

    const onMessage = data => {
      try {
        const raw = typeof data === 'string' ? data : (data?.data !== undefined ? data.data : data.toString('utf8'));
        const parsed = JSON.parse(raw);
        if (parsed.id && callbacks.has(parsed.id)) {
          const cb = callbacks.get(parsed.id);
          callbacks.delete(parsed.id);
          if (parsed.error) cb.reject(new Error(JSON.stringify(parsed.error)));
          else cb.resolve(parsed);
        }
      } catch {}
    };

    const onError = err => {
      clearTimeout(timer);
      reject(err);
    };

    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener('open', onOpen);
      ws.addEventListener('message', onMessage);
      ws.addEventListener('error', onError);
    } else if (typeof ws.on === 'function') {
      ws.on('open', onOpen);
      ws.on('message', onMessage);
      ws.on('error', onError);
    } else {
      ws.onopen = onOpen;
      ws.onmessage = onMessage;
      ws.onerror = onError;
    }
  });
}

function evaluateCdpSnippet(wsUrl, snippet, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const WS = globalThis.WebSocket;
    if (!WS) {
      return reject(new Error('WebSocket is not available on globalThis in current Node runtime'));
    }
    const ws = new WS(wsUrl);
    const timer = setTimeout(() => {
      try { ws.close(); } catch {}
      reject(new Error('cdp_ws_timeout'));
    }, timeoutMs);

    const onOpen = () => {
      try {
        ws.send(JSON.stringify({
          id: 1,
          method: 'Runtime.evaluate',
          params: {
            expression: snippet,
            awaitPromise: true,
            returnByValue: true,
          },
        }));
      } catch (err) {
        clearTimeout(timer);
        reject(err);
      }
    };

    const onMessage = data => {
      clearTimeout(timer);
      try {
        const raw = typeof data === 'string' ? data : (data?.data !== undefined ? data.data : data.toString('utf8'));
        const parsed = JSON.parse(raw);
        try { ws.close(); } catch {}
        if (parsed.error) return reject(new Error(JSON.stringify(parsed.error)));
        resolve(parsed.result?.result?.value);
      } catch (err) {
        reject(err);
      }
    };

    const onError = err => {
      clearTimeout(timer);
      reject(err);
    };

    if (typeof ws.addEventListener === 'function') {
      ws.addEventListener('open', onOpen);
      ws.addEventListener('message', onMessage);
      ws.addEventListener('error', onError);
    } else if (typeof ws.on === 'function') {
      ws.on('open', onOpen);
      ws.on('message', onMessage);
      ws.on('error', onError);
    } else {
      ws.onopen = onOpen;
      ws.onmessage = onMessage;
      ws.onerror = onError;
    }
  });
}

const isDirectCli = process.argv[1] && (process.argv[1].endsWith('win-probe.mjs') || process.argv[1].endsWith('win-probe'));
if (isDirectCli) {
  const args = process.argv.slice(2);
  const portIdx = args.indexOf('--port');
  const port = portIdx >= 0 ? Number(args[portIdx + 1]) || DEFAULT_PORT : DEFAULT_PORT;
  const reportIdx = args.indexOf('--report');
  const reportPath = reportIdx >= 0 ? args[reportIdx + 1] : join(process.cwd(), 'win-probe-report.json');

  runProbe({ port, reportPath }).then(report => {
    if (args.includes('--json')) {
      console.log(JSON.stringify(report, null, 2));
    }
    if (report.verdict === 'STOP_NATIVE_TITLEBAR_UNINJECTABLE') {
      process.exitCode = 12;
    } else if (report.verdict === 'PASS_READY_FOR_P1') {
      process.exitCode = 0;
    } else {
      process.exitCode = 1;
    }
  }).catch(err => {
    console.error(`探针运行失败: ${err.message}`);
    process.exitCode = 1;
  });
}
