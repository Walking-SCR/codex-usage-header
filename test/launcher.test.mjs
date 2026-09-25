import assert from 'node:assert/strict';
import { getStatus, selectRendererTargets, selectUsageTargets, getDesktopAppProcessInfo, isDesktopAppRunning, classifyMountProbe, statusExitCode } from '../src/launcher.mjs';

console.log('Testing: launcher target selection and offline status...');

const targets = [
  { type: 'service_worker', title: 'worker', url: 'app://worker', webSocketDebuggerUrl: 'ws://worker' },
  { type: 'page', title: 'Codex', url: 'app://codex/index.html', webSocketDebuggerUrl: 'ws://codex' },
  { type: 'page', title: 'Other', url: 'https://example.com', webSocketDebuggerUrl: 'ws://other' },
];

assert.deepEqual(selectRendererTargets(targets).map(target => target.title), ['Codex']);
assert.deepEqual(selectRendererTargets([targets[2]]).map(target => target.title), ['Other']);
assert.deepEqual(selectUsageTargets([
  ...targets,
  { type: 'page', title: 'Main', url: 'app://-/index.html', webSocketDebuggerUrl: 'ws://main' },
  { type: 'page', title: 'Detached', url: 'app://-/index.html?initialRoute=%2Fsettings', webSocketDebuggerUrl: 'ws://detached' },
]).map(target => target.title), ['Main']);

const unusedPort = 65534;
const status = await getStatus(unusedPort);
assert.equal(status.cdpAvailable, false);
assert.equal(status.port, unusedPort);
assert.equal(status.mountedCount, 0);

const procInfo = getDesktopAppProcessInfo(9229);
assert.equal(typeof procInfo.running, 'boolean');
assert.equal(typeof procInfo.hasCdpFlag, 'boolean');
assert.equal(isDesktopAppRunning(), procInfo.running);

// P0-2：挂载四态分类——绝不把「未挂载」包装成成功
assert.equal(classifyMountProbe(null), 'not-installed');
assert.equal(classifyMountProbe({ installed: false }), 'not-installed');
assert.equal(classifyMountProbe({ installed: true, mounted: true, mountable: 'thread' }), 'mounted');
assert.equal(classifyMountProbe({ installed: true, mounted: false, mountable: null }), 'waiting');
assert.equal(classifyMountProbe({ installed: true, mounted: false, mountable: 'chat' }), 'failed');
// waiting 绝不能被当成 mounted
assert.notEqual(classifyMountProbe({ installed: true, mounted: false, mountable: null }), 'mounted');
assert.equal(statusExitCode({ installedCount: 1, mountedCount: 0, waitingCount: 0, failedCount: 1 }), 2,
  '已注入但挂载失败必须以失败状态退出');
assert.equal(statusExitCode({ installedCount: 1, mountedCount: 0, waitingCount: 1, failedCount: 0 }), 0);

console.log('✓ Launcher target selection and offline status tests passed!');
