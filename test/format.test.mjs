 /**
  * Test Suite: Formatting, Countdown, & 4-Tier Adaptive Breakpoints
  */
 import assert from 'node:assert/strict';
 import { formatCountdown, resolveAdaptiveMode, normalizeUsagePayload } from '../src/utils.mjs';
 
 console.log('Testing: Countdown & Adaptive Breakpoints...');
 
 // 1. Countdown Formatting
 {
   // 5h format (hours and minutes)
   assert.equal(formatCountdown(2 * 3600 + 15 * 60), '2h 15m');
   assert.equal(formatCountdown(45 * 60), '45m');
   assert.equal(formatCountdown(0), '即将重置');
   assert.equal(formatCountdown(-10), '即将重置');
 
   // 7d format (days, hours, and minutes)
   assert.equal(formatCountdown(3 * 86400 + 14 * 3600 + 20 * 60, true), '3d 14h 20m');
   assert.equal(formatCountdown(1 * 86400 + 2 * 3600 + 5 * 60, true), '1d 2h 5m');
 }
 
 // 2. Adaptive Breakpoint Classification
 {
   assert.equal(resolveAdaptiveMode(700), 'full');
   assert.equal(resolveAdaptiveMode(520), 'full');
   assert.equal(resolveAdaptiveMode(519), 'compact');
   assert.equal(resolveAdaptiveMode(340), 'compact');
   assert.equal(resolveAdaptiveMode(339), 'minimal');
   assert.equal(resolveAdaptiveMode(210), 'minimal');
   assert.equal(resolveAdaptiveMode(209), 'nano');
   assert.equal(resolveAdaptiveMode(50), 'nano');

   // A 24px dead-band prevents resize feedback from bouncing between modes.
   assert.equal(resolveAdaptiveMode(510, 'full'), 'full');
   assert.equal(resolveAdaptiveMode(495, 'full'), 'compact');
   assert.equal(resolveAdaptiveMode(530, 'compact'), 'compact');
   assert.equal(resolveAdaptiveMode(545, 'compact'), 'full');
   assert.equal(resolveAdaptiveMode(220, 'nano'), 'nano');
   assert.equal(resolveAdaptiveMode(235, 'nano'), 'minimal');
 }
 
 // 3. Usage Payload Normalization
 {
   const sampleBackendApiPayload = {
     rate_limit: {
       primary_window: {
         used_percent: 28,
         reset_after_seconds: 7200,
         reset_at: Math.floor(Date.now() / 1000) + 7200,
       },
       secondary_window: {
         used_percent: 15,
         reset_after_seconds: 310000,
         reset_at: Math.floor(Date.now() / 1000) + 310000,
       },
     },
     rate_limit_reset_credits: 2,
   };
 
   const normalized = normalizeUsagePayload(sampleBackendApiPayload);
   assert.equal(normalized.primary.usedPercent, 28);
   assert.equal(normalized.primary.remainingPercent, 72);
   assert.equal(normalized.secondary.usedPercent, 15);
   assert.equal(normalized.secondary.remainingPercent, 85);
  assert.equal(normalized.resetCredits, 2);

  const weeklyExhausted = normalizeUsagePayload({
    rate_limit: {
      primary_window: { used_percent: 28, reset_after_seconds: 7200 },
      secondary_window: { used_percent: 100, reset_after_seconds: 310000 },
    },
  });
  assert.equal(weeklyExhausted.secondary.remainingPercent, 0);
  assert.equal(weeklyExhausted.primary.remainingPercent, 0);
  assert.equal(weeklyExhausted.primary.usedPercent, 100);
}
 
 console.log('✓ All Formatting & Adaptive Breakpoint tests passed!');
