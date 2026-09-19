import assert from 'node:assert/strict';
import {
  formatGeminiCountdown,
  matchGeminiStandardRow,
  GeminiQuotaManager,
} from '../src/extended-usage.mjs';

console.log('Testing: Gemini quota manager and matching contract...');

// 1. Countdown format tests
assert.deepEqual(formatGeminiCountdown(0), { zh: '即将重置', en: 'resets soon' });
assert.deepEqual(formatGeminiCountdown(45), { zh: '即将重置', en: 'resets soon' });
assert.deepEqual(formatGeminiCountdown(5520), { zh: '1h32min后重置', en: 'resets in 1h 32m' });
assert.deepEqual(formatGeminiCountdown(356400), { zh: '4天后重置', en: 'resets in 4d' });

// 2. Standard row matching
assert.equal(matchGeminiStandardRow('Gemini Models', '5h'), 'Gemini 5h');
assert.equal(matchGeminiStandardRow('Gemini Models', 'five-hour'), 'Gemini 5h');
assert.equal(matchGeminiStandardRow('Gemini Models', 'five_hour'), 'Gemini 5h');
assert.equal(matchGeminiStandardRow('Gemini Models', 'weekly'), 'Gemini 7d');
assert.equal(matchGeminiStandardRow('Gemini Models', '7d'), 'Gemini 7d');
assert.equal(matchGeminiStandardRow('Gemini Models', 'week'), 'Gemini 7d');
assert.equal(matchGeminiStandardRow('Claude and GPT models', 'weekly'), 'Claude & GPT 7d');
assert.equal(matchGeminiStandardRow('Claude and GPT models', '5h'), 'Claude & GPT 5h');
assert.equal(matchGeminiStandardRow('3p-models', '7d'), 'Claude & GPT 7d');
assert.equal(matchGeminiStandardRow('Shared Models', 'weekly'), 'Claude & GPT 7d');

// 3. Raw payload parsing (camelCase and snake_case support)
const manager = new GeminiQuotaManager();

const camelPayload = {
  groups: [
    {
      displayName: 'Gemini Models',
      buckets: [
        { window: '5h', remainingFraction: 0.68, resetTime: new Date(Date.now() + 5520000).toISOString() },
        { window: 'weekly', remainingFraction: 0.42, resetTime: new Date(Date.now() + 356400000).toISOString() },
      ],
    },
    {
      displayName: 'Claude and GPT models',
      buckets: [
        { window: 'weekly', remainingFraction: 0.95, resetTime: new Date(Date.now() + 356400000).toISOString() },
      ],
    },
  ],
};

const rowsCamel = manager.parseRawQuotaPayload(camelPayload);
assert.equal(rowsCamel.length, 3);
assert.equal(rowsCamel[0].label, 'Gemini 5h');
assert.equal(rowsCamel[0].remainingPercent, 68);
assert.equal(rowsCamel[0].unavailable, false);
assert.equal(rowsCamel[1].label, 'Gemini 7d');
assert.equal(rowsCamel[1].remainingPercent, 42);
assert.equal(rowsCamel[2].label, 'Claude & GPT 7d');
assert.equal(rowsCamel[2].remainingPercent, 95);

// Test snake_case payload
const snakePayload = {
  groups: [
    {
      display_name: 'gemini_models',
      buckets: [
        { window: 'five_hour', remaining_fraction: 0.0, reset_time: '2026-09-20T10:00:00Z' },
        { window: 'week', remaining_fraction: 0.50, reset_time: '2026-09-24T10:00:00Z' },
      ],
    },
  ],
};

const rowsSnake = manager.parseRawQuotaPayload(snakePayload);
assert.equal(rowsSnake[0].label, 'Gemini 5h');
assert.equal(rowsSnake[0].remainingPercent, 0); // explicitly 0 must stay 0%
assert.equal(rowsSnake[0].unavailable, false);
assert.equal(rowsSnake[1].label, 'Gemini 7d');
assert.equal(rowsSnake[1].remainingPercent, 50);
assert.equal(rowsSnake[2].label, 'Claude & GPT 7d');
assert.equal(rowsSnake[2].remainingPercent, null);
assert.equal(rowsSnake[2].unavailable, true); // missing data must not become 0%

// 4. Stale cache retention on error
manager.cache = {
  status: 'ready',
  plan: 'Gemini AI Pro',
  rows: rowsCamel,
  fetchedAt: 1000,
  stale: false,
  error: null,
};

// Simulate failure while having cached data
manager.fetchQuota = async () => {
  manager.cache = {
    ...manager.cache,
    stale: true,
    error: 'Simulated 500 error',
  };
  return manager.cache;
};

const result = await manager.fetchQuota();
assert.equal(result.stale, true);
assert.equal(result.rows[0].remainingPercent, 68); // retains previous good data!
assert.equal(result.error, 'Simulated 500 error');

console.log('✓ Gemini quota manager and matching contract passed!');
