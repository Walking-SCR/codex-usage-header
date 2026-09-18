 /**
  * Test Suite: Apple HIG Battery Color Palette & Threshold Mapping
  */
 import assert from 'node:assert/strict';
 import { getQuotaColor, defaultConfig } from '../src/config.mjs';
 
 console.log('Testing: Apple HIG Battery Color Mapping...');
 
 // Light Theme Tests
 {
   // Green Range: 40% - 100% remaining
   assert.equal(getQuotaColor(100, false), defaultConfig.colors.light.green);
   assert.equal(getQuotaColor(75, false), defaultConfig.colors.light.green);
   assert.equal(getQuotaColor(41, false), defaultConfig.colors.light.green);
 
   // Yellow Range: 20% - 40% remaining (Low Power Battery Amber)
   assert.equal(getQuotaColor(40, false), defaultConfig.colors.light.yellow);
   assert.equal(getQuotaColor(30, false), defaultConfig.colors.light.yellow);
   assert.equal(getQuotaColor(21, false), defaultConfig.colors.light.yellow);
 
   // Red Range: 0% - 20% remaining
   assert.equal(getQuotaColor(20, false), defaultConfig.colors.light.red);
   assert.equal(getQuotaColor(10, false), defaultConfig.colors.light.red);
   assert.equal(getQuotaColor(0, false), defaultConfig.colors.light.red);
 }
 
 // Dark Theme Tests
 {
   assert.equal(getQuotaColor(85, true), defaultConfig.colors.dark.green);
   assert.equal(getQuotaColor(35, true), defaultConfig.colors.dark.yellow);
   assert.equal(getQuotaColor(5, true), defaultConfig.colors.dark.red);
   assert.equal(getQuotaColor(0, true), defaultConfig.colors.dark.red);
 }
 
 console.log('✓ All Apple HIG Battery Color Mapping tests passed!');
