/**
 * Codex Quota Header - renderer component.
 * The launcher supplies the local usage bridge and icon assets before this
 * file is evaluated in the Codex renderer.
 */
(() => {
  'use strict';

  const RUNTIME_VERSION = '2.2.5';
  const COMPONENT_TAG = 'codex-usage-header-v23';
  const POPOVER_CLASS = 'codex-usage-popover-v23';
  const LEGACY_COMPONENTS = [
    'codex-usage-header',
    'codex-usage-header-v2',
    'codex-usage-header-v3',
    'codex-usage-header-v4',
    'codex-usage-header-v5',
    'codex-usage-header-v6',
    'codex-usage-header-v7',
    'codex-usage-header-v8',
    'codex-usage-header-v9',
    'codex-usage-header-v10',
    'codex-usage-header-v11',
    'codex-usage-header-v12',
    'codex-usage-header-v13',
    'codex-usage-header-v14',
    'codex-usage-header-v15',
    'codex-usage-header-v16',
    'codex-usage-header-v17',
    'codex-usage-header-v18',
    'codex-usage-header-v19',
    'codex-usage-header-v20',
    'codex-usage-header-v21',
    'codex-usage-header-v22',
  ];

  function suppressLegacyInstances() {
    document.querySelectorAll(LEGACY_COMPONENTS.join(',')).forEach(element => {
      element.style.setProperty('display', 'none', 'important');
      element.style.setProperty('pointer-events', 'none', 'important');
      element.setAttribute('aria-hidden', 'true');
    });
  }

  suppressLegacyInstances();
  document.querySelectorAll('.codex-usage-popover,.codex-usage-popover-v9,.codex-usage-popover-v10,.codex-usage-popover-v11,.codex-usage-popover-v12,.codex-usage-popover-v13,.codex-usage-popover-v14,.codex-usage-popover-v15,.codex-usage-popover-v16,.codex-usage-popover-v17,.codex-usage-popover-v18,.codex-usage-popover-v19,.codex-usage-popover-v20,.codex-usage-popover-v21,.codex-usage-popover-v22,.codex-usage-popover-v23').forEach(element => element.remove());

  if (window.__codexUsageHeaderInstalled__ === RUNTIME_VERSION) {
    window.__codexUsageHeaderRemount?.();
    return;
  }
  window.__codexUsageHeaderTeardown__?.();
  window.__codexUsageHeaderInstalled__ = RUNTIME_VERSION;

  const CONFIG = {
    activeIntervalMs: 30000,
    idleIntervalMs: 180000,
    debounceMs: 5000,
    refreshTimeoutMs: 8000,
    minimumSpinMs: 650,
    popoverWidth: 520,
    popoverGap: 8,
    viewportInset: 12,
    modeHysteresis: 24,
    breakpoints: { full: 520, compact: 340, minimal: 210 },
    colors: {
      green: '#34C759',
      yellow: '#FF9500',
      red: '#FF3B30',
      track: 'rgba(120,120,128,.16)',
      muted: '#8E8E93',
    },
  };
  const ICONS = window.__codexUsageHeaderIcons__ || {};

  let usageState = {
    status: 'loading',
    primary: null,
    secondary: null,
    resetCredits: null,
    lastUpdated: null,
    error: null,
  };
  let lastFetchTime = 0;
  let pollTimer = null;
  let ticker = null;
  let currentMode = 'full';
  let resizeObserver = null;
  let popover = null;
  let popoverHideTimer = null;
  let popoverShowTimer = null;
  let observer = null;
  let mountTimer = null;
  let healthTimer = null;
  let mountAttempt = 0;
  let layoutFrame = null;
  let refreshState = 'idle';
  let refreshRequestId = null;
  let refreshRequestedAt = 0;
  let refreshStartedAt = 0;
  let refreshTimeoutTimer = null;
  let refreshSettleTimer = null;

  function getQuotaColor(remainingPercent) {
    if (!Number.isFinite(remainingPercent)) return CONFIG.colors.muted;
    if (remainingPercent <= 10) return CONFIG.colors.red;
    if (remainingPercent <= 20) return CONFIG.colors.yellow;
    return CONFIG.colors.green;
  }

  function getValueColor(remainingPercent, isDark) {
    if (!Number.isFinite(remainingPercent) || remainingPercent > 20) {
      return isDark ? '#F5F5F7' : '#3A3A3C';
    }
    return remainingPercent <= 10
      ? (isDark ? '#FF453A' : '#FF3B30')
      : (isDark ? '#FFD60A' : '#C66A00');
  }

  function formatTime(seconds, includeDays = false) {
    if (!Number.isFinite(seconds) || seconds <= 0) return '即将重置';
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    if (includeDays && d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${Math.max(1, m)}m`;
  }

  function formatClock(timestamp, includeWeekday = false) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '--:--';
    const date = new Date(timestamp * 1000);
    const hh = String(date.getHours()).padStart(2, '0');
    const mm = String(date.getMinutes()).padStart(2, '0');
    if (!includeWeekday && date.toDateString() === new Date().toDateString()) return `${hh}:${mm}`;
    const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return `${weekdays[date.getDay()]} ${hh}:${mm}`;
  }

  function formatUpdatedAt(timestamp) {
    if (!Number.isFinite(timestamp)) return '等待首次更新';
    const elapsed = Math.max(0, Date.now() - timestamp);
    if (elapsed < 60000) return '更新于刚刚';
    if (elapsed < 3600000) return `更新于 ${Math.floor(elapsed / 60000)} 分钟前`;
    return `更新于 ${Math.floor(elapsed / 3600000)} 小时前`;
  }

  function normalizePayload(raw, metadata = {}) {
    if (!raw || typeof raw !== 'object') return null;
    const root = raw.rateLimits || raw.rate_limit || raw;
    const parseWindow = value => {
      if (!value || typeof value !== 'object') return null;
      const usedPercent = Number(value.usedPercent ?? value.used_percent ?? 0);
      const resetsAt = Number(value.resetsAt ?? value.reset_at ?? 0);
      const resetAfter = Number(value.resetAfterSeconds ?? value.reset_after_seconds ?? 0);
      const now = Math.floor(Date.now() / 1000);
      const used = Math.max(0, Math.min(100, Math.round(usedPercent)));
      return {
        usedPercent: used,
        remainingPercent: 100 - used,
        resetsAt,
        secondsRemaining: Math.max(0, resetsAt > 0 ? resetsAt - now : resetAfter),
      };
    };
    const credits = raw.rateLimitResetCredits;
    const resetCredits = typeof credits === 'object'
      ? Number(credits.availableCount ?? credits.available_count ?? 0)
      : Number(credits ?? raw.rate_limit_reset_credits ?? 0);
    const primary = parseWindow(root.primary || root.primary_window || root.primaryWindow);
    const secondary = parseWindow(root.secondary || root.secondary_window || root.secondaryWindow);
    if (!primary || !secondary) return null;
    return {
      status: 'ready',
      primary,
      secondary,
      resetCredits: Number.isFinite(resetCredits) ? resetCredits : null,
      lastUpdated: Number(metadata.fetchedAt) || Date.now(),
      error: null,
    };
  }

  function iconMarkup(name, className = '') {
    const source = ICONS[name];
    if (!source) return '';
    return `<img class="icon ${className}" aria-hidden="true" alt="" src="${source}">`;
  }

  function clearRefreshTimers() {
    if (refreshTimeoutTimer) clearTimeout(refreshTimeoutTimer);
    if (refreshSettleTimer) clearTimeout(refreshSettleTimer);
    refreshTimeoutTimer = null;
    refreshSettleTimer = null;
  }

  function settleRefresh(nextState, message = null) {
    const requestAtSettle = refreshRequestId;
    const complete = () => {
      if (requestAtSettle !== refreshRequestId) return;
      clearRefreshTimers();
      refreshState = nextState;
      usageState.error = nextState === 'error' ? (message || '刷新失败，请重试') : null;
      renderComponent();
      refreshSettleTimer = setTimeout(() => {
        if (requestAtSettle !== refreshRequestId) return;
        refreshState = 'idle';
        refreshRequestId = null;
        renderComponent();
      }, nextState === 'success' ? 900 : 2600);
    };
    const elapsed = performance.now() - refreshStartedAt;
    const delay = nextState === 'success' ? Math.max(0, CONFIG.minimumSpinMs - elapsed) : 0;
    if (delay > 0) refreshSettleTimer = setTimeout(complete, delay);
    else complete();
  }

  function requestUsage({ manual = false } = {}) {
    const now = Date.now();
    if (manual) {
      if (refreshState === 'loading' || now - lastFetchTime < CONFIG.debounceMs) return false;
      clearRefreshTimers();
      lastFetchTime = now;
      refreshRequestedAt = now;
      refreshStartedAt = performance.now();
      refreshRequestId = `manual-${now}-${Math.random().toString(36).slice(2, 8)}`;
      refreshState = 'loading';
      usageState.error = null;
      window.__codexUsageHeaderRefreshRequested__ = { id: refreshRequestId, requestedAt: now, manual: true };
      renderComponent();
      refreshTimeoutTimer = setTimeout(() => settleRefresh('error', '刷新超时，请重试'), CONFIG.refreshTimeoutMs);
      return true;
    }
    window.__codexUsageHeaderRefreshRequested__ = { id: null, requestedAt: now, manual: false };
    return true;
  }

  function applyUsagePayload(raw, metadata = {}) {
    const normalized = normalizePayload(raw, metadata);
    if (!normalized) return false;
    usageState = normalized;
    renderComponent();
    if (refreshState === 'loading') {
      const matchingAck = metadata.requestId && metadata.requestId === refreshRequestId;
      const compatibleLegacyPush = !metadata.requestId && normalized.lastUpdated >= refreshRequestedAt;
      if (matchingAck || compatibleLegacyPush) settleRefresh('success');
    }
    return true;
  }

  function applyRefreshError(requestId, message) {
    if (refreshState !== 'loading' || requestId !== refreshRequestId) return false;
    settleRefresh('error', message || '刷新失败，请重试');
    return true;
  }

  function renderComponent() {
    const element = document.querySelector(COMPONENT_TAG);
    element?.render();
    if (popover?.classList.contains('is-visible')) {
      renderPopover();
      requestAnimationFrame(positionPopover);
    }
  }

  function resetPollTimer() {
    if (pollTimer) clearTimeout(pollTimer);
    const delay = document.hidden ? CONFIG.idleIntervalMs : CONFIG.activeIntervalMs;
    pollTimer = setTimeout(() => {
      requestUsage();
      resetPollTimer();
    }, delay);
  }

  function updateCountdowns() {
    const element = document.querySelector(COMPONENT_TAG);
    const root = element?.shadowRoot;
    const p = usageState.primary;
    const s = usageState.secondary;
    const primaryHeader = root?.querySelector('.primary-countdown');
    const primaryPopover = popover?.querySelector('.popover-primary-value');
    const secondaryPopover = popover?.querySelector('.popover-secondary-value');
    const updated = popover?.querySelector('.updated-label');
    if (primaryHeader && p) primaryHeader.textContent = `${p.remainingPercent}% (${formatTime(p.resetsAt - Math.floor(Date.now() / 1000))}后重置)`;
    if (primaryPopover && p) primaryPopover.textContent = `剩余 ${p.remainingPercent}%（${formatClock(p.resetsAt)} 重置，距重置 ${formatTime(p.resetsAt - Math.floor(Date.now() / 1000))}）`;
    if (secondaryPopover && s) secondaryPopover.textContent = `剩余 ${s.remainingPercent}%（${formatClock(s.resetsAt, true)} 重置）`;
    if (updated) updated.textContent = formatUpdatedAt(usageState.lastUpdated);
  }

  function ensurePopoverStyles() {
    if (document.getElementById('codex-usage-popover-style-v23')) return;
    const style = document.createElement('style');
    style.id = 'codex-usage-popover-style-v23';
    style.textContent = `
      .${POPOVER_CLASS}{position:fixed;z-index:2147483646;box-sizing:border-box;-webkit-app-region:no-drag;opacity:0;visibility:hidden;pointer-events:none;transform:translateY(-4px) scale(.99);transform-origin:top right;transition:opacity 140ms ease,transform 140ms cubic-bezier(.2,.8,.2,1),visibility 0s linear 140ms}
      .${POPOVER_CLASS}.is-visible{opacity:1;visibility:visible;pointer-events:auto;transform:translateY(0) scale(1);transition-delay:0s}
      .${POPOVER_CLASS}[data-side="top"]{transform-origin:bottom right}
      @media(prefers-reduced-motion:reduce){.${POPOVER_CLASS},.${POPOVER_CLASS}.is-visible{transition:none;transform:none}}
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function updateExpanded(expanded) {
    const capsule = document.querySelector(COMPONENT_TAG)?.shadowRoot?.querySelector('.capsule');
    capsule?.setAttribute('aria-expanded', String(expanded));
  }

  function ensurePopover() {
    if (popover?.isConnected) return popover;
    ensurePopoverStyles();
    popover = document.createElement('div');
    popover.id = 'codex-usage-details-v23';
    popover.className = POPOVER_CLASS;
    popover.setAttribute('role', 'tooltip');
    popover.setAttribute('aria-hidden', 'true');
    popover.addEventListener('pointerenter', () => {
      if (popoverHideTimer) clearTimeout(popoverHideTimer);
    });
    popover.addEventListener('pointerleave', scheduleHidePopover);
    (document.body || document.documentElement).appendChild(popover);
    return popover;
  }

  function positionPopover() {
    const element = document.querySelector(COMPONENT_TAG);
    const capsule = element?.shadowRoot?.querySelector('.capsule');
    if (!capsule || !popover) return;
    const rect = capsule.getBoundingClientRect();
    const width = Math.min(CONFIG.popoverWidth, Math.max(296, window.innerWidth - CONFIG.viewportInset * 2));
    popover.style.width = `${width}px`;
    const height = popover.getBoundingClientRect().height || 220;
    const left = Math.max(CONFIG.viewportInset, Math.min(window.innerWidth - width - CONFIG.viewportInset, rect.right - width));
    const below = rect.bottom + CONFIG.popoverGap;
    const canFitBelow = below + height <= window.innerHeight - CONFIG.viewportInset;
    const top = canFitBelow
      ? below
      : Math.max(CONFIG.viewportInset, rect.top - height - CONFIG.popoverGap);
    popover.dataset.side = canFitBelow ? 'bottom' : 'top';
    Object.assign(popover.style, { left: `${left}px`, top: `${top}px` });
  }

  function showPopover({ immediate = false } = {}) {
    if (popoverShowTimer) clearTimeout(popoverShowTimer);
    if (popoverHideTimer) clearTimeout(popoverHideTimer);
    const open = () => {
      const target = ensurePopover();
      renderPopover();
      positionPopover();
      target.classList.add('is-visible');
      target.setAttribute('aria-hidden', 'false');
      updateExpanded(true);
    };
    if (immediate) open();
    else popoverShowTimer = setTimeout(open, 100);
  }

  function hidePopover() {
    if (popoverShowTimer) clearTimeout(popoverShowTimer);
    if (popoverHideTimer) clearTimeout(popoverHideTimer);
    popoverShowTimer = null;
    popoverHideTimer = null;
    popover?.classList.remove('is-visible');
    popover?.setAttribute('aria-hidden', 'true');
    updateExpanded(false);
  }

  function scheduleHidePopover() {
    if (popoverShowTimer) clearTimeout(popoverShowTimer);
    if (popoverHideTimer) clearTimeout(popoverHideTimer);
    popoverHideTimer = setTimeout(hidePopover, 180);
  }

  function popoverMarkup(isDark) {
    const p = usageState.primary;
    const s = usageState.secondary;
    const ready = Boolean(p && s);
    const pColor = getQuotaColor(p?.remainingPercent);
    const sColor = getQuotaColor(s?.remainingPercent);
    const text = usageState.status === 'error'
      ? '暂时无法读取额度，请确认客户端已登录'
      : '正在同步额度…';
    return `<style>
      *{box-sizing:border-box}.popover-shell{font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;color:${isDark ? '#F5F5F7' : '#1D1D1F'};background:${isDark ? 'rgba(35,35,38,.97)' : 'rgba(255,255,255,.97)'};border:1px solid ${isDark ? 'rgba(255,255,255,.13)' : 'rgba(0,0,0,.09)'};box-shadow:0 12px 34px rgba(0,0,0,.16);backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px);border-radius:15px;padding:16px 18px}
      .rows{display:flex;flex-direction:column;gap:16px}.row{display:grid;grid-template-columns:54px 112px minmax(0,1fr);align-items:center;gap:12px;min-height:22px}.label{font-size:13px;font-weight:700;white-space:nowrap}.track{height:12px;border-radius:999px;overflow:hidden;background:rgba(120,120,128,.16)}.fill{display:block;height:100%;border-radius:999px;transition:width .3s ease,background .3s ease}.value{min-width:0;color:${isDark ? '#E5E5EA' : '#3A3A3C'};font-size:12.5px;font-weight:520;line-height:1.35;white-space:nowrap;font-variant-numeric:tabular-nums}.divider{height:1px;background:${isDark ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.07)'};margin:15px 0}.meta-row{display:flex;align-items:center;gap:10px;min-height:20px;font-size:12.5px;color:${isDark ? '#E5E5EA' : '#3A3A3C'}}.meta-row.muted{color:${isDark ? '#A1A1A6' : '#7A7A80'}}.icon{display:block;flex:none;width:18px;height:18px;object-fit:contain;opacity:.78;${isDark ? 'filter:invert(1)' : ''}}.unavailable{color:${isDark ? '#A1A1A6' : '#6E6E73'};font-size:12.5px;padding:4px 0}.error-note{margin-top:10px;color:${isDark ? '#FF6961' : '#C42B1C'};font-size:11.5px}@media(prefers-reduced-motion:reduce){.fill{transition:none}}
    </style><div class="popover-shell">${ready ? `<div class="rows"><div class="row"><span class="label">5小时</span><span class="track"><span class="fill" style="width:${p.remainingPercent}%;background:${pColor}"></span></span><span class="value popover-primary-value">剩余 ${p.remainingPercent}%（${formatClock(p.resetsAt)} 重置，距重置 ${formatTime(p.secondsRemaining)}）</span></div><div class="row"><span class="label">7天</span><span class="track"><span class="fill" style="width:${s.remainingPercent}%;background:${sColor}"></span></span><span class="value popover-secondary-value">剩余 ${s.remainingPercent}%（${formatClock(s.resetsAt, true)} 重置）</span></div></div><div class="divider"></div><div class="meta-row">${iconMarkup('database')}<span>额度重置券：${usageState.resetCredits ?? '—'}次可用</span></div><div class="divider"></div><div class="meta-row muted">${iconMarkup('clock')}<span class="updated-label">${formatUpdatedAt(usageState.lastUpdated)}</span></div>${usageState.error ? `<div class="error-note">${usageState.error}</div>` : ''}` : `<div class="unavailable">${text}</div>`}</div>`;
  }

  function renderPopover() {
    const target = ensurePopover();
    const isDark = document.documentElement.classList.contains('dark')
      || window.matchMedia('(prefers-color-scheme: dark)').matches;
    target.innerHTML = popoverMarkup(isDark);
  }

  function baseModeForWidth(width) {
    if (!Number.isFinite(width) || width >= CONFIG.breakpoints.full) return 'full';
    if (width >= CONFIG.breakpoints.compact) return 'compact';
    if (width >= CONFIG.breakpoints.minimal) return 'minimal';
    return 'nano';
  }

  function resolveModeWithHysteresis(width, mode = currentMode) {
    const h = CONFIG.modeHysteresis;
    if (mode === 'full' && width >= CONFIG.breakpoints.full - h) return 'full';
    if (mode === 'compact' && width >= CONFIG.breakpoints.compact - h && width < CONFIG.breakpoints.full + h) return 'compact';
    if (mode === 'minimal' && width >= CONFIG.breakpoints.minimal - h && width < CONFIG.breakpoints.compact + h) return 'minimal';
    if (mode === 'nano' && width < CONFIG.breakpoints.minimal + h) return 'nano';
    return baseModeForWidth(width);
  }

  function visibleRect(element) {
    const rect = element?.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? rect : null;
  }

  function measureTitleNeed(titleRegion) {
    const regionRect = visibleRect(titleRegion);
    if (!regionRect) return 160;
    const candidates = [...titleRegion.querySelectorAll('button,a,[role="button"]')]
      .map(visibleRect)
      .filter(Boolean);
    const contentRight = candidates.length
      ? Math.max(...candidates.map(rect => rect.right))
      : regionRect.left + 160;
    return Math.max(128, Math.min(320, contentRight - regionRect.left + 12));
  }

  function measureAvailableWidth(element) {
    const actionGroup = element?.parentElement;
    const isNewChat = element?.dataset?.placement === 'new-chat';
    const toolbar = isNewChat ? element?.closest('header') : actionGroup?.parentElement;
    const toolbarRect = visibleRect(toolbar);
    if (!toolbarRect || !actionGroup) return 520;
    const titleRegion = isNewChat
      ? null
      : [...toolbar.children].find(child => child !== actionGroup) || null;
    const titleNeed = isNewChat ? 160 : measureTitleNeed(titleRegion);
    const nativeControls = isNewChat
      ? (visibleRect(element.nextElementSibling)?.width || 70)
      : [...actionGroup.children]
        .filter(child => child !== element)
        .map(visibleRect)
        .filter(Boolean)
        .reduce((sum, rect) => sum + rect.width, 0);
    return Math.max(0, toolbarRect.width - titleNeed - nativeControls - 32);
  }

  class CodexUsageHeaderElement extends HTMLElement {
    constructor() {
      super();
      this.attachShadow({ mode: 'open' });
    }

    connectedCallback() {
      currentMode = baseModeForWidth(measureAvailableWidth(this));
      this.render();
      this.setupResizeObserver();
      ensurePopover();
    }

    disconnectedCallback() {
      resizeObserver?.disconnect();
      if (layoutFrame) cancelAnimationFrame(layoutFrame);
      popover?.remove();
      popover = null;
    }

    updateMode() {
      const availableWidth = measureAvailableWidth(this);
      const next = resolveModeWithHysteresis(availableWidth);
      this.dataset.availableWidth = String(Math.round(availableWidth));
      if (next === currentMode) return;
      currentMode = next;
      this.render();
      if (popover?.classList.contains('is-visible')) requestAnimationFrame(positionPopover);
    }

    setupResizeObserver() {
      resizeObserver?.disconnect();
      resizeObserver = new ResizeObserver(() => {
        if (layoutFrame) cancelAnimationFrame(layoutFrame);
        layoutFrame = requestAnimationFrame(() => this.updateMode());
      });
      const toolbar = this.parentElement?.parentElement;
      if (toolbar) resizeObserver.observe(toolbar);
      const header = toolbar?.closest('header');
      if (header && header !== toolbar) resizeObserver.observe(header);
    }

    setupEvents() {
      const capsule = this.shadowRoot.querySelector('.capsule');
      const togglePopover = () => {
        if (popover?.classList.contains('is-visible')) hidePopover();
        else showPopover({ immediate: true });
      };
      capsule?.addEventListener('pointerenter', showPopover);
      capsule?.addEventListener('pointerleave', scheduleHidePopover);
      capsule?.addEventListener('focusin', showPopover);
      capsule?.addEventListener('focusout', event => {
        if (!capsule.contains(event.relatedTarget)) scheduleHidePopover();
      });
      capsule?.addEventListener('keydown', event => {
        if (event.key === 'Escape') {
          event.preventDefault();
          hidePopover();
          return;
        }
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault();
          togglePopover();
        }
      });
      const host = this;
      if (host.__interactionEventsBound) return;
      host.__interactionEventsBound = true;
      const interactionState = { primaryUntil: 0, refreshUntil: 0 };
      const eventPath = event => event.composedPath?.() || [];
      const inside = (event, node) => eventPath(event).includes(node);
      const activatePrimary = event => {
        const currentCapsule = host.shadowRoot?.querySelector('.capsule');
        const currentRefresh = host.shadowRoot?.querySelector('.refresh-btn');
        if (!inside(event, currentCapsule) || inside(event, currentRefresh)) return;
        if (event.type !== 'click' && event.button !== 0) return;
        const now = Date.now();
        if (event.type === 'click') {
          if (now < interactionState.primaryUntil) {
            interactionState.primaryUntil = 0;
            event.stopPropagation();
            return;
          }
          togglePopover();
          return;
        }
        if (now < interactionState.primaryUntil) return;
        interactionState.primaryUntil = now + 500;
        event.preventDefault();
        togglePopover();
      };
      const activateRefresh = event => {
        const currentRefresh = host.shadowRoot?.querySelector('.refresh-btn');
        if (!inside(event, currentRefresh)) return;
        if (event.type !== 'click' && event.button !== 0) return;
        const now = Date.now();
        if (event.type === 'click') {
          event.stopPropagation();
          if (now < interactionState.refreshUntil) {
            interactionState.refreshUntil = 0;
            return;
          }
          requestUsage({ manual: true });
          return;
        }
        if (now < interactionState.refreshUntil) return;
        interactionState.refreshUntil = now + 500;
        event.preventDefault();
        event.stopPropagation();
        requestUsage({ manual: true });
      };
      const revealFromNativeMouse = event => {
        const currentCapsule = host.shadowRoot?.querySelector('.capsule');
        if (inside(event, currentCapsule)) showPopover();
      };
      host.addEventListener('pointerdown', activatePrimary, true);
      host.addEventListener('mousedown', activatePrimary, true);
      host.addEventListener('click', activatePrimary, true);
      host.addEventListener('pointerdown', activateRefresh, true);
      host.addEventListener('mousedown', activateRefresh, true);
      host.addEventListener('click', activateRefresh, true);
      host.addEventListener('pointerover', revealFromNativeMouse, true);
      host.addEventListener('mouseover', revealFromNativeMouse, true);
    }

    render() {
      const isDark = document.documentElement.classList.contains('dark')
        || window.matchMedia('(prefers-color-scheme: dark)').matches;
      const p = usageState.primary;
      const s = usageState.secondary;
      const pColor = getQuotaColor(p?.remainingPercent);
      const sColor = getQuotaColor(s?.remainingPercent);
      const pValueColor = getValueColor(p?.remainingPercent, isDark);
      const sValueColor = getValueColor(s?.remainingPercent, isDark);
      const pText = p ? `${p.remainingPercent}%` : '—';
      const sText = s ? `${s.remainingPercent}%` : '—';
      const refreshTitle = refreshState === 'loading'
        ? '正在刷新额度'
        : refreshState === 'error'
          ? '刷新失败，点击重试'
          : refreshState === 'success'
            ? '额度已更新'
            : '立即刷新';
      const refreshButton = `<button class="refresh-btn state-${refreshState}" data-refresh-state="${refreshState}" aria-label="${refreshTitle}" aria-busy="${refreshState === 'loading'}" title="${refreshTitle}" ${refreshState === 'loading' ? 'disabled' : ''}>${iconMarkup('refresh', 'refresh-icon')}</button>`;
      let content;
      if (currentMode === 'nano') {
        content = `<span class="label">5h</span><span class="value" style="color:${pValueColor}">${pText}</span>${refreshButton}`;
      } else if (currentMode === 'minimal') {
        content = `<span class="label">5h</span><span class="track"><span class="fill" style="width:${p?.remainingPercent || 0}%;background:${pColor}"></span></span><span class="value" style="color:${pValueColor}">${pText}</span>${refreshButton}`;
      } else if (currentMode === 'compact') {
        content = `<span class="label">5h</span><span class="track"><span class="fill" style="width:${p?.remainingPercent || 0}%;background:${pColor}"></span></span><span class="value" style="color:${pValueColor}">${pText}</span><span class="divider"></span><span class="label">7d</span><span class="track"><span class="fill" style="width:${s?.remainingPercent || 0}%;background:${sColor}"></span></span><span class="value" style="color:${sValueColor}">${sText}</span>${refreshButton}`;
      } else {
        content = `<span class="label">5h</span><span class="track"><span class="fill" style="width:${p?.remainingPercent || 0}%;background:${pColor}"></span></span><span class="value primary-countdown" style="color:${pValueColor}">${p ? `${pText} (${formatTime(p.secondsRemaining)}后重置)` : pText}</span><span class="divider"></span><span class="label">7d</span><span class="track"><span class="fill" style="width:${s?.remainingPercent || 0}%;background:${sColor}"></span></span><span class="value" style="color:${sValueColor}">${sText}</span>${refreshButton}`;
      }
      this.dataset.mode = currentMode;
      this.shadowRoot.innerHTML = `<style>
        *{box-sizing:border-box}:host{display:inline-flex;align-items:center;flex:0 0 auto;min-width:0;margin:0;position:relative;z-index:20;pointer-events:auto!important;-webkit-app-region:no-drag;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;user-select:none}.capsule{height:34px;min-width:0;padding:0 9px;border-radius:999px;display:inline-flex;align-items:center;gap:5px;color:${isDark ? '#F5F5F7' : '#1D1D1F'};background:${isDark ? 'rgba(40,40,42,.90)' : 'rgba(247,247,248,.94)'};border:1px solid ${isDark ? 'rgba(255,255,255,.13)' : 'rgba(0,0,0,.07)'};box-shadow:0 1px 3px rgba(0,0,0,.07);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);pointer-events:auto;-webkit-app-region:no-drag;white-space:nowrap;outline:none}.capsule:focus-visible{box-shadow:0 0 0 2px ${isDark ? 'rgba(10,132,255,.72)' : 'rgba(0,122,255,.55)'},0 1px 3px rgba(0,0,0,.07)}.label{flex:none;font-size:12px;font-weight:700;letter-spacing:-.15px}.track{flex:none;width:70px;height:12px;overflow:hidden;border-radius:999px;background:${CONFIG.colors.track}}.fill{display:block;height:100%;border-radius:999px;transition:width .3s ease,background .3s ease}.value{flex:none;font-size:12px;font-weight:560;letter-spacing:-.1px;font-variant-numeric:tabular-nums}.primary-countdown{min-width:128px}.divider{flex:none;width:1px;height:16px;margin:0;background:${isDark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.12)'}}.refresh-btn{display:grid;place-items:center;flex:none;width:26px;height:26px;padding:0;border:0;border-radius:50%;background:transparent;color:${isDark ? '#D1D1D6' : '#636366'};cursor:pointer;pointer-events:auto;-webkit-app-region:no-drag;transition:background 140ms ease,color 140ms ease,transform 100ms ease}.refresh-btn:hover,.refresh-btn:focus-visible{color:${isDark ? '#FFFFFF' : '#1D1D1F'};background:${isDark ? 'rgba(255,255,255,.11)' : 'rgba(0,0,0,.06)'};outline:none}.refresh-btn:active:not(:disabled){transform:scale(.92)}.refresh-btn:disabled{cursor:wait}.refresh-btn.state-success{background:rgba(52,199,89,.14)}.refresh-btn.state-error{background:rgba(255,59,48,.13)}.icon{display:block;width:17px;height:17px;object-fit:contain;opacity:.72;${isDark ? 'filter:invert(1)' : ''}}.refresh-btn:hover .icon,.refresh-btn:focus-visible .icon{opacity:1}.state-loading .refresh-icon{animation:quota-refresh-spin .72s linear infinite;opacity:1}@keyframes quota-refresh-spin{to{transform:rotate(360deg)}}@media(prefers-reduced-motion:reduce){.fill,.refresh-btn{transition:none}.state-loading .refresh-icon{animation:none;opacity:.52}}
      </style><div class="capsule" tabindex="0" role="button" aria-label="Codex 额度详情" aria-describedby="codex-usage-details-v23" aria-expanded="${popover?.classList.contains('is-visible') ? 'true' : 'false'}">${content}</div>`;
      this.setupEvents();
    }
  }

  if (!customElements.get(COMPONENT_TAG)) customElements.define(COMPONENT_TAG, CodexUsageHeaderElement);

  function isVisible(element) {
    const rect = visibleRect(element);
    const style = element ? getComputedStyle(element) : null;
    return Boolean(
      rect
      && style
      && style.display !== 'none'
      && style.visibility !== 'hidden'
      && Number(style.opacity) > 0
      && rect.top < 80
      && rect.right > 0
      && rect.left < window.innerWidth,
    );
  }

  function resolveMountPoint() {
    const buttons = [...document.querySelectorAll('button')].filter(isVisible);
    const threadAction = buttons.find(button => /^聊天操作$|^chat actions?$|^more$/i.test(button.getAttribute('aria-label') || ''))
      || buttons.find(button => /^分享$|^share$/i.test(button.getAttribute('aria-label') || button.textContent || ''));
    const newChatAction = buttons.find(button => /^切换底部面板显示$|^toggle bottom panel visibility$|^toggle bottom panel$/i.test(button.getAttribute('aria-label') || ''))
      || buttons.find(button => /^显示\/隐藏侧边面板$|^show\/hide side panel$|^toggle side panel$/i.test(button.getAttribute('aria-label') || ''));
    const action = threadAction || newChatAction;
    const placement = threadAction ? 'thread' : 'new-chat';
    if (!action) return null;
    const header = action.closest('header');
    const isNewChat = !threadAction;
    const nativeRegion = isNewChat
      ? [...(header?.children || [])].find(child => child.contains(action))
      : null;
    const reference = isNewChat
      ? nativeRegion
      : action;
    const container = isNewChat ? header : action.parentElement;
    const toolbar = isNewChat ? header : container?.parentElement;
    if (!header || !container || !toolbar || !header.contains(toolbar)) return null;
    const headerRect = visibleRect(header);
    const toolbarRect = visibleRect(toolbar);
    if (!reference || !headerRect || !toolbarRect || headerRect.height > 80 || (!isNewChat && toolbarRect.width < 240)) return null;
    return { header, toolbar, container, reference, placement };
  }

  function mountCapsule() {
    const point = resolveMountPoint();
    const existing = document.querySelector(COMPONENT_TAG);
    if (!point) return false;
    if (existing?.isConnected) {
      if (existing.parentElement !== point.container || existing.nextElementSibling !== point.reference) {
        point.container.insertBefore(existing, point.reference);
      }
      existing.dataset.placement = point.placement;
      existing.style.setProperty('margin-right', point.placement === 'new-chat' ? '6px' : '0px');
      existing.setupResizeObserver?.();
      existing.updateMode?.();
      return true;
    }
    const element = document.createElement(COMPONENT_TAG);
    element.dataset.placement = point.placement;
    element.style.setProperty('margin-right', point.placement === 'new-chat' ? '6px' : '0px');
    point.container.insertBefore(element, point.reference);
    return true;
  }

  function ensureMounted() {
    if (mountTimer) clearTimeout(mountTimer);
    if (mountCapsule()) {
      mountAttempt = 0;
      return;
    }
    mountAttempt += 1;
    mountTimer = setTimeout(ensureMounted, Math.min(2000, 180 + mountAttempt * 80));
  }

  function initObserver() {
    ensureMounted();
    observer?.disconnect();
    observer = new MutationObserver(() => {
      suppressLegacyInstances();
      const element = document.querySelector(COMPONENT_TAG);
      const point = resolveMountPoint();
      if (!element?.isConnected || (point && element.parentElement !== point.container)) ensureMounted();
    });
    observer.observe(document.documentElement, { childList: true, subtree: true });
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = setInterval(() => {
      suppressLegacyInstances();
      ensureMounted();
    }, 3000);
  }

  window.__codexUsageHeaderRemount = ensureMounted;
  window.__codexUsageHeaderSetUsage__ = applyUsagePayload;
  window.__codexUsageHeaderSetRefreshError__ = applyRefreshError;
  window.__codexUsageHeaderTeardown__ = () => {
    if (pollTimer) clearTimeout(pollTimer);
    if (ticker) clearInterval(ticker);
    if (mountTimer) clearTimeout(mountTimer);
    if (healthTimer) clearInterval(healthTimer);
    clearRefreshTimers();
    observer?.disconnect();
    resizeObserver?.disconnect();
    document.querySelector(COMPONENT_TAG)?.remove();
    popover?.remove();
    document.getElementById('codex-usage-popover-style-v23')?.remove();
  };
  window.__codexUsageHeaderDebug__ = {
    getState: () => ({ ...usageState, refreshState, refreshRequestId }),
    getMode: () => currentMode,
    getAvailableWidth: () => measureAvailableWidth(document.querySelector(COMPONENT_TAG)),
    showPopover: () => showPopover({ immediate: true }),
    hidePopover,
  };
  document.addEventListener('visibilitychange', resetPollTimer);
  document.addEventListener('pointerdown', event => {
    const element = document.querySelector(COMPONENT_TAG);
    const insideHeader = element?.contains(event.target) || element?.shadowRoot?.contains(event.target);
    if (!insideHeader && !popover?.contains(event.target)) hidePopover();
  }, true);
  window.addEventListener('focus', resetPollTimer);
  window.addEventListener('resize', () => {
    document.querySelector(COMPONENT_TAG)?.updateMode?.();
    positionPopover();
  });
  window.addEventListener('scroll', positionPopover, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') hidePopover();
  }, true);
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      initObserver();
      resetPollTimer();
      requestUsage();
    });
  } else {
    initObserver();
    resetPollTimer();
    requestUsage();
  }
  ticker = setInterval(updateCountdowns, 30000);
})();
