 /**
  * Master Test Runner for Codex Quota Header
  */
 import { spawnSync } from 'node:child_process';
 import { fileURLToPath } from 'node:url';
 import { dirname, join } from 'node:path';
 
 const __dirname = dirname(fileURLToPath(import.meta.url));
 
 const testFiles = [
   'color.test.mjs',
   'format.test.mjs',
   'polling.test.mjs',
   'resilience.test.mjs',
  'launcher.test.mjs',
  'installer.test.mjs',
  'renderer-contract.test.mjs',
  'refresh-contract.test.mjs',
  'extended-tokens.test.mjs',
  'extended-gemini.test.mjs',
  'account-switch.test.mjs',
];

console.log('========================================================');
 console.log('🚀 Running Codex Quota Header Test Suite...');
 console.log('========================================================\n');
 
 let allPassed = true;
 
 for (const file of testFiles) {
   const fullPath = join(__dirname, file);
   console.log(`▶ Executing ${file}:`);
   const result = spawnSync(process.execPath, [fullPath], {
     stdio: 'inherit',
   });
 
   if (result.status !== 0) {
     console.error(`❌ Test failed in ${file} (Exit code: ${result.status})`);
     allPassed = false;
   }
   console.log('');
 }
 
 console.log('========================================================');
 if (allPassed) {
   console.log(`🎉 ALL TESTS PASSED SUCCESSFULLY! (${testFiles.length}/${testFiles.length} test suites)`);
   console.log('✓ Apple HIG Battery Palette verified');
   console.log('✓ 4-Tier Adaptive Breakpoints verified');
   console.log('✓ Smart Dual-Track Polling verified');
   console.log('✓ Cascading Anchor Self-Healing verified');
   console.log('✓ CDP launcher diagnostics verified');
   console.log('✓ Installer permissions and wrapper verified');
   console.log('✓ Renderer mounting and interaction contract verified');
   console.log('========================================================');
   process.exit(0);
 } else {
   console.error('❌ SOME TESTS FAILED.');
   console.log('========================================================');
   process.exit(1);
 }
