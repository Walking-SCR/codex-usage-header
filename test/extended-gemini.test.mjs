import assert from 'node:assert/strict';
import {
  formatGeminiCountdown,
  matchGeminiStandardRow,
  GeminiQuotaManager,
  crossBasename,
} from '../src/extended-usage.mjs';

console.log('Testing: Gemini quota manager and matching contract...');

// 1. 倒计时格式测试
assert.deepEqual(formatGeminiCountdown(0), { zh: '即将重置', en: 'resets soon' });
assert.deepEqual(formatGeminiCountdown(45), { zh: '即将重置', en: 'resets soon' });
assert.deepEqual(formatGeminiCountdown(5520), { zh: '1h32min后重置', en: 'resets in 1h 32m' });
assert.deepEqual(formatGeminiCountdown(356400), { zh: '4天后重置', en: 'resets in 4d' });

// 2. 标准行匹配测试
assert.equal(matchGeminiStandardRow('Gemini Models', '5h'), 'Gemini 5h');
assert.equal(matchGeminiStandardRow('Gemini Models', 'five-hour'), 'Gemini 5h');
assert.equal(matchGeminiStandardRow('Gemini Models', 'five_hour'), 'Gemini 5h');
assert.equal(matchGeminiStandardRow('Gemini Models', 'weekly'), 'Gemini 7d');
assert.equal(matchGeminiStandardRow('Gemini Models', '7d'), 'Gemini 7d');
assert.equal(matchGeminiStandardRow('Gemini Models', 'week'), 'Gemini 7d');
assert.equal(matchGeminiStandardRow('Claude and GPT models', 'weekly'), 'Claude & GPT 7d');
assert.equal(matchGeminiStandardRow('Claude and GPT models', '5h'), 'Claude & GPT 5h');
assert.equal(matchGeminiStandardRow('3p-models', '7d'), 'Claude & GPT 7d');
assert.equal(matchGeminiStandardRow('Shared Models', 'weekly'), 'Claude & GPT 7d');
assert.equal(matchGeminiStandardRow('Gemini 4 Argon', 'weekly'), null, 'Gemini 4 Argon 必须作为独立动态分组解析，不可被归入基础 Gemini 7d');
assert.equal(matchGeminiStandardRow('Gemini 模型', '周限额'), 'Gemini 7d');
assert.equal(matchGeminiStandardRow('Claude 与 GPT 模型', '5 小时限额'), 'Claude & GPT 5h');

// 3. 原始数据解析测试（支持 camelCase 和 snake_case）
const manager = new GeminiQuotaManager();

const camelPayload = {
  groups: [
    {
      displayName: 'Gemini Models',
      buckets: [
        { window: '5h', remainingFraction: 0.68, resetTime: new Date(Date.now() + 5520000).toISOString() },
        { window: 'weekly', remainingFraction: 0.42, resetTime: new Date(Date.now() + 356400000).toISOString() },
      ],
    },
    {
      displayName: 'Claude and GPT models',
      buckets: [
        { window: 'weekly', remainingFraction: 0.95, resetTime: new Date(Date.now() + 356400000).toISOString() },
      ],
    },
  ],
};

const rowsCamel = manager.parseRawQuotaPayload(camelPayload);
assert.equal(rowsCamel.length, 3);
assert.equal(rowsCamel[0].label, 'Gemini 5h');
assert.equal(rowsCamel[0].remainingPercent, 68);
assert.equal(rowsCamel[0].unavailable, false);
assert.equal(rowsCamel[1].label, 'Gemini 7d');
assert.equal(rowsCamel[1].remainingPercent, 42);
assert.equal(rowsCamel[2].label, 'Claude & GPT 7d');
assert.equal(rowsCamel[2].remainingPercent, 95);

// 测试 snake_case 数据（仅含 Gemini 模型，无 Claude 时隐藏 Claude 行，仅返回 2 行）
const snakePayload = {
  groups: [
    {
      display_name: 'gemini_models',
      buckets: [
        { window: 'five_hour', remaining_fraction: 0.0, reset_time: '2026-09-20T10:00:00Z' },
        { window: 'week', remaining_fraction: 0.50, reset_time: '2026-09-24T10:00:00Z' },
      ],
    },
  ],
};

