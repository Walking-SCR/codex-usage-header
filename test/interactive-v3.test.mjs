import assert from 'node:assert/strict';
import { fetchCdpTargets, selectUsageTargets, evaluateInTarget } from '../src/launcher.mjs';

console.log('Testing: V3 Interactive and Layout features...');

const targets = selectUsageTargets(await fetchCdpTargets(9229));
const [target] = targets;
assert.ok(target, 'Target must exist');

// 1. 显示弹出卡片
await evaluateInTarget(target.webSocketDebuggerUrl, 'window.__codexUsageHeaderDebug__.showPopover()');
await new Promise(r => setTimeout(r, 250));

// 确保 Google AI Pro 已开启，以便执行交互检查
await evaluateInTarget(target.webSocketDebuggerUrl, '(() => { const btn = document.querySelector(".google-toggle-btn"); if (btn && !btn.classList.contains("is-active")) btn.click(); })()');
await new Promise(r => setTimeout(r, 250));

// 确保重置券已开启，以便执行交互检查
await evaluateInTarget(target.webSocketDebuggerUrl, '(() => { const btn = document.querySelector(".voucher-toggle-btn"); if (btn && !btn.classList.contains("is-active")) btn.click(); })()');
await new Promise(r => setTimeout(r, 250));

// 确保 Token 用量已开启，以便执行交互检查
await evaluateInTarget(target.webSocketDebuggerUrl, '(() => { const btn = document.querySelector(".stats-toggle-btn"); if (btn && !btn.classList.contains("is-active")) btn.click(); })()');
await new Promise(r => setTimeout(r, 250));

const initialHeight = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".codex-usage-popover-v24").getBoundingClientRect().height');
assert.ok(initialHeight > 500, 'Initial height should be > 500');

// 2. 收起 Google AI Pro
await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".quota-extension-toggle").click()');
await new Promise(r => setTimeout(r, 250));
const collapsedHeight = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".codex-usage-popover-v24").getBoundingClientRect().height');
assert.ok(collapsedHeight < initialHeight - 100, 'Collapsed height must be significantly lower (>100px reduction)');

// 3. 再次展开 Google AI Pro
await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".quota-extension-toggle").click()');
await new Promise(r => setTimeout(r, 250));
const expandedHeight = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".codex-usage-popover-v24").getBoundingClientRect().height');
assert.ok(expandedHeight >= collapsedHeight + 100, 'Expanded height should restore (>100px higher than collapsed)');

// 4. 测试时间范围切换，以及大数值（近 30 日）不换行
await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".quota-extension-range-tab[data-range=\'days30\']").click()');
await new Promise(r => setTimeout(r, 200));
const activeRange30 = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".quota-extension-range-tab.is-active").dataset.range');
assert.equal(activeRange30, 'days30');
const tokenTotalDays30 = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".token-summary-number").innerText');
const summaryValHeight = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".token-summary-val").getBoundingClientRect().height');
assert.ok(summaryValHeight < 45, 'Token summary must remain single-line (no wrap to 72px)');
console.log('  Switched to days30:', activeRange30, 'total tokens:', tokenTotalDays30, 'valHeight:', summaryValHeight);

// 4.1. 测试时间范围切换
await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".quota-extension-range-tab[data-range=\'days7\']").click()');
await new Promise(r => setTimeout(r, 200));
const activeRange = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".quota-extension-range-tab.is-active").dataset.range');
assert.equal(activeRange, 'days7');
const tokenTotalDays7 = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".token-summary-number").innerText');
console.log('  Switched to days7:', activeRange, 'total tokens:', tokenTotalDays7);

await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".quota-extension-range-tab[data-range=\'today\']").click()');
await new Promise(r => setTimeout(r, 200));
const activeRangeToday = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".quota-extension-range-tab.is-active").dataset.range');
assert.equal(activeRangeToday, 'today');
const tokenTotalToday = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".token-summary-number").innerText');
console.log('  Switched back to today, total tokens:', tokenTotalToday);

