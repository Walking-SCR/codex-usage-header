import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

console.log('Testing: phase-three lightweight UX contracts...');
const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'injected.js'), 'utf8');

assert.match(source, /staleIndicatorText\(\)/);
assert.match(source, /data-stale="true"/);
assert.match(source, /connection-status/);
assert.match(source, /function buildTokenSummary\(\)/);
assert.match(source, /navigator\.clipboard\?\.writeText/);
assert.match(source, /document\.execCommand\('copy'\)/);
assert.match(source, /coolingUntil/);
assert.match(source, /health\.recoveryAt/);
assert.match(source, /__codexUsageHeaderSetCommandAck__/);
assert.match(source, /finishRebalanceFeedback\(ack\.success \? 'success' : 'error'/);
assert.match(source, /togglePopoverFromCapsule\(\{ keyboard: true \}\)/);
assert.match(source, /host\?\.shadowRoot\?\.querySelector\('\.details-trigger'\)\?\.focus/);
assert.match(source, /token-folded-toggle/);

console.log('✓ Phase-three lightweight UX contracts passed!');
