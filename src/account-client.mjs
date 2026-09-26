/**
 * Codex App Server 的直接 JSON-RPC 客户端。
 * 渲染器不会接收凭证，也不会暴露本机 HTTP 桥接。
 *
 * Codex 26.924+ 兼容策略：
 * 1. 优先使用当前 account/rateLimits/read 参数能力；
 * 2. App Server 返回 -32600/-32602 时，自动回退旧协议；
 * 3. 初始化或传输层失败时销毁异常子进程，下一次读取自动重连；
 * 4. 保留 JSON-RPC error.code / error.data / rpcMethod，便于精确诊断；
 * 5. stderr 仅在后台保留有限尾部，不传入页面。
 */
import { spawn, execFileSync } from 'node:child_process';
import { locateCodexBinary } from './desktop-runtime.mjs';
export { locateCodexBinary } from './desktop-runtime.mjs';

const DEFAULT_REQUEST_TIMEOUT_MS = 10000;
const DEFAULT_INITIALIZE_TIMEOUT_MS = 20000;
const STDERR_TAIL_LIMIT = 8192;

function appendBoundedTail(current, chunk, limit = STDERR_TAIL_LIMIT) {
  const next = `${current || ''}${chunk || ''}`;
  return next.length <= limit ? next : next.slice(-limit);
}

function enrichError(error, {
  code = undefined,
  data = undefined,
  method = undefined,
  stderrTail = '',
} = {}) {
  if (!error || typeof error !== 'object') {
    error = new Error(String(error || 'codex_app_server_error'));
  }
  if (code !== undefined) error.code = code;
  if (data !== undefined) error.data = data;
  if (method !== undefined) error.rpcMethod = method;
  if (stderrTail && !error.stderrTail) error.stderrTail = stderrTail;
  return error;
}

function rpcError(message, method, stderrTail) {
  return enrichError(
    new Error(message?.message || 'codex_app_server_error'),
    {
      code: message?.code,
      data: message?.data,
      method,
      stderrTail,
    },
  );
}

function isLegacyRateLimitParamsError(error) {
  return error?.code === -32600 || error?.code === -32602;
}

function isRecoverableTransportError(error) {
  if (!error || Number.isFinite(Number(error.code))) return false;
  const message = String(error.message || '');
  return /codex_app_server_(?:exited|not_running|spawn_failed|write_failed)|_timeout$|EPIPE|ECONNRESET|broken pipe|socket.*closed/i.test(message);
}

export class AppServerClient {
  constructor({
    onNotification,
    binaryPath = null,
    binaryArgsPrefix = [],
    spawnProcess = spawn,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    initializeTimeoutMs = DEFAULT_INITIALIZE_TIMEOUT_MS,
  } = {}) {
    this.child = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.onNotification = onNotification;

    // binaryPath / binaryArgsPrefix 主要用于回归测试；生产环境保持默认。
    this.binaryPath = binaryPath;
    this.configuredBinaryPath = binaryPath;
    this.spawnProcess = spawnProcess;
    this.binaryVersion = null;
    this.lastError = null;
    this.binaryArgsPrefix = Array.isArray(binaryArgsPrefix) ? [...binaryArgsPrefix] : [];
    this.requestTimeoutMs = requestTimeoutMs;
    this.initializeTimeoutMs = initializeTimeoutMs;

    this.initialized = false;
    this.startPromise = null;
    this.stderrTail = '';
  }

  async ensureStarted() {
    if (this.child && !this.child.killed && this.initialized) return;
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.start();
    try {
      await this.startPromise;
    } finally {
      this.startPromise = null;
    }
  }

  async start() {
    this.disposeChild();

    const binary = this.configuredBinaryPath || locateCodexBinary();
    if (!binary) throw new Error('codex_app_server_not_found');

    this.binaryPath = binary;
    try { this.binaryVersion = execFileSync(binary, ['--version'], { encoding: 'utf8', timeout: 2000 }).trim().slice(0, 100); } catch { this.binaryVersion = null; }
    this.buffer = '';
    this.stderrTail = '';
    this.initialized = false;

    let child;
    try {
      child = this.spawnProcess(
        binary,
        [...this.binaryArgsPrefix, 'app-server', '--stdio'],
        { stdio: ['pipe', 'pipe', 'pipe'] },
      );
    } catch (error) {
      throw enrichError(
        new Error(`codex_app_server_spawn_failed: ${error.message}`),
        { method: 'initialize' },
      );
    }

    this.child = child;

    child.stdout.on('data', chunk => this.onData(chunk, child));
    child.stderr?.on('data', chunk => {
      if (this.child !== child) return;
      this.stderrTail = appendBoundedTail(this.stderrTail, chunk.toString());
    });

    child.stdin.on('error', error => {
      this.handleChildFailure(child, new Error(`codex_app_server_write_failed: ${error.message}`));
    });

    child.on('error', error => {
      this.handleChildFailure(
        child,
        enrichError(
          new Error(`codex_app_server_spawn_failed: ${error.message}`),
          { method: 'initialize', stderrTail: this.stderrTail },
        ),
      );
    });

    child.on('exit', (code, signal) => {
      this.handleChildFailure(
        child,
        enrichError(
          new Error(`codex_app_server_exited:${code ?? 'null'}:${signal ?? ''}`),
          { stderrTail: this.stderrTail },
        ),
      );
    });

    try {
      await this.request(
        'initialize',
        {
          clientInfo: { name: 'codex-usage-header', version: '2.3.0' },
          capabilities: { experimentalApi: true },
        },
        { timeoutMs: this.initializeTimeoutMs },
      );

      this.writeNotification('initialized', {});
      this.initialized = true;
      this.lastError = null;
    } catch (error) {
      enrichError(error, {
        method: error.rpcMethod || 'initialize',
        stderrTail: this.stderrTail,
      });
      this.disposeChild(child);
      throw error;
    }
  }

