import assert from 'node:assert/strict';
import {
  getRoamingAppDataDir,
  getLocalAppDataDir,
  getSettingsPath,
  getDataDir,
  getRollupStoragePath,
  getSessionsDir,
  getSkillPath,
  getLockFilePath,
  getPluginInstallDir,
} from '../src/platform-paths.mjs';

console.log('Testing: platform paths contract...');

// 1. macOS defaults
const macHome = '/Users/testuser';
assert.equal(getRoamingAppDataDir({ platform: 'darwin', home: macHome }), '/Users/testuser/Library/Application Support');
assert.equal(getLocalAppDataDir({ platform: 'darwin', home: macHome }), '/Users/testuser/Library/Application Support');
assert.equal(getSettingsPath({ platform: 'darwin', home: macHome }), '/Users/testuser/Library/Application Support/Codex Quota Header/settings.json');
assert.equal(getDataDir({ platform: 'darwin', home: macHome }), '/Users/testuser/Library/Application Support/Codex Quota Header');
assert.equal(getRollupStoragePath({ platform: 'darwin', home: macHome }), '/Users/testuser/Library/Application Support/Codex Quota Header/token-rollup.json');
assert.equal(getSessionsDir({ platform: 'darwin', home: macHome, env: {} }), '/Users/testuser/.codex/sessions');
assert.equal(getSkillPath({ platform: 'darwin', home: macHome, env: {} }), '/Users/testuser/.codex/skills/codex-autoheal-bridge/SKILL.md');
assert.equal(getPluginInstallDir({ platform: 'darwin', home: macHome, env: {} }), '/Users/testuser/.codex/plugins/codex-usage-header');

// 2. Windows defaults (%APPDATA% for settings, %LOCALAPPDATA% for data/cache)
const winHome = 'C:\\Users\\testuser';
const winEnv = {
  APPDATA: 'C:\\Users\\testuser\\AppData\\Roaming',
  LOCALAPPDATA: 'C:\\Users\\testuser\\AppData\\Local',
  USERPROFILE: 'C:\\Users\\testuser',
  TEMP: 'C:\\Users\\testuser\\AppData\\Local\\Temp',
};
assert.equal(getRoamingAppDataDir({ platform: 'win32', env: winEnv, home: winHome }), 'C:\\Users\\testuser\\AppData\\Roaming');
assert.equal(getLocalAppDataDir({ platform: 'win32', env: winEnv, home: winHome }), 'C:\\Users\\testuser\\AppData\\Local');
assert.equal(getSettingsPath({ platform: 'win32', env: winEnv, home: winHome }), 'C:\\Users\\testuser\\AppData\\Roaming\\Codex Quota Header\\settings.json');
assert.equal(getDataDir({ platform: 'win32', env: winEnv, home: winHome }), 'C:\\Users\\testuser\\AppData\\Local\\Codex Quota Header');
assert.equal(getRollupStoragePath({ platform: 'win32', env: winEnv, home: winHome }), 'C:\\Users\\testuser\\AppData\\Local\\Codex Quota Header\\token-rollup.json');
assert.equal(getSessionsDir({ platform: 'win32', env: winEnv, home: winHome }), 'C:\\Users\\testuser\\.codex\\sessions');
assert.equal(getSkillPath({ platform: 'win32', env: winEnv, home: winHome }), 'C:\\Users\\testuser\\.codex\\skills\\codex-autoheal-bridge\\SKILL.md');
assert.equal(getPluginInstallDir({ platform: 'win32', env: winEnv, home: winHome }), 'C:\\Users\\testuser\\.codex\\plugins\\codex-usage-header');
assert.equal(getLockFilePath({ platform: 'win32', env: winEnv }), 'C:\\Users\\testuser\\AppData\\Local\\Temp\\codex-usage-header-monitor.lock');

// 3. Lock file custom override
assert.equal(getLockFilePath({ env: { CODEX_USAGE_HEADER_LOCK: '/custom/path.lock' } }), '/custom/path.lock');

console.log('✓ Platform paths contract passed!');
