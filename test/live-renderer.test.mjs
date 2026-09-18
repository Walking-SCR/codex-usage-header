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
    const timer = setTimeout(() => { try { ws.close(); } catch {} reject(new Error(method + '_timeout')); }, timeoutMs);
    ws.onopen = () => ws.send(JSON.stringify({ id, method, params }));
    ws.onmessage = event => {
      const message = JSON.parse(event.data);
      if (message.id !== id) return;
      clearTimeout(timer);
      ws.close();
      if (message.error) reject(new Error(JSON.stringify(message.error)));
      else resolve(message.result);
    };
    ws.onerror = () => { clearTimeout(timer); reject(new Error(method + '_websocket_error')); };
  });
}

async function mouseClick(wsUrl, point) {
  await cdpCommand(wsUrl, 'Input.dispatchMouseEvent', { type: 'mousePressed', x: point.x, y: point.y, button: 'left', clickCount: 1 });
  await cdpCommand(wsUrl, 'Input.dispatchMouseEvent', { type: 'mouseReleased', x: point.x, y: point.y, button: 'left', clickCount: 1 });
}

const [target] = selectUsageTargets(await fetchCdpTargets(9229));
assert.ok(target, 'Codex renderer with CDP must be available');
const widths = [1440, 1100, 900, 760, 620];
const snapshots = [];

