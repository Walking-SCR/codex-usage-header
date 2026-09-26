import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

console.log('Testing: single-owner manual refresh contract...');

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const monitor = readFileSync(join(rootDir, 'src', 'monitor.mjs'), 'utf8');
const client = readFileSync(join(rootDir, 'src', 'account-client.mjs'), 'utf8');
const renderer = readFileSync(join(rootDir, 'src', 'injected.js'), 'utf8');

assert.match(monitor, /kind === 'refresh'/);
assert.match(monitor, /refreshIntervalSeconds/);
assert.match(monitor, /account\/rateLimits\/updated/);
assert.match(monitor, /!item\.state\.mounted/);
assert.match(monitor, /launchAndInject\(cdpPort, \{ launchIfNeeded: false \}\)/);
assert.match(client, /account\/rateLimits\/read/);
assert.match(renderer, /minimumSpinMs/);
assert.match(renderer, /refreshTimeoutMs/);
assert.match(renderer, /refreshState === 'loading'/);
assert.match(renderer, /metadata\.requestId === refreshRequestId/);
assert.match(renderer, /card-refresh/);
assert.doesNotMatch(renderer, /class="refresh-btn/);

// 执行生产错误处理函数：首读失败结束加载，已有快照失败不清空数值。
const errorHandler = renderer.match(/  function applyUsageError[\s\S]*?(?=  function saveInterval)/)?.[0];
assert.ok(errorHandler);
const applyError = new Function('usageState', 'errorInfo', 'metadata', `
  let vouchersLoading = true, refreshState = 'loading', refreshRequestId = 'test-refresh';
  let settled = null, renders = 0;
  const t = key => key;
  const renderAll = () => { renders++; };
  const settleRefresh = (status, message) => { settled = { status, message }; };
  ${errorHandler}
  applyUsageError(errorInfo, metadata);
  return { usageState, vouchersLoading, settled, renders };
`);
const failed = applyError({ status: 'loading' }, { kind: 'server' }, { requestId: 'test-refresh', fetchedAt: 42 });
assert.equal(failed.usageState.status, 'error');
assert.equal(failed.vouchersLoading, false);
assert.equal(failed.settled.status, 'error');
assert.equal(failed.usageState.lastUpdated, 42);
const cached = applyError({ status: 'ready', primary: { remainingPercent: 62 } }, { kind: 'timeout' }, {});
assert.equal(cached.usageState.primary.remainingPercent, 62);
assert.equal(cached.usageState.status, 'ready');
assert.equal(cached.usageState.error, 'usageErrorTimeout');
assert.equal(cached.settled, null, '其他刷新请求的错误不得结束当前请求');
assert.match(monitor, /payload && !refreshError/, '同一轮读取失败不得立即用旧 payload 清除错误');

console.log('✓ Single-owner manual refresh contract passed!');