  handleChildFailure(child, error) {
    if (this.child !== child) return;
    enrichError(error, { stderrTail: this.stderrTail });
    this.rejectAllPending(error);
    this.disposeChild(child);
  }

  rejectAllPending(error) {
    for (const pending of this.pending.values()) pending.reject(error);
    this.pending.clear();
  }

  disposeChild(child = this.child) {
    if (!child) return;

    if (this.child === child) {
      this.child = null;
      this.initialized = false;
      this.buffer = '';
      this.rejectAllPending(new Error('codex_app_server_exited'));
    }

    try {
      if (!child.killed) child.kill();
    } catch {
      /* 子进程可能已经退出 */
    }
  }

  writeNotification(method, params) {
    const child = this.child;
    if (!child || child.killed) throw new Error('codex_app_server_not_running');

    const message = { jsonrpc: '2.0', method };
    if (params !== undefined) message.params = params;
    child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  onData(chunk, child = this.child) {
    if (this.child !== child) return;

    this.buffer += chunk.toString();
    while (this.buffer.includes('\n')) {
      const index = this.buffer.indexOf('\n');
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;

      let message;
      try { message = JSON.parse(line); } catch { continue; }

      if (message.id === undefined || message.id === null) {
        this.onNotification?.(message);
        continue;
      }

      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);

      if (message.error) {
        pending.reject(rpcError(message.error, pending.method, this.stderrTail));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  request(method, params, { timeoutMs = this.requestTimeoutMs } = {}) {
    return new Promise((resolve, reject) => {
      const child = this.child;
      if (!child || child.killed) {
        reject(enrichError(
          new Error('codex_app_server_not_running'),
          { method, stderrTail: this.stderrTail },
        ));
        return;
      }

      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(enrichError(
          new Error(`${method}_timeout`),
          { method, stderrTail: this.stderrTail },
        ));
      }, timeoutMs);

      const settleResolve = value => {
        clearTimeout(timer);
        resolve(value);
      };

      const settleReject = error => {
        clearTimeout(timer);
        reject(enrichError(error, { method, stderrTail: this.stderrTail }));
      };

      this.pending.set(id, {
        method,
        resolve: settleResolve,
        reject: settleReject,
      });

      const message = { jsonrpc: '2.0', id, method };
      // undefined = 完全省略 params；null = 显式发送 params:null。
      if (params !== undefined) message.params = params;

      try {
        child.stdin.write(`${JSON.stringify(message)}\n`, error => {
          if (!error) return;
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          pending.reject(new Error(`codex_app_server_write_failed: ${error.message}`));
        });
      } catch (error) {
        const pending = this.pending.get(id);
        if (pending) {
          this.pending.delete(id);
          pending.reject(new Error(`codex_app_server_write_failed: ${error.message}`));
        }
      }
    });
  }

  async requestRateLimitsWithProtocolFallback(excludeResetCreditDetails) {
    try {
      // 当前官方 Codex 的参数能力。
      return await this.request('account/rateLimits/read', {
        supportsLunaReserve: true,
        excludeResetCreditDetails,
      });
    } catch (error) {
      if (!isLegacyRateLimitParamsError(error)) throw error;
    }

    // 官方 Codex TUI 的兼容策略：旧 App Server 只接受旧请求形态。
    // 首先完全省略 params（对应协议层的 None）。
    try {
      return await this.request('account/rateLimits/read', undefined);
    } catch (error) {
      if (!isLegacyRateLimitParamsError(error)) throw error;
    }

    // 再兼容少数要求显式 JSON null 的旧实现。
    return this.request('account/rateLimits/read', null);
  }

  async readRateLimits({ excludeResetCreditDetails = false } = {}) {
    let lastError;

    // 只对传输/进程类故障自动重建一次，避免业务错误无限重启。
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.ensureStarted();
        const result = await this.requestRateLimitsWithProtocolFallback(excludeResetCreditDetails);
        this.lastError = null;
        return result;
      } catch (error) {
        lastError = error;
        // 页面诊断仅暴露固定故障类型，原始 RPC 数据和 stderr 留在后台。
        this.lastError = isLegacyRateLimitParamsError(error) ? 'codex_app_server_protocol_error'
          : isRecoverableTransportError(error) ? 'codex_app_server_transport_error'
          : error.message === 'codex_app_server_not_found' ? 'codex_app_server_not_found'
          : 'codex_app_server_read_failed';
        if (attempt === 0 && isRecoverableTransportError(error)) {
          this.disposeChild();
          continue;
        }
        throw error;
      }
    }

    throw lastError;
  }

  getDiagnostics() {
    return { binaryPath: this.binaryPath, binaryVersion: this.binaryVersion, initialized: this.initialized, lastError: this.lastError };
  }

  close() {
    const error = enrichError(
      new Error('codex_app_server_closed'),
      { stderrTail: this.stderrTail },
    );
    this.rejectAllPending(error);
    this.disposeChild();
    this.startPromise = null;
  }
}
