/**
 * 跨平台路径管理与规范化。
 *
 * 遵循 Windows 与 macOS 规范：
 * - 低频设置放 Roaming（Windows: %APPDATA% / macOS: ~/Library/Application Support）
 * - 高频写入（Token 汇总、日志、缓存）放 Local（Windows: %LOCALAPPDATA% / macOS: ~/Library/Application Support）
 * - 会话与技能统一放用户目录（Windows: %USERPROFILE% / macOS: ~）
 */
import path from 'node:path';
import { homedir, tmpdir } from 'node:os';

const APP_NAME = 'Codex Quota Header';

function getPath(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function getRoamingAppDataDir({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const p = getPath(platform);
  if (platform === 'win32') {
    return env.APPDATA || p.join(home, 'AppData', 'Roaming');
  }
  if (platform === 'darwin') {
    return p.join(home, 'Library', 'Application Support');
  }
  return env.XDG_CONFIG_HOME || p.join(home, '.config');
}

export function getLocalAppDataDir({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const p = getPath(platform);
  if (platform === 'win32') {
    return env.LOCALAPPDATA || p.join(home, 'AppData', 'Local');
  }
  if (platform === 'darwin') {
    return p.join(home, 'Library', 'Application Support');
  }
  return env.XDG_DATA_HOME || p.join(home, '.local', 'share');
}

export function getSettingsPath(options = {}) {
  const platform = options.platform || process.platform;
  const p = getPath(platform);
  const base = getRoamingAppDataDir(options);
  return p.join(base, APP_NAME, 'settings.json');
}

export function getDataDir(options = {}) {
  const platform = options.platform || process.platform;
  const p = getPath(platform);
  const base = getLocalAppDataDir(options);
  return p.join(base, APP_NAME);
}

export function getRollupStoragePath(options = {}) {
  const platform = options.platform || process.platform;
  const p = getPath(platform);
  return p.join(getDataDir(options), 'token-rollup.json');
}

export function getSessionsDir({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const p = getPath(platform);
  const userHome = env.USERPROFILE || home;
  return p.join(userHome, '.codex', 'sessions');
}

export function getSkillPath({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const p = getPath(platform);
  const userHome = env.USERPROFILE || home;
  return p.join(userHome, '.codex', 'skills', 'codex-autoheal-bridge', 'SKILL.md');
}

export function getLockFilePath({ platform = process.platform, env = process.env } = {}) {
  if (env.CODEX_USAGE_HEADER_LOCK) {
    return env.CODEX_USAGE_HEADER_LOCK;
  }
  const p = getPath(platform);
  if (platform === 'win32') {
    return p.join(env.TEMP || env.TMP || tmpdir(), 'codex-usage-header-monitor.lock');
  }
  return p.join(tmpdir(), 'codex-usage-header-monitor.lock');
}

export function getPluginInstallDir({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const p = getPath(platform);
  const userHome = env.USERPROFILE || home;
  return p.join(userHome, '.codex', 'plugins', 'codex-usage-header');
}

export function getCliProxyApiAuthDir({ platform = process.platform, env = process.env, home = homedir() } = {}) {
  const p = getPath(platform);
  const userHome = env.USERPROFILE || home;
  return p.join(userHome, '.cli-proxy-api');
}
