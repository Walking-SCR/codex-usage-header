/**
 * 测试套件：挂载点根因回归
 *
 * P0-1：只从有效顶栏中寻找锚点按钮；候选不合格时继续查找，
 * 不因侧栏的同名按钮提前退出。
 *
 * 回归 1：侧栏和顶栏同时存在同名「聊天操作」按钮 → 始终选择顶栏。
 * 回归 2：启动后才出现顶栏、切换页面后顶栏被重建 → 组件自行挂载且仅一次。
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

console.log('Testing: Mount Point Root Cause...');

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const source = readFileSync(join(rootDir, 'src', 'injected.js'), 'utf8');

// ---- 从源码提取挂载点逻辑块（标记区间），在桩 DOM 上真实执行 ----
const beginMarker = '// __MOUNT_POINT_LOGIC_BEGIN__';
const endMarker = '// __MOUNT_POINT_LOGIC_END__';
const begin = source.indexOf(beginMarker);
const end = source.indexOf(endMarker);
assert.ok(begin >= 0 && end > begin, 'mount point logic block markers must exist');
const logicBlock = source.slice(begin, end);

// ---- 最小桩 DOM ----
function makeRect({ top = 0, left = 0, width = 100, height = 40 } = {}) {
  return { top, left, width, height, right: left + width, bottom: top + height };
}

function makeEl({ tag = 'div', rect = makeRect(), attrs = {}, text = '', children = [] } = {}) {
  const el = {
    tagName: String(tag).toUpperCase(),
    _rect: rect,
    _attrs: { ...attrs },
    textContent: text,
    parentElement: null,
    children: [],
    classList: { contains: () => false },
    getAttribute(name) { return this._attrs[name] ?? null; },
    getBoundingClientRect() { return this._rect; },
    closest(selector) {
      let node = this.parentElement;
      if (selector === 'header') {
        while (node) {
          if (node.tagName === 'HEADER') return node;
          node = node.parentElement;
        }
        return null;
      }
      return null;
    },
    contains(node) {
      let current = node;
      while (current) {
        if (current === this) return true;
        current = current.parentElement;
      }
      return false;
    },
    querySelectorAll() { return []; },
  };
  for (const child of children) {
    child.parentElement = el;
    el.children.push(child);
  }
  return el;
}

function makeEnv(buttons) {
  const fakeDocument = {
    querySelectorAll(selector) {
      if (selector === 'button') return [...buttons];
      return [];
    },
  };
  const fakeWindow = { innerWidth: 1440 };
  const fakeGetComputedStyle = () => ({ display: 'block', visibility: 'visible', opacity: '1' });
  const factory = new Function(
    'document', 'window', 'getComputedStyle',
    `${logicBlock}\nreturn { resolveMountPoint, validateActionAnchor };`
  );
  return factory(fakeDocument, fakeWindow, fakeGetComputedStyle);
}

// 构造：侧栏按钮（DOM 顺序在前，不在 <header> 内）+ 顶栏 header 内按钮
function buildSidebarTopbar() {
  const sidebarBtn = makeEl({
    tag: 'button',
    rect: makeRect({ top: 10, left: 8, width: 120, height: 32 }),
    attrs: { 'aria-label': '聊天操作' },
  });
  const sidebar = makeEl({ tag: 'div', rect: makeRect({ top: 0, left: 0, width: 200, height: 800 }), children: [sidebarBtn] });

  const topbarBtn = makeEl({
    tag: 'button',
    rect: makeRect({ top: 8, left: 700, width: 32, height: 32 }),
    attrs: { 'aria-label': '聊天操作' },
  });
  const actions = makeEl({ tag: 'div', rect: makeRect({ top: 6, left: 640, width: 200, height: 36 }), children: [topbarBtn] });
  const toolbar = makeEl({ tag: 'div', rect: makeRect({ top: 4, left: 200, width: 900, height: 40 }), children: [actions] });
  const header = makeEl({ tag: 'header', rect: makeRect({ top: 0, left: 0, width: 1440, height: 46 }), children: [toolbar] });

  return { sidebarBtn, topbarBtn, header, buttons: [sidebarBtn, topbarBtn] };
}

// ---- 回归 1：同名按钮必须选顶栏 ----
{
  const { topbarBtn, buttons } = buildSidebarTopbar();
  const { resolveMountPoint } = makeEnv(buttons);
  const point = resolveMountPoint();
  assert.ok(point, '顶栏按钮有效时必须解析出挂载点（不能因侧栏同名按钮返回 null）');
  assert.equal(point.reference, topbarBtn, '必须选择顶栏内的按钮，而非侧栏同名按钮');
  assert.equal(point.placement, 'thread');
}

// ---- 回归 1b：只有侧栏同名按钮时 → 明确返回 null（等待顶栏，而非挂载到错误位置） ----
{
  const { sidebarBtn } = buildSidebarTopbar();
  const { resolveMountPoint } = makeEnv([sidebarBtn]);
  assert.equal(resolveMountPoint(), null, '没有有效顶栏时必须返回 null（等待状态）');
}

// ---- 回归 2：顶栏后出现 → 可挂载；页面切换顶栏重建 → 重新解析到新节点 ----
{
  const first = buildSidebarTopbar();
  let env = makeEnv([first.sidebarBtn]);
  assert.equal(env.resolveMountPoint(), null, '启动时顶栏尚未出现 → 等待');

  env = makeEnv(first.buttons);
  const p1 = env.resolveMountPoint();
  assert.ok(p1 && p1.reference === first.topbarBtn, '顶栏出现后 → 解析出挂载点');

  // 模拟页面切换：旧顶栏被移除，全新节点重建
  const second = buildSidebarTopbar();
  env = makeEnv(second.buttons);
  const p2 = env.resolveMountPoint();
  assert.ok(p2, '顶栏重建后 → 重新解析出挂载点');
  assert.equal(p2.reference, second.topbarBtn, '必须锚定到重建后的新按钮节点，而非过期引用');
  assert.notEqual(p2.reference, first.topbarBtn, '不得复用已 detached 的旧节点');
}

// ---- 幂等挂载：源码必须复用已存在的 host，而不是重复创建 ----
assert.match(source, /const existing = document\.querySelector\(HOST_TAG\)/);
assert.match(source, /existing\?\.isConnected/);
assert.match(source, /point\.container\.insertBefore\(existing, point\.reference\)/);
// 顶栏重建后自动重新挂载：MutationObserver + 健康检查缺一不可
assert.match(source, /new MutationObserver/);
assert.match(source, /healthTimer = setInterval/);
// 挂载成功后退避计数清零，避免后续重试间隔被污染
assert.match(source, /ensureMounted\.attempt = 0/);

console.log('✓ Mount Point Root Cause tests passed!');
