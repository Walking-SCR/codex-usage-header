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

function makeEl({ tag = 'div', rect = makeRect(), attrs = {}, text = '', children = [], display = 'block' } = {}) {
  const el = {
    tagName: String(tag).toUpperCase(),
    _rect: rect,
    _display: display,
    _attrs: { ...attrs },
    textContent: text,
    parentElement: null,
    children: [],
    classList: { contains: () => false },
    getAttribute(name) { return this._attrs[name] ?? null; },
    getBoundingClientRect() { return this._rect; },
    closest(selector) {
      let node = this;
      while (node) {
        if (selector === 'header' && node.tagName === 'HEADER') return node;
        if (selector === '[data-app-shell-header-toolbar="true"]' && node._attrs['data-app-shell-header-toolbar'] === 'true') return node;
        if (selector === '[role="toolbar"]' && node._attrs.role === 'toolbar') return node;
        node = node.parentElement;
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
  const fakeGetComputedStyle = el => ({ display: el._display || 'block', visibility: 'visible', opacity: '1' });
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
// 回归 3：26.924 Work 在原生按钮外增加两层 div.contents，必须插入真实布局容器。
for (const withHeader of [true, false]) {
  const button = makeEl({ tag: 'button', rect: makeRect({ top: 8, left: 1300, width: 28, height: 28 }), attrs: { 'aria-label': '聊天操作' } });
  const inner = makeEl({ display: 'contents', rect: makeRect({ width: 0, height: 0 }), children: [button] });
  const outer = makeEl({ display: 'contents', rect: makeRect({ width: 0, height: 0 }), children: [inner] });
  const actions = makeEl({ rect: makeRect({ top: 8, left: 1300, width: 62, height: 28 }), children: [outer] });
  const toolbar = makeEl({ rect: makeRect({ top: 0, left: 240, width: 1200, height: 44 }), attrs: { 'data-app-shell-header-toolbar': 'true' }, children: [actions] });
  if (withHeader) makeEl({ tag: 'header', rect: makeRect({ width: 1440, height: 44 }), children: [toolbar] });
  const point = makeEnv([button]).resolveMountPoint();
  assert.ok(point, `新版 Work（有 header=${withHeader}）必须找到安全挂载点`);
  assert.equal(point.container, actions);
  assert.equal(point.reference, outer);
  assert.equal(point.toolbar, toolbar);
}
// 回归 4：狭窄的侧栏 toolbar 即便有同名按钮，也不能被误判为 Work 顶栏。
{
  const button = makeEl({ tag: 'button', attrs: { 'aria-label': '聊天操作' }, rect: makeRect({ left: 10, top: 8, width: 28, height: 28 }) });
  makeEl({ attrs: { role: 'toolbar' }, rect: makeRect({ width: 200, height: 40 }), children: [button] });
  assert.equal(makeEnv([button]).resolveMountPoint(), null);
}

// 回归 5：新版主页/新对话（聊天/工作 Tab 下），右上角新建 [+] 按钮（无聊天操作/无面板切换按钮时）必须成功解析为 new-chat 挂载点
{
  const topbarNewChatBtn = makeEl({
    tag: 'button',
    rect: makeRect({ top: 8, left: 1390, width: 32, height: 32 }),
    attrs: { 'aria-label': '新聊天' },
  });
  const rightActions = makeEl({ tag: 'div', rect: makeRect({ top: 6, left: 1380, width: 50, height: 36 }), children: [topbarNewChatBtn] });
  const centerTabs = makeEl({ tag: 'div', rect: makeRect({ top: 6, left: 640, width: 160, height: 36 }), text: '聊天 工作' });
  const leftNav = makeEl({ tag: 'div', rect: makeRect({ top: 6, left: 10, width: 120, height: 36 }) });
  const header = makeEl({ tag: 'header', rect: makeRect({ top: 0, left: 0, width: 1440, height: 46 }), children: [leftNav, centerTabs, rightActions] });

  const point = makeEnv([topbarNewChatBtn]).resolveMountPoint();
  assert.ok(point, '新聊天页面仅有右上角新建按钮时必须解析成功');
  assert.equal(point.reference, rightActions, '锚点引用必须为右侧包含该按钮的直接区域');
  assert.equal(point.container, header, '挂载容器必须为顶栏 header');
  assert.equal(point.placement, 'new-chat');
}

// 回归 6：侧栏存在同名「新聊天」按钮，顶栏右上角存在新建 [+] 按钮 → 必须忽略侧栏按钮，精准锚定顶栏右上角
{
  const sidebarNewChatBtn = makeEl({
    tag: 'button',
    rect: makeRect({ top: 50, left: 12, width: 180, height: 36 }),
    attrs: { 'aria-label': '新聊天' },
  });
  const topbarNewChatBtn = makeEl({
    tag: 'button',
    rect: makeRect({ top: 8, left: 1390, width: 32, height: 32 }),
    attrs: { 'aria-label': '新聊天' },
  });
  const rightActions = makeEl({ tag: 'div', rect: makeRect({ top: 6, left: 1380, width: 50, height: 36 }), children: [topbarNewChatBtn] });
  const header = makeEl({ tag: 'header', rect: makeRect({ top: 0, left: 0, width: 1440, height: 46 }), children: [rightActions] });

  const point = makeEnv([sidebarNewChatBtn, topbarNewChatBtn]).resolveMountPoint();
  assert.ok(point, '同时存在侧栏与顶栏新聊天按钮时必须成功找到挂载点');
  assert.equal(point.reference, rightActions, '必须精准选择顶栏右侧区域，而非侧栏按钮');
  assert.equal(point.placement, 'new-chat');
}

// 回归 7：快捷键后缀兼容（如「新聊天 (⌘N)」、「新标签页 (⌘T)」、「New chat (⌘N)」）
for (const label of ['新聊天 (⌘N)', '新标签页 (⌘T)', '新建标签页', 'New chat (⌘N)', 'New tab (⌘T)', '+']) {
  const topbarBtn = makeEl({
    tag: 'button',
    rect: makeRect({ top: 8, left: 1390, width: 32, height: 32 }),
    attrs: { 'aria-label': label },
  });
  const rightActions = makeEl({ tag: 'div', rect: makeRect({ top: 6, left: 1380, width: 50, height: 36 }), children: [topbarBtn] });
  makeEl({ tag: 'header', rect: makeRect({ top: 0, left: 0, width: 1440, height: 46 }), children: [rightActions] });

  const point = makeEnv([topbarBtn]).resolveMountPoint();
  assert.ok(point, `快捷键/变体标签 "${label}" 必须被正确识别为有效新建操作`);
  assert.equal(point.placement, 'new-chat');
}

// 回归 8：顶栏采用单一包装层 <header><div class="inner flex">...</div></header> 时下钻排版容器
{
  const topbarBtn = makeEl({
    tag: 'button',
    rect: makeRect({ top: 8, left: 1390, width: 32, height: 32 }),
    attrs: { 'aria-label': '新标签页' },
  });
  const rightActions = makeEl({ tag: 'div', rect: makeRect({ top: 6, left: 1380, width: 50, height: 36 }), children: [topbarBtn] });
  const centerTabs = makeEl({ tag: 'div', rect: makeRect({ top: 6, left: 640, width: 160, height: 36 }) });
  const leftNav = makeEl({ tag: 'div', rect: makeRect({ top: 6, left: 10, width: 120, height: 36 }) });
  const innerFlex = makeEl({ tag: 'div', rect: makeRect({ top: 0, left: 0, width: 1440, height: 46 }), children: [leftNav, centerTabs, rightActions] });
  const header = makeEl({ tag: 'header', rect: makeRect({ top: 0, left: 0, width: 1440, height: 46 }), children: [innerFlex] });

  const point = makeEnv([topbarBtn]).resolveMountPoint();
  assert.ok(point, '嵌套包装容器下必须成功解析');
  assert.equal(point.container, innerFlex, '挂载容器必须正确下钻到实际排版容器 innerFlex，而不是顶层 header');
  assert.equal(point.reference, rightActions, '必须插入在右侧新建操作之前');
  assert.equal(point.placement, 'new-chat');
}

// 回归 9：Tier 5 兜底：纯 SVG / 无文字属性按钮，仅位于顶栏右侧，兜底命中
{
  const unlabeledBtn = makeEl({
    tag: 'button',
    rect: makeRect({ top: 8, left: 1400, width: 28, height: 28 }),
    attrs: {},
  });
  const header = makeEl({ tag: 'header', rect: makeRect({ top: 0, left: 0, width: 1440, height: 46 }), children: [unlabeledBtn] });

  const point = makeEnv([unlabeledBtn]).resolveMountPoint();
  assert.ok(point, '无标签属性的顶栏右侧新建按钮必须通过 Tier 5 兜底挂载');
  assert.equal(point.placement, 'new-chat');
  assert.equal(point.reference, unlabeledBtn);
}

// 回归 10：真实 ChatGPT Work 双区块顶栏结构（左侧导航区 + 主内容排版区）
// 绝对不能误将 mainSection 整个当作 reference，把胶囊插入到左侧（紧邻返回/侧边栏切换按钮）
{
  const topbarNewChatBtn = makeEl({
    tag: 'button',
    rect: makeRect({ top: 8, left: 1390, width: 32, height: 32 }),
    attrs: { 'aria-label': '新聊天' },
  });
  const rightActions = makeEl({ tag: 'div', rect: makeRect({ top: 6, left: 1380, width: 50, height: 36 }), children: [topbarNewChatBtn] });
  const centerTabs = makeEl({ tag: 'div', rect: makeRect({ top: 6, left: 640, width: 160, height: 36 }), text: '聊天 工作' });
  const mainSection = makeEl({ tag: 'div', rect: makeRect({ top: 0, left: 200, width: 1240, height: 46 }), children: [centerTabs, rightActions] });

  const sidebarBtn = makeEl({ tag: 'button', rect: makeRect({ top: 8, left: 150, width: 32, height: 32 }), attrs: { 'aria-label': '关闭侧边栏' } });
  const leftSection = makeEl({ tag: 'div', rect: makeRect({ top: 0, left: 0, width: 200, height: 46 }), children: [sidebarBtn] });

  const header = makeEl({ tag: 'header', rect: makeRect({ top: 0, left: 0, width: 1440, height: 46 }), children: [leftSection, mainSection] });

  const point = makeEnv([sidebarBtn, topbarNewChatBtn]).resolveMountPoint();
  assert.ok(point, '双区块顶栏结构下必须成功解析挂载点');
  assert.equal(point.container, mainSection, '挂载容器必须为 mainSection，绝不能误判为最外层 header');
  assert.equal(point.reference, rightActions, '锚点必须为右上角新建按钮区域，绝不可是 mainSection 本身');
  assert.equal(point.placement, 'new-chat');
}
assert.match(source, /const existing = document\.querySelector\(HOST_TAG\)/);
assert.match(source, /existing\?\.isConnected/);
assert.match(source, /point\.container\.insertBefore\(existing, point\.reference\)/);
assert.match(source, /existing\.style\.setProperty\('margin-left',\s*'auto'\)/);
assert.match(source, /host\.style\.setProperty\('margin-left',\s*'auto'\)/);
// 顶栏重建后自动重新挂载：MutationObserver + 健康检查缺一不可
assert.match(source, /new MutationObserver/);
assert.match(source, /healthTimer = setInterval/);
// 挂载成功后退避计数清零，避免后续重试间隔被污染
assert.match(source, /ensureMounted\.attempt = 0/);

console.log('✓ Mount Point Root Cause tests passed!');
