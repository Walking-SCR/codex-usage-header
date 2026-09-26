/** 新旧 Bundle 路径、GUI PATH、App Server 初始化和并发启动回归。 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { locateCodexBinary, desktopExecutableCandidates } from '../src/desktop-runtime.mjs';
import { AppServerClient } from '../src/account-client.mjs';

const discover = (paths, options = {}) => locateCodexBinary({ home: '/users/test', platform: 'darwin', processPaths: [], findOnPath: () => '', runnable: path => paths.includes(path), ...options });
const bundled = '/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
assert.equal(discover([bundled]), bundled);
assert.equal(discover(['/Applications/ChatGPT.app/Contents/Resources/codex']), '/Applications/ChatGPT.app/Contents/Resources/codex');
const codexBundle = '/Applications/Codex.app/Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex';
assert.equal(discover([codexBundle]), codexBundle);
const movedBundle = '/custom/ChatGPT.app/Contents/Resources/codex-cli/bin/codex';
assert.equal(discover([bundled, movedBundle], { processPaths: ['/custom/ChatGPT.app/Contents/MacOS/ChatGPT'] }), movedBundle);
assert.equal(discover(['/opt/homebrew/bin/codex']), '/opt/homebrew/bin/codex', 'GUI 的 PATH 缺少 Homebrew 时仍可定位');
assert.equal(discover(['/opt/custom/codex'], { findOnPath: () => '/opt/custom/codex\n' }), '/opt/custom/codex');
assert.equal(discover([], { findOnPath: () => '/missing/codex' }), undefined, 'PATH 输出仍须经过可执行校验');
assert.ok(desktopExecutableCandidates({ home: '/users/test', processPaths: [] }).includes('/Applications/Codex.app/Contents/MacOS/Codex'));

let spawns = 0;
const fixture = fileURLToPath(new URL('./fixtures/app-server-stub.mjs', import.meta.url));
const client = new AppServerClient({ binaryPath: process.execPath, spawnProcess: (_binary, args, options) => {
  spawns++;
  assert.deepEqual(args, ['app-server', '--stdio']);
  return spawn(process.execPath, [fixture], options);
} });
try {
  const results = await Promise.all([client.readRateLimits(), client.readRateLimits(), client.readRateLimits()]);
  assert.equal(spawns, 1, '并发请求必须共享初始化过程');
  for (const result of results) assert.equal(result.rateLimitsByLimitId.codex.primary.usedPercent, 22);
  assert.equal(client.getDiagnostics().initialized, true);
  assert.equal(client.getDiagnostics().lastError, null);
  const exited = once(client.child, 'exit');
  client.child.kill();
  await exited;
  assert.equal(client.getDiagnostics().initialized, false);
  const recovered = await client.readRateLimits();
  assert.equal(spawns, 2, '断线后的下一次读取必须重建并完成初始化');
  assert.equal(recovered.rateLimitsByLimitId.codex.primary.usedPercent, 22);
} finally { client.close(); }
const failed = new AppServerClient({ binaryPath: '/missing/codex-header-test-binary' });
try { await assert.rejects(failed.readRateLimits(), /codex_app_server_spawn_failed/); }
finally { failed.close(); }
console.log('✓ Desktop runtime discovery and App Server initialization passed');
