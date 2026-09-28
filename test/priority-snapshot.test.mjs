import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { exportQuotaSnapshot, readPoolStatus } from '../src/dynamic-priority-adapter.mjs';

console.log('Testing: weekly/5h quota snapshot and exhausted-pool projection...');

const dir = mkdtempSync(join(tmpdir(), 'quota-priority-snapshot-'));
try {
  const reset5h = Math.floor(Date.now() / 1000) + 1800;
  const reset7d = Math.floor(Date.now() / 1000) + 2 * 86400;
  const result = exportQuotaSnapshot([{
    email: 'hidden@example.test',
    rows: [
      { label: 'Gemini 5h', remainingPercent: 0, resetTime: reset5h, secondsRemaining: 1800 },
      { label: 'Gemini 7d', remainingPercent: 64, resetTime: reset7d, secondsRemaining: 2 * 86400 },
    ],
  }], { authDir: dir });
  assert.equal(result.ok, true);
  const snapshot = JSON.parse(readFileSync(join(dir, 'quota-snapshot.json'), 'utf8'));
  const account = snapshot.accounts['hidden@example.test'];
  assert.equal(account.gemini5hRemaining, 0);
  assert.equal(account.gemini5hResetAt, reset5h);
  assert.equal(account.gemini7dRemaining, 64);
  assert.equal(account.gemini7dResetAt, reset7d);

  writeFileSync(join(dir, 'pool-status.json'), JSON.stringify({
    mode: 'auto',
    primaryAccount: null,
    rankings: [{ email: 'hidden@example.test', status: 'FIVE_HOUR_EXHAUSTED', next_retry_after: new Date(reset5h * 1000).toISOString() }],
  }));
  const pool = readPoolStatus({ authDir: dir });
  assert.equal(pool.primaryAccount, null, 'an exhausted account must not be fabricated as route primary');
  assert.equal(pool.accountMap['hidden@example.test'].isPrimary, false);
  assert.equal(pool.accountMap['hidden@example.test'].rankLabel, '5h用尽');
  assert.equal(pool.accountMap['hidden@example.test'].recoveryAt, reset5h * 1000);
} finally {
  rmSync(dir, { recursive: true, force: true });
}

console.log('✓ Quota snapshot and exhausted-pool projection tests passed!');