// 5. 测试账号切换
const accounts = await evaluateInTarget(target.webSocketDebuggerUrl, '[...document.querySelectorAll(".quota-extension-account-tab")].map(t => t.innerText)');
console.log('  Available account tabs:', accounts);
if (accounts.length > 1) {
  await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelectorAll(".quota-extension-account-tab")[1].click()');
  await new Promise(r => setTimeout(r, 200));
  const activeAcc = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".quota-extension-account-tab.is-active").innerText');
  assert.equal(activeAcc, accounts[1]);
  console.log('  Switched to account:', activeAcc);
  await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelectorAll(".quota-extension-account-tab")[0].click()');
  console.log('  Switched back to primary account');
}

// 6. 验证胶囊上的箭头图标已移除
 const capsuleArrow = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector("codex-usage-header-host")?.shadowRoot?.querySelector(".capsule-arrow")');
 assert.equal(capsuleArrow, null, 'Capsule arrow should be removed');
 console.log('  Capsule arrow icon successfully verified as removed');

// 7. 测试关闭和开启 Google AI Pro
await evaluateInTarget(target.webSocketDebuggerUrl, 'window.__codexUsageHeaderDebug__.showPopover()');
await new Promise(r => setTimeout(r, 100));
await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".google-toggle-btn").click()');
await new Promise(r => setTimeout(r, 200));
const hasGoogleOff = await evaluateInTarget(target.webSocketDebuggerUrl, 'Boolean(document.querySelector(".quota-extension-title")?.innerText.includes("Google AI Pro"))');
assert.equal(hasGoogleOff, false);
console.log('  Google AI Pro toggled off successfully (card hidden)');

await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".google-toggle-btn").click()');
await new Promise(r => setTimeout(r, 200));
const hasGoogleOn = await evaluateInTarget(target.webSocketDebuggerUrl, 'Boolean(document.querySelector(".quota-extension-title")?.innerText.includes("Google AI Pro"))');
assert.equal(hasGoogleOn, true);
console.log('  Google AI Pro toggled on successfully (card restored)');

// 8. 测试关闭和开启 Token 用量（stats-toggle-btn）
await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".stats-toggle-btn").click()');
await new Promise(r => setTimeout(r, 200));
const hasTokensOff = await evaluateInTarget(target.webSocketDebuggerUrl, 'Boolean([...document.querySelectorAll(".quota-extension-title")].some(el => el.innerText.includes("Token使用量") || el.innerText.includes("Token处理量")))');
assert.equal(hasTokensOff, false);
console.log('  Token Usage toggled off successfully (card hidden)');

await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".stats-toggle-btn").click()');
await new Promise(r => setTimeout(r, 200));
const hasTokensOn = await evaluateInTarget(target.webSocketDebuggerUrl, 'Boolean([...document.querySelectorAll(".quota-extension-title")].some(el => el.innerText.includes("Token使用量") || el.innerText.includes("Token处理量")))');
assert.equal(hasTokensOn, true);
console.log('  Token Usage toggled on successfully (card restored)');

// 9. 测试关闭和开启重置券（voucher-toggle-btn）
await evaluateInTarget(target.webSocketDebuggerUrl, '(() => { const b = document.querySelector(".voucher-toggle-btn"); if (b && !b.classList.contains("is-active")) b.click(); })()');
await new Promise(r => setTimeout(r, 200));
await evaluateInTarget(target.webSocketDebuggerUrl, '(() => { const b = document.querySelector(".voucher-toggle-btn"); if (b && b.classList.contains("is-active")) b.click(); })()');
await new Promise(r => setTimeout(r, 200));
const hasVoucherOff = await evaluateInTarget(target.webSocketDebuggerUrl, 'Boolean(document.querySelector(".reset-voucher-section"))');
assert.equal(hasVoucherOff, false, 'Voucher section should be hidden when toggled off');
console.log('  Voucher section toggled off successfully (card hidden)');

