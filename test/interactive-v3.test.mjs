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
await evaluateInTarget(target.webSocketDebuggerUrl, '(() => { const btn = document.querySelector(".header-module-toggle[data-module=google]"); if (btn && btn.getAttribute("aria-pressed") !== "true") btn.click(); })()');
await new Promise(r => setTimeout(r, 250));

// 确保重置券已开启，以便执行交互检查
await evaluateInTarget(target.webSocketDebuggerUrl, '(() => { const btn = document.querySelector(".header-module-toggle[data-module=reset]"); if (btn && btn.getAttribute("aria-pressed") !== "true") btn.click(); })()');
await new Promise(r => setTimeout(r, 250));

// 确保 Token 用量已开启，以便执行交互检查
await evaluateInTarget(target.webSocketDebuggerUrl, '(() => { const btn = document.querySelector(".header-module-toggle[data-module=tokens]"); if (btn && btn.getAttribute("aria-pressed") !== "true") btn.click(); })()');
await new Promise(r => setTimeout(r, 250));

await evaluateInTarget(target.webSocketDebuggerUrl, 'window.__codexUsageHeaderDebug__.showPopover()');
await new Promise(r => setTimeout(r, 100));
const initialHeight = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".codex-usage-popover-v24")?.getBoundingClientRect()?.height || 0');
assert.ok(initialHeight > 500, 'Initial height should be > 500');
const initialGoogleRows = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelectorAll(".quota-extension-row").length');
const initialClaudeRows = await evaluateInTarget(target.webSocketDebuggerUrl, '[...document.querySelectorAll(".quota-extension-row")].filter(row=>/Claude/i.test(row.querySelector(".quota-extension-label")?.textContent||"")).length');
const initialGeminiRows = await evaluateInTarget(target.webSocketDebuggerUrl, '[...document.querySelectorAll(".quota-extension-row")].filter(row=>/Gemini/i.test(row.querySelector(".quota-extension-label")?.textContent||"")).length');

if (initialGoogleRows > 0) {
  // 2. 只收起 Claude 的配额行，Gemini 行继续显示
  await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".quota-extension-toggle").click()');
  await new Promise(r => setTimeout(r, 250));
  const collapsedGoogleRows = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelectorAll(".quota-extension-row").length');
  const collapsedClaudeRows = await evaluateInTarget(target.webSocketDebuggerUrl, '[...document.querySelectorAll(".quota-extension-row")].filter(row=>/Claude/i.test(row.querySelector(".quota-extension-label")?.textContent||"")).length');
  const collapsedGeminiRows = await evaluateInTarget(target.webSocketDebuggerUrl, '[...document.querySelectorAll(".quota-extension-row")].filter(row=>/Gemini/i.test(row.querySelector(".quota-extension-label")?.textContent||"")).length');
  assert.equal(collapsedClaudeRows, 0, 'Claude quota rows should hide when its chevron is collapsed');
  assert.equal(collapsedGeminiRows, initialGeminiRows, 'Gemini quota rows must remain visible when Claude rows are collapsed');
  assert.equal(collapsedGoogleRows, initialGoogleRows - initialClaudeRows);

  // 3. 再次展开 Claude 配额行
  await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".quota-extension-toggle").click()');
  await new Promise(r => setTimeout(r, 250));
  const expandedGoogleRows = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelectorAll(".quota-extension-row").length');
  assert.equal(expandedGoogleRows, initialGoogleRows, 'Expanding Google AI Pro should restore all quota rows');
} else {
  console.log('  Google AI Pro has no quota rows in the current account state; collapse sizing check skipped');
}

// 4. 测试时间范围切换，以及大数值（近 30 日）不换行
await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".quota-extension-range-tab[data-range=\'days30\']").click()');
await new Promise(r => setTimeout(r, 200));
const activeRange30 = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".quota-extension-range-tab.is-active").dataset.range');
assert.equal(activeRange30, 'days30');
const tokenTotalDays30 = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".token-summary-number").innerText');
const summaryValHeight = await evaluateInTarget(target.webSocketDebuggerUrl, '(document.querySelector(".token-summary-number") || document.querySelector(".token-summary-val")).getBoundingClientRect().height');
assert.ok(summaryValHeight <= 50, 'Token summary must remain compact');
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

// 5. 测试账号切换（仅切换界面展示，不改动路由优先级）
const accounts = await evaluateInTarget(target.webSocketDebuggerUrl, '[...document.querySelectorAll(".quota-extension-account-tab")].map(t => t.innerText)');
console.log('  Available account tabs:', accounts);
if (accounts.length > 1) {
  await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelectorAll(".quota-extension-account-tab")[1].click()');
  await new Promise(r => setTimeout(r, 200));
  const activeAcc = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".quota-extension-account-tab.is-active").innerText');
  assert.equal(activeAcc, accounts[1]);
  console.log('  Switched displayed account to:', activeAcc);
  await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelectorAll(".quota-extension-account-tab")[0].click()');
  console.log('  Switched display back to the first account');
}

