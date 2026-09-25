import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(rootDir, 'src', 'injected.js'), 'utf8');

assert.match(source, /function readLocalSetting\(key, fallback = null\) \{\s*try\s*\{\s*return window\.localStorage\.getItem\(key\) \?\? fallback;\s*\} catch \{\s*return fallback;\s*\}\s*\}/s);
assert.equal([...source.matchAll(/localStorage\.getItem/g)].length, 1, 'all storage reads must go through the guarded helper');
assert.doesNotMatch(source, /typeof localStorage/);
assert.match(source, /JSON\.parse\(readLocalSetting\(SETTINGS_KEY, '\{\}'\)/);
assert.match(source, /readLocalSetting\('codexQuotaHeader\.googleCollapsed', 'false'\)/);
assert.match(source, /readLocalSetting\('codexQuotaHeader\.selectedTokenRange'\)/);

const helper = source.match(/  function readLocalSetting\(key, fallback = null\) \{[\s\S]*?\n  \}/)?.[0];
assert.ok(helper, 'guarded local setting reader must exist');
const restrictedWindow = Object.defineProperty({}, 'localStorage', {
  get() { throw new Error('SecurityError'); },
});
const readLocalSetting = new Function('window', `${helper}; return readLocalSetting;`)(restrictedWindow);
assert.equal(readLocalSetting('codexQuotaHeader.settings.v1', '{}'), '{}');

console.log('✓ Restricted localStorage access safely falls back without aborting injection');
