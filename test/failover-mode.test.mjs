import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readFailoverStatus } from '../src/failover-mode-adapter.mjs';

console.log('Testing: Failover Mode Adapter contract...');

// 1. Fallback when state file does not exist
const fallback = readFailoverStatus({ statePath: '/non/existent/path/quota-state.json' });
assert.equal(fallback.available, false);
assert.equal(fallback.mode, 'openai');
assert.equal(fallback.lifecycle_state, 'OPENAI_ACTIVE');

// 2. Parse mock external state file
const testDir = mkdtempSync(join(tmpdir(), 'failover-test-'));
try {
  const externalStatePath = join(testDir, 'quota-state.json');
  writeFileSync(externalStatePath, JSON.stringify({
    schema_version: 1,
    mode: 'external',
    effective_mode: 'external',
    lifecycle_state: 'EXTERNAL_ACTIVE',
    external_model: 'claude-sonnet-4-6',
    resets_at: 1790444241,
    resets_at_iso: '2026-09-26T17:37:21+00:00',
    last_checked_at: '2026-09-26T15:42:16+00:00',
  }));

  const externalStatus = readFailoverStatus({ statePath: externalStatePath });
  assert.equal(externalStatus.available, true);
  assert.equal(externalStatus.mode, 'external');
  assert.equal(externalStatus.lifecycle_state, 'EXTERNAL_ACTIVE');
  assert.equal(externalStatus.external_model, 'claude-sonnet-4-6');
  assert.equal(externalStatus.resets_at, 1790444241);

  // 3. Parse mock openai state file
  const openaiStatePath = join(testDir, 'quota-state-openai.json');
  writeFileSync(openaiStatePath, JSON.stringify({
    schema_version: 1,
    mode: 'openai',
    effective_mode: 'openai',
    lifecycle_state: 'OPENAI_ACTIVE',
  }));

  const openaiStatus = readFailoverStatus({ statePath: openaiStatePath });
  assert.equal(openaiStatus.available, true);
  assert.equal(openaiStatus.mode, 'openai');
  assert.equal(openaiStatus.lifecycle_state, 'OPENAI_ACTIVE');

} finally {
  rmSync(testDir, { recursive: true, force: true });
}

console.log('✓ Failover Mode Adapter contract passed!');
