import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  toShanghaiDate,
  formatTokenCount,
  classifyModel,
  TokenRollupEngine,
} from '../src/extended-usage.mjs';

console.log('Testing: extended token usage engine...');

// 1. Classification
assert.equal(classifyModel('gpt-5.6-sol'), 'GPT');
assert.equal(classifyModel('gpt-6-astra'), 'GPT');
assert.equal(classifyModel('o1-preview'), 'GPT');
assert.equal(classifyModel('o3-mini'), 'GPT');
assert.equal(classifyModel('gemini-3.8-flash-high'), 'Gemini');
assert.equal(classifyModel('gemini-2.5-pro'), 'Gemini');
assert.equal(classifyModel('deepseek-v4-flash'), 'Other');
assert.equal(classifyModel('claude-sonnet-4-6'), 'Other');
assert.equal(classifyModel('minimax-m3'), 'Other');

// 2. Number formatting
assert.equal(formatTokenCount(0), '0');
assert.equal(formatTokenCount(932), '932');
assert.equal(formatTokenCount(12400), '12.4K');
assert.equal(formatTokenCount(1920000), '1.92M');
assert.equal(formatTokenCount(1280000000), '1.28B');
assert.equal(formatTokenCount(640000), '640K');

// Chinese units (万, 亿)
assert.equal(formatTokenCount(0, 'zh-CN'), '0');
assert.equal(formatTokenCount(932, 'zh-CN'), '932');
assert.equal(formatTokenCount(12400, 'zh-CN'), '1.2万');
assert.equal(formatTokenCount(338600, 'zh-CN'), '33.9万');
assert.equal(formatTokenCount(1920000, 'zh-CN'), '192万');
assert.equal(formatTokenCount(37540000, 'zh-CN'), '3754万');
assert.equal(formatTokenCount(1460000000, 'zh-CN'), '14.6亿');
assert.equal(formatTokenCount(1280000000, 'zh-CN'), '12.8亿');

// 3. Timezone conversion
assert.equal(toShanghaiDate('2026-09-19T14:43:20.636Z'), '2026-09-19');
assert.equal(toShanghaiDate('2026-09-19T16:05:00.000Z'), '2026-09-20');

// 4. TokenRollupEngine Delta & Inode Tracking
const testDir = mkdtempSync(join(tmpdir(), 'token-test-'));
const storagePath = join(testDir, 'rollup.json');
const sessionsDir = join(testDir, 'sessions');

try {
  const engine = new TokenRollupEngine({ baseDir: testDir, storagePath, sessionsDir });
  const fileRecord = { inode: 101, offset: 0, lastTotal: undefined, currentModel: 'gpt-5.6-sol' };
  const todayDate = toShanghaiDate(Date.now());

  // Turn 1: GPT-5.6-sol with initial tokens
  engine.processLine(JSON.stringify({
    type: 'turn_context',
    payload: { model: 'gpt-5.6-sol' },
  }), fileRecord, todayDate);

  engine.processLine(JSON.stringify({
    type: 'event_msg',
    timestamp: new Date().toISOString(),
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1000 } } },
  }), fileRecord, todayDate);

  // Baseline established, no delta counted yet
  assert.equal(fileRecord.lastTotal, 1000);
  assert.equal(engine.data.days[todayDate], undefined);

  // Turn 2: same model, token increment
  engine.processLine(JSON.stringify({
    type: 'event_msg',
    timestamp: new Date().toISOString(),
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1600 } } },
  }), fileRecord, todayDate);

  assert.equal(fileRecord.lastTotal, 1600);
  assert.equal(engine.data.days[todayDate]['gpt-5.6-sol'], 600);

  // Duplicate token_count event (delta === 0), must ignore
  engine.processLine(JSON.stringify({
    type: 'event_msg',
    timestamp: new Date().toISOString(),
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 1600 } } },
  }), fileRecord, todayDate);
  assert.equal(engine.data.days[todayDate]['gpt-5.6-sol'], 600);

  // Model switch in same session: GPT -> Gemini -> GPT
  engine.processLine(JSON.stringify({
    type: 'turn_context',
    payload: { model: 'gemini-3.8-flash-high' },
  }), fileRecord, todayDate);

  engine.processLine(JSON.stringify({
    type: 'event_msg',
    timestamp: new Date().toISOString(),
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 2200 } } },
  }), fileRecord, todayDate);
  assert.equal(engine.data.days[todayDate]['gemini-3.8-flash-high'], 600);

  // Switch back to GPT
  engine.processLine(JSON.stringify({
    type: 'turn_context',
    payload: { model: 'gpt-5.6-sol' },
  }), fileRecord, todayDate);

  engine.processLine(JSON.stringify({
    type: 'event_msg',
    timestamp: new Date().toISOString(),
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 3000 } } },
  }), fileRecord, todayDate);
  assert.equal(engine.data.days[todayDate]['gpt-5.6-sol'], 1400);

  // total_tokens drop (delta < 0), must reset baseline without adding negative count
  engine.processLine(JSON.stringify({
    type: 'event_msg',
    timestamp: new Date().toISOString(),
    payload: { type: 'token_count', info: { total_token_usage: { total_tokens: 500 } } },
  }), fileRecord, todayDate);
  assert.equal(fileRecord.lastTotal, 500);
  assert.equal(engine.data.days[todayDate]['gpt-5.6-sol'], 1400); // unchanged

  // Incomplete line and corrupted line
  engine.processLine('', fileRecord, todayDate);
  engine.processLine('{ corrupt json', fileRecord, todayDate);
  assert.equal(fileRecord.lastTotal, 500);

  // Rollup calculations
  const rollup = engine.calculateRollup();
  const todayRange = rollup.today;
  const gptItem = todayRange.items.find(i => i.key === 'gpt');
  const geminiItem = todayRange.items.find(i => i.key === 'gemini');

  assert.equal(todayRange.total, 2000); // 1400 gpt + 600 gemini
  assert.equal(gptItem.tokens, 1400);
  assert.equal(gptItem.percent, '70.0%');
  assert.equal(geminiItem.tokens, 600);
  assert.equal(geminiItem.percent, '30.0%');
  // Total must strictly equal sum of items
  const sumTokens = todayRange.items.reduce((s, i) => s + i.tokens, 0);
  assert.equal(sumTokens, todayRange.total);

  // Test zero tokens: no NaN%
  const emptyEngine = new TokenRollupEngine({ baseDir: testDir });
  const emptyRollup = emptyEngine.calculateRollup();
  assert.equal(emptyRollup.today.total, 0);
  assert.equal(emptyRollup.today.totalFormatted, '0');
  assert.equal(emptyRollup.today.items[0].percent, '—');
  assert.equal(emptyRollup.today.items[1].percent, '—');

  // Test save and reload
  engine.dirty = true;
  engine.save(true);
  assert.equal(statSync(storagePath).mode & 0o777, 0o600);

  const reloaded = new TokenRollupEngine({ baseDir: testDir, storagePath });
  reloaded.load();
  assert.equal(reloaded.data.days[todayDate]['gpt-5.6-sol'], 1400);
  assert.equal(reloaded.data.days[todayDate]['gemini-3.8-flash-high'], 600);

  console.log('✓ Token rollup engine tests passed!');
} finally {
  rmSync(testDir, { recursive: true, force: true });
}
