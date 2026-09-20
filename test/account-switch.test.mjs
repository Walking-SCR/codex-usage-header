import assert from 'node:assert/strict';
import { isAccountAvailable, GeminiQuotaManager } from '../src/extended-usage.mjs';

console.log('Testing: Intelligent Google AI Pro active account selection & auto-failover...');

// 1. Account with available quota is considered available
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

// 2. Account A runs out of 5h quota (Gemini 5h = 0)
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

// 3. Test manager resolution
const manager = new GeminiQuotaManager();
manager.cache = {
  status: 'ready',
  plan: 'Gemini AI Pro',
  accounts: [exhaustedAccountA, healthyAccountB],
  rows: [],
};

// Even if user or default was accountA, because accountA is exhausted, it automatically fails over to accountB!
manager.selectedAccount = 'accountA@gmail.com';
const snapshot = manager.getSnapshot();
assert.equal(snapshot.selectedAccount, 'accountB@gmail.com');

// 4. Test priority-based initial default selection
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

// With no manual override, high priority account (priority 100) must be selected by default
priorityManager.selectedAccount = null;
const prioritySnapshot = priorityManager.getSnapshot();
assert.equal(prioritySnapshot.selectedAccount, 'accountB@gmail.com');
assert.equal(prioritySnapshot.accounts[0].email, 'accountB@gmail.com');

console.log('✓ Intelligent active account auto-failover passed!');
