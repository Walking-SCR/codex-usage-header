import assert from 'node:assert/strict';
import { isAccountAvailable, GeminiQuotaManager } from '../src/extended-usage.mjs';

console.log('Testing: Intelligent Google AI Pro active account selection & auto-failover...');

// 1. 有可用配额的账号应被视为可用
const healthyAccountA = {
  id: 'antigravity-accountA.json',
  email: 'accountA@gmail.com',
  label: 'accountA',
  status: 'ready',
  rows: [
    { label: 'Gemini 5h', remainingPercent: 100, unavailable: false },
    { label: 'Gemini 7d', remainingPercent: 62, unavailable: false },
    { label: 'Claude & GPT 7d', remainingPercent: 61, unavailable: false },
    { label: 'Claude & GPT 5h', remainingPercent: 100, unavailable: false },
  ],
};

const healthyAccountB = {
  id: 'antigravity-accountB.json',
  email: 'accountB@gmail.com',
  label: 'accountB',
  status: 'ready',
  rows: [
    { label: 'Gemini 5h', remainingPercent: 80, unavailable: false },
    { label: 'Gemini 7d', remainingPercent: 70, unavailable: false },
    { label: 'Claude & GPT 7d', remainingPercent: 90, unavailable: false },
    { label: 'Claude & GPT 5h', remainingPercent: 100, unavailable: false },
  ],
};

assert.equal(isAccountAvailable(healthyAccountA), true);
assert.equal(isAccountAvailable(healthyAccountB), true);

// 2. 账号 A 的 5 小时配额耗尽（Gemini 5h = 0）
const exhaustedAccountA = {
  ...healthyAccountA,
  rows: [
    { label: 'Gemini 5h', remainingPercent: 0, unavailable: false },
    { label: 'Gemini 7d', remainingPercent: 62, unavailable: false },
    { label: 'Claude & GPT 7d', remainingPercent: 61, unavailable: false },
    { label: 'Claude & GPT 5h', remainingPercent: 0, unavailable: false },
  ],
};

assert.equal(isAccountAvailable(exhaustedAccountA), false);

// 3. 测试管理器解析
const manager = new GeminiQuotaManager();
manager.cache = {
  status: 'ready',
  plan: 'Gemini AI Pro',
  accounts: [exhaustedAccountA, healthyAccountB],
  rows: [],
};

// 即使用户选择或默认账号是账号 A，由于账号 A 已耗尽，也应自动切换到账号 B。
manager.selectedAccount = 'accountA@gmail.com';
const snapshot = manager.getSnapshot();
assert.equal(snapshot.selectedAccount, 'accountB@gmail.com');

// 4. 测试基于优先级的初始默认账号选择
const priorityAccountLow = {
  ...healthyAccountA,
  priority: 50,
};
const priorityAccountHigh = {
  ...healthyAccountB,
  priority: 100,
};

const priorityManager = new GeminiQuotaManager();
priorityManager.cache = {
  status: 'ready',
  plan: 'Gemini AI Pro',
  accounts: [priorityAccountLow, priorityAccountHigh],
  rows: [],
};

// 没有手动覆盖时，优先级较高的账号（priority 100）必须被默认选中
priorityManager.selectedAccount = null;
const prioritySnapshot = priorityManager.getSnapshot();
assert.equal(prioritySnapshot.selectedAccount, 'accountB@gmail.com');
assert.equal(prioritySnapshot.accounts[0].email, 'accountB@gmail.com');

console.log('✓ Intelligent active account auto-failover passed!');
