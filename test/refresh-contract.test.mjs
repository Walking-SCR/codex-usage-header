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

console.log('✓ Single-owner manual refresh contract passed!');