// 6. 验证胶囊右侧箭头与用量内容共同切换卡片
const capsuleToggle = await evaluateInTarget(target.webSocketDebuggerUrl, 'Boolean(document.querySelector("codex-usage-header-host")?.shadowRoot?.querySelector(".capsule-toggle"))');
assert.ok(capsuleToggle, 'The integrated capsule toggle should be present');
const expandedBeforeToggle = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector("codex-usage-header-host")?.shadowRoot?.querySelector(".capsule-toggle")?.getAttribute("aria-expanded")');
await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector("codex-usage-header-host")?.shadowRoot?.querySelector(".capsule-toggle")?.click()');
await new Promise(r => setTimeout(r, 120));
const expandedAfterToggle = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector("codex-usage-header-host")?.shadowRoot?.querySelector(".capsule-toggle")?.getAttribute("aria-expanded")');
assert.notEqual(expandedAfterToggle, expandedBeforeToggle);
await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector("codex-usage-header-host")?.shadowRoot?.querySelector(".capsule-toggle")?.click()');
await new Promise(r => setTimeout(r, 120));
console.log('  Integrated capsule toggle opens and closes the details card');
const detailsTrigger = await evaluateInTarget(target.webSocketDebuggerUrl, 'Boolean(document.querySelector("codex-usage-header-host")?.shadowRoot?.querySelector(".details-trigger"))');
assert.equal(detailsTrigger, true, 'Usage content should remain a clickable details trigger');
const detailsBeforeContentClick = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector("codex-usage-header-host")?.shadowRoot?.querySelector(".details-trigger")?.getAttribute("aria-expanded")');
await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector("codex-usage-header-host")?.shadowRoot?.querySelector(".details-trigger")?.click()');
await new Promise(r => setTimeout(r, 120));
const detailsAfterContentClick = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector("codex-usage-header-host")?.shadowRoot?.querySelector(".details-trigger")?.getAttribute("aria-expanded")');
assert.notEqual(detailsAfterContentClick, detailsBeforeContentClick, 'Usage content should open and close the card on click');
await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector("codex-usage-header-host")?.shadowRoot?.querySelector(".details-trigger")?.click()');

// 7. 测试关闭和开启 Google AI Pro
await evaluateInTarget(target.webSocketDebuggerUrl, 'window.__codexUsageHeaderDebug__.showPopover()');
await new Promise(r => setTimeout(r, 100));
await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".header-module-toggle[data-module=google]").click()');
await new Promise(r => setTimeout(r, 200));
const hasGoogleOff = await evaluateInTarget(target.webSocketDebuggerUrl, 'Boolean(document.querySelector(".quota-extension-title")?.innerText.includes("Google AI Pro"))');
assert.equal(hasGoogleOff, false);
console.log('  Google AI Pro toggled off successfully (card hidden)');

await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".header-module-toggle[data-module=google]").click()');
await new Promise(r => setTimeout(r, 200));
const hasGoogleOn = await evaluateInTarget(target.webSocketDebuggerUrl, 'Boolean(document.querySelector(".quota-extension-title")?.innerText.includes("Google AI Pro"))');
assert.equal(hasGoogleOn, true);
console.log('  Google AI Pro toggled on successfully (card restored)');

// 8. 测试关闭和开启 Token 用量（顶栏 Token 图标）
await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".header-module-toggle[data-module=tokens]").click()');
await new Promise(r => setTimeout(r, 200));
const hasTokensOff = await evaluateInTarget(target.webSocketDebuggerUrl, 'Boolean([...document.querySelectorAll(".quota-extension-title")].some(el => el.innerText.includes("Token使用量") || el.innerText.includes("Token处理量")))');
assert.equal(hasTokensOff, false);
console.log('  Token Usage toggled off successfully (card hidden)');

await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".header-module-toggle[data-module=tokens]").click()');
await new Promise(r => setTimeout(r, 200));
const hasTokensOn = await evaluateInTarget(target.webSocketDebuggerUrl, 'Boolean([...document.querySelectorAll(".quota-extension-title")].some(el => el.innerText.includes("Token使用量") || el.innerText.includes("Token处理量")))');
assert.equal(hasTokensOn, true);
console.log('  Token Usage toggled on successfully (card restored)');

// 9. 测试关闭和开启重置券（顶栏券图标）
await evaluateInTarget(target.webSocketDebuggerUrl, '(() => { const b = document.querySelector(".header-module-toggle[data-module=reset]"); if (b && b.getAttribute("aria-pressed") !== "true") b.click(); })()');
await new Promise(r => setTimeout(r, 200));
await evaluateInTarget(target.webSocketDebuggerUrl, '(() => { const b = document.querySelector(".header-module-toggle[data-module=reset]"); if (b && b.getAttribute("aria-pressed") === "true") b.click(); })()');
await new Promise(r => setTimeout(r, 200));
const hasVoucherOff = await evaluateInTarget(target.webSocketDebuggerUrl, 'Boolean(document.querySelector(".reset-voucher-section"))');
assert.equal(hasVoucherOff, false, 'Voucher section should be hidden when toggled off');
console.log('  Voucher section toggled off successfully (card hidden)');

await evaluateInTarget(target.webSocketDebuggerUrl, '(() => { const b = document.querySelector(".header-module-toggle[data-module=reset]"); if (b && b.getAttribute("aria-pressed") !== "true") b.click(); })()');
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
await evaluateInTarget(target.webSocketDebuggerUrl, '(() => { const b = document.querySelector(".header-module-toggle[data-module=reset]"); if (b?.getAttribute("aria-pressed") === "true") b.click(); })()');
await new Promise(r => setTimeout(r, 150));
// 开启重置券：应显示加载状态或有效的重置券
await evaluateInTarget(target.webSocketDebuggerUrl, '(() => { const b = document.querySelector(".header-module-toggle[data-module=reset]"); if (b?.getAttribute("aria-pressed") !== "true") b.click(); })()');
await new Promise(r => setTimeout(r, 50));
const hasVoucherSectionOrLoading = await evaluateInTarget(target.webSocketDebuggerUrl, 'Boolean(document.querySelector(".reset-voucher-section"))');
assert.equal(hasVoucherSectionOrLoading, true, 'Voucher section should be displayed when enabled');
console.log('  Voucher section display & loading contract verified');

console.log('✓ All V3 Interactive and Layout tests passed perfectly!');
