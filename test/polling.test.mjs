 /**
  * 测试套件：智能双轨轮询和防抖逻辑
  */
 import assert from 'node:assert/strict';
 import { defaultConfig } from '../src/config.mjs';
 
 console.log('Testing: Smart Dual-Track Polling & Debounce...');
 
// 1. 轮询间隔检查
 function calculatePollingInterval(isDocumentHidden, config = defaultConfig) {
   return isDocumentHidden
     ? config.idleRefreshIntervalSeconds * 1000
     : config.refreshIntervalSeconds * 1000;
 }
 
 {
   // 活跃窗口：默认严格为 30 秒
   assert.equal(calculatePollingInterval(false), 30000);

   assert.equal(calculatePollingInterval(false, { ...defaultConfig, refreshIntervalSeconds: 60 }), 60000);
 
   // 后台窗口：180 秒（3 分钟），用于避免 429 并节省电量
   assert.equal(calculatePollingInterval(true), 180000);
 }
 
 // 2. 防抖冷却时间验证
 function shouldAllowManualRefresh(lastTime, now, cooldownMs = defaultConfig.debounceCooldownMs) {
   return (now - lastTime) >= cooldownMs;
 }
 
 {
   const baseTime = 1000000;
   // 100 毫秒内快速点击：拒绝
   assert.equal(shouldAllowManualRefresh(baseTime, baseTime + 100), false);
   // 在 4.9 秒时点击：拒绝
   assert.equal(shouldAllowManualRefresh(baseTime, baseTime + 4900), false);
   // 在 5.0 秒时点击：允许
   assert.equal(shouldAllowManualRefresh(baseTime, baseTime + 5000), true);
   // 在 10.0 秒时点击：允许
   assert.equal(shouldAllowManualRefresh(baseTime, baseTime + 10000), true);
 }
 
 console.log('✓ All Polling & Debounce tests passed!');
