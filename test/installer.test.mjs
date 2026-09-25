import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { createServer } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { getMonitorStatus } from '../src/monitor-lock.mjs';

console.log('Testing: macOS installer and launcher wrapper...');

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(testDir);
const tempHome = mkdtempSync(join(tmpdir(), 'codex-usage-header-'));
const liveMonitorBefore = getMonitorStatus();
// HOME 本身不足以隔离运行实例：锁与 CDP 使用全局路径/端口。
const isolatedLock = join(tempHome, 'monitor.lock');
const server = createServer();
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const isolatedPort = server.address().port;
await new Promise(resolve => server.close(resolve));
assert.notEqual(isolatedPort, 9229, '卸载测试不得连接真实应用的默认 CDP 端口');
const testEnv = {
  ...process.env,
  HOME: tempHome,
  TMPDIR: tempHome,
  CODEX_USAGE_HEADER_LOCK: isolatedLock,
  CODEX_USAGE_HEADER_CDP_PORT: String(isolatedPort),
};

try {
  const installResult = spawnSync('/bin/bash', [join(rootDir, 'bin', 'install.sh')], {
    env: testEnv,
    encoding: 'utf8',
  });
  assert.equal(installResult.status, 0, installResult.stderr || installResult.stdout);

  const wrapper = join(tempHome, '.local', 'bin', 'codex-header');
  const app = join(tempHome, 'Applications', 'Codex Quota Header.app');
  const appExecutable = join(app, 'Contents', 'MacOS', 'Codex Quota Header');
  const appInfo = join(app, 'Contents', 'Info.plist');
  const installedLauncher = join(tempHome, '.codex', 'plugins', 'codex-usage-header', 'src', 'launcher.mjs');
  assert.equal(statSync(wrapper).mode & 0o111, 0o111, 'wrapper must be executable');
  const wrapperSource = readFileSync(wrapper, 'utf8');
  assert.match(wrapperSource, /^#!\/usr\/bin\/env bash\n/);
  assert.doesNotMatch(wrapperSource, /^ /);
  assert.match(wrapperSource, /\/opt\/homebrew\/bin\/node/);
  assert.match(wrapperSource, /\/usr\/local\/bin\/node/);
  assert.equal(statSync(installedLauncher).isFile(), true);
  assert.equal(statSync(appExecutable).mode & 0o111, 0o111, 'no-terminal app must be executable');
  assert.equal(statSync(appInfo).isFile(), true);
  assert.match(readFileSync(appInfo, 'utf8'), /Codex Quota Header/);
  const appLauncher = readFileSync(appExecutable, 'utf8');
  assert.match(appLauncher, /tell application \"ChatGPT\" to quit/);
  assert.match(appLauncher, /show_force_dialog/);
  assert.match(appLauncher, /Codex Quota Header\.log/);
  assert.doesNotMatch(appLauncher, /是否尝试退出普通 Codex/);

  const helpResult = spawnSync(wrapper, ['--help'], {
    env: {
      HOME: tempHome,
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      CODEX_USAGE_HEADER_NODE: process.execPath,
    },
    encoding: 'utf8',
  });
  assert.equal(helpResult.status, 0, helpResult.stderr || helpResult.stdout);
  assert.match(helpResult.stdout, /Usage: codex-header/);

  // P1-6 安全卸载：先停进程再删文件，默认保留设置与统计
  const uninstallSh = join(rootDir, 'bin', 'uninstall.sh');
  const uninstallSrc = readFileSync(uninstallSh, 'utf8');
  assert.match(uninstallSrc, /--teardown/, '卸载必须先做受控 teardown');
  assert.match(uninstallSrc, /monitor\.mjs/, '停止监控进程前必须核实身份');
  assert.match(uninstallSrc, /--purge/, '默认保留数据，--purge 才彻底清除');

  const dataDir = join(tempHome, 'Library', 'Application Support', 'Codex Quota Header');
  // 模拟一份用户数据
  spawnSync('/bin/mkdir', ['-p', dataDir]);
  spawnSync('/bin/sh', ['-c', `echo '{"a":1}' > "${join(dataDir, 'settings.json')}"`]);

  const uninstallResult = spawnSync('/bin/bash', [uninstallSh], {
    env: testEnv,
    encoding: 'utf8',
  });
  assert.equal(uninstallResult.status, 0, uninstallResult.stderr || uninstallResult.stdout);
  assert.equal(existsSync(join(tempHome, '.codex', 'plugins', 'codex-usage-header')), false, '插件目录应被删除');
  assert.equal(statSync(join(dataDir, 'settings.json')).isFile(), true, '默认必须保留设置数据');

  const purgeResult = spawnSync('/bin/bash', [uninstallSh, '--purge'], {
    env: testEnv,
    encoding: 'utf8',
  });
  assert.equal(purgeResult.status, 0, purgeResult.stderr || purgeResult.stdout);
  assert.equal(existsSync(dataDir), false, '--purge 必须清除设置与统计数据');
  if (liveMonitorBefore.running) {
    const liveMonitorAfter = getMonitorStatus();
    assert.equal(liveMonitorAfter.pid, liveMonitorBefore.pid, '隔离卸载测试不得停止真实监控');
    assert.equal(liveMonitorAfter.running, true, '隔离卸载测试必须保留真实监控');
  }
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('✓ Installer and launcher wrapper tests passed!');
