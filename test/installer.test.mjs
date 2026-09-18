import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

console.log('Testing: macOS installer and launcher wrapper...');

const testDir = dirname(fileURLToPath(import.meta.url));
const rootDir = dirname(testDir);
const tempHome = mkdtempSync(join(tmpdir(), 'codex-usage-header-'));

try {
  const installResult = spawnSync('/bin/bash', [join(rootDir, 'bin', 'install.sh')], {
    env: { ...process.env, HOME: tempHome },
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
} finally {
  rmSync(tempHome, { recursive: true, force: true });
}

console.log('✓ Installer and launcher wrapper tests passed!');
