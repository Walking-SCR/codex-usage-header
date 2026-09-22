 /**
  * 测试套件：Apple HIG 电池配色和阈值映射
  */
 import assert from 'node:assert/strict';
 import { getQuotaColor, defaultConfig } from '../src/config.mjs';
 
 console.log('Testing: Apple HIG Battery Color Mapping...');
 
 // 浅色主题测试
 {
   // 绿色区间：剩余 41% - 100%
   assert.equal(getQuotaColor(100, false), defaultConfig.colors.light.green);
   assert.equal(getQuotaColor(75, false), defaultConfig.colors.light.green);
   assert.equal(getQuotaColor(41, false), defaultConfig.colors.light.green);
 
   // 黄色区间：剩余 11% - 40%（低电量电池琥珀色）
   assert.equal(getQuotaColor(40, false), defaultConfig.colors.light.yellow);
   assert.equal(getQuotaColor(30, false), defaultConfig.colors.light.yellow);
   assert.equal(getQuotaColor(11, false), defaultConfig.colors.light.yellow);
 
   // 红色区间：剩余 0% - 10%
   assert.equal(getQuotaColor(10, false), defaultConfig.colors.light.red);
   assert.equal(getQuotaColor(11, false), defaultConfig.colors.light.yellow);
   assert.equal(getQuotaColor(10, false), defaultConfig.colors.light.red);
   assert.equal(getQuotaColor(0, false), defaultConfig.colors.light.red);
 }
 
 // 深色主题测试
 {
   assert.equal(getQuotaColor(85, true), defaultConfig.colors.dark.green);
   assert.equal(getQuotaColor(35, true), defaultConfig.colors.dark.yellow);
   assert.equal(getQuotaColor(5, true), defaultConfig.colors.dark.red);
   assert.equal(getQuotaColor(0, true), defaultConfig.colors.dark.red);
 }
 
 console.log('✓ All Apple HIG Battery Color Mapping tests passed!');