try {
  const readyDeadline = Date.now() + 10000;
  let ready = false;
  while (Date.now() < readyDeadline && !ready) {
    ready = await evaluateInTarget(target.webSocketDebuggerUrl, 'window.__codexUsageHeaderDebug__?.getState?.().status === "ready"');
    if (!ready) await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.equal(ready, true, 'usage payload should arrive before card interaction checks');

  for (const width of widths) {
    await cdpCommand(target.webSocketDebuggerUrl, 'Emulation.setDeviceMetricsOverride', { width, height: 820, deviceScaleFactor: 1, mobile: false });
    await new Promise(resolve => setTimeout(resolve, 320));
    const snapshot = await evaluateInTarget(target.webSocketDebuggerUrl, '(() => { const element=document.querySelector("codex-usage-header-host"); const trigger=element?.shadowRoot?.querySelector(".details-trigger"); const visible=button=>{const r=button.getBoundingClientRect();const s=getComputedStyle(button);return s.display!=="none"&&s.visibility!=="hidden"&&Number(s.opacity)>0&&r.width>0&&r.height>0&&r.left<innerWidth&&r.right>0}; const more=[...document.querySelectorAll("button")].find(button=>button.getAttribute("aria-label")==="聊天操作"&&visible(button)); const newChat=[...document.querySelectorAll("button")].find(button=>["切换底部面板显示","显示/隐藏侧边面板"].includes(button.getAttribute("aria-label")||"")&&visible(button)); const native=element?.dataset?.placement==="thread"?more:newChat; const r=element?.getBoundingClientRect(); const nr=native?.getBoundingClientRect(); return {placement:element?.dataset?.placement,mode:element?.dataset?.mode,hostHeight:r?.height,gap:r&&nr?nr.left-r.right:null,overlaps:r&&nr?r.right>nr.left:false,hostRegion:element?getComputedStyle(element).getPropertyValue("-webkit-app-region"):null,triggerRegion:trigger?getComputedStyle(trigger).getPropertyValue("-webkit-app-region"):null,gapStyle:element?.shadowRoot?.querySelector(".capsule")?getComputedStyle(element.shadowRoot.querySelector(".capsule")).gap:null,track:element?.shadowRoot?.querySelector(".track")?getComputedStyle(element.shadowRoot.querySelector(".track")).height:null,topRefresh:element?.shadowRoot?.querySelectorAll(".refresh-btn").length||0,text:trigger?.innerText}; })()');
    snapshots.push(snapshot);
    assert.equal(snapshot.overlaps, false);
    assert.ok(snapshot.gap >= 4);
    assert.ok(['thread', 'new-chat'].includes(snapshot.placement));
    assert.equal(snapshot.hostHeight, 34);
    assert.equal(snapshot.hostRegion, 'no-drag');
    assert.equal(snapshot.triggerRegion, 'no-drag');
    assert.equal(snapshot.gapStyle, '5px');
    assert.equal(snapshot.topRefresh, 0);
    if (snapshot.track !== null) assert.equal(snapshot.track, '12px');
  }

  await cdpCommand(target.webSocketDebuggerUrl, 'Emulation.setDeviceMetricsOverride', { width: 1440, height: 820, deviceScaleFactor: 1, mobile: false });
  await new Promise(resolve => setTimeout(resolve, 320));
  const triggerPoint = await evaluateInTarget(target.webSocketDebuggerUrl, '(() => { window.__codexUsageHeaderDebug__?.hidePopover(); const r=document.querySelector("codex-usage-header-host")?.shadowRoot?.querySelector(".details-trigger")?.getBoundingClientRect(); return r?{x:r.left+r.width/2,y:r.top+r.height/2}:null; })()');
  assert.ok(triggerPoint);
  await cdpCommand(target.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: triggerPoint.x, y: triggerPoint.y });
  await new Promise(resolve => setTimeout(resolve, 220));
  const hover = await evaluateInTarget(target.webSocketDebuggerUrl, '(() => { const n=document.querySelector(".codex-usage-popover-v24"); const r=n?.getBoundingClientRect(); return {visible:getComputedStyle(n).visibility==="visible",position:getComputedStyle(n).position,inside:Boolean(r&&r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight),text:n?.innerText}; })()');
  assert.equal(hover.visible, true);
  assert.equal(hover.position, 'fixed');
  assert.equal(hover.inside, true);
  assert.match(hover.text, /用量额度|Usage quota/);

  const cardLayout = await evaluateInTarget(target.webSocketDebuggerUrl, '(() => { const card=document.querySelector(".codex-usage-popover-v24"); const bars=[...card.querySelectorAll(".row .track")].map(node=>node.getBoundingClientRect()); const credits=card.querySelector(".credits-copy"); const balance=card.querySelector(".balance"); const meta=card.querySelector(".meta-actions"); return {barDelta:bars.length===2?Math.abs(bars[0].left-bars[1].left):null,creditsIcon:Boolean(credits?.querySelector("img")),copyYDelta:credits&&balance?Math.abs(credits.getBoundingClientRect().top-balance.getBoundingClientRect().top):null,flexWrap:meta?getComputedStyle(meta).flexWrap:null,modal:Boolean(document.getElementById("codex-usage-modal-v24"))}; })()');
  assert.equal(cardLayout.barDelta, 0);
  assert.equal(cardLayout.creditsIcon, false);
  assert.ok(cardLayout.copyYDelta !== null && cardLayout.copyYDelta <= 1);
  assert.equal(cardLayout.flexWrap, 'nowrap');
  assert.equal(cardLayout.modal, false);
  const localeBefore = await evaluateInTarget(target.webSocketDebuggerUrl, 'window.__codexUsageHeaderDebug__?.getState()?.settings.locale');
  const topBeforeLocale = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector("codex-usage-header-host")?.shadowRoot?.querySelector(".details-trigger")?.innerText');
  await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".codex-usage-popover-v24 .language-toggle")?.click()');
  await new Promise(resolve => setTimeout(resolve, 100));
  const localeAfter = await evaluateInTarget(target.webSocketDebuggerUrl, 'window.__codexUsageHeaderDebug__?.getState()?.settings.locale');
  const topAfterLocale = await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector("codex-usage-header-host")?.shadowRoot?.querySelector(".details-trigger")?.innerText');
  assert.notEqual(localeAfter, localeBefore);
  assert.notEqual(topAfterLocale, topBeforeLocale);
  await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".codex-usage-popover-v24 .language-toggle")?.click()');
  await evaluateInTarget(target.webSocketDebuggerUrl, '(()=>{const s=document.querySelector(".codex-usage-popover-v24 .refresh-interval"); if(!s)return false; s.value="60"; s.dispatchEvent(new Event("change",{bubbles:true})); return true})()');
  await new Promise(resolve => setTimeout(resolve, 150));
  assert.equal(await evaluateInTarget(target.webSocketDebuggerUrl, 'window.__codexUsageHeaderDebug__?.getState()?.settings.refreshIntervalSeconds'), 60);
  await evaluateInTarget(target.webSocketDebuggerUrl, '(()=>{const s=document.querySelector(".codex-usage-popover-v24 .refresh-interval"); if(!s)return false; s.value="30"; s.dispatchEvent(new Event("change",{bubbles:true})); return true})()');

  const cardPoint = await evaluateInTarget(target.webSocketDebuggerUrl, '(() => { const r=document.querySelector(".codex-usage-popover-v24")?.getBoundingClientRect(); return r?{x:r.left+r.width/2,y:r.top+20}:null; })()');
  await cdpCommand(target.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: cardPoint.x, y: cardPoint.y });
  await new Promise(resolve => setTimeout(resolve, 180));
  assert.equal(await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".codex-usage-popover-v24")?.classList.contains("is-visible")'), true);

  await cdpCommand(target.webSocketDebuggerUrl, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: 200, y: 300 });
  await new Promise(resolve => setTimeout(resolve, 320));
  assert.equal(await evaluateInTarget(target.webSocketDebuggerUrl, '!document.querySelector(".codex-usage-popover-v24")?.classList.contains("is-visible")'), true);

  await mouseClick(target.webSocketDebuggerUrl, triggerPoint);
  assert.equal(await evaluateInTarget(target.webSocketDebuggerUrl, 'document.querySelector(".codex-usage-popover-v24")?.classList.contains("is-visible")'), true);
  await mouseClick(target.webSocketDebuggerUrl, triggerPoint);
  assert.equal(await evaluateInTarget(target.webSocketDebuggerUrl, '!document.querySelector(".codex-usage-popover-v24")?.classList.contains("is-visible")'), true);

  await evaluateInTarget(target.webSocketDebuggerUrl, 'window.__codexUsageHeaderDebug__?.showPopover()');
  await new Promise(resolve => setTimeout(resolve, 180));
  const refreshPoint = await evaluateInTarget(target.webSocketDebuggerUrl, '(() => { const r=document.querySelector(".codex-usage-popover-v24 .card-refresh")?.getBoundingClientRect(); return r?{x:r.left+r.width/2,y:r.top+r.height/2}:null; })()');
  assert.ok(refreshPoint);
  const before = await evaluateInTarget(target.webSocketDebuggerUrl, 'window.__codexUsageHeaderDebug__?.getState()?.lastUpdated');
  await mouseClick(target.webSocketDebuggerUrl, refreshPoint);
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(await evaluateInTarget(target.webSocketDebuggerUrl, 'window.__codexUsageHeaderDebug__?.getState()?.refreshState'), 'loading');
  const deadline = Date.now() + 7000;
  let finalState = 'loading';
  while (Date.now() < deadline && finalState === 'loading') {
    await new Promise(resolve => setTimeout(resolve, 160));
    finalState = await evaluateInTarget(target.webSocketDebuggerUrl, 'window.__codexUsageHeaderDebug__?.getState()?.refreshState');
  }
  assert.notEqual(finalState, 'loading');
  assert.equal(await evaluateInTarget(target.webSocketDebuggerUrl, 'window.__codexUsageHeaderDebug__?.getState()?.lastUpdated > ' + Number(before || 0)), true);

  await evaluateInTarget(target.webSocketDebuggerUrl, 'window.__codexUsageHeaderDebug__?.showPopover()');
  await new Promise(resolve => setTimeout(resolve, 180));
  mkdirSync(evidenceDir, { recursive: true });
  const screenshot = await cdpCommand(target.webSocketDebuggerUrl, 'Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false });
  const screenshotPath = join(evidenceDir, '04-implementation-wide-popover.png');
  writeFileSync(screenshotPath, Buffer.from(screenshot.data, 'base64'));
  console.log(JSON.stringify({ snapshots, hover, finalState, screenshotPath }, null, 2));
  console.log('✓ Live renderer responsive, popover, and card-refresh checks passed!');
} finally {
  await cdpCommand(target.webSocketDebuggerUrl, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
}
