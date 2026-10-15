import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(root, 'src/injected.js'), 'utf8');
const helper = source.match(/function normalizeResetCreditDetails\(raw, previous = \{\}\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(helper, 'reset-credit normalization helper must be present');
const normalize = new Function(`return (${helper})`)();

const withDetails = normalize({ rateLimitResetCredits: {
  availableCount: 3,
  credits: [{ id: 'a', expiresAt: 100 }, { id: 'b', expiresAt: 200 }],
} });
assert.equal(withDetails.availableCount, 3);
assert.equal(withDetails.state, 'loaded');
assert.equal(withDetails.details.length, 2);
assert.equal(withDetails.loaded, true);

const countOnlyCamel = normalize({ rateLimitResetCredits: { availableCount: 3 } });
assert.equal(countOnlyCamel.availableCount, 3);
assert.equal(countOnlyCamel.state, 'unavailable');
assert.equal(countOnlyCamel.loaded, false);

const countOnlyLegacy = normalize({ rateLimitResetCredits: null, rate_limit_reset_credits: 3 });
assert.equal(countOnlyLegacy.availableCount, 3, 'a null modern field must fall back to the legacy count');
assert.equal(countOnlyLegacy.state, 'unavailable');

const empty = normalize({ rateLimitResetCredits: { availableCount: 0, credits: [] } });
assert.equal(empty.state, 'empty');
assert.equal(empty.loaded, true);

const lastKnown = [{ id: 'known', expiresAt: 500 }];
const stale = normalize({ rate_limit_reset_credits: 2 }, {
  resetCreditDetailsLoaded: true,
  resetCreditDetails: lastKnown,
});
assert.equal(stale.state, 'stale');
assert.deepEqual(stale.details, lastKnown, 'missing detail fields must not erase a last-known card');

assert.match(source, /vouchersLoading = false;[\s\S]*?resetCreditDetailsState: resetDetailPayload\.state/,
  'a successful quota response without voucher details must end the spinner');
assert.match(source, /settings\.enableResetCredits && vouchersLoading && !usageState\.resetCreditDetailsLoaded/,
  'loading UI must represent an active request, not just missing optional details');
assert.doesNotMatch(source.match(/function hidePopover\([\s\S]*?\n  \}/)?.[0] || '', /popover\.__lastMarkup = null/,
  'closing and reopening without data changes should not force a full card rebuild');
assert.match(source, /if \(popoverState !== 'closed'\) suppressHoverUntilLeave = true;\s*hidePopover\(true\);/,
  'hiding the app must dismiss the popover so it does not reappear on restore');

console.log('✓ Popover dismissal and reset-credit loading lifecycle tests passed');
