import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluateInTarget, fetchCdpTargets, selectUsageTargets } from '../src/launcher.mjs';

const rootDir = dirname(dirname(fileURLToPath(import.meta.url)));
const evidenceDir = join(rootDir, 'audit', '2026-09-18-quota-header');

function cdpCommand(wsUrl, method, params = {}, timeoutMs = 6000) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const id = 1;
    const timer = setTimeout(() => {
      try { ws.close(); } catch { /* already closed */ }
      reject(new Error(`${method}_timeout`));
    }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id, method, params }));
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer);
      ws.close();
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    };
    ws.onerror = () => {
      clearTimeout(timer);
      reject(new Error(`${method}_websocket_error`));
    };
  });
}

async function mouseClick(wsUrl, point) {
  await cdpCommand(wsUrl, 'Input.dispatchMouseEvent', {
    type: 'mousePressed',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
  await cdpCommand(wsUrl, 'Input.dispatchMouseEvent', {
    type: 'mouseReleased',
    x: point.x,
    y: point.y,
    button: 'left',
    clickCount: 1,
  });
}

const [target] = selectUsageTargets(await fetchCdpTargets(9229));
assert.ok(target, 'Codex renderer with CDP must be available');

const widths = [1440, 1100, 900, 760];
const snapshots = [];

try {
  for (const width of widths) {
    await cdpCommand(target.webSocketDebuggerUrl, 'Emulation.setDeviceMetricsOverride', {
      width,
      height: 820,
      deviceScaleFactor: 1,
      mobile: false,
    });
    await new Promise(resolve => setTimeout(resolve, 320));
    const snapshot = await evaluateInTarget(target.webSocketDebuggerUrl, `(() => {
      const element = document.querySelector('codex-usage-header-v23');
      const isVisibleAnchor = button => {
        const rect = button.getBoundingClientRect();
        const style = getComputedStyle(button);
        return style.display !== 'none'
          && style.visibility !== 'hidden'
          && Number(style.opacity) > 0
          && rect.width > 0
          && rect.height > 0
          && rect.left < innerWidth
          && rect.right > 0;
      };
      const more = [...document.querySelectorAll('button')].find(button => button.getAttribute('aria-label') === '聊天操作' && isVisibleAnchor(button));
      const newChatAnchor = [...document.querySelectorAll('button')].find(button => ['切换底部面板显示', '显示/隐藏侧边面板'].includes(button.getAttribute('aria-label') || '') && isVisibleAnchor(button));
      const safeAnchor = more || newChatAnchor;
      const capsule = element?.shadowRoot?.querySelector('.capsule');
      const rect = element?.getBoundingClientRect();
      const moreRect = safeAnchor?.getBoundingClientRect();
      return {
        viewport: innerWidth,
        placement: element?.dataset?.placement,
        anchor: safeAnchor?.getAttribute('aria-label'),
        mode: element?.dataset?.mode,
        availableWidth: Number(element?.dataset?.availableWidth),
        hostWidth: rect?.width,
        hostHeight: rect?.height,
        gapToMore: rect && moreRect ? moreRect.left - rect.right : null,
        overlapsMore: rect && moreRect ? rect.right > moreRect.left : true,
        hostAppRegion: element ? getComputedStyle(element).getPropertyValue('-webkit-app-region') : null,
        capsuleAppRegion: capsule ? getComputedStyle(capsule).getPropertyValue('-webkit-app-region') : null,
        capsuleGap: capsule ? getComputedStyle(capsule).gap : null,
        trackHeight: element?.shadowRoot?.querySelector('.track')
          ? getComputedStyle(element.shadowRoot.querySelector('.track')).height
          : null,
        capsuleText: capsule?.innerText,
      };
    })()`);
    snapshots.push(snapshot);
    assert.equal(snapshot.overlapsMore, false, `quota header must not cover the native header anchor at ${width}px`);
    assert.ok(snapshot.gapToMore >= 4, `quota header must preserve a safe gap at ${width}px`);
    assert.ok(['thread', 'new-chat'].includes(snapshot.placement), `quota header must resolve a supported placement at ${width}px`);
    assert.equal(snapshot.hostHeight, 34, `quota header height must stay stable at ${width}px`);
    assert.equal(snapshot.hostAppRegion, 'no-drag', `host must accept physical pointer input at ${width}px`);
    assert.equal(snapshot.capsuleAppRegion, 'no-drag', `capsule must accept physical pointer input at ${width}px`);
    assert.equal(snapshot.capsuleGap, '5px', `internal 5h/7d rhythm must stay at 5px at ${width}px`);
    if (snapshot.mode === 'nano') {
      assert.equal(snapshot.trackHeight, null, 'Nano mode must hide the progress track');
    } else {
      assert.equal(snapshot.trackHeight, '12px', `header progress track must stay at 12px at ${width}px`);
    }
  }

  const modes = snapshots.map(item => item.mode);
  if (snapshots.every(item => item.placement === 'thread')) {
    assert.deepEqual(modes, ['full', 'compact', 'minimal', 'nano']);
  } else {
    assert.ok(modes.every(mode => ['full', 'compact', 'minimal', 'nano'].includes(mode)), 'new-chat placement must stay within supported responsive modes');
  }

  await cdpCommand(target.webSocketDebuggerUrl, 'Emulation.setDeviceMetricsOverride', {
    width: 1440,
    height: 820,
    deviceScaleFactor: 1,
    mobile: false,
  });
  const capsulePoint = await evaluateInTarget(target.webSocketDebuggerUrl, `(() => {
    window.__codexUsageHeaderDebug__?.hidePopover();
    const capsule = document.querySelector('codex-usage-header-v23')?.shadowRoot?.querySelector('.capsule');
    const rect = capsule?.getBoundingClientRect();
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  })()`);
  assert.ok(capsulePoint, 'quota header capsule must expose a pointer target');
  await cdpCommand(target.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: capsulePoint.x,
    y: capsulePoint.y,
  });
  await new Promise(resolve => setTimeout(resolve, 180));
  const popover = await evaluateInTarget(target.webSocketDebuggerUrl, `(() => {
    const node = document.querySelector('.codex-usage-popover-v23');
    const rect = node?.getBoundingClientRect();
    return {
      visible: getComputedStyle(node).visibility === 'visible',
      position: getComputedStyle(node).position,
      pointerEvents: getComputedStyle(node).pointerEvents,
      withinViewport: Boolean(rect && rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight),
      text: node?.innerText,
    };
  })()`);
  assert.equal(popover.visible, true);
  assert.equal(popover.position, 'fixed');
  assert.equal(popover.pointerEvents, 'auto');
  assert.equal(popover.withinViewport, true);
  assert.match(popover.text, /剩余 \d+%/);
  assert.match(popover.text, /更新于/);

  const popoverPoint = await evaluateInTarget(target.webSocketDebuggerUrl, `(() => {
    const node = document.querySelector('.codex-usage-popover-v23');
    const rect = node?.getBoundingClientRect();
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  })()`);
  assert.ok(popoverPoint, 'quota details card must expose a pointer target');
  await cdpCommand(target.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: popoverPoint.x,
    y: popoverPoint.y,
  });
  await new Promise(resolve => setTimeout(resolve, 320));
  const stayedOpen = await evaluateInTarget(target.webSocketDebuggerUrl, `document.querySelector('.codex-usage-popover-v23')?.classList.contains('is-visible')`);
  await cdpCommand(target.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: 200,
    y: 300,
  });
  await new Promise(resolve => setTimeout(resolve, 320));
  const closedAfterLeave = await evaluateInTarget(target.webSocketDebuggerUrl, `!document.querySelector('.codex-usage-popover-v23')?.classList.contains('is-visible')`);
  const hoverBridge = { stayedOpen, closedAfterLeave };
  assert.equal(hoverBridge.stayedOpen, true);
  assert.equal(hoverBridge.closedAfterLeave, true);

  const clickPoint = await evaluateInTarget(target.webSocketDebuggerUrl, `(() => {
    const capsule = document.querySelector('codex-usage-header-v23')?.shadowRoot?.querySelector('.capsule');
    const rect = capsule?.getBoundingClientRect();
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  })()`);
  assert.ok(clickPoint, 'quota header capsule must expose a click target');
  await cdpCommand(target.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: clickPoint.x,
    y: clickPoint.y,
  });
  await new Promise(resolve => setTimeout(resolve, 180));
  await mouseClick(target.webSocketDebuggerUrl, clickPoint);
  const hiddenAfterClick = await evaluateInTarget(target.webSocketDebuggerUrl, `!document.querySelector('.codex-usage-popover-v23')?.classList.contains('is-visible')`);
  await mouseClick(target.webSocketDebuggerUrl, clickPoint);
  const reopenedAfterSecondClick = await evaluateInTarget(target.webSocketDebuggerUrl, `document.querySelector('.codex-usage-popover-v23')?.classList.contains('is-visible')`);
  const clickToggle = { hiddenAfterClick, reopenedAfterSecondClick };
  assert.deepEqual(clickToggle, { hiddenAfterClick: true, reopenedAfterSecondClick: true });

  const refreshPoint = await evaluateInTarget(target.webSocketDebuggerUrl, `(() => {
    const root = document.querySelector('codex-usage-header-v23')?.shadowRoot;
    const button = root?.querySelector('.refresh-btn');
    const rect = button?.getBoundingClientRect();
    return rect ? { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 } : null;
  })()`);
  assert.ok(refreshPoint, 'refresh button must expose a click target');
  await mouseClick(target.webSocketDebuggerUrl, refreshPoint);
  const refresh = await evaluateInTarget(target.webSocketDebuggerUrl, `(async () => {
    const root = document.querySelector('codex-usage-header-v23')?.shadowRoot;
    const before = window.__codexUsageHeaderDebug__?.getState()?.lastUpdated;
    await new Promise(resolve => setTimeout(resolve, 80));
    if (root?.querySelector('.refresh-btn')?.dataset?.refreshState !== 'loading') {
      await new Promise(resolve => setTimeout(resolve, 5100));
      window.__codexUsageHeaderDebug__?.requestUsage?.({ manual: true });
      await new Promise(resolve => setTimeout(resolve, 80));
    }
    const button = root?.querySelector('.refresh-btn');
    const icon = root?.querySelector('.refresh-icon');
    const loading = {
      state: button?.dataset?.refreshState,
      disabled: button?.disabled,
      ariaBusy: button?.getAttribute('aria-busy'),
      animation: getComputedStyle(icon).animationName,
    };
    const deadline = Date.now() + 7000;
    let finalState = loading.state;
    while (Date.now() < deadline && finalState === 'loading') {
      await new Promise(resolve => setTimeout(resolve, 160));
      finalState = root?.querySelector('.refresh-btn')?.dataset?.refreshState;
    }
    return {
      loading,
      finalState,
      updated: window.__codexUsageHeaderDebug__?.getState()?.lastUpdated > before,
    };
  })()`);
  assert.deepEqual(refresh.loading, {
    state: 'loading',
    disabled: true,
    ariaBusy: 'true',
    animation: 'quota-refresh-spin',
  });
  assert.notEqual(refresh.finalState, 'loading');
  assert.equal(refresh.updated, true);

  await evaluateInTarget(target.webSocketDebuggerUrl, `window.__codexUsageHeaderDebug__?.showPopover()`);
  await new Promise(resolve => setTimeout(resolve, 180));

  mkdirSync(evidenceDir, { recursive: true });
  const screenshot = await cdpCommand(target.webSocketDebuggerUrl, 'Page.captureScreenshot', {
    format: 'png',
    fromSurface: true,
    captureBeyondViewport: false,
  });
  const screenshotPath = join(evidenceDir, '04-implementation-wide-popover.png');
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));

  console.log(JSON.stringify({ snapshots, popover, hoverBridge, clickToggle, refresh, screenshotPath }, null, 2));
  console.log('✓ Live renderer responsive, popover, and native-control safety checks passed!');
} finally {
  await cdpCommand(target.webSocketDebuggerUrl, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
}
