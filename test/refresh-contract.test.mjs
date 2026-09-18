import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

console.log('Testing: acknowledged manual refresh contract...');

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const monitor = readFileSync(join(rootDir, 'src', 'monitor.mjs'), 'utf8');
const bridge = readFileSync(join(rootDir, 'src', 'usage-bridge.mjs'), 'utf8');
const renderer = readFileSync(join(rootDir, 'src', 'injected.js'), 'utf8');

assert.match(monitor, /\?fresh=1/);
assert.match(monitor, /requestId/);
assert.match(monitor, /SetRefreshError/);
assert.match(bridge, /searchParams\.get\('fresh'\) === '1'/);
assert.match(renderer, /minimumSpinMs/);
assert.match(renderer, /refreshTimeoutMs/);
assert.match(renderer, /refreshState === 'loading'/);
assert.match(renderer, /matchingAck/);

console.log('✓ Acknowledged manual refresh contract passed!');
