/** 监控进程与启动器共用的单实例锁。 */
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const MONITOR_LOCK_PATH = process.env.CODEX_USAGE_HEADER_LOCK
  || join(tmpdir(), 'codex-usage-header-monitor.lock');

const ownedLocks = new Map();
const pauseArray = new Int32Array(new SharedArrayBuffer(4));
const pause = ms => Atomics.wait(pauseArray, 0, 0, ms);

export function monitorCodeHash(installDir = join(dirname(fileURLToPath(import.meta.url)), '..')) {
  const hash = createHash('sha256');
  const srcDir = join(installDir, 'src');
  for (const file of readdirSync(srcDir).filter(name => name.endsWith('.mjs')).sort()) {
    hash.update(file).update(readFileSync(join(srcDir, file)));
  }
  return hash.digest('hex');
}

export function isPidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

// 锁中的 PID 可能已被系统复用；发信号前必须核实它仍是指定插件的监控器。
export function isMonitorProcess(pid, installDir) {
  if (!isPidAlive(pid) || !installDir) return false;
  const expected = join(resolve(installDir), 'src', 'monitor.mjs');
  try {
    const command = process.platform === 'win32'
      ? execFileSync('powershell.exe', ['-NoProfile', '-Command',
        `(Get-CimInstance Win32_Process -Filter 'ProcessId=${pid}').CommandLine`], { encoding: 'utf8' })
      : execFileSync('/bin/ps', ['-ww', '-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    const executable = command.trim().match(/^(?:"([^"]+)"|(\S+))/)?.[1]
      || command.trim().match(/^(?:"[^"]+"|(\S+))/)?.[1];
    if (!/(?:^|[\\/])node(?:\.exe)?$/i.test(executable || '')) return false;
    return command.includes(expected) || (process.platform === 'win32' && command.includes(expected.replaceAll('\\', '/')));
  } catch { return false; }
}

export function readMonitorLock(lockPath = MONITOR_LOCK_PATH) {
  let raw;
  try {
    raw = readFileSync(lockPath, 'utf8');
  } catch {
    return null;
  }
  try {
    const data = JSON.parse(raw);
    if (data && Number.isInteger(data.pid) && data.pid > 0) {
      return {
        pid: data.pid,
        installDir: typeof data.installDir === 'string' ? data.installDir : null,
        startedAt: Number.isInteger(data.startedAt) ? data.startedAt : null,
        codeHash: typeof data.codeHash === 'string' ? data.codeHash : null,
        ownerId: typeof data.ownerId === 'string' ? data.ownerId : null,
        legacy: false,
      };
    }
  } catch {
    // 非 JSON：按旧版纯 pid 文本格式解析
  }
  const pid = Number(String(raw).trim());
  if (Number.isInteger(pid) && pid > 0) {
    return { pid, installDir: null, startedAt: null, codeHash: null, ownerId: null, legacy: true };
  }
  return null;
}

export function getMonitorStatus(lockPath = MONITOR_LOCK_PATH) {
  const lock = readMonitorLock(lockPath);
  if (!lock) return { running: false, pid: null, installDir: null, codeHash: null, stale: false, legacy: false };
  if (isPidAlive(lock.pid)) {
    return { ...lock, running: true, stale: false };
  }
  return { ...lock, running: false, stale: true };
}

// 候选文件先完整写好，再用硬链接原子发布；旧锁回收由独立目录串行化。
export function acquireMonitorLock({ installDir = null, lockPath = MONITOR_LOCK_PATH, codeHash = null } = {}) {
  const ownerId = randomUUID();
  const candidate = `${lockPath}.${ownerId}.tmp`;
  const reclaim = `${lockPath}.reclaim`;
  const fd = openSync(candidate, 'wx', 0o600);
  try {
    writeFileSync(fd, JSON.stringify({ pid: process.pid, installDir, startedAt: Date.now(), codeHash, ownerId }));
  } catch (error) {
    closeSync(fd);
    unlinkSync(candidate);
    throw error;
  }
  closeSync(fd);
  try {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      // 整个检查、回收、发布过程串行化，而非只在删除旧锁时加保护。
      try { mkdirSync(reclaim); }
      catch (error) {
        if (error?.code !== 'EEXIST') throw error;
        pause(50);
        continue;
      }
      try {
        const status = getMonitorStatus(lockPath);
        if (status.running) return { acquired: false, ...status };
        // 旧版进程可能刚创建锁而未写入 PID，留出短暂写入窗口。
        if (!status.pid && existsSync(lockPath) && Date.now() - statSync(lockPath).mtimeMs < 1000) {
          pause(50);
          continue;
        }
        if (existsSync(lockPath)) {
          try { unlinkSync(lockPath); }
          catch (error) { if (error?.code !== 'ENOENT') throw error; }
        }
        linkSync(candidate, lockPath);
        ownedLocks.set(lockPath, ownerId);
        return { acquired: true, pid: process.pid, codeHash };
      } finally { rmdirSync(reclaim); }
    }
    throw new Error(`monitor_lock_busy: ${lockPath}`);
  } finally {
    try { unlinkSync(candidate); } catch { /* 候选文件已移除 */ }
  }
}

export function releaseMonitorLock(lockPath = MONITOR_LOCK_PATH) {
  const ownerId = ownedLocks.get(lockPath);
  if (!ownerId) return;
  try {
    const lock = readMonitorLock(lockPath);
    if (lock?.pid === process.pid && lock.ownerId === ownerId) unlinkSync(lockPath);
  } catch {
    // 锁已经释放时忽略异常
  }
  ownedLocks.delete(lockPath);
}