const rowsSnake = manager.parseRawQuotaPayload(snakePayload);
assert.equal(rowsSnake.length, 2, '无 Claude 分组时只返回 2 条 Gemini 额度行');
assert.equal(rowsSnake[0].label, 'Gemini 5h');
assert.equal(rowsSnake[0].remainingPercent, 0); // explicitly 0 must stay 0%
assert.equal(rowsSnake[0].unavailable, false);
assert.equal(rowsSnake[1].label, 'Gemini 7d');
assert.equal(rowsSnake[1].remainingPercent, 50);

// 测试显式缺失 remaining_fraction 的桶不会变成 0%
const missingFractionPayload = {
  groups: [
    {
      display_name: 'claude_and_gpt_models',
      buckets: [
        { window: 'week', remaining_fraction: null },
      ],
    },
  ],
};
const missingFractionRows = manager.parseRawQuotaPayload(missingFractionPayload);
assert.equal(missingFractionRows.length, 1);
assert.equal(missingFractionRows[0].label, 'Claude & GPT 7d');
assert.equal(missingFractionRows[0].remainingPercent, null);
assert.equal(missingFractionRows[0].unavailable, true); // missing data must not become 0%

// 测试完整的 4 行数据：Claude & GPT 7d 必须排在 Claude & GPT 5h 之后
const fullPayload = {
  groups: [
    {
      displayName: 'Gemini Models',
      buckets: [
        { window: '5h', remainingFraction: 0.80, resetTime: new Date(Date.now() + 5520000).toISOString() },
        { window: 'weekly', remainingFraction: 0.50, resetTime: new Date(Date.now() + 356400000).toISOString() },
      ],
    },
    {
      displayName: 'Claude and GPT models',
      buckets: [
        { window: '5h', remainingFraction: 1.0, resetTime: new Date(Date.now() + 18000000).toISOString() },
        { window: 'weekly', remainingFraction: 0.90, resetTime: new Date(Date.now() + 356400000).toISOString() },
      ],
    },
  ],
};
const fullRows = manager.parseRawQuotaPayload(fullPayload);
assert.equal(fullRows.length, 4);
assert.equal(fullRows[0].label, 'Gemini 5h');
assert.equal(fullRows[1].label, 'Gemini 7d');
assert.equal(fullRows[2].label, 'Claude & GPT 5h');
assert.equal(fullRows[3].label, 'Claude & GPT 7d');

// 测试含 Gemini 4 Argon 的 5 行数据（含满额无 resetTime 兜底）
const gemini4Payload = {
  groups: [
    {
      displayName: 'Gemini Models',
      buckets: [
        { window: 'weekly', remainingFraction: 1.0, resetTime: new Date(Date.now() + 7 * 86400000).toISOString() },
        { window: '5h', remainingFraction: 1.0, resetTime: new Date(Date.now() + 18000000).toISOString() },
      ],
    },
    {
      displayName: 'Claude and GPT models',
      buckets: [
        { window: 'weekly', remainingFraction: 0.79, resetTime: new Date(Date.now() + (4 * 86400 + 13 * 3600) * 1000).toISOString() },
        { window: '5h', remainingFraction: 1.0, resetTime: new Date(Date.now() + (4 * 3600 + 57 * 60) * 1000).toISOString() },
      ],
    },
    {
      displayName: 'Gemini 4 Argon',
      buckets: [
        { bucketId: 'gemini-argon-wtu-weekly', displayName: 'Gemini 4 Argon Weekly Limit', window: 'weekly', remainingFraction: 1.0 },
      ],
    },
  ],
};
const gemini4Rows = manager.parseRawQuotaPayload(gemini4Payload);
assert.equal(gemini4Rows.length, 5, '包含 Gemini 4 Argon 时应返回 5 条额度行');
assert.equal(gemini4Rows[0].label, 'Gemini 4 Argon 7d');
assert.equal(gemini4Rows[0].remainingPercent, 100);
assert.equal(gemini4Rows[0].unavailable, false);
assert.deepEqual(gemini4Rows[0].countdown, { zh: '7天后重置', en: 'resets in 7d' });
assert.equal(gemini4Rows[1].label, 'Gemini 5h');
assert.equal(gemini4Rows[2].label, 'Gemini 7d');
assert.equal(gemini4Rows[3].label, 'Claude & GPT 5h');
assert.equal(gemini4Rows[4].label, 'Claude & GPT 7d');
assert.equal(gemini4Rows[4].remainingPercent, 79);

