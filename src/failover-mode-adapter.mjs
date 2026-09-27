/**
 * 模式双向切换适配器 (Failover Mode Adapter)
 * 
 * 职责：
 * 1. 轻量读取 ~/.config/codex-cli-model-bridge/quota-state.json 获取当前运行模式（openai / external）
 * 2. 提供触发 `python3 ... quota_failover.py toggle --apply --restart` 的异步执行方法
 * 3. 切换完成后，触发打开【Codex Quota Header】APP，确保应用携带 CDP 端口启动并完成插件挂载
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';

const DEFAULT_STATE_PATH = join(
  homedir(),
  '.config/codex-cli-model-bridge/quota-state.json'
);

const DEFAULT_SCRIPT_PATH = join(
  homedir(),
  '.codex/skills/codex-autoheal-bridge/scripts/quota_failover.py'
);

const DEFAULT_APP_PATH = join(
  homedir(),
  'Applications/Codex Quota Header.app'
);

/**
 * 轻量读取当前模型切换模式与生命周期状态
 */
export function readFailoverStatus(options = {}) {
  const statePath = options.statePath || DEFAULT_STATE_PATH;

  const fallback = {
    available: false,
    mode: 'openai',
    lifecycle_state: 'OPENAI_ACTIVE',
    external_model: null,
    resets_at: null,
    resets_at_iso: null,
    last_checked_at: null,
  };

  if (!existsSync(statePath)) {
    return fallback;
  }

  try {
    const raw = readFileSync(statePath, 'utf8');
    const data = JSON.parse(raw);
    const mode = (data.mode === 'external' || data.effective_mode === 'external') ? 'external' : 'openai';
    const lifecycle_state = data.lifecycle_state || data.state_machine || (mode === 'external' ? 'EXTERNAL_ACTIVE' : 'OPENAI_ACTIVE');

    return {
      available: true,
      mode,
      lifecycle_state,
      external_model: data.external_model || null,
      resets_at: data.resets_at || data.last_analysis?.expected_recovery_at || null,
      resets_at_iso: data.resets_at_iso || data.last_analysis?.expected_recovery_at_iso || null,
      last_checked_at: data.last_checked_at || null,
    };
  } catch {
    return fallback;
  }
}

/**
 * 打开【Codex Quota Header】APP
 */
export function launchCodexQuotaHeaderApp(options = {}) {
  const appPath = options.appPath || DEFAULT_APP_PATH;
  if (existsSync(appPath)) {
    execFile('/usr/bin/open', [appPath], () => {});
  } else {
    execFile('/usr/bin/open', ['-a', 'Codex Quota Header'], () => {});
  }
}

/**
 * 触发双向交替切换命令
 * python3 ~/.codex/skills/codex-autoheal-bridge/scripts/quota_failover.py toggle --apply --restart
 * 执行后触发打开【Codex Quota Header】APP
 */
export function triggerToggleFailoverMode(options = {}) {
  const scriptPath = options.scriptPath || DEFAULT_SCRIPT_PATH;
  const pythonBin = options.pythonBin || process.env.CODEX_BRIDGE_PYTHON || process.env.PYTHON || 'python3';

  return new Promise((resolve) => {
    if (!existsSync(scriptPath)) {
      return resolve({ ok: false, error: 'script_not_found', path: scriptPath });
    }

    execFile(
      pythonBin,
      [scriptPath, 'toggle', '--apply', '--restart'],
      { timeout: 20000 },
      (error, stdout, stderr) => {
        // 模式切换命令执行后关闭了 app，触发延迟打开【Codex Quota Header】APP 重新拉起并完成注入
        setTimeout(() => {
          launchCodexQuotaHeaderApp(options);
        }, 1200);

        if (error) {
          return resolve({ ok: false, error: error.message, stderr: String(stderr || '') });
        }
        try {
          const parsed = JSON.parse(stdout.trim());
          resolve({ ok: true, data: parsed, output: stdout.trim() });
        } catch {
          resolve({ ok: true, output: stdout.trim() });
        }
      }
    );
  });
}
