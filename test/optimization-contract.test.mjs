import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const renderer = readFileSync(join(root, 'src/injected.js'), 'utf8');
const css = readFileSync(join(root, 'assets/ui-quota/design.css'), 'utf8');
const launcher = readFileSync(join(root, 'bin/codex-header'), 'utf8');
const mount = renderer.match(/function mountCapsule\(\) \{([\s\S]*?)\n  function suppressLegacyInstances/);
const widthMeasure = renderer.match(/function measureAvailableWidth\(element\) \{([\s\S]*?)\n  function renderHost/);
const updateMode = renderer.match(/function updateMode\(\) \{([\s\S]*?)\n  function ensureHostHitArea/);
const resizeBinding = renderer.match(/function bindResizeObserver\(\) \{([\s\S]*?)\n  \/\/ __MOUNT_POINT_LOGIC_BEGIN__/);

assert.ok(mount, 'mountCapsule implementation must remain present');
assert.ok(widthMeasure, 'available-width measurement must remain present');
assert.ok(updateMode, 'responsive mode update must remain present');
assert.ok(resizeBinding, 'layout observer must remain present');
assert.match(mount[1], /if \(changed\) \{\s*renderHost\(\)/, 'healthy periodic mount checks must not rewrite the capsule DOM');
assert.match(mount[1], /周期性挂载巡检[\s\S]*?updateMode\(\);/, 'unchanged mounts must refresh geometry when position changes without resize');
assert.doesNotMatch(widthMeasure[1], /currentHostWidth|maxCanExpand|freeSpaceToRight/, 'mode measurement must not use the capsule width as available space');
assert.match(widthMeasure[1], /firstVisibleLayoutRect\(element\.nextElementSibling\)/, 'display:contents anchors must resolve to a visible native child');
assert.match(widthMeasure[1], /rightControl\.contains\(element\)/, 'right boundary must exclude flex rows containing the injected capsule');
assert.doesNotMatch(renderer, /host\.shadowRoot\.innerHTML\s*=\s*style/, 'host rerenders must preserve the capsule root');
assert.match(updateMode[1], /if \(popover\?\.classList\.contains\('is-visible'\)\) positionPopover\(\)/, 'visible popover follows layout changes even when the mode is unchanged');
assert.doesNotMatch(resizeBinding[1], /observe\(host\?\.parentElement\)|observe\(toolbar\)/, 'resize observer must not subscribe to the host flex container');
assert.match(resizeBinding[1], /observe\(host\.nextElementSibling\)/, 'right-side native anchor changes must be observed');
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

// 新增性能优化与窗口缩窄跟手回归断言
assert.match(renderer, /function ensurePopoverStyles\(dark\b/, 'popover static CSS must be managed as a singleton <style>');
assert.doesNotMatch(renderer, /popoverMarkup\(dark\)\s*\{[\s\S]*?<style>/, 'popoverMarkup must not rebuild 60KB <style> on every render');
assert.doesNotMatch(renderer, /quota-number-shimmer[^\n]*blur\(/, 'shimmer animation must use pure compositor opacity without filter:blur');
assert.match(renderer, /if \(nextDark === lastRenderedDark\) return;/, 'rootThemeObserver must ignore non-theme html attribute mutations');
assert.match(renderer, /popoverState === 'closed' && !popoverShowTimer && event\.clientY > 96/, 'document pointermove must short-circuit outside header when popover is closed');
assert.match(css, /contain:\s*layout style/, 'complex popover sections must isolate layout/style recalculation');

const overlayMain = readFileSync(join(root, 'src/claude-overlay/main.m'), 'utf8');
const installSh = readFileSync(join(root, 'bin/install.sh'), 'utf8');
assert.match(overlayMain, /- \(void\)pauseTimers/, 'Claude overlay helper must pause timers when unfocused');
assert.match(overlayMain, /- \(void\)resumeTimers/, 'Claude overlay helper must resume timers when Claude activates');
assert.match(overlayMain, /kCGWindowListOptionOnScreenOnly \| kCGWindowListExcludeDesktopElements/, 'WindowServer query must exclude offscreen/desktop windows');
assert.match(overlayMain, /0\.016/, 'Active resize tracking must run at ~60Hz');
assert.match(installSh, /codesign --force --sign - --identifier "com\.codex-usage-header\.claude-overlay-helper"/, 'Installer must preserve ad-hoc code signing identity for TCC');

// 实测 measureAvailableWidth 在 display:contents 包装锚点与嵌套顶栏槽位下缩窄窗口的实时跟手性
const widthSliceStart = renderer.indexOf('  function measureTitleNeed(');
const widthSliceEnd = renderer.indexOf('  function renderHost(', widthSliceStart);
assert.ok(widthSliceStart >= 0 && widthSliceEnd > widthSliceStart);

function createMockEl({ rect = null, tag = 'div', classes = [], style = {}, dataset = {}, children = [], attrs = {} } = {}) {
  const classSet = new Set(classes);
  const el = {
    tagName: tag.toUpperCase(),
    dataset: { ...dataset },
    style: { flexGrow: '0', textOverflow: 'clip', overflow: 'visible', whiteSpace: 'normal', ...style },
    parentElement: null,
    previousElementSibling: null,
    nextElementSibling: null,
    children: [],
    classList: {
      contains: c => classSet.has(c),
    },
    getAttribute: name => attrs[name] ?? null,
    getBoundingClientRect: () => rect || { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 },
    closest(selector) {
      let cur = this;
      while (cur) {
        if (selector.includes('data-app-shell-header-toolbar') && cur.getAttribute('data-app-shell-header-toolbar') === 'true') return cur;
        if (selector.includes('@container/titlebar') && [...classSet].some(() => String(cur._classAttr || '').includes('@container/titlebar'))) return cur;
        if (selector.split(',').map(s => s.trim()).includes(cur.tagName.toLowerCase())) return cur;
        cur = cur.parentElement;
      }
      return null;
    },
    querySelector: () => null,
    querySelectorAll(selector) {
      const out = [];
      const walk = node => {
        for (const ch of node.children || []) {
          if (selector === '*' || selector.split(',').some(s => s.trim() === ch.tagName.toLowerCase())) out.push(ch);
          walk(ch);
        }
      };
      walk(this);
      return out;
    },
    contains(target) {
      let cur = target;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentElement;
      }
      return false;
    },
  };
  el._classAttr = classes.join(' ');
  setChildren(el, children);
  return el;
}

function setChildren(parent, list) {
  parent.children = list;
  parent.firstElementChild = list[0] || null;
  for (let i = 0; i < list.length; i += 1) {
    list[i].parentElement = parent;
    list[i].previousElementSibling = list[i - 1] || null;
    list[i].nextElementSibling = list[i + 1] || null;
  }
}

let mockInnerWidth = 1100;
const buildMeasureHelpers = new Function(
  'window',
  'document',
  'getComputedStyle',
  'visibleRect',
  `${renderer.slice(widthSliceStart, widthSliceEnd)}; return { measureAvailableWidth, computeFluidTrackWidth };`,
);
const mockWindow = {
  get innerWidth() { return mockInnerWidth; },
};
const mockDocument = {
  querySelector: () => null,
};
const visibleRect = el => {
  const r = el?.getBoundingClientRect?.();
  return r && r.width > 0 && r.height > 0 ? r : null;
};
const { measureAvailableWidth, computeFluidTrackWidth } = buildMeasureHelpers(
  mockWindow,
  mockDocument,
  el => el?.style || {},
  visibleRect,
);

// Case 1: chat placement，nextElementSibling 为 display:contents 包装器（自身零矩形，内部包裹右侧操作按钮）
for (const [winW, minExpected, maxExpected] of [[1100, 520, 700], [720, 200, 300], [520, 0, 100]]) {
  mockInnerWidth = winW;
  const titleBtn = createMockEl({ tag: 'button', rect: { left: 260, top: 8, right: 330, bottom: 36, width: 70, height: 28 } });
  const titleRegion = createMockEl({ rect: { left: 250, top: 4, right: 340, bottom: 40, width: 90, height: 36 }, children: [titleBtn] });
  const hostEl = createMockEl({ tag: 'codex-usage-header-host', dataset: { placement: 'chat' }, rect: { left: 350, top: 5, right: 726, bottom: 39, width: 376, height: 34 } });
  const actionBtn = createMockEl({ tag: 'button', rect: { left: winW - 96, top: 8, right: winW - 16, bottom: 36, width: 80, height: 28 } });
  const contentsWrapper = createMockEl({ rect: { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 }, style: { display: 'contents' }, children: [actionBtn] });
  const toolbar = createMockEl({
    attrs: { 'data-app-shell-header-toolbar': 'true' },
    rect: { left: 250, top: 0, right: winW, bottom: 44, width: winW - 250, height: 44 },
    children: [titleRegion, hostEl, contentsWrapper],
  });
  assert.ok(toolbar);
  const measured = measureAvailableWidth(hostEl);
  assert.ok(measured >= minExpected && measured <= maxExpected, `chat width at winW=${winW} should be in [${minExpected}, ${maxExpected}], got ${measured}`);
}

// Case 2: new-chat-right placement，host 嵌套在右侧组且自身宽度曾撑出视口，左侧祖先有 290px 导航栏
mockInnerWidth = 680;
const leftNav = createMockEl({ rect: { left: 0, top: 0, right: 290, bottom: 44, width: 290, height: 44 } });
const hostNested = createMockEl({ tag: 'codex-usage-header-host', dataset: { placement: 'new-chat-right' }, rect: { left: 300, top: 5, right: 676, bottom: 39, width: 376, height: 34 } });
const plusBtn = createMockEl({ tag: 'button', rect: { left: 682, top: 8, right: 718, bottom: 36, width: 36, height: 28 } });
const rightSlot = createMockEl({ rect: { left: 300, top: 0, right: 724, bottom: 44, width: 424, height: 44 }, children: [hostNested, plusBtn] });
const newChatHeader = createMockEl({
  attrs: { 'data-app-shell-header-toolbar': 'true' },
  // 模拟子元素未收缩前把 headerRect.right 撑大到 724 (> mockInnerWidth=680)
  rect: { left: 0, top: 0, right: 724, bottom: 44, width: 724, height: 44 },
  children: [leftNav, rightSlot],
});
assert.ok(newChatHeader);
const nestedMeasured = measureAvailableWidth(hostNested);
assert.ok(nestedMeasured < 360 && nestedMeasured > 280, `nested new-chat-right at winW=680 must clamp to viewport and subtract leftNav+plusBtn, got ${nestedMeasured}`);
assert.ok(computeFluidTrackWidth('compact', nestedMeasured, 'new-chat-right') < 50, 'fluid track width must narrow smoothly in compact mode');

console.log('✓ Reduced redundant UI work and responsive compatibility contracts passed');