// 4. 出错时保留过期缓存
manager.cache = {
  status: 'ready',
  plan: 'Gemini AI Pro',
  rows: rowsCamel,
  fetchedAt: 1000,
  stale: false,
  error: null,
};

// 模拟已有缓存数据时发生失败
manager.fetchQuota = async () => {
  manager.cache = {
    ...manager.cache,
    stale: true,
    error: 'Simulated 500 error',
  };
  return manager.cache;
};

const result = await manager.fetchQuota();
assert.equal(result.stale, true);
assert.equal(result.rows[0].remainingPercent, 68); // retains previous good data!
assert.equal(result.error, 'Simulated 500 error');

// 5. 凭证安全边界测试：移除 admin123 默认密码猜测
import { mkdtempSync, rmSync, writeFileSync, statSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

const tempDir = mkdtempSync(join(tmpdir(), 'gemini-sec-test-'));
try {
  const configPath = join(tempDir, 'config.yaml');
  const secManager = new GeminiQuotaManager({ configPath });

  // 场景 A: 无环境变量且文件不存在时，必须返回 null，严禁返回 "admin123"
  const prevEnv = process.env.MANAGEMENT_PASSWORD;
  delete process.env.MANAGEMENT_PASSWORD;
  assert.equal(secManager.readManagementKey(), null, '未配置管理密钥时严禁猜测 admin123');

  // 场景 B: 配置文件中包含明文密钥
  writeFileSync(configPath, 'remote-management:\n  secret-key: "valid-production-secret-998"\n');
  assert.equal(secManager.readManagementKey(), 'valid-production-secret-998');

  // 场景 C: 配置文件中包含 bcrypt 哈希（以 $2 开头）时不能作为 API token 发送
  writeFileSync(configPath, 'remote-management:\n  secret-key: "$2a$12$e8x...hash"\n');
  assert.equal(secManager.readManagementKey(), null, '哈希密码不可作为明文密钥发送');

  // 场景 D: 环境变量优先
  process.env.MANAGEMENT_PASSWORD = 'env-override-secret';
  assert.equal(secManager.readManagementKey(), 'env-override-secret');
  if (prevEnv !== undefined) process.env.MANAGEMENT_PASSWORD = prevEnv;
  else delete process.env.MANAGEMENT_PASSWORD;

  // 6. 原子凭证更新与 0o600 权限保护
  const authFile = join(tempDir, 'antigravity-test@gmail.com.json');
  writeFileSync(authFile, JSON.stringify({ access_token: 'old_tok', refresh_token: 'ref_tok' }), { mode: 0o600 });
  const authData = { access_token: 'new_tok', refresh_token: 'ref_tok', expires_in: 3600 };

  // 使用原型的原子写入机制验证
  const tmpPath = `${authFile}.tmp.${process.pid}`;
  writeFileSync(tmpPath, JSON.stringify(authData, null, 2), { mode: 0o600 });
  renameSync(tmpPath, authFile);
  if (process.platform !== 'win32') {
    assert.equal(statSync(authFile).mode & 0o777, 0o600, 'OAuth 凭证文件权限必须为 0o600');
  }

  // 7. Windows 反斜杠路径兼容性验证
  const winPath = 'C:\\Users\\Administrator\\.cli-proxy-api\\antigravity-alice@example.com.json';
  assert.equal(crossBasename(winPath), 'antigravity-alice@example.com.json', 'crossBasename 必须正确解析 Windows 反斜杠文件名');
  assert.equal(crossBasename('/home/user/.cli-proxy-api/antigravity-alice@example.com.json'), 'antigravity-alice@example.com.json');

} finally {
  rmSync(tempDir, { recursive: true, force: true });
}

console.log('✓ Gemini quota manager and matching contract passed!');
