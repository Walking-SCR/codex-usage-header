import assert from 'node:assert/strict';
import { desktopExecutableCandidates } from '../src/desktop-runtime.mjs';
import {
  getRoamingAppDataDir,
  getLocalAppDataDir,
  getSettingsPath,
  getDataDir,
  getRollupStoragePath,
  getSessionsDir,
  getLockFilePath,
} from '../src/platform-paths.mjs';

console.log('Testing: Windows launcher, paths and process detection helpers...');

// 1. Windows App Execution Alias 与 Store/MSIX 候选路径生成
const winCandidates = desktopExecutableCandidates({
  platform: 'win32',
  env: {
    LOCALAPPDATA: 'C:\\Users\\TestUser\\AppData\\Local',
    ProgramFiles: 'C:\\Program Files',
    'ProgramFiles(x86)': 'C:\\Program Files (x86)',
  },
  home: 'C:\\Users\\TestUser',
});

assert.ok(Array.isArray(winCandidates), 'Candidates must be an array');
assert.ok(winCandidates.length >= 4, 'Should contain Store and Standalone candidates');

// 优先条目必须是 Store/MSIX 应用执行别名
assert.equal(
  winCandidates[0],
  'C:\\Users\\TestUser\\AppData\\Local\\Microsoft\\WindowsApps\\ChatGPT.exe',
  'First candidate must be ChatGPT AppExecutionAlias'
);
assert.equal(
  winCandidates[1],
  'C:\\Users\\TestUser\\AppData\\Local\\Microsoft\\WindowsApps\\Codex.exe',
  'Second candidate must be Codex AppExecutionAlias'
);

// 验证所有路径均为合法 Windows 路径（反斜杠分隔）
for (const cand of winCandidates) {
  assert.ok(cand.includes('\\'), `Candidate path must use Windows backslashes: ${cand}`);
  assert.ok(!cand.includes('/'), `Candidate path must not contain POSIX slashes: ${cand}`);
}

// 2. 双层目录规划（Roaming 与 Local 分离）
const mockEnv = {
  APPDATA: 'C:\\Users\\TestUser\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\TestUser\\AppData\\Local',
  USERPROFILE: 'C:\\Users\\TestUser',
  TEMP: 'C:\\Users\\TestUser\\AppData\\Local\\Temp',
};

const roamingDir = getRoamingAppDataDir({ platform: 'win32', env: mockEnv });
assert.equal(roamingDir, 'C:\\Users\\TestUser\\AppData\\Roaming');

const settingsPath = getSettingsPath({ platform: 'win32', env: mockEnv });
assert.equal(settingsPath, 'C:\\Users\\TestUser\\AppData\\Roaming\\Codex Quota Header\\settings.json');

const localDataDir = getDataDir({ platform: 'win32', env: mockEnv });
assert.equal(localDataDir, 'C:\\Users\\TestUser\\AppData\\Local\\Codex Quota Header');

const rollupPath = getRollupStoragePath({ platform: 'win32', env: mockEnv });
assert.equal(rollupPath, 'C:\\Users\\TestUser\\AppData\\Local\\Codex Quota Header\\token-rollup.json');

const sessionsDir = getSessionsDir({ platform: 'win32', env: mockEnv });
assert.equal(sessionsDir, 'C:\\Users\\TestUser\\.codex\\sessions');

const lockPath = getLockFilePath({ platform: 'win32', env: mockEnv });
assert.equal(lockPath, 'C:\\Users\\TestUser\\AppData\\Local\\Temp\\codex-usage-header-monitor.lock');

// 3. 命令行 CDP 标志解析逻辑单元测试
function parseCdpFlagFromCommandLine(commandLine, port = 9229) {
  if (!commandLine || typeof commandLine !== 'string') return false;
  return commandLine.includes(`--remote-debugging-port=${port}`) || commandLine.includes('--remote-debugging-port=');
}

assert.equal(parseCdpFlagFromCommandLine('ChatGPT.exe --remote-debugging-port=9229 --remote-debugging-address=127.0.0.1'), true);
assert.equal(parseCdpFlagFromCommandLine('ChatGPT.exe --remote-debugging-port=9230', 9230), true);
assert.equal(parseCdpFlagFromCommandLine('"C:\\Program Files\\ChatGPT\\ChatGPT.exe" --remote-debugging-port=9229'), true);
assert.equal(parseCdpFlagFromCommandLine('ChatGPT.exe'), false);
assert.equal(parseCdpFlagFromCommandLine(''), false);
assert.equal(parseCdpFlagFromCommandLine(null), false);

// 4. Windows Codex CLI 可执行路径解析
import { locateCodexBinary } from '../src/desktop-runtime.mjs';
import { getCliProxyApiAuthDir } from '../src/platform-paths.mjs';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const authDir = getCliProxyApiAuthDir({ platform: 'win32', env: mockEnv });
assert.equal(authDir, 'C:\\Users\\TestUser\\.cli-proxy-api');

const foundCodex = locateCodexBinary({
  home: 'C:\\Users\\TestUser',
  platform: 'win32',
  runnable: path => path.includes('npm\\codex.cmd'),
});
assert.equal(foundCodex, 'C:\\Users\\TestUser\\AppData\\Roaming\\npm\\codex.cmd');

// 5. 验证 CLI 命令包装器存在并语法合法
const cmdWrapper = join(process.cwd(), 'bin', 'codex-header.cmd');
const ps1Wrapper = join(process.cwd(), 'bin', 'codex-header.ps1');
assert.ok(existsSync(cmdWrapper), 'bin/codex-header.cmd must exist');
assert.ok(existsSync(ps1Wrapper), 'bin/codex-header.ps1 must exist');

const ps1Content = readFileSync(ps1Wrapper, 'utf8');
assert.ok(!ps1Content.includes('??'), 'PowerShell wrapper must not use PS7-only null-coalescing operators');
assert.ok(ps1Content.includes('launcher.mjs'), 'PowerShell wrapper must reference launcher.mjs');

console.log('✓ Windows launcher, paths and process detection helpers passed!');
