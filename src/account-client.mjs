/**
 * Direct JSON-RPC client for the Codex App Server.
 * The renderer never receives credentials and no localhost HTTP bridge is
 * exposed. This process owns the single app-server connection.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';

function locateCodexBinary() {
  const home = process.env.HOME || '';
  const candidates = [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    `${home}/Applications/ChatGPT.app/Contents/Resources/codex`,
    '/usr/local/bin/codex',
  ];
  try { candidates.push(execFileSync('which', ['codex'], { encoding: 'utf8' }).trim()); } catch { /* optional */ }
  return candidates.find(candidate => candidate && existsSync(candidate));
}

export class AppServerClient {
  constructor({ onNotification } = {}) {
    this.child = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
    this.onNotification = onNotification;
  }

  async ensureStarted() {
    if (this.child && !this.child.killed) return;
    const binary = locateCodexBinary();
    if (!binary) throw new Error('codex_app_server_not_found');
    this.child = spawn(binary, ['app-server', '--stdio'], { stdio: ['pipe', 'pipe', 'ignore'] });
    this.child.stdout.on('data', chunk => this.onData(chunk));
    this.child.on('exit', () => {
      for (const pending of this.pending.values()) pending.reject(new Error('codex_app_server_exited'));
      this.pending.clear();
      this.child = null;
    });
    await this.request('initialize', {
      clientInfo: { name: 'codex-usage-header', version: '2.3.0' },
      capabilities: { experimentalApi: true },
    });
    this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'initialized', params: {} })}\n`);
  }

  onData(chunk) {
    this.buffer += chunk.toString();
    while (this.buffer.includes('\n')) {
      const index = this.buffer.indexOf('\n');
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      if (message.id === undefined || message.id === null) {
        this.onNotification?.(message);
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'codex_app_server_error'));
      else pending.resolve(message.result);
    }
  }

  request(method, params = {}) {
    return new Promise((resolve, reject) => {
      if (!this.child || this.child.killed) {
        reject(new Error('codex_app_server_not_running'));
        return;
      }
      const id = this.nextId++;
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method}_timeout`));
      }, 8000);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timeout); resolve(value); },
        reject: error => { clearTimeout(timeout); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async readRateLimits({ excludeResetCreditDetails = false } = {}) {
    await this.ensureStarted();
    return this.request('account/rateLimits/read', { excludeResetCreditDetails });
  }

  close() {
    this.child?.kill();
    this.child = null;
  }
}
