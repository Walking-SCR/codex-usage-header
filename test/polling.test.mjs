 /**
  * Test Suite: Smart Dual-Track Polling & Debounce Logic
  */
 import assert from 'node:assert/strict';
 import { defaultConfig } from '../src/config.mjs';
 
 console.log('Testing: Smart Dual-Track Polling & Debounce...');
 
 // 1. Polling interval evaluation
 function calculatePollingInterval(isDocumentHidden, config = defaultConfig) {
   return isDocumentHidden
     ? config.idleRefreshIntervalSeconds * 1000
     : config.refreshIntervalSeconds * 1000;
 }
 
 {
   // Active window: strictly 30s by default
   assert.equal(calculatePollingInterval(false), 30000);

   assert.equal(calculatePollingInterval(false, { ...defaultConfig, refreshIntervalSeconds: 60 }), 60000);
 
   // Background window: 180s (3 minutes) to prevent 429 and save battery
   assert.equal(calculatePollingInterval(true), 180000);
 }
 
 // 2. Debounce cooldown verification
 function shouldAllowManualRefresh(lastTime, now, cooldownMs = defaultConfig.debounceCooldownMs) {
   return (now - lastTime) >= cooldownMs;
 }
 
 {
   const baseTime = 1000000;
   // Rapid clicking within 100ms: rejected
   assert.equal(shouldAllowManualRefresh(baseTime, baseTime + 100), false);
   // Click at 4.9s: rejected
   assert.equal(shouldAllowManualRefresh(baseTime, baseTime + 4900), false);
   // Click at 5.0s: allowed
   assert.equal(shouldAllowManualRefresh(baseTime, baseTime + 5000), true);
   // Click at 10.0s: allowed
   assert.equal(shouldAllowManualRefresh(baseTime, baseTime + 10000), true);
 }
 
 console.log('✓ All Polling & Debounce tests passed!');