await evaluateInTarget(target.webSocketDebuggerUrl, '(() => { const b = document.querySelector(".voucher-toggle-btn"); if (b && !b.classList.contains("is-active")) b.click(); })()');
await new Promise(r => setTimeout(r, 200));
const hasVoucherOn = await evaluateInTarget(target.webSocketDebuggerUrl, 'Boolean(document.querySelector(".reset-voucher-section"))');
assert.equal(hasVoucherOn, true, 'Voucher section should be restored when toggled on');
console.log('  Voucher section toggled on successfully (card restored)');

// 10. 测试刷新动画和加载状态
await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".card-refresh").click()');
await new Promise(r => setTimeout(r, 80));
const isRefreshing = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".popover-shell")?.classList.contains("is-refreshing")');
assert.equal(isRefreshing, true, 'Popover shell should have is-refreshing class during refresh');
console.log('  Refresh loading animation state verified (is-refreshing present)');

// 11. 测试账号名称遮罩切换（眼睛按钮）
const maskBtn = await evaluateInTarget(target.webSocketDebuggerUrl, 'Boolean(document.querySelector(".account-mask-toggle-btn"))');
assert.equal(maskBtn, true, 'Account mask toggle button should exist');

// 确保从未遮罩状态开始
await evaluateInTarget(target.webSocketDebuggerUrl, '(() => { const btn = document.querySelector(".account-mask-toggle-btn"); if (btn?.classList.contains("is-active")) btn.click(); })()');
await new Promise(r => setTimeout(r, 200));

const initialAccounts = await evaluateInTarget(target.webSocketDebuggerUrl, '[...document.querySelectorAll(".quota-extension-account-tab")].map(t => t.innerText)');
// 开启遮罩
await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".account-mask-toggle-btn").click()');
await new Promise(r => setTimeout(r, 200));
const maskedAccounts = await evaluateInTarget(target.webSocketDebuggerUrl, '[...document.querySelectorAll(".quota-extension-account-tab")].map(t => t.innerText)');
console.log('  Masked accounts:', maskedAccounts);
assert.ok(maskedAccounts.every(name => name.includes('*****')), 'All account tabs should contain ***** when masked');
if (maskedAccounts.some(name => name.startsWith('wa'))) {
  assert.ok(maskedAccounts.includes('wa*****scr'), 'walkingscr should be masked to wa*****scr');
}
if (maskedAccounts.some(name => name.startsWith('she'))) {
  assert.ok(maskedAccounts.includes('she*****rong'), 'shekchoyrong should be masked to she*****rong');
}
// 关闭遮罩（恢复完整名称）
await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".account-mask-toggle-btn").click()');
await new Promise(r => setTimeout(r, 200));
const restoredAccounts = await evaluateInTarget(target.webSocketDebuggerUrl, '[...document.querySelectorAll(".quota-extension-account-tab")].map(t => t.innerText)');
assert.deepEqual(restoredAccounts, initialAccounts, 'Restored account names should match initial names');
console.log('  Account name mask toggle verified successfully');

// 12. 测试切换重置券时的加载状态
// 先关闭重置券
await evaluateInTarget(target.webSocketDebuggerUrl, '(() => { const b = document.querySelector(".voucher-toggle-btn"); if (b?.classList.contains("is-active")) b.click(); })()');
await new Promise(r => setTimeout(r, 150));
// 开启重置券：应显示加载状态或有效的重置券
await evaluateInTarget(target.webSocketDebuggerUrl, '(() => { const b = document.querySelector(".voucher-toggle-btn"); if (!b?.classList.contains("is-active")) b.click(); })()');
await new Promise(r => setTimeout(r, 50));
const hasVoucherSectionOrLoading = await evaluateInTarget(target.webSocketDebuggerUrl, 'Boolean(document.querySelector(".reset-voucher-section"))');
assert.equal(hasVoucherSectionOrLoading, true, 'Voucher section should be displayed when enabled');
console.log('  Voucher section display & loading contract verified');

console.log('✓ All V3 Interactive and Layout tests passed perfectly!');
