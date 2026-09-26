/** 桌面 App 的可执行路径发现：优先正在运行的 Bundle，兼容新旧 CLI 打包目录。 */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export function desktopBundleCandidates({ home = homedir(), processPaths } = {}) {
  if (!processPaths) {
    try { processPaths = execFileSync('/bin/ps', ['-ax', '-o', 'comm='], { encoding: 'utf8', timeout: 1500 }).split('\n'); }
    catch { processPaths = []; }
  }
  const active = processPaths.map(path => path.trim().match(/^(.*\/(?:ChatGPT|Codex)\.app)\/Contents\/MacOS\/(?:ChatGPT|Codex)$/)?.[1]).filter(Boolean);
  return [...new Set([...active,
    '/Applications/ChatGPT.app', join(home, 'Applications/ChatGPT.app'),
    '/Applications/Codex.app', join(home, 'Applications/Codex.app'),
  ])];
}

export function desktopExecutableCandidates(options = {}) {
  return desktopBundleCandidates(options).map(bundle => join(bundle, 'Contents/MacOS', bundle.endsWith('/Codex.app') ? 'Codex' : 'ChatGPT'));
}

function isRunnable(path) {
  try {
    if (!statSync(path).isFile()) return false;
    accessSync(path, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch { return false; }
}

export function locateCodexBinary({ home = homedir(), platform = process.platform, processPaths, runnable = isRunnable, findOnPath } = {}) {
  const bundled = platform === 'darwin' ? desktopBundleCandidates({ home, processPaths }).flatMap(bundle => [
    join(bundle, 'Contents/Resources/codex-cli/bin/codex'),
    join(bundle, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
    join(bundle, 'Contents/Resources/codex'),
  ]) : [];
  const fallback = platform === 'win32' ? [] : ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', join(home, '.local/bin/codex'), '/usr/bin/codex'];
  const found = [...bundled, ...fallback].find(path => runnable(path));
  if (found) return found;
  try {
    const paths = findOnPath ? findOnPath() : execFileSync(platform === 'win32' ? 'where.exe' : '/usr/bin/which', ['codex'], { encoding: 'utf8', timeout: 1500 });
    return String(paths).split(/\r?\n/).map(path => path.trim()).find(path => path && runnable(path));
  } catch { return undefined; }
}
