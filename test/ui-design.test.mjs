/** 验证资源包视觉资产已接入，且下拉层沿用旧版紧凑尺寸。 */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const css = readFileSync(join(root, 'assets/ui-quota/design.css'), 'utf8');
const renderer = readFileSync(join(root, 'src/injected.js'), 'utf8');
const launcher = readFileSync(join(root, 'src/launcher.mjs'), 'utf8');

assert.match(css, /\.popover-shell\.quota-dashboard\{[\s\S]*?width:590px/);
assert.match(css, /\.popover-shell\.quota-dashboard\{[\s\S]*?max-height:calc\(100vh - 40px\)/);
assert.match(css, /\.quota-dashboard \.credit-details\{[^}]*grid-template-columns:repeat\(3,minmax\(0,1fr\)\)/);
assert.match(css, /\.quota-dashboard \.credit-detail\{min-height:52px/);
assert.match(css, /\.quota-dashboard \.usage-section \.row\{[\s\S]*?min-height:38px/);
assert.match(css, /quota-icon-btn\.header-module-toggle img,\.quota-dashboard \.header-module-toggle img\{width:24px;height:24px\}/);
assert.match(css, /\.quota-dashboard \.section-icon\{width:22px;height:22px\}/);
assert.match(css, /\.quota-dashboard \.usage-icon img\{width:18px;height:18px\}/);
assert.match(css, /\.quota-dashboard \.credit-icon\{width:22px;height:22px\}/);
assert.match(css, /\.quota-dashboard \.credit-detail \.coupon-lightning\{width:18px;height:18px/);
assert.match(css, /quota-extension-header:hover \+ \.quota-rebalance-tooltip/);
assert.match(css, /quota-extension-header:focus-within \+ \.quota-rebalance-tooltip/);
assert.match(css, /\.quota-rebalance-tooltip \{\s+display: none;\s+position: absolute;/);
assert.match(css, /\.quota-dashboard \.quota-icon-btn\{height:36px;min-width:36px;width:36px;padding:0;border-radius:9px\}/);
assert.match(css, /quota-extension-header\{gap:5px;margin-bottom:7px;flex-wrap:nowrap\}/);
assert.match(css, /quota-extension-header-actions\{display:flex;align-items:center;justify-content:flex-end;gap:4px;flex:1;min-width:0;width:auto\}/);
assert.match(css, /quota-extension-toggle\{position:relative;z-index:1;width:20px;height:20px;flex:none;padding:0\}/);
assert.match(css, /quota-extension-toggle::before\{content:"";position:absolute;inset:-6px\}/);
assert.match(css, /chevron-icon\{width:20px;height:20px\}/);
assert.match(css, /\.quota-dashboard \.quota-extension-row\{[\s\S]*?min-height:24px/);
assert.match(css, /\.quota-dashboard \.credit-detail\{min-height:52px/);
assert.match(css, /\.quota-dashboard \.usage-section \.row\{[\s\S]*?min-height:38px/);
assert.match(renderer, /Math\.min\(590, Math\.max\(280, window\.innerWidth - CONFIG\.viewportInset \* 2\)\)/);
assert.match(renderer, /green: '#34C759'/, 'quota progress keeps the established semantic green');
assert.match(renderer, /tokenDonutStops\(rangeData\)/);
assert.match(renderer, /function toggleUsageModule/);
assert.match(renderer, /moduleButton\('reset', 'coupon'/);
assert.match(renderer, /moduleButton\('google', 'sparkle'/);
assert.match(renderer, /moduleButton\('tokens', 'tokenChart'/);
assert.match(renderer, /card-section-heading[\s\S]*designIcon\('clock', 'section-icon'\)/);
assert.match(renderer, /id="quota-rebalance-tooltip" class="quota-rebalance-tooltip" role="tooltip"/);
assert.match(renderer, /aria-describedby="quota-rebalance-tooltip"/);
assert.doesNotMatch(renderer, /quota-rebalance-pill-btn" aria-label="' \+ esc\(rebalanceDescription\) \+ '" title=/);
assert.match(renderer, /quota-token-controls/);
assert.match(renderer, /token-model-pct.*item\.percent[\s\S]*token-model-amount/);
assert.match(renderer, /belowSpace = Math\.max/);
assert.match(renderer, /availableSpace = side === 'bottom' \? belowSpace : aboveSpace/);
assert.doesNotMatch(renderer, /header-settings-btn|header-export-btn|header-stats-btn/);
assert.match(renderer, /Math\.min\(naturalHeight, 200\)/, 'dropdown placement must reserve the native header area');
assert.match(renderer, /shell\.style\.maxHeight = boundedHeight \+ 'px'/, 'height must adapt to free viewport space');
assert.match(renderer, /const summaryItems = rangeData\.summaryItems \|\| rawItems/);
assert.match(renderer, /toggleClaudeRows/);
assert.match(renderer, /visibleProviderRows = claudeGptCollapsed/);
assert.match(renderer, /replace\(\/\^Claude/);
assert.match(renderer, /String\(row\.label\)\.replace\(\/\^Claude/);
assert.doesNotMatch(renderer, /5小时额度|每周额度/);
assert.match(css, /overflow-wrap:anywhere;overflow:visible;text-overflow:clip/);
assert.match(renderer, /aria-pressed="' \+ active/);
assert.match(launcher, /__codexUsageHeaderDesignCSS__/);
assert.match(launcher, /const DESIGN_DIR = join\(ASSET_DIR, 'ui-quota'\)/);

for (const asset of [
  'icons/common/app-logo.svg', 'icons/header/refresh.svg', 'icons/quota/clock.svg',
  'icons/quota/calendar.svg', 'icons/coupon/coupon.svg', 'icons/coupon/lightning.svg',
  'icons/coupon/info.svg', 'icons/google-ai-pro/sparkle.svg', 'icons/token/token-chart.svg',
  'backgrounds/coupon-wave.svg',
]) assert.ok(existsSync(join(root, 'assets/ui-quota', asset)), `${asset} must be present`);

console.log('✓ Compact 590px responsive UI and supplied asset contract passed');
