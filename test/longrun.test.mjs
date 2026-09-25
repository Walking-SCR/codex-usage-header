/**
 * 测试套件：长期运行与体验
 *
 * P2：倒计时局部更新（不每秒全量重写胶囊）、命令去重缓存上限、
 * 旧节点清理、调试端口风险说明。
 */
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

console.log('Testing: long-run stability & UX...');

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const injected = readFileSync(join(rootDir, 'src', 'injected.js'), 'utf8');
const monitor = readFileSync(join(rootDir, 'src', 'monitor.mjs'), 'utf8');

// ---- 倒计时：updateCountdowns 内不得全量 renderHost，必须局部更新文本节点 ----
{
  const start = injected.indexOf('function updateCountdowns() {');
  assert.ok(start >= 0);
  const end = injected.indexOf('\n  function updatePopoverCountdowns()', start);
  const body = injected.slice(start, end);
  assert.ok(!/^\s*renderHost\(\);$/m.test(body), '每秒更新不得全量重写胶囊 DOM');
  assert.ok(body.includes("querySelector('.primary-countdown')"), '必须局部定位倒计时节点');
  assert.ok(body.includes('textContent'), '必须只更新文本节点');
}

// ---- 命令去重缓存：有上限、防无界增长 ----
assert.match(monitor, /seenCommands\.size > 2000/, '命令缓存必须有上限');
assert.match(monitor, /rememberCommand/, '添加命令必须走带上限的记账函数');
const directAdds = (monitor.match(/seenCommands\.add\(/g) || []).length;
assert.equal(directAdds, 1, 'seenCommands.add 只允许出现在 rememberCommand 内部，不得绕过上限直接 add');

// ---- 旧节点清理：teardown 移除遗留节点（P0-4 已覆盖，此处确认无回归） ----
assert.match(injected, /LEGACY_COMPONENTS\.forEach/);

// ---- 调试端口风险说明 ----
assert.equal(existsSync(join(rootDir, 'SECURITY.md')), true, '必须有 SECURITY.md 风险说明');
const security = readFileSync(join(rootDir, 'SECURITY.md'), 'utf8');
assert.match(security, /9229/);
assert.match(security, /127\.0\.0\.1/);
assert.match(security, /本机/);
const launcher = readFileSync(join(rootDir, 'src', 'launcher.mjs'), 'utf8');
assert.match(launcher, /SECURITY\.md/, 'launcher 头部注释应指向风险说明');

console.log('✓ Long-run stability & UX tests passed!');
