/**
 * 测试套件：更新后可靠重注入
 *
 * P0-4：用内容哈希（而非仅版本号）判断运行代码是否需要替换；
 * teardown 必须清理全部监听器、定时器与旧节点；重复注入不得叠加组件。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildInjectableScript } from '../src/launcher.mjs';

console.log('Testing: reliable re-injection...');

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(rootDir, 'src', 'injected.js'), 'utf8');

// ---- 内容哈希：任何代码改动都改变哈希 ----
const { scriptCode, contentHash } = buildInjectableScript();
assert.match(contentHash, /^[0-9a-f]{64}$/, 'contentHash 应为 sha256 hex');
assert.ok(!scriptCode.includes('__INJECTED_CONTENT_HASH__'), '占位符必须被真实哈希替换');
assert.ok(scriptCode.includes(`const CONTENT_HASH = '${contentHash}'`), '哈希必须注入到运行代码中');

const alteredHash = createHash('sha256').update(source + '\n// touch').digest('hex');
assert.notEqual(alteredHash, contentHash, '代码改动必须改变内容哈希');

// ---- 版本守卫：版本相同但哈希不同 → teardown + 重装；完全相同 → 仅 remount ----
assert.match(source, /window\.__codexUsageHeaderInstalled__ === RUNTIME_VERSION/);
assert.match(source, /window\.__codexUsageHeaderContentHash__ === CONTENT_HASH/);
assert.match(source, /window\.__codexUsageHeaderTeardown__\?\.\(\)/);
assert.match(source, /window\.__codexUsageHeaderContentHash__ = CONTENT_HASH/);

// ---- teardown 完整性 ----
assert.match(source, /offAllTrackedListeners\(\)/, 'teardown 必须移除全部追踪的监听器');
assert.match(source, /clearInterval\(countdownTimer\)/, 'teardown 必须清理倒计时定时器');
assert.match(source, /clearInterval\(healthTimer\)/, 'teardown 必须清理健康检查定时器');
assert.match(source, /LEGACY_COMPONENTS\.forEach/, 'teardown 必须移除旧版本遗留节点');
assert.match(source, /data-quota-capsule/, 'teardown 必须移除旧胶囊节点');
assert.match(source, /window\.__codexUsageHeaderInstalled__ = null/, 'teardown 必须清除安装标记');
assert.match(source, /window\.__codexUsageHeaderContentHash__ = null/, 'teardown 必须清除内容哈希');

// ---- document/window 级监听器全部走追踪注册 ----
const trackedOnCalls = source.match(/\bon\((document|window),/g) || [];
assert.ok(trackedOnCalls.length >= 8, `应有 ≥8 处追踪监听器注册，实际 ${trackedOnCalls.length}`);
assert.ok(!/document\.addEventListener\('pointerdown'/.test(source), 'document pointerdown 必须走追踪注册');
assert.ok(!/window\.addEventListener\('(resize|scroll|focus|storage)'/.test(source), 'window 监听器必须走追踪注册');
// host/popover 自身监听器随元素移除，不走追踪（避免误删）
assert.ok(/host\.addEventListener\('pointerover'/.test(source), 'host 自身监听器保持原样');

// ---- 重复注入不叠加：teardown 先行 + 挂载复用 ----
assert.match(source, /const existing = document\.querySelector\(HOST_TAG\)/);

console.log('✓ Reliable re-injection tests passed!');
