import assert from 'node:assert/strict';
import { fetchCdpTargets, selectUsageTargets, evaluateInTarget } from '../src/launcher.mjs';

console.log('Testing: V3 Interactive and Layout features...');

const targets = selectUsageTargets(await fetchCdpTargets(9229));
const [target] = targets;
assert.ok(target, 'Target must exist');

// 1. Show popover
await evaluateInTarget(target.webSocketDebuggerUrl, 'window.__codexUsageHeaderDebug__.showPopover()');
await new Promise(r => setTimeout(r, 250));

// Ensure Google AI Pro is toggled ON for interactive checks
await evaluateInTarget(target.webSocketDebuggerUrl, '(() => { const btn = document.querySelector(".google-toggle-btn"); if (btn && !btn.classList.contains("is-active")) btn.click(); })()');
await new Promise(r => setTimeout(r, 250));

const initialHeight = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".codex-usage-popover-v24").getBoundingClientRect().height');
assert.ok(initialHeight > 500, 'Initial height should be > 500');

// 2. Collapse Google AI Pro
await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".quota-extension-toggle").click()');
await new Promise(r => setTimeout(r, 250));
const collapsedHeight = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".codex-usage-popover-v24").getBoundingClientRect().height');
assert.ok(collapsedHeight < initialHeight - 100, 'Collapsed height must be significantly lower (>100px reduction)');

// 3. Expand Google AI Pro back
await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".quota-extension-toggle").click()');
await new Promise(r => setTimeout(r, 250));
const expandedHeight = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".codex-usage-popover-v24").getBoundingClientRect().height');
assert.ok(Math.abs(expandedHeight - initialHeight) < 5, 'Expanded height should restore');

// 4. Test range tab switching & no-wrap on large totals (days30)
await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".quota-extension-range-tab[data-range=\'days30\']").click()');
await new Promise(r => setTimeout(r, 200));
const activeRange30 = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".quota-extension-range-tab.is-active").dataset.range');
assert.equal(activeRange30, 'days30');
const tokenTotalDays30 = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".token-summary-number").innerText');
const summaryValHeight = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".token-summary-val").getBoundingClientRect().height');
assert.ok(summaryValHeight < 45, 'Token summary must remain single-line (no wrap to 72px)');
console.log('  Switched to days30:', activeRange30, 'total tokens:', tokenTotalDays30, 'valHeight:', summaryValHeight);

// 4.1. Test range tab switching
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

// 5. Test account switching
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

// 6. Test capsule arrow toggle
await evaluateInTarget(target.webSocketDebuggerUrl, 'window.__codexUsageHeaderDebug__.showPopover()');
await new Promise(r => setTimeout(r, 150));
const capsuleArrowOpen = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector("codex-usage-header-host").shadowRoot.querySelector(".capsule-arrow")?.innerText');
assert.equal(capsuleArrowOpen, '▴');

await evaluateInTarget(target.webSocketDebuggerUrl, 'window.__codexUsageHeaderDebug__.hidePopover()');
await new Promise(r => setTimeout(r, 300));
const capsuleArrowClosed = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector("codex-usage-header-host").shadowRoot.querySelector(".capsule-arrow")?.innerText');
assert.equal(capsuleArrowClosed, '▾');

// 7. Test toggling Google AI Pro off and on
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

console.log('✓ All V3 Interactive and Layout tests passed perfectly!');
