/** 桌面 App 的可执行路径发现：优先正在运行的 Bundle / 进程，兼容新旧 CLI 打包目录与 Windows Store 应用。 */
import { execFile, execFileSync } from 'node:child_process';
import { accessSync, constants, statSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
let cachedDefaultCodexBinary = { path: undefined, expiresAt: 0 };

function getPath(platform = process.platform) {
  return platform === 'win32' ? path.win32 : path.posix;
}

export function desktopBundleCandidates({ home = homedir(), processPaths } = {}) {
  const p = getPath('darwin');
  if (!processPaths) {
    try { processPaths = execFileSync('/bin/ps', ['-ax', '-o', 'comm='], { encoding: 'utf8', timeout: 1500 }).split('\n'); }
    catch { processPaths = []; }
  }
  const active = processPaths.map(item => item.trim().match(/^(.*\/(?:ChatGPT|Codex)\.app)\/Contents\/MacOS\/(?:ChatGPT|Codex)$/)?.[1]).filter(Boolean);
  return [...new Set([...active,
    '/Applications/ChatGPT.app', p.join(home, 'Applications/ChatGPT.app'),
    '/Applications/Codex.app', p.join(home, 'Applications/Codex.app'),
  ])];
}

export function desktopExecutableCandidates(options = {}) {
  const platform = options.platform || process.platform;
  const p = getPath(platform);
  if (platform === 'win32') {
    const env = options.env || process.env;
    const home = options.home || homedir();
    const localAppData = env.LOCALAPPDATA || p.join(home, 'AppData', 'Local');
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    return [
      p.join(localAppData, 'Microsoft', 'WindowsApps', 'ChatGPT.exe'),
      p.join(localAppData, 'Microsoft', 'WindowsApps', 'Codex.exe'),
      p.join(localAppData, 'Programs', 'ChatGPT', 'ChatGPT.exe'),
      p.join(localAppData, 'Programs', 'Codex', 'Codex.exe'),
      p.join(programFiles, 'ChatGPT', 'ChatGPT.exe'),
      p.join(programFiles, 'Codex', 'Codex.exe'),
      p.join(programFilesX86, 'ChatGPT', 'ChatGPT.exe'),
      p.join(programFilesX86, 'Codex', 'Codex.exe'),
    ];
  }
  return desktopBundleCandidates(options).map(bundle => p.join(bundle, 'Contents/MacOS', bundle.endsWith('/Codex.app') ? 'Codex' : 'ChatGPT'));
}

function isRunnable(filePath) {
  try {
    if (!statSync(filePath).isFile()) return false;
    accessSync(filePath, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch { return false; }
}

export function locateCodexBinary({ home = homedir(), platform = process.platform, processPaths, runnable = isRunnable, findOnPath } = {}) {
  const p = getPath(platform);
  const bundled = platform === 'darwin' ? desktopBundleCandidates({ home, processPaths }).flatMap(bundle => [
    p.join(bundle, 'Contents/Resources/codex-cli/bin/codex'),
    p.join(bundle, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
    p.join(bundle, 'Contents/Resources/codex'),
  ]) : [];
  const fallback = platform === 'win32' ? [
    p.join(home, 'AppData', 'Local', 'Programs', 'codex', 'bin', 'codex.cmd'),
    p.join(home, 'AppData', 'Local', 'Programs', 'codex', 'codex.exe'),
    p.join(home, 'AppData', 'Roaming', 'npm', 'codex.cmd'),
    p.join(home, 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'codex.exe'),
    p.join(home, '.codex', 'bin', 'codex.cmd'),
    p.join(home, '.codex', 'bin', 'codex.exe'),
    p.join(home, '.local', 'bin', 'codex.cmd'),
    p.join(home, '.local', 'bin', 'codex.exe'),
  ] : ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', p.join(home, '.local/bin/codex'), '/usr/bin/codex'];
  const found = [...bundled, ...fallback].find(item => runnable(item));
  if (found) return found;
  try {
    const paths = findOnPath ? findOnPath() : execFileSync(platform === 'win32' ? 'where.exe' : '/usr/bin/which', ['codex'], { encoding: 'utf8', timeout: 1500, windowsHide: true });
    return String(paths).split(/\r?\n/).map(item => item.trim()).find(item => item && runnable(item));
  } catch { return undefined; }
}

export async function locateCodexBinaryAsync(options = {}) {
  const isDefault = Object.keys(options).length === 0;
  if (isDefault && cachedDefaultCodexBinary.path && Date.now() < cachedDefaultCodexBinary.expiresAt && isRunnable(cachedDefaultCodexBinary.path)) {
    return cachedDefaultCodexBinary.path;
  }
  const home = options.home || homedir();
  const platform = options.platform || process.platform;
  const runnable = options.runnable || isRunnable;
  let processPaths = options.processPaths;
  if (!processPaths && platform === 'darwin') {
    try {
      const { stdout } = await execFileAsync('/bin/ps', ['-ax', '-o', 'comm='], { encoding: 'utf8', timeout: 1500 });
      processPaths = stdout.split('\n');
    } catch {
      processPaths = [];
    }
  }
  const p = getPath(platform);
  const bundled = platform === 'darwin' ? desktopBundleCandidates({ home, processPaths }).flatMap(bundle => [
    p.join(bundle, 'Contents/Resources/codex-cli/bin/codex'),
    p.join(bundle, 'Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex'),
    p.join(bundle, 'Contents/Resources/codex'),
  ]) : [];
  const fallback = platform === 'win32' ? [
    p.join(home, 'AppData', 'Local', 'Programs', 'codex', 'bin', 'codex.cmd'),
    p.join(home, 'AppData', 'Local', 'Programs', 'codex', 'codex.exe'),
    p.join(home, 'AppData', 'Roaming', 'npm', 'codex.cmd'),
    p.join(home, 'AppData', 'Local', 'Microsoft', 'WindowsApps', 'codex.exe'),
    p.join(home, '.codex', 'bin', 'codex.cmd'),
    p.join(home, '.codex', 'bin', 'codex.exe'),
    p.join(home, '.local', 'bin', 'codex.cmd'),
    p.join(home, '.local', 'bin', 'codex.exe'),
  ] : ['/opt/homebrew/bin/codex', '/usr/local/bin/codex', p.join(home, '.local/bin/codex'), '/usr/bin/codex'];
  let found = [...bundled, ...fallback].find(item => runnable(item));
  if (!found) {
    try {
      const rawPaths = options.findOnPath
        ? options.findOnPath()
        : (await execFileAsync(platform === 'win32' ? 'where.exe' : '/usr/bin/which', ['codex'], { encoding: 'utf8', timeout: 1500, windowsHide: true })).stdout;
      found = String(rawPaths).split(/\r?\n/).map(item => item.trim()).find(item => item && runnable(item));
    } catch {
      found = undefined;
    }
  }
  if (isDefault && found) {
    cachedDefaultCodexBinary = { path: found, expiresAt: Date.now() + 60000 };
  }
  return found;
}
