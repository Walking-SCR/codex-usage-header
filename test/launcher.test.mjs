import assert from 'node:assert/strict';
import { getStatus, selectRendererTargets, selectUsageTargets, getDesktopAppProcessInfo, isDesktopAppRunning } from '../src/launcher.mjs';

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

console.log('✓ Launcher target selection and offline status tests passed!');
