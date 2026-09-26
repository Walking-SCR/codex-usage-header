import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const injectedJs = readFileSync(join(__dirname, '../src/injected.js'), 'utf8');
const designCss = readFileSync(join(__dirname, '../assets/ui-quota/design.css'), 'utf8');
const extendedUsageMjs = readFileSync(join(__dirname, '../src/extended-usage.mjs'), 'utf8');

test('Token Usage V4: allTime range is fully supported across rollup and renderer', () => {
  assert.match(extendedUsageMjs, /allTime:\s*formatRange\(aggregates\.allTime\)/, 'rollup exports allTime aggregate');
  assert.match(injectedJs, /data-range="allTime"/, 'rangeTabs includes allTime tab');
  assert.match(injectedJs, /allTime:\s*'累计'/, 'i18n zh-CN includes allTime');
  assert.match(injectedJs, /\['today',\s*'days7',\s*'days30',\s*'allTime'\]\.includes\(range\)/, 'range selector handles allTime click');
});

test('Token Usage V4: Global total is placed on top of donut without bar chart, hidden in summary', () => {
  assert.match(injectedJs, /selectedModel !== 'all'\s*\?\s*'<div class="token-global-stat"/, 'hidden in allModels summary mode');
  assert.match(injectedJs, /token-global-stat-label[\s\S]*token-global-stat-value/, 'label and value structure');
  assert.match(designCss, /\.quota-dashboard \.token-global-stat/, 'CSS styling for global stat capsule');
  assert.doesNotMatch(injectedJs, /token-global-stat-start/, '始于... is deleted from global stat tag');
  assert.doesNotMatch(injectedJs, /class="token-family-summary"/, 'old bottom subtotal container removed');
});

test('Token Usage V4: Model table header row is completely removed', () => {
  assert.doesNotMatch(injectedJs, /<div class="token-model-columns">/, 'table header is removed');
});

test('Token Usage V4: Long-tail models (>4) support click-to-expand detail', () => {
  assert.match(injectedJs, /models\.length > 4/, 'folding threshold logic exists');
  assert.match(injectedJs, /token-folded-toggle/, 'fold toggle class exists');
  assert.match(injectedJs, /otherModelsExpanded/, 'otherModelsExpanded state exists');
  assert.match(designCss, /\.quota-dashboard \.token-model-row\.is-folded-other\.token-folded-toggle/, 'CSS for clickable folded other row');
});

test('Token Usage V4: Dedicated 1-row Hero Card and 2-row Dual Cards are supported', () => {
  assert.match(injectedJs, /single-model-hero-card/, '1-row Hero card container exists');
  assert.match(injectedJs, /singleModelDedicated/, 'dedicated occupancy badge text');
  assert.match(injectedJs, /dual-cards-stack/, '2-row dual cards container exists');
  assert.match(injectedJs, /dual-subcard/, 'dual subcard item exists');
  assert.match(designCss, /\.quota-dashboard \.single-model-hero-card/, 'CSS for 1-row Hero card');
  assert.match(designCss, /\.quota-dashboard \.dual-cards-stack/, 'CSS for 2-row dual cards');
});

test('Token Usage V4: Scheme B permanent accumulator in backend', () => {
  assert.match(extendedUsageMjs, /historicalTotals/, 'historicalTotals accumulator exists');
  assert.match(extendedUsageMjs, /getEarliestDate/, 'getEarliestDate method exists');
});
