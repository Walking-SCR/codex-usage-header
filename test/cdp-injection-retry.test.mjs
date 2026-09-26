import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { injectScriptIntoTarget, evaluateInTarget, closeAllCdpSockets } from '../src/launcher.mjs';

console.log('Testing: CDP injection timeout/retry contract...');
const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const launcher = readFileSync(join(rootDir, 'src', 'launcher.mjs'), 'utf8');

assert.match(launcher, /CDP_EVALUATION_TIMEOUT_MS = 8000/);
assert.match(launcher, /CDP_INJECTION_TIMEOUT_MS = 20000/);
assert.match(launcher, /CDP_INJECTION_RETRY_DELAY_MS = 300/);
assert.match(launcher, /export function closeCdpSocket\(wsUrl\)/);
assert.match(launcher, /closeCdpSocket\(wsUrl\);\s*reject\(new Error\('cdp_evaluation_timeout'\)\)/s);
assert.match(launcher, /function isRetryableCdpInjectionError/);
assert.match(launcher, /async function evaluateInjectionWithRetry/);
assert.match(launcher, /attempt < 2/);
assert.match(launcher, /evaluateInTarget\(wsUrl, scriptCode, CDP_INJECTION_TIMEOUT_MS\)/);
assert.match(launcher, /await evaluateInjectionWithRetry\(wsUrl, scriptCode\)/);
assert.match(launcher, /const deadline = Date\.now\(\) \+ 6000/);

// 模拟旧连接延迟关闭，确保重试后的新连接不会被旧 onclose 从连接池删掉。
const NativeWebSocket = globalThis.WebSocket;
let sockets = 0;
class TestWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  constructor() {
    this.serial = ++sockets;
    this.readyState = 0;
    queueMicrotask(() => { this.readyState = 1; this.onopen?.(); });
  }
  send(raw) {
    const message = JSON.parse(raw);
    const response = this.serial === 1
      ? { id: message.id, error: { message: 'temporary connection failure' } }
      : { id: message.id, result: { result: { value: message.params.expression === 'retry-script'
        ? true : { installed: true, mounted: true, placement: 'thread' } } } };
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify(response) }));
  }
  close() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    if (this.serial === 1) setTimeout(() => this.onclose?.(), 350);
    else queueMicrotask(() => this.onclose?.());
  }
}
globalThis.WebSocket = TestWebSocket;
try {
  const result = await injectScriptIntoTarget('ws://quota-test.invalid', 'retry-script');
  assert.equal(result.status, 'mounted');
  await evaluateInTarget('ws://quota-test.invalid', 'probe');
  assert.equal(sockets, 2, '旧 close 回调不得丢弃重试建立的新 socket');
} finally {
  closeAllCdpSockets();
  globalThis.WebSocket = NativeWebSocket;
}
console.log('✓ CDP injection timeout/retry contract passed!');
