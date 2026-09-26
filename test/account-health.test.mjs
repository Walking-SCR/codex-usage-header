/** 账号异常标记、旧配额缓存、隐私过滤与只读展示选择的回归测试。 */
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAccountHealth } from '../src/account-health.mjs';
import { GeminiQuotaManager } from '../src/extended-usage.mjs';

const healthy = { id: 'antigravity-main.json', email: 'main@example.test', label: 'main', status: 'ready', priority: 100, rows: [
  { label: 'Gemini 5h', remainingPercent: 99, unavailable: false },
  { label: 'Gemini 7d', remainingPercent: 80, unavailable: false },
] };
const backup = { ...healthy, id: 'antigravity-backup.json', email: 'backup@example.test', label: 'backup', priority: 50, rows: healthy.rows.map(row => ({ ...row, remainingPercent: 44 })) };
const validation = '403 VALIDATION_REQUIRED https://secret.example.test/verify?token=must-not-leak';
assert.equal(getAccountHealth({ error: '503 auth_unavailable' }).state, 'unavailable');
assert.equal(getAccountHealth({ error: validation }).code, 'validation_required');
assert.equal(getAccountHealth({ error: 'auth_expired' }).state, 'unavailable');
assert.equal(getAccountHealth(healthy, { status: 'BLOCKED', reason: 'validation_required' }).code, 'validation_required');
assert.equal(getAccountHealth(healthy, { status: 'COOLING', reason: 'quota' }).state, 'cooling');
assert.equal(getAccountHealth({ ...healthy, stale: true, error: 'ECONNRESET' }).state, 'unknown');
assert.equal(getAccountHealth(healthy).state, 'healthy');
assert.equal(getAccountHealth({ ...healthy, rows: [{ remainingPercent: 0 }] }).state, 'healthy', '余额耗尽不是登录凭证异常');
assert.ok(!JSON.stringify(getAccountHealth({ error: validation })).includes('secret.example'));
const standaloneClassifier = new Function(`return (${getAccountHealth.toString()});`)();
assert.deepEqual(standaloneClassifier({ error: '503 auth_unavailable' }), getAccountHealth({ error: '503 auth_unavailable' }), '浏览器和 Node 共用无闭包依赖的分类规则');

const dir = mkdtempSync(join(tmpdir(), 'quota-account-health-'));
try {
  const manager = new GeminiQuotaManager({ authDir: dir, enableDynamicPriority: true });
  manager.cache.accounts = [healthy, backup];
  const recordPath = join(dir, 'main.cds');
  writeFileSync(recordPath, JSON.stringify({ provider: 'antigravity', records: [
    { auth_id: healthy.id, status: 'cooling', reason: 'upstream_error', last_error: { code: 403, message: validation } },
    { auth_id: 'unmatched-credential', status: 'error', last_error: { message: '503 auth_unavailable' } },
  ] }));
  const snapshot = manager.getSnapshot();
  assert.equal(snapshot.accounts[0].health.code, 'validation_required');
  assert.equal(snapshot.accounts[1].health.state, 'healthy', '全局或未匹配错误不能误标另一账号');
  assert.ok(!JSON.stringify(snapshot).includes('must-not-leak'), '渲染快照不得携带验证 URL');
  assert.equal(manager.readRoutingHealth(manager.cache.accounts), manager.routingHealthByAccount, '五秒内复用本地健康缓存');
  writeFileSync(recordPath, JSON.stringify({ provider: 'antigravity', records: [{ auth_id: healthy.email, status: 'ACTIVE' }] }));
  manager.routingHealthReadAt -= 6000;
  assert.equal(manager.getSnapshot().accounts[0].health.state, 'healthy', '恢复状态清除红点');
  unlinkSync(recordPath);
  manager.routingHealthReadAt -= 6000;
  assert.equal(manager.getSnapshot().accounts[0].health.state, 'healthy', '已删除的错误记录不能继续保留红点');

  const authPath = join(dir, healthy.id);
  writeFileSync(authPath, JSON.stringify({ type: 'antigravity', email: healthy.email, priority: 100 }));
  manager.accountCaches.set(healthy.email, healthy);
  manager.getAccessTokenForFile = async () => 'synthetic-test-token';
  manager.fetchQuotaViaApiCall = async () => { throw new Error('management endpoint unavailable'); };
  manager.fetchQuotaFromGoogle = async () => { throw Object.assign(new Error(validation), { httpStatus: 403 }); };
  const failed = await manager.fetchQuotaForFile(authPath);
  assert.equal(failed.stale, true);
  assert.equal(failed.rows[0].remainingPercent, 99, '保留旧配额供查看，不伪装成额度为零');
  assert.equal(getAccountHealth(failed).state, 'unavailable', '旧配额缓存不能掩盖认证失败');
  assert.equal(failed.error, 'validation_required');
  assert.ok(!JSON.stringify(failed).includes('secret.example'));
  manager.fetchQuotaFromGoogle = async () => ({ groups: [] });
  const recovered = await manager.fetchQuotaForFile(authPath);
  assert.equal(recovered.error, null);
  assert.equal(getAccountHealth(recovered).state, 'healthy');
  writeFileSync(join(dir, 'pool-status.json'), JSON.stringify({ primaryAccount: healthy.email, rankings: [
    { email: healthy.email, status: 'BLOCKED', reason: validation, last_error: { validation_url: 'https://secret.example.test/token' } },
  ] }));
  const blockedSnapshot = manager.getSnapshot();
  assert.equal(blockedSnapshot.accounts[0].health.code, 'validation_required');
  assert.ok(!JSON.stringify(blockedSnapshot).includes('secret.example'), '调度快照也必须过滤原始错误字段');
} finally { rmSync(dir, { recursive: true, force: true }); }

