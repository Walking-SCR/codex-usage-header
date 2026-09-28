import assert from 'node:assert/strict';
import { ExtendedUsageCoordinator, GeminiQuotaManager } from '../src/extended-usage.mjs';

console.log('Testing: extension settings gates and bounded Gemini concurrency...');

const coordinator = new ExtendedUsageCoordinator({ settings: {
  enableGoogleAiPro: false,
  enableTokenUsage: false,
  enableDynamicPriority: false,
} });
let tokenEnableCalls = [];
let tokenScans = 0;
let geminiFetches = 0;
coordinator.tokenEngine.setEnabled = enabled => tokenEnableCalls.push(enabled);
coordinator.tokenEngine.scanIncremental = async () => { tokenScans += 1; return true; };
coordinator.tokenEngine.getSnapshot = () => ({ status: 'ready' });
coordinator.geminiManager.fetchQuota = async () => { geminiFetches += 1; return { status: 'ready' }; };
coordinator.geminiManager.getSnapshot = () => ({ status: 'ready', accounts: [] });

coordinator.init();
assert.deepEqual(tokenEnableCalls, []);
assert.equal(geminiFetches, 0, 'disabled extensions must not make startup requests');
assert.equal((await coordinator.scanTokensIncremental()), false);
assert.equal(tokenScans, 0, 'disabled token tracking must not scan session files');
assert.equal(await coordinator.refreshGemini(), null, 'disabled quota fetch must be a no-op');

coordinator.updateSettings({ enableGoogleAiPro: true, enableTokenUsage: true, enableDynamicPriority: false });
assert.deepEqual(tokenEnableCalls, [true]);
assert.equal(geminiFetches, 1, 'enabling Gemini starts one initial quota fetch');
assert.equal(await coordinator.scanTokensIncremental(), true);
assert.equal(tokenScans, 1);

coordinator.updateSettings({ enableGoogleAiPro: false, enableTokenUsage: false, enableDynamicPriority: false });
assert.deepEqual(tokenEnableCalls, [true, false]);
assert.equal(await coordinator.scanTokensIncremental(), false);
assert.equal(tokenScans, 1, 'disabled token tracking must stop subsequent scans');
assert.equal(await coordinator.refreshGemini(), null);
assert.equal(geminiFetches, 1);
assert.equal(coordinator.getSnapshot().tokens.status, 'disabled');
assert.equal(coordinator.getSnapshot().antigravity.status, 'disabled');

const manager = new GeminiQuotaManager();
manager.findAllAntigravityAuthFiles = () => Array.from({ length: 8 }, (_, i) => `account-${i}`);
let active = 0;
let maxActive = 0;
manager.fetchQuotaForFile = async file => {
  active += 1;
  maxActive = Math.max(maxActive, active);
  await new Promise(resolve => setTimeout(resolve, 2));
  active -= 1;
  return { id: file, email: file, priority: 0, disabled: false, status: 'ready', rows: [{ label: 'Gemini 5h', remainingPercent: 50, unavailable: false }] };
};
const fetched = await manager.fetchQuota();
assert.equal(fetched.accounts.length, 8);
assert.ok(maxActive <= 2, `Gemini account fetch concurrency must be capped at 2, saw ${maxActive}`);

console.log('✓ Extension gates and Gemini concurrency tests passed!');
