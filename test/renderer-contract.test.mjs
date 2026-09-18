import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

console.log('Testing: renderer interaction and mounting contract...');

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(rootDir, 'src', 'injected.js'), 'utf8');

assert.match(source, /pointer-events:auto!important/);
assert.match(source, /-webkit-app-region:no-drag/);
assert.match(source, /codex-usage-header-v23/);
assert.match(source, /function renderComponent/);
assert.match(source, /attachShadow\(\{ mode: 'open' \}\)/);
assert.match(source, /account\/rateLimits\/read|usage bridge/i);
assert.match(source, /__codexUsageHeaderSetUsage__/);
assert.match(source, /__codexUsageHeaderSetRefreshError__/);
assert.match(source, /pointerenter/);
assert.match(source, /pointerleave/);
assert.match(source, /addEventListener\('click'/);
assert.match(source, /addEventListener\('pointerdown'/);
assert.match(source, /addEventListener\('mousedown'/);
assert.match(source, /popover.*body|body.*popover/s);
assert.match(source, /position:fixed;z-index:2147483646/);
assert.match(source, /@keyframes quota-refresh-spin/);
assert.match(source, /\}\}\.refresh-btn\{display:grid/);
assert.match(source, /align-items:center;gap:5px/);
assert.match(source, /\.track\{flex:none;width:70px;height:12px/);
assert.match(source, /\.divider\{flex:none;width:1px;height:16px;margin:0/);
assert.match(source, /data-refresh-state/);
assert.match(source, /requestId/);
assert.match(source, /usedPercent/);
assert.match(source, /剩余 \$\{p\.remainingPercent\}/);
assert.match(source, /resolveModeWithHysteresis/);
assert.match(source, /切换底部面板显示/);
assert.match(source, /显示\\\/隐藏侧边面板/);
assert.match(source, /placement = threadAction \? 'thread' : 'new-chat'/);
assert.match(source, /existing\.dataset\.placement = point\.placement/);
assert.match(source, /更新于刚刚/);
assert.match(source, /额度重置券/);
assert.doesNotMatch(source, /fixed-fallback/);
assert.doesNotMatch(source, /right:\s*'150px'/);
assert.doesNotMatch(source, />↻</);
assert.doesNotMatch(source, /remainingPercent:\s*72/);
assert.doesNotMatch(source, /remainingPercent:\s*86/);

console.log('✓ Renderer interaction and mounting contract passed!');
