import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { AppServerClient } from '../src/account-client.mjs';

console.log('Testing: Codex App Server rate-limit protocol compatibility...');

const dir = mkdtempSync(join(tmpdir(), 'codex-usage-header-appserver-'));
const logPath = join(dir, 'requests.jsonl');
const fakePath = join(dir, 'fake-app-server.mjs');

writeFileSync(fakePath, `
import { appendFileSync } from 'node:fs';
import readline from 'node:readline';

const logPath = ${JSON.stringify("${LOG_PATH}")};
`, 'utf8');

// 替换占位符，避免 JavaScript 字符串转义歧义。
let fakeSource = readFileSync(fakePath, 'utf8')
  .replace(JSON.stringify("${LOG_PATH}"), JSON.stringify(logPath));

fakeSource += String.raw`
const rl = readline.createInterface({ input: process.stdin });
const send = value => process.stdout.write(JSON.stringify(value) + '\n');

rl.on('line', line => {
  const message = JSON.parse(line);
  appendFileSync(logPath, JSON.stringify(message) + '\n');

  if (message.method === 'initialize' && message.id != null) {
    send({ jsonrpc: '2.0', id: message.id, result: { userAgent: 'fake-app-server' } });
    return;
  }

  if (message.method === 'initialized') return;

  if (message.method === 'account/rateLimits/read' && message.id != null) {
    const hasParams = Object.prototype.hasOwnProperty.call(message, 'params');

    if (hasParams && message.params && typeof message.params === 'object') {
      send({
        jsonrpc: '2.0',
        id: message.id,
        error: { code: -32602, message: 'Invalid params' }
      });
      return;
    }

    send({
      jsonrpc: '2.0',
      id: message.id,
      result: {
        rateLimits: {
          primary: { usedPercent: 12, resetsAt: 1234567890 },
          secondary: { usedPercent: 34, resetsAt: 1234567999 }
        }
      }
    });
    return;
  }

  if (message.method === 'boom' && message.id != null) {
    send({
      jsonrpc: '2.0',
      id: message.id,
      error: {
        code: -32099,
        message: 'boom',
        data: { reason: 'test' }
      }
    });
  }
});
`;

writeFileSync(fakePath, fakeSource, 'utf8');

const client = new AppServerClient({
  binaryPath: process.execPath,
  binaryArgsPrefix: [fakePath],
  requestTimeoutMs: 1500,
  initializeTimeoutMs: 1500,
});

const result = await client.readRateLimits({ excludeResetCreditDetails: true });
assert.equal(result.rateLimits.primary.usedPercent, 12);

const requests = readFileSync(logPath, 'utf8').trim().split('\n').map(JSON.parse);
const rateRequests = requests.filter(item => item.method === 'account/rateLimits/read');

assert.equal(rateRequests.length, 2, '应先尝试新协议，再回退旧协议');
assert.deepEqual(rateRequests[0].params, {
  supportsLunaReserve: true,
  excludeResetCreditDetails: true,
});
assert.equal(
  Object.prototype.hasOwnProperty.call(rateRequests[1], 'params'),
  false,
  '兼容回退必须完全省略 params',
);

await assert.rejects(
  client.request('boom', {}),
  error => (
    error?.code === -32099
    && error?.data?.reason === 'test'
    && error?.rpcMethod === 'boom'
  ),
  'JSON-RPC error.code/data/rpcMethod 必须完整保留',
);

client.close();
console.log('✓ Codex App Server compatibility tests passed!');
