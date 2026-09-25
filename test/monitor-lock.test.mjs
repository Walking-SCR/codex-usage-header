/**
 * 测试套件：监控单实例锁
 *
 * P0-3：不删除活进程持有的锁；启动器能区分「新监控已启动」与「现有监控继续运行」。
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  isPidAlive,
  isMonitorProcess,
  monitorCodeHash,
  readMonitorLock,
  getMonitorStatus,
  acquireMonitorLock,
  releaseMonitorLock,
} from '../src/monitor-lock.mjs';

console.log('Testing: monitor single-instance lock...');

const lockPath = join(tmpdir(), `codex-usage-header-lock-test-${process.pid}.lock`);
const cleanup = () => { try { unlinkSync(lockPath); } catch { /* ignore */ } };
cleanup();

// ---- isPidAlive：ESRCH=死，EPERM/无异常=活 ----
assert.equal(isPidAlive(process.pid), true, '当前进程必须判定为存活');
assert.equal(isPidAlive(-1), false);
assert.equal(isPidAlive(2147483647), false, '不存在的 pid 必须判定为死亡');
assert.equal(isPidAlive(0), false);
assert.equal(isPidAlive(Number.NaN), false);
assert.equal(isMonitorProcess(process.pid, '/tmp/fake'), false, '普通测试进程绝不是监控进程');
assert.match(monitorCodeHash(dirname(dirname(fileURLToPath(import.meta.url)))), /^[a-f0-9]{64}$/);

// ---- 旧版纯 pid 文本格式兼容 ----
writeFileSync(lockPath, String(process.pid));
{
  const lock = readMonitorLock(lockPath);
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.legacy, true);
  const status = getMonitorStatus(lockPath);
  assert.equal(status.running, true, '活进程持有的旧格式锁必须判定为运行中');
  assert.equal(status.stale, false);
}

// ---- 活锁不可被抢占 ----
{
  const result = acquireMonitorLock({ installDir: '/tmp/fake', lockPath });
  assert.equal(result.acquired, false, '绝不能抢占活进程持有的锁');
  assert.equal(result.pid, process.pid);
}

// ---- 死锁可被安全替换 ----
writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, installDir: '/old/dir', startedAt: 1 }));
{
  const before = getMonitorStatus(lockPath);
  assert.equal(before.running, false);
  assert.equal(before.stale, true);
  const result = acquireMonitorLock({ installDir: '/new/dir', lockPath });
  assert.equal(result.acquired, true, '持有者已死的过期锁必须可被替换');
  const lock = readMonitorLock(lockPath);
  assert.equal(lock.pid, process.pid);
  assert.equal(lock.installDir, '/new/dir', '新锁必须记录安装目录，供后台交接判断');
  assert.equal(lock.legacy, false);
}

// ---- releaseMonitorLock 只释放自己真正取得的锁（不是只比较 PID） ----
releaseMonitorLock(lockPath);
assert.equal(existsSync(lockPath), false, '取得锁的进程应可正常释放');
writeFileSync(lockPath, JSON.stringify({ pid: 2147483647, installDir: '/x', startedAt: 1 }));
releaseMonitorLock(lockPath);
assert.equal(existsSync(lockPath), true, '不得删除他人持有的锁');
writeFileSync(lockPath, JSON.stringify({ pid: process.pid, installDir: '/x', startedAt: 1 }));
releaseMonitorLock(lockPath);
assert.equal(existsSync(lockPath), true, '即使 PID 相同，也不得删除不是自己取得的锁');

// 不存在的目录须立即报错，绝不能递归重试直至栈溢出。
assert.throws(() => acquireMonitorLock({ lockPath: join(tmpdir(), `missing-codex-lock-${process.pid}`, 'lock') }),
  error => error?.code === 'ENOENT');

cleanup();

// 两个进程同时争抢同一个锁：完整写入后原子发布，恰好一个取得所有权。
const sharedLock = join(tmpdir(), `codex-usage-header-concurrency-${process.pid}.lock`);
const moduleUrl = new URL('../src/monitor-lock.mjs', import.meta.url).href;
const childCode = `import { acquireMonitorLock, releaseMonitorLock } from ${JSON.stringify(moduleUrl)};
  const result = acquireMonitorLock({ lockPath: ${JSON.stringify(sharedLock)}, installDir: '/tmp/test' });
  console.log(result.acquired ? 'owner' : 'other');
  if (result.acquired) { await new Promise(resolve => setTimeout(resolve, 650)); releaseMonitorLock(${JSON.stringify(sharedLock)}); }`;
const contender = () => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childCode], { stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  let error = '';
  child.stdout.on('data', chunk => { output += chunk; });
  child.stderr.on('data', chunk => { error += chunk; });
  child.on('error', reject);
  child.on('exit', code => code === 0 ? resolve(output.trim()) : reject(new Error(error)));
});
try {
  const result = await Promise.all([contender(), contender()]);
  assert.deepEqual(result.sort(), ['other', 'owner']);
} finally {
  try { unlinkSync(sharedLock); } catch { /* 测试进程已释放 */ }
}
console.log('✓ Monitor single-instance lock tests passed!');