// 直接运行生产渲染函数，检查实际 HTML 而非仅匹配源码字符串。
const source = readFileSync(new URL('../src/injected.js', import.meta.url), 'utf8');
const start = source.indexOf('  function renderExtendedUsage(');
const end = source.indexOf('  function popoverMarkup(', start);
assert.ok(start >= 0 && end > start);
const makeRenderer = new Function('settings', 'extendedUsageState', 'getAccountHealth', 'isAccountAvailable', 't', 'esc', 'maskAccountName', 'designIcon', 'claudeGptCollapsed', 'formatDynamicCountdown', 'renderEmptyState', 'getQuotaColor', `${source.slice(start, end)}; return renderExtendedUsage;`);
const escape = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
const render = anti => makeRenderer({ locale: 'zh-CN', enableGoogleAiPro: true, enableTokenUsage: false, maskAccountNames: false }, { antigravity: anti, tokens: {} }, getAccountHealth, account => account.status === 'ready', key => key, escape, value => value, () => '', false, () => '3h后重置', () => 'empty', () => '#34C759')(false);
const pool = { available: true, primaryAccount: healthy.email, rankings: [
  { email: healthy.email, status: 'ACTIVE' }, { email: backup.email, status: 'ACTIVE' },
], accountMap: { [healthy.email]: { status: 'ACTIVE', isPrimary: true }, [backup.email]: { status: 'ACTIVE' } } };
const badPrimary = { ...healthy, health: getAccountHealth({ error: '503 auth_unavailable' }), status: 'error', stale: true };
const badHtml = render({ accounts: [badPrimary, backup], selectedAccount: backup.email, userSelectedAccount: healthy.email, enableDynamicPriority: true, poolStatus: pool });
assert.match(badHtml, /quota-tab-dot is-error/);
assert.doesNotMatch(badHtml, /<span class="quota-tab-dot" aria-hidden/);
assert.match(badHtml, /quota-extension-account-tab is-active[^>]+data-account="main@example.test"/, '异常账号可选中查看，与路由状态无关');
assert.match(badHtml, />99%<\/span>/, '展示所选异常账号的缓存配额');
assert.match(badHtml, /暂无可用登录凭证/);
assert.match(badHtml, /auth_unavailable/);
const viewBackupWithError = render({ accounts: [badPrimary, backup], selectedAccount: backup.email, userSelectedAccount: backup.email, enableDynamicPriority: true, poolStatus: pool });
assert.match(viewBackupWithError, /quota-extension-account-tab is-active[^>]+data-account="backup@example.test"/);
assert.match(viewBackupWithError, /quota-tab-dot is-error/);
assert.match(viewBackupWithError, />44%<\/span>/);
assert.doesNotMatch(badHtml, /secret\.example/);
assert.match(render({ accounts: [badPrimary], selectedAccount: healthy.email, poolStatus: pool, enableDynamicPriority: true }), /quota-tab-dot is-error/, '只有一个账号时仍应显示异常标记');
const healthyHtml = render({ accounts: [healthy, backup], selectedAccount: healthy.email, userSelectedAccount: backup.email, enableDynamicPriority: true, poolStatus: pool });
assert.match(healthyHtml, /quota-tab-dot" aria-hidden/);
assert.doesNotMatch(healthyHtml, /quota-tab-dot is-error/);
assert.match(healthyHtml, /quota-extension-account-tab is-active[^>]+data-account="backup@example.test"/);
assert.match(healthyHtml, />44%<\/span>/);
const poolErrorHtml = render({ accounts: [healthy, backup], selectedAccount: healthy.email, enableDynamicPriority: true, poolStatus: pool, error: '503 auth_unavailable' });
assert.doesNotMatch(poolErrorHtml, /quota-tab-dot is-error/);
assert.match(poolErrorHtml, /错误未指明具体账号/);
assert.doesNotMatch(source, /emitCommand\('promote-account'/, '仅查看统计，不发路由变更命令');
console.log('✓ Account health, red dots, recovery, sanitized tooltip and read-only selection passed');
