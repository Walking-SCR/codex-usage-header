import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const renderer = readFileSync(join(root, 'src/injected.js'), 'utf8');
const css = readFileSync(join(root, 'assets/ui-quota/design.css'), 'utf8');
const launcher = readFileSync(join(root, 'bin/codex-header'), 'utf8');
const mount = renderer.match(/function mountCapsule\(\) \{([\s\S]*?)\n  function suppressLegacyInstances/);

assert.ok(mount, 'mountCapsule implementation must remain present');
assert.match(mount[1], /if \(changed\) \{\s*renderHost\(\)/, 'healthy periodic mount checks must not rewrite the capsule DOM');
assert.match(renderer, /previousFocusIndex[\s\S]*focus\(\{ preventScroll: true \}\)/, 'popover rerenders restore keyboard focus and scrolling');
assert.match(renderer, /let pointerMoveFrame = 0[\s\S]*requestAnimationFrame\(/, 'document-level pointer fallback is frame-batched');
assert.match(renderer, /on\(document, 'pointermove', handleDocumentPointerMove, true\)/);
assert.doesNotMatch(renderer, /on\(document, 'mousemove'/, 'do not process duplicate mouse and pointer streams');
assert.match(renderer, /if \(document\.hidden\) \{[\s\S]*?if \(countdownTimer\) clearInterval\(countdownTimer\)[\s\S]*?if \(healthTimer\) clearInterval\(healthTimer\)/, 'renderer countdowns and mount repair stop while Codex is hidden');
assert.match(renderer, /function isDarkAppearance\(\)/);
assert.match(renderer, /rootThemeObserver\.observe\(document\.documentElement, \{ attributes: true/);
assert.match(renderer, /on\(systemTheme, 'change'/, 'OS appearance changes update the widget unless the app explicitly pins a theme');
assert.match(renderer, /mini-pie-empty/);
assert.match(css, /container-type:inline-size;container-name:quota-card/);
assert.match(css, /@container quota-card \(max-width: 719px\)/);
assert.match(css, /@container quota-card \(max-width: 520px\)/);
assert.match(launcher, /\$HOME\/plugins\/codex-usage-header/);
assert.match(launcher, /\$HOME\/\.codex\/plugins\/codex-usage-header/);

console.log('✓ Reduced redundant UI work and responsive compatibility contracts passed');
