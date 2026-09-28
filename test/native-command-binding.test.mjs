import assert from 'node:assert/strict';
import { closeCdpSocket, subscribeToCdpBinding } from '../src/launcher.mjs';
import { parseNativeCommand } from '../src/monitor.mjs';

console.log('Testing: native CDP command binding and validation...');

const target = { id: 'test-target', webSocketDebuggerUrl: 'ws://127.0.0.1/test' };
const command = {
  type: 'command',
  command: { id: 'cmd-1', kind: 'refresh', payload: {}, manual: true, createdAt: Date.now() },
};
assert.deepEqual(parseNativeCommand(JSON.stringify(command), target), {
  ...command.command,
  target,
});
assert.deepEqual(parseNativeCommand(JSON.stringify({ type: 'lifecycle', visible: true, resync: true }), target), {
  kind: 'lifecycle', visible: true, resync: true, target,
});
assert.equal(parseNativeCommand(JSON.stringify({ type: 'command', command: { id: 'bad', kind: 'arbitrary-eval' } }), target), null);
assert.equal(parseNativeCommand('x'.repeat(16 * 1024 + 1), target), null);

const previousWebSocket = globalThis.WebSocket;
class FakeWebSocket {
  static OPEN = 1;
  static CONNECTING = 0;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = FakeWebSocket.CONNECTING;
    this.sent = [];
    FakeWebSocket.instances.push(this);
    queueMicrotask(() => {
      this.readyState = FakeWebSocket.OPEN;
      this.onopen?.();
    });
  }

  send(raw) {
    const message = JSON.parse(raw);
    this.sent.push(message);
    queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, result: {} }) }));
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }
}

try {
  globalThis.WebSocket = FakeWebSocket;
  const seen = [];
  const unsubscribe = await subscribeToCdpBinding(target.webSocketDebuggerUrl, 'codexUsageHeaderCommandV1', event => seen.push(event));
  const socket = FakeWebSocket.instances[0];
  assert.equal(socket.sent[0].method, 'Runtime.addBinding');
  socket.onmessage({ data: JSON.stringify({
    method: 'Runtime.bindingCalled',
    params: { name: 'codexUsageHeaderCommandV1', payload: JSON.stringify(command), executionContextId: 1 },
  }) });
  assert.equal(seen.length, 1);
  assert.equal(seen[0].payload, JSON.stringify(command));
  unsubscribe();
  closeCdpSocket(target.webSocketDebuggerUrl);
} finally {
  globalThis.WebSocket = previousWebSocket;
  closeCdpSocket(target.webSocketDebuggerUrl);
}

console.log('✓ Native CDP binding tests passed!');
