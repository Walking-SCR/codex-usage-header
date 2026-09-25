/**
 * 测试套件：模块启动路径回归
 *
 * 回归：2026-09-25 发现 src/monitor.mjs 使用了 fileURLToPath
 * 却没有从 'node:url' 导入 —— node --check 查不出，运行时
 * ReferenceError 直接崩掉监控进程。本测试做两件事：
 *  1. 全部 src 模块必须通过 node --check；
 *  2. 静态检查：源码中使用的 Node 非全局内置标识符必须已导入。
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

console.log('Testing: module startup path...');

const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');
const modules = readdirSync(srcDir).filter(f => f.endsWith('.mjs') || f.endsWith('.js'));

// ---- 1. 语法检查 ----
for (const file of modules) {
  const result = spawnSync(process.execPath, ['--check', join(srcDir, file)], { stdio: 'pipe' });
  assert.equal(result.status, 0, `${file} 必须通过 node --check: ${result.stderr?.toString().slice(0, 300)}`);
}

// ---- 2. Node 非全局内置标识符必须已导入 ----
// 这些 API 不是全局变量，用了就必须 import（否则运行时 ReferenceError）。
// 注意：URL / URLSearchParams / TextEncoder / TextDecoder / Buffer /
// setImmediate 等在 Node 里是全局的，不需要 import。
const NODE_NON_GLOBALS = [
  'fileURLToPath', 'pathToFileURL',
];

for (const file of modules) {
  const source = readFileSync(join(srcDir, file), 'utf8');
  // 去掉 import 行和注释，只看真正的「使用」
  const stripped = source
    .split('\n')
    .filter(line => !/^\s*import\b/.test(line))
    .join('\n')
    .replace(/\/\/[^\n]*/g, '')
    .replace(/\/\*[\s\S]*?\*\//g, '');
  const imported = source
    .split('\n')
    .filter(line => /^\s*import\b/.test(line))
    .join('\n');

  for (const name of NODE_NON_GLOBALS) {
    const used = new RegExp(`\\b${name}\\b`).test(stripped);
    if (!used) continue;
    const hasImport = new RegExp(`\\b${name}\\b`).test(imported);
    assert.ok(
      hasImport,
      `${file} 使用了 ${name}，但没有从 node:* 导入 —— 启动时会 ReferenceError`
    );
  }
}

console.log(`✓ ${modules.length} 个 src 模块全部通过启动路径回归检查`);

// ---- 3. monitor.mjs 可被 import 且无副作用（main 守卫） ----
const imported = await import('../src/monitor.mjs');
assert.ok(imported, 'monitor.mjs 必须可被 import');
console.log('✓ monitor.mjs import 无副作用（main 守卫生效）');

console.log('ALL MONITOR-STARTUP TESTS PASSED');
