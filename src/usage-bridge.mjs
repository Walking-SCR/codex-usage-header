/**
 * Local-only usage bridge. It reads account/rateLimits/read from the same
 * app-server protocol used by Codex and exposes a small CORS-enabled JSON API.
 */
import { spawn, execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

const DEFAULT_PORT = 9230;
const APP_SERVER_IDLE_MS = 20000;

function locateCodexBinary() {
  const candidates = [
    '/Applications/ChatGPT.app/Contents/Resources/codex',
    `${process.env.HOME || ''}/Applications/ChatGPT.app/Contents/Resources/codex`,
    '/usr/local/bin/codex',
  ];
  if (process.platform !== 'win32') {
    try { candidates.push(execFileSync('which', ['codex'], { encoding: 'utf8' }).trim()); } catch { /* optional */ }
  }
  return candidates.find(Boolean) && candidates.find(existsSync);
}

function appIsRunning() {
  if (process.platform !== 'darwin') return true;
  try {
    const processes = execFileSync('/bin/ps', ['-ax', '-o', 'command='], { encoding: 'utf8' });
    const candidates = [
      '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT',
      `${process.env.HOME || ''}/Applications/ChatGPT.app/Contents/MacOS/ChatGPT`,
    ];
    return processes.split('\n').some(line => {
      const command = line.trim();
      return candidates.some(candidate => command === candidate || command.startsWith(`${candidate} `));
    });
  } catch { return false; }
}

class AppServerClient {
  constructor() {
    this.child = null;
    this.buffer = '';
    this.nextId = 1;
    this.pending = new Map();
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
    await this.request('initialize', { clientInfo: { name: 'codex-usage-header', version: '2.0.0' }, capabilities: { experimentalApi: true } });
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
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message || 'codex_app_server_error'));
      else pending.resolve(message.result);
    }
  }

  request(method, params) {
    return new Promise((resolve, reject) => {
      const id = this.nextId++;
      const timeout = setTimeout(() => { this.pending.delete(id); reject(new Error(`${method}_timeout`)); }, 8000);
      this.pending.set(id, {
        resolve: value => { clearTimeout(timeout); resolve(value); },
        reject: error => { clearTimeout(timeout); reject(error); },
      });
      this.child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  async readUsage() {
    await this.ensureStarted();
    return this.request('account/rateLimits/read', { excludeResetCreditDetails: false });
  }

  close() { this.child?.kill(); }
}

function createServer(port) {
  const client = new AppServerClient();
  let cache = null;
  let cacheAt = 0;
  const server = http.createServer(async (request, response) => {
    response.setHeader('Access-Control-Allow-Origin', '*');
    response.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    response.setHeader('Cache-Control', 'no-store');
    if (request.method === 'OPTIONS') { response.writeHead(204); response.end(); return; }
    const url = new URL(request.url || '/', `http://127.0.0.1:${port}`);
    if (request.method !== 'GET' || !['/usage', '/health'].includes(url.pathname)) { response.writeHead(404); response.end(); return; }
    if (url.pathname === '/health') { response.writeHead(200, { 'Content-Type': 'application/json' }); response.end(JSON.stringify({ ok: true })); return; }
    try {
      const forceFresh = url.searchParams.get('fresh') === '1';
      if (forceFresh || !cache || Date.now() - cacheAt > 10000) { cache = await client.readUsage(); cacheAt = Date.now(); }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify(cache));
    } catch (error) {
      response.writeHead(503, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ error: error.message }));
    }
  });
  server.listen(port, '127.0.0.1');
  const idleTimer = setInterval(() => { if (!appIsRunning()) { clearInterval(idleTimer); client.close(); server.close(() => process.exit(0)); } }, 5000);
  return server;
}

export async function ensureUsageBridge(port = DEFAULT_PORT) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    if (response.ok) return port;
  } catch { /* start it below */ }
  const child = spawn(process.execPath, [fileURLToPath(new URL('./usage-bridge.mjs', import.meta.url)), '--serve', '--port', String(port)], { detached: true, stdio: 'ignore' });
  child.unref();
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try { const response = await fetch(`http://127.0.0.1:${port}/health`); if (response.ok) return port; } catch { /* wait */ }
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('usage_bridge_not_ready');
}

if (process.argv.includes('--serve')) {
  const index = process.argv.indexOf('--port');
  createServer(Number(index >= 0 ? process.argv[index + 1] : DEFAULT_PORT));
}
