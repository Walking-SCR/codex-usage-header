import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GeminiQuotaManager } from '../src/extended-usage.mjs';

test('GeminiQuotaManager respects enableDynamicPriority: true', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gemini-dynamic-on-'));
  try {
    const auth1 = join(tmp, 'antigravity-account1@example.com.json');
    const auth2 = join(tmp, 'antigravity-account2@example.com.json');
    writeFileSync(auth1, JSON.stringify({ type: 'antigravity', email: 'account1@example.com', priority: 200 }));
    writeFileSync(auth2, JSON.stringify({ type: 'antigravity', email: 'account2@example.com', priority: 100 }));

    // Mock pool-status.json
    writeFileSync(join(tmp, 'pool-status.json'), JSON.stringify({
      mode: 'auto',
      primaryAccount: 'account1@example.com',
      rankings: [
        { email: 'account1@example.com', priority: 200, status: 'ACTIVE' },
        { email: 'account2@example.com', priority: 100, status: 'ACTIVE' },
      ],
    }));

    const manager = new GeminiQuotaManager({
      authDir: tmp,
      enableDynamicPriority: true,
    });

    const snapshot = manager.getSnapshot();
    assert.equal(snapshot.enableDynamicPriority, true);
    assert.notEqual(snapshot.poolStatus, null);
    assert.equal(snapshot.poolStatus.available, true);
    assert.equal(snapshot.poolStatus.accountMap['account1@example.com'].rankLabel, '使用中');
    assert.equal(snapshot.poolStatus.accountMap['account2@example.com'].rankLabel, '备选1');
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('GeminiQuotaManager respects enableDynamicPriority: false (关闭状态)', async () => {
  const tmp = mkdtempSync(join(tmpdir(), 'gemini-dynamic-off-'));
  try {
    const auth1 = join(tmp, 'antigravity-account1@example.com.json');
    writeFileSync(auth1, JSON.stringify({ type: 'antigravity', email: 'account1@example.com', priority: 200 }));

    // Even if pool-status.json exists on disk, feature is turned OFF
    writeFileSync(join(tmp, 'pool-status.json'), JSON.stringify({
      mode: 'auto',
      primaryAccount: 'account1@example.com',
      rankings: [{ email: 'account1@example.com', priority: 200 }],
    }));

    const manager = new GeminiQuotaManager({
      authDir: tmp,
      enableDynamicPriority: false,
    });

    const snapshot = manager.getSnapshot();
    assert.equal(snapshot.enableDynamicPriority, false);
    assert.equal(snapshot.poolStatus, null);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test('formatAccountTabHtml renders correct labels and styling in dynamic mode', async () => {
  const { formatAccountTabHtml, renderRebalanceButton } = await import('../src/dynamic-priority-adapter.mjs');

  const poolStatus = {
    available: true,
    primaryAccount: 'mancyliao001@gmail.com',
    rankings: [
      { email: 'mancyliao001@gmail.com', priority: 650, status: 'ACTIVE' },
      { email: 'shekchoyrong@gmail.com', priority: 550, status: 'ACTIVE' },
      { email: 'walkingscr@gmail.com', priority: 200, status: 'COOLING' },
    ],
    accountMap: {
      'mancyliao001@gmail.com': { rankLabel: '使用中', status: 'ACTIVE' },
      'shekchoyrong@gmail.com': { rankLabel: '备选1', status: 'ACTIVE' },
      'walkingscr@gmail.com': { rankLabel: '❄ 冷却', status: 'COOLING' },
    },
  };

  // 1. 打开状态：选中项仅保留绿点，使用中状态留给辅助信息
  const activeTab = formatAccountTabHtml('mancyliao001', 'mancyliao001@gmail.com', poolStatus, true);
  assert.match(activeTab, /quota-tab-dot/);
  assert.match(activeTab, /mancyliao001$/);
  assert.doesNotMatch(activeTab, /使用中/);

  // 2. 打开状态：备选账号
  const fallbackTab = formatAccountTabHtml('shekchoyrong', 'shekchoyrong@gmail.com', poolStatus, false);
  assert.equal(fallbackTab, 'shekchoyrong · 备1');
  const selectedBackupTab = formatAccountTabHtml('shekchoyrong', 'shekchoyrong@gmail.com', poolStatus, true);
  assert.equal(selectedBackupTab, 'shekchoyrong · 备1', 'Selecting a backup account must not make it look like the route primary');
  const stillPrimaryTab = formatAccountTabHtml('mancyliao001', 'mancyliao001@gmail.com', poolStatus, false);
  assert.match(stillPrimaryTab, /quota-tab-dot/, 'The actual route primary keeps its green dot when another tab is selected');

  // 3. 打开状态：重置优先级按钮
  const btn = renderRebalanceButton(poolStatus);
  assert.match(btn, /重排/);
  assert.doesNotMatch(btn, /重置优先级/);
  assert.match(btn, /排队顺序/);
  assert.match(btn, /aria-label="重排。排队顺序：mancyliao001 \(使用中\) → shekchoyrong \(备选1\)/);
  assert.match(btn, /mancyliao001 \(使用中\) → shekchoyrong \(备选1\)/);

  // 4. 关闭状态（poolStatus.available 为 false）
  const disabledStatus = { available: false };
  const plainTab = formatAccountTabHtml('mancyliao001', 'mancyliao001@gmail.com', disabledStatus, true);
  assert.equal(plainTab, 'mancyliao001'); // 还原为纯账号名，无使用中与备选标记
});
