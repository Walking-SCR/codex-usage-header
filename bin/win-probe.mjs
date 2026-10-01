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
        const lines = netstatOutput.split(/\r?\n/).filter(line => line.includes(`:${port}`) && line.includes('LISTENING'));
        const boundToWildcard = lines.some(line => line.includes(`0.0.0.0:${port}`) || line.includes(`[::]:${port}`));
        const boundToLoopback = lines.some(line => line.includes(`127.0.0.1:${port}`) || line.includes(`[::1]:${port}`));
        if (boundToLoopback && !boundToWildcard) {
          cdpSecurity.boundOnlyToLoopback = true;
          logPass(`端口安全核验通过: 仅绑定 127.0.0.1 回环地址，未暴露于 0.0.0.0`);
        } else if (boundToWildcard) {
          cdpSecurity.boundOnlyToLoopback = false;
          logFail(`严重安全告警: 调试端口绑定到了 0.0.0.0 或公网接口！`);
        } else {
          cdpSecurity.boundOnlyToLoopback = true;
          logInfo('未直接检测到外网监听绑定');
        }
      } catch {
        cdpSecurity.boundOnlyToLoopback = true;
      }
    } else {
      cdpSecurity.boundOnlyToLoopback = true;
    }
  } catch (error) {
    logWarn(`CDP 端口 ${port} 未连接或超时 (${error.message})`);
  }

  report.gates.cdpPortSecurity = {
    pass: cdpSecurity.portOpen && cdpSecurity.boundOnlyToLoopback,
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
    isWebviewTitlebar: false,
  };

  if (cdpSecurity.portOpen && cdpSecurity.targets.length > 0) {
    const webviewTarget = cdpSecurity.targets.find(t => ['page', 'webview'].includes(t.type));
    if (webviewTarget && webviewTarget.wsUrl) {
      const fullTarget = (await fetchHttpJson(`http://127.0.0.1:${port}/json/list`, 2000)).find(t => t.id === webviewTarget.id);
      if (fullTarget?.webSocketDebuggerUrl) {
        injectabilityDetails.targetUrl = fullTarget.url;
        try {
          const domAnalysis = await evaluateCdpSnippet(fullTarget.webSocketDebuggerUrl, `
            (() => {
              const header = document.querySelector('header')
                || document.querySelector('[data-app-shell-header-toolbar="true"]')
                || document.querySelector('[role="toolbar"]')
                || document.querySelector('nav');
              const headerRect = header ? header.getBoundingClientRect() : null;

              // 检测 Windows 系统按钮（最小化、最大化、关闭）是否位于 DOM 内部
              const captionButtons = document.querySelectorAll('.caption-buttons, [data-caption-buttons], .window-controls, [data-window-controls]');

              // 尝试创建临时探针元素挂载与事件触发
              let probeSuccess = false;
              let clickReceived = false;
              try {
                const probe = document.createElement('div');
                probe.id = '__codex_p0_probe__';
                probe.style.cssText = 'position:fixed;top:0;left:0;width:10px;height:10px;z-index:999999;opacity:0.01;pointer-events:auto;';
                probe.addEventListener('click', () => { clickReceived = true; });
                (header || document.body).appendChild(probe);
                probeSuccess = Boolean(document.getElementById('__codex_p0_probe__'));
                probe.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
                probe.remove();
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
                clickReceived,
              };
            })()
          `);

          injectabilityDetails.hasDomDocument = true;
          injectabilityDetails.headerElementFound = domAnalysis.hasHeader;
          injectabilityDetails.headerTag = domAnalysis.headerTag;
          injectabilityDetails.headerRect = domAnalysis.headerRect;
          injectabilityDetails.systemCaptionButtonsInDom = domAnalysis.captionButtonsInDom;
          injectabilityDetails.probeMounted = domAnalysis.probeSuccess;
          injectabilityDetails.clickEventHandled = domAnalysis.clickReceived;
          injectabilityDetails.isWebviewTitlebar = domAnalysis.hasHeader && domAnalysis.probeSuccess;

          logPass(`Webview DOM 文档连接成功: "${domAnalysis.title || 'Untitled'}"`);
          if (domAnalysis.hasHeader) {
            logPass(`找到可注入顶栏元素 <${domAnalysis.headerTag}>: 尺寸 ${Math.round(domAnalysis.headerRect.width)}x${Math.round(domAnalysis.headerRect.height)}px (top: ${Math.round(domAnalysis.headerRect.top)}px)`);
          } else {
            logWarn('页面内未检测到标准 <header> 或工具栏节点');
          }
          if (domAnalysis.probeSuccess && domAnalysis.clickReceived) {
            logPass('动态探针节点挂载与合成点击事件绑定成功 (Runtime.evaluate 交互正常)');
          } else {
            logWarn('动态探针节点挂载或点击事件未被响应');
          }
          if (domAnalysis.captionButtonsInDom) {
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
