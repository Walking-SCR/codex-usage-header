/**
 * Codex Quota Header renderer.
 * The component is mounted through localhost CDP, but never opens a local
 * HTTP bridge. The background monitor owns account reads and scheduling.
 */
(() => {
  'use strict';

  const RUNTIME_VERSION = '2.4.2';
  const HOST_TAG = 'codex-usage-header-host';
  const POPOVER_CLASS = 'codex-usage-popover-v24';
  const POPOVER_ID = 'codex-usage-details-v24';
  const SETTINGS_KEY = 'codexQuotaHeader.settings.v1';
  const LEGACY_COMPONENTS = [
    'codex-usage-header', 'codex-usage-header-v2', 'codex-usage-header-v3',
    'codex-usage-header-v4', 'codex-usage-header-v5', 'codex-usage-header-v6',
    'codex-usage-header-v7', 'codex-usage-header-v8', 'codex-usage-header-v9',
    'codex-usage-header-v10', 'codex-usage-header-v11', 'codex-usage-header-v12',
    'codex-usage-header-v13', 'codex-usage-header-v14', 'codex-usage-header-v15',
    'codex-usage-header-v16', 'codex-usage-header-v17', 'codex-usage-header-v18',
    'codex-usage-header-v19', 'codex-usage-header-v20', 'codex-usage-header-v21',
    'codex-usage-header-v22', 'codex-usage-header-v23',
  ];
  const CONFIG = {
    debounceMs: 5000,
    refreshTimeoutMs: 8000,
    minimumSpinMs: 650,
    popoverGap: 8,
    viewportInset: 12,
    modeHysteresis: 20,
    breakpoints: { full: 520, compact: 330, minimal: 190, nano: 140 },
    colors: {
      green: '#34C759',
      yellow: '#FF9500',
      red: '#FF3B30',
      track: 'rgba(120,120,128,.16)',
      muted: '#8E8E93',
    },
  };
  if (window.__codexUsageHeaderInstalled__ === RUNTIME_VERSION) {
    window.__codexUsageHeaderRemount?.();
    return;
  }
  window.__codexUsageHeaderTeardown__?.();
  const ICONS = window.__codexUsageHeaderIcons__ || {};
  const defaultSettings = {
    locale: /^zh/i.test(document.documentElement.lang || navigator.language || '') ? 'zh-CN' : 'en-US',
    refreshIntervalSeconds: 30,
  };

  function safeSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      return {
        locale: saved.locale === 'zh-CN' || saved.locale === 'en-US' ? saved.locale : defaultSettings.locale,
        refreshIntervalSeconds: Number(saved.refreshIntervalSeconds) === 60 ? 60 : 30,
      };
    } catch {
      return { ...defaultSettings };
    }
  }

  let settings = safeSettings();
  let usageState = {
    status: 'loading',
    primary: null,
    secondary: null,
    planType: null,
    showFiveHours: true,
    creditBalance: { value: null, displayValue: '—', unlimited: false },
    resetCredits: null,
    resetCreditDetails: [],
    lastUpdated: null,
    error: null,
  };
  let lastManualRefresh = 0;
  let currentMode = 'full';
  let host = null;
  let popover = null;
  let popoverState = 'closed';
  let popoverShowTimer = null;
  let popoverHideTimer = null;
  let refreshState = 'idle';
  let refreshRequestId = null;
  let refreshStartedAt = 0;
  let refreshTimeoutTimer = null;
  let refreshSettleTimer = null;
  let resizeObserver = null;
  let mountObserver = null;
  let mountTimer = null;
  let healthTimer = null;
  let layoutFrame = null;
  let commandCounter = 0;
  let hitAreaParent = null;
  let hitAreaParentStyle = null;
  let lastPointerX = null;
  let lastPointerY = null;

  const I18N = {
    'zh-CN': {
      title: '用量额度',
      subtitle: '合理AI协作，人负责思考，AI负责执行',
      details: 'Codex 用量额度详情',
      fiveHours: '5小时',
      sevenDays: '7天',
      remaining: '剩余',
      resetAt: '重置',
      untilReset: '剩余',
      imminent: '即将重置',
      minutes: '分钟',
      hours: '小时',
      days: '天',
      resetCredits: '额度重置券',
      available: '次可用',
      balance: '额度余额',
      unlimited: '无限额度',
      waiting: '等待首次更新',
      syncing: '正在同步额度…',
      unavailable: '暂时无法读取额度，请确认 Codex 已登录',
      refresh: '刷新额度',
      refreshing: '正在刷新额度',
      refreshFailed: '刷新失败，点击重试',
      refreshTimeout: '刷新超时，请重试',
      autoRefresh: '自动刷新',
      seconds: '秒',
      minute: '分钟',
      close: '关闭',
      usage: '使用量',
      resetDetails: '可用重置额度',
      noResetDetails: '暂无可用重置额度明细',
      expires: '到期',
      locale: '切换语言',
      settingsSaved: '刷新频率已保存',
    },
    'en-US': {
      title: 'Usage quota',
      subtitle: 'People think, AI executes—collaborate wisely',
      details: 'Codex usage quota details',
      fiveHours: '5 hours',
      sevenDays: '7 days',
      remaining: 'Remaining',
      resetAt: 'Resets',
      untilReset: 'remaining',
      imminent: 'Resetting soon',
      minutes: 'min',
      hours: 'hr',
      days: 'days',
      resetCredits: 'Reset credits',
      available: 'available',
      balance: 'Credit balance',
      unlimited: 'Unlimited',
      waiting: 'Waiting for first update',
      syncing: 'Syncing quota…',
      unavailable: 'Quota unavailable. Confirm Codex is signed in.',
      refresh: 'Refresh quota',
      refreshing: 'Refreshing quota',
      refreshFailed: 'Refresh failed. Click to retry',
      refreshTimeout: 'Refresh timed out. Try again',
      autoRefresh: 'Auto refresh',
      seconds: 'sec',
      minute: 'min',
      close: 'Close',
      usage: 'Usage',
      resetDetails: 'Available reset credits',
      noResetDetails: 'No reset credit details available',
      expires: 'Expires',
      locale: 'Switch language',
      settingsSaved: 'Refresh interval saved',
    },
  };

  const t = key => I18N[settings.locale][key] || key;
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[char]));

  function persistSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* best effort */ }
  }

  function emitCommand(kind, payload = {}, manual = false) {
    const id = 'cmd-' + Date.now() + '-' + (++commandCounter);
    window.__codexUsageHeaderCommand__ = { id, kind, payload, manual, createdAt: Date.now() };
    return id;
  }

  function getQuotaColor(remaining) {
    if (!Number.isFinite(remaining)) return CONFIG.colors.muted;
    if (remaining <= 10) return CONFIG.colors.red;
    if (remaining <= 20) return CONFIG.colors.yellow;
    return CONFIG.colors.green;
  }

  function getValueColor(remaining, dark) {
    if (!Number.isFinite(remaining) || remaining > 20) return dark ? '#F5F5F7' : '#3A3A3C';
    return remaining <= 10 ? (dark ? '#FF453A' : '#FF3B30') : (dark ? '#FFD60A' : '#C66A00');
  }

  function formatDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return t('imminent');
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.max(1, Math.floor((seconds % 3600) / 60));
    if (d > 0) return settings.locale === 'zh-CN' ? d + t('days') + ' ' + h + '小时' : d + 'd ' + h + 'h';
    if (h > 0) return settings.locale === 'zh-CN' ? h + '小时 ' + m + '分钟' : h + 'h ' + m + 'm';
    return settings.locale === 'zh-CN' ? m + '分钟' : m + 'm';
  }

  function formatDate(timestamp, includeDate = false) {
    if (!Number.isFinite(timestamp) || timestamp <= 0) return '--:--';
    const date = new Date(timestamp * 1000);
    if (settings.locale === 'zh-CN') {
      if (!includeDate && date.toDateString() === new Date().toDateString()) {
        return new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
      }
      return new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
    }
    if (!includeDate && date.toDateString() === new Date().toDateString()) {
      return new Intl.DateTimeFormat('en-US', { hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
    }
    return new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
  }

  function parseWindow(value) {
    if (!value || typeof value !== 'object') return null;
    const usedRaw = Number(value.usedPercent ?? value.used_percent);
    const used = Number.isFinite(usedRaw) ? Math.max(0, Math.min(100, Math.round(usedRaw))) : 0;
    const resetsAt = Number(value.resetsAt ?? value.reset_at ?? 0);
    const resetAfter = Number(value.resetAfterSeconds ?? value.reset_after_seconds ?? 0);
    const now = Math.floor(Date.now() / 1000);
    return {
      usedPercent: used,
      remainingPercent: 100 - used,
      resetsAt,
      secondsRemaining: Math.max(0, resetsAt > 0 ? resetsAt - now : resetAfter),
    };
  }

  function normalizePayload(raw, metadata = {}) {
    if (!raw || typeof raw !== 'object') return null;
    const legacy = raw.rateLimits || raw.rate_limit || raw;
    const buckets = raw.rateLimitsByLimitId || {};
    const root = buckets.codex || legacy;
    const secondarySource = root.secondary || root.secondary_window || root.secondaryWindow
      || buckets.codex_other?.primary || legacy.secondary;
    const planType = String(root.planType ?? legacy.planType ?? raw.planType ?? '').toLowerCase();
    const showFiveHours = !planType || planType === 'plus';
    const primary = parseWindow(root.primary || root.primary_window || root.primaryWindow);
    const secondary = parseWindow(secondarySource);
    if (!secondary || (showFiveHours && !primary)) return null;
    const credits = root.credits || raw.credits || {};
    const balance = credits.balance ?? credits.balanceText ?? raw.balance ?? null;
    const resetCredits = raw.rateLimitResetCredits;
    const availableCount = typeof resetCredits === 'object'
      ? Number(resetCredits.availableCount ?? resetCredits.available_count)
      : Number(resetCredits ?? raw.rate_limit_reset_credits);
    const details = typeof resetCredits === 'object' && Array.isArray(resetCredits.credits)
      ? resetCredits.credits.map(item => ({
        id: item.id || null,
        status: item.status || null,
        title: item.title || null,
        description: item.description || null,
        expiresAt: Number(item.expiresAt || 0),
      }))
      : [];
    const unlimited = credits.unlimited === true || credits.unlimited === 'true';
    return {
      status: 'ready',
      primary,
      secondary,
      planType: planType || null,
      showFiveHours,
      creditBalance: {
        value: balance,
        displayValue: unlimited ? t('unlimited') : (balance === null || balance === undefined ? '—' : String(balance)),
        unlimited,
      },
      resetCredits: Number.isFinite(availableCount) ? availableCount : null,
      resetCreditDetails: details,
      lastUpdated: Number(metadata.fetchedAt) || Date.now(),
      error: null,
    };
  }

  function iconMarkup(name, className = '') {
    const source = ICONS[name];
    return source ? '<img class="icon ' + className + '" aria-hidden="true" alt="" src="' + source + '">' : '';
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
      usageState.error = nextState === 'error' ? (message || t('refreshFailed')) : null;
      renderAll();
      refreshSettleTimer = setTimeout(() => {
        if (requestAtSettle !== refreshRequestId) return;
        refreshState = 'idle';
        refreshRequestId = null;
        renderAll();
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
      if (refreshState === 'loading' || now - lastManualRefresh < CONFIG.debounceMs) return false;
      clearRefreshTimers();
      lastManualRefresh = now;
      refreshStartedAt = performance.now();
      refreshRequestId = emitCommand('refresh', {}, true);
      refreshState = 'loading';
      usageState.error = null;
      renderAll();
      refreshTimeoutTimer = setTimeout(() => settleRefresh('error', t('refreshTimeout')), CONFIG.refreshTimeoutMs);
      return true;
    }
    emitCommand('refresh', {}, false);
    return true;
  }

  function applyUsagePayload(raw, metadata = {}) {
    const normalized = normalizePayload(raw, metadata);
    if (!normalized) return false;
    usageState = normalized;
    renderAll();
    if (refreshState === 'loading' && metadata.requestId === refreshRequestId) settleRefresh('success');
    return true;
  }

  function applyRefreshError(requestId, message) {
    if (refreshState !== 'loading' || requestId !== refreshRequestId) return false;
    settleRefresh('error', message || t('refreshFailed'));
    return true;
  }

  function saveInterval(value) {
    const seconds = Number(value) === 60 ? 60 : 30;
    settings.refreshIntervalSeconds = seconds;
    persistSettings();
    emitCommand('settings', { refreshIntervalSeconds: seconds });
    if (popover) renderPopover();
  }

  function switchLocale() {
    settings.locale = settings.locale === 'zh-CN' ? 'en-US' : 'zh-CN';
    persistSettings();
    renderAll();
  }

  function renderAll() {
    renderHost();
    if (popover?.classList.contains('is-visible')) {
      renderPopover();
      requestAnimationFrame(positionPopover);
    }
  }

  function updateCountdowns() {
    if (!host || !usageState.secondary) return;
    renderHost();
    if (popover?.classList.contains('is-visible')) renderPopover();
  }

  function ensurePopoverStyles() {
    if (document.getElementById('codex-usage-popover-style-v24')) return;
    const style = document.createElement('style');
    style.id = 'codex-usage-popover-style-v24';
    style.textContent = [
      '.' + POPOVER_CLASS + '{position:fixed;z-index:2147483646;box-sizing:border-box;-webkit-app-region:no-drag;opacity:0;visibility:hidden;pointer-events:none;transform:translateY(-4px) scale(.99);transform-origin:top right;transition:opacity 140ms ease,transform 140ms cubic-bezier(.2,.8,.2,1),visibility 0s linear 140ms}',
      '.' + POPOVER_CLASS + '.is-visible{opacity:1;visibility:visible;pointer-events:auto;transform:translateY(0) scale(1);transition-delay:0s}',
      '.' + POPOVER_CLASS + '[data-side="top"]{transform-origin:bottom right}',
      '@media(prefers-reduced-motion:reduce){.' + POPOVER_CLASS + ',.' + POPOVER_CLASS + '.is-visible{transition:none;transform:none}}',
    ].join('');
    (document.head || document.documentElement).appendChild(style);
  }

  function updateExpanded(expanded) {
    host?.shadowRoot?.querySelector('.details-trigger')?.setAttribute('aria-expanded', String(expanded));
  }

  function ensurePopover() {
    if (popover?.isConnected) return popover;
    ensurePopoverStyles();
    popover = document.createElement('div');
    popover.id = POPOVER_ID;
    popover.className = POPOVER_CLASS;
    popover.setAttribute('role', 'dialog');
    popover.setAttribute('aria-modal', 'false');
    popover.setAttribute('aria-hidden', 'true');
    popover.addEventListener('pointerenter', () => {
      if (popoverHideTimer) clearTimeout(popoverHideTimer);
    });
    popover.addEventListener('pointerleave', scheduleHidePopover);
    popover.addEventListener('click', event => {
      const path = event.composedPath();
      const refresh = path.find(node => node?.classList?.contains('card-refresh'));
      const language = path.find(node => node?.classList?.contains('language-toggle'));
      if (refresh && refreshState !== 'loading') requestUsage({ manual: true });
      else if (language) switchLocale();
    });
    popover.addEventListener('change', event => {
      if (event.target?.classList?.contains('refresh-interval')) saveInterval(event.target.value);
    });
    (document.body || document.documentElement).appendChild(popover);
    return popover;
  }

  function positionPopover() {
    if (!host || !popover) return;
    const trigger = host.shadowRoot?.querySelector('.details-trigger');
    const rect = trigger?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(620, Math.max(360, window.innerWidth - CONFIG.viewportInset * 2));
    popover.style.width = 'max-content';
    popover.style.maxWidth = 'calc(100vw - ' + (CONFIG.viewportInset * 2) + 'px)';
    const measured = Math.min(width, Math.max(360, popover.scrollWidth || width));
    popover.style.width = measured + 'px';
    const height = popover.getBoundingClientRect().height || 260;
    const left = Math.max(CONFIG.viewportInset, Math.min(window.innerWidth - measured - CONFIG.viewportInset, rect.right - measured));
    const below = rect.bottom + CONFIG.popoverGap;
    const belowFits = below + height <= window.innerHeight - CONFIG.viewportInset;
    const top = belowFits ? below : Math.max(CONFIG.viewportInset, rect.top - height - CONFIG.popoverGap);
    popover.dataset.side = belowFits ? 'bottom' : 'top';
    popover.style.left = left + 'px';
    popover.style.top = top + 'px';
  }

  function showPopover({ immediate = false, pinned = false } = {}) {
    if (popoverShowTimer) clearTimeout(popoverShowTimer);
    if (popoverHideTimer) clearTimeout(popoverHideTimer);
    const open = () => {
      const target = ensurePopover();
      popoverState = pinned ? 'pinned' : 'hover';
      renderPopover();
      positionPopover();
      target.classList.add('is-visible');
      target.setAttribute('aria-hidden', 'false');
      updateExpanded(true);
    };
    if (immediate) open();
    else popoverShowTimer = setTimeout(open, 100);
  }

  function hidePopover(force = false) {
    if (!force && popoverState === 'pinned') return;
    if (!force) {
      const popRect = popover?.getBoundingClientRect();
      const pointerInPopover = popRect && lastPointerX !== null
        && lastPointerX >= popRect.left && lastPointerX <= popRect.right
        && lastPointerY >= popRect.top && lastPointerY <= popRect.bottom;
      if (pointerInPopover || popover?.matches(':hover') || host?.matches(':hover')) return;
    }
    if (popoverShowTimer) clearTimeout(popoverShowTimer);
    if (popoverHideTimer) clearTimeout(popoverHideTimer);
    popoverShowTimer = null;
    popoverHideTimer = null;
    popoverState = 'closed';
    popover?.classList.remove('is-visible');
    popover?.setAttribute('aria-hidden', 'true');
    updateExpanded(false);
  }

  function scheduleHidePopover() {
    if (popoverState === 'pinned') return;
    if (popoverShowTimer) clearTimeout(popoverShowTimer);
    if (popoverHideTimer) clearTimeout(popoverHideTimer);
    popoverHideTimer = setTimeout(() => {
      // A rerender can replace the card node while the pointer is already
      // over it, so pointerenter may not fire again. Keep it open when CSS
      // hit-testing still reports the host or card as hovered.
      const popRect = popover?.getBoundingClientRect();
      const pointerInPopover = popRect && lastPointerX !== null
        && lastPointerX >= popRect.left && lastPointerX <= popRect.right
        && lastPointerY >= popRect.top && lastPointerY <= popRect.bottom;
      if (pointerInPopover || popover?.matches(':hover') || host?.matches(':hover')) {
        popoverHideTimer = null;
        return;
      }
      hidePopover();
    }, 240);
  }

  function popoverMarkup(dark) {
    const p = usageState.primary;
    const s = usageState.secondary;
    const showFiveHours = usageState.showFiveHours !== false;
    const ready = Boolean(s && (!showFiveHours || p));
    const pColor = getQuotaColor(p?.remainingPercent);
    const sColor = getQuotaColor(s?.remainingPercent);
    const message = usageState.status === 'error' ? t('unavailable') : t('syncing');
    const interval = settings.refreshIntervalSeconds;
    const creditTitle = settings.locale === 'zh-CN' ? '额度重置券' : 'Reset credit';
    const details = usageState.resetCreditDetails.length
      ? usageState.resetCreditDetails.map(item => '<div class="credit-detail"><span>' + esc(creditTitle) + '</span><span>' + (item.expiresAt ? esc(t('expires') + ' ' + formatDate(item.expiresAt, true)) : '') + '</span></div>').join('')
      : '<div class="credit-detail muted">' + esc(t('noResetDetails')) + '</div>';
    const primaryRow = showFiveHours
      ? '<div class="row"><span class="label">' + esc(t('fiveHours')) + '</span><span class="track"><span class="fill" style="width:' + p.remainingPercent + '%;background:' + pColor + '"></span></span><span class="value popover-primary-value">' + esc(t('remaining') + ' ' + p.remainingPercent + '%（' + formatDate(p.resetsAt) + ' ' + t('resetAt') + '，' + t('untilReset') + ' ' + formatDuration(p.secondsRemaining) + '）') + '</span></div>'
      : '';
    const rows = primaryRow + '<div class="row"><span class="label">' + esc(t('sevenDays')) + '</span><span class="track"><span class="fill" style="width:' + s.remainingPercent + '%;background:' + sColor + '"></span></span><span class="value popover-secondary-value">' + esc(t('remaining') + ' ' + s.remainingPercent + '%（' + formatDate(s.resetsAt, true) + ' ' + t('resetAt') + '）') + '</span></div>';
    const css = [
      '*{box-sizing:border-box}',
      '.popover-shell{display:block;inline-size:max-content;min-inline-size:min(420px,calc(100vw - 24px));max-inline-size:calc(100vw - 24px);font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;color:' + (dark ? '#F5F5F7' : '#1D1D1F') + ';background:' + (dark ? 'rgba(35,35,38,.97)' : 'rgba(255,255,255,.97)') + ';border:1px solid ' + (dark ? 'rgba(255,255,255,.13)' : 'rgba(0,0,0,.09)') + ';box-shadow:0 12px 34px rgba(0,0,0,.16);backdrop-filter:blur(22px);-webkit-backdrop-filter:blur(22px);border-radius:15px;padding:16px 18px}',
      '.popover-header{display:grid;grid-template-columns:minmax(0,1fr) auto;align-items:start;gap:16px}',
      '.popover-title{font-size:16px;font-weight:750;line-height:1.2}.popover-subtitle{margin-top:4px;font-size:11px;color:' + (dark ? '#A1A1A6' : '#7A7A80') + ';white-space:nowrap}',
      '.popover-actions{display:flex;align-items:center;gap:6px}.language-toggle,.card-refresh{height:28px;border:0;border-radius:8px;background:' + (dark ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.05)') + ';color:' + (dark ? '#F5F5F7' : '#3A3A3C') + ';cursor:pointer;padding:0 8px;font:600 11px -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif}.card-refresh{width:28px;padding:0;display:grid;place-items:center}.card-refresh .icon{width:16px;height:16px}.card-refresh.state-loading .icon{animation:quota-refresh-spin .72s linear infinite}.language-toggle:hover,.card-refresh:hover{background:' + (dark ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.09)') + '}',
      '.rows{display:flex;flex-direction:column;gap:16px;margin-top:16px}.row{display:grid;grid-template-columns:80px 122px minmax(190px,1fr);align-items:center;gap:10px;min-height:22px}.label{font-size:13px;font-weight:700;white-space:nowrap}.track{height:12px;border-radius:999px;overflow:hidden;background:' + CONFIG.colors.track + '}.fill{display:block;height:100%;border-radius:999px;transition:width .3s ease,background .3s ease}.value{min-width:0;color:' + (dark ? '#E5E5EA' : '#3A3A3C') + ';font-size:12.5px;font-weight:520;line-height:1.35;white-space:nowrap;font-variant-numeric:tabular-nums}',
      '.divider{height:1px;background:' + (dark ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.07)') + ';margin:15px 0}.meta-row{display:flex;align-items:center;gap:10px;min-height:28px;font-size:12.5px}.meta-row.muted{color:' + (dark ? '#A1A1A6' : '#7A7A80') + '}.meta-actions{display:flex;align-items:center;gap:18px;white-space:nowrap;flex-wrap:nowrap}.credits-copy{white-space:nowrap}.balance{color:' + (dark ? '#E5E5EA' : '#3A3A3C') + ';white-space:nowrap}.interval-label{display:flex;align-items:center;gap:8px}.refresh-interval{border:1px solid ' + (dark ? 'rgba(255,255,255,.16)' : 'rgba(0,0,0,.10)') + ';border-radius:7px;background:transparent;color:inherit;padding:4px 7px;font:inherit}.credit-details{margin-top:8px;border-top:1px solid ' + (dark ? 'rgba(255,255,255,.09)' : 'rgba(0,0,0,.07)') + ';padding-top:8px}.credit-detail{display:flex;justify-content:space-between;gap:20px;padding:5px 0;font-size:11px}.muted,.unavailable{color:' + (dark ? '#A1A1A6' : '#6E6E73') + '}.error-note{margin-top:10px;color:' + (dark ? '#FF6961' : '#C42B1C') + ';font-size:11.5px}',
      '@keyframes quota-refresh-spin{to{transform:rotate(360deg)}}@media(max-width:520px){.popover-subtitle{white-space:normal}.row{grid-template-columns:52px 100px minmax(150px,1fr);gap:10px}.value{white-space:normal}.meta-actions{gap:10px}}',
    ].join('');
    if (!ready) return '<style>' + css + '</style><div class="popover-shell"><div class="popover-header"><div><div class="popover-title">' + esc(t('title')) + '</div><div class="popover-subtitle">' + esc(t('subtitle')) + '</div></div><div class="popover-actions"><button class="language-toggle" aria-label="' + esc(t('locale')) + '">中 / EN</button><button class="card-refresh state-' + refreshState + '" aria-label="' + esc(refreshState === 'loading' ? t('refreshing') : t('refresh')) + '">' + iconMarkup('refresh') + '</button></div></div><div class="unavailable">' + esc(message) + '</div></div>';
    return '<style>' + css + '</style><div class="popover-shell"><div class="popover-header"><div><div class="popover-title">' + esc(t('title')) + '</div><div class="popover-subtitle">' + esc(t('subtitle')) + '</div></div><div class="popover-actions"><button class="language-toggle" aria-label="' + esc(t('locale')) + '">中 / EN</button><button class="card-refresh state-' + refreshState + '" aria-label="' + esc(refreshState === 'loading' ? t('refreshing') : refreshState === 'error' ? t('refreshFailed') : t('refresh')) + '">' + iconMarkup('refresh') + '</button></div></div><div class="rows">' + rows + '</div><div class="divider"></div><div class="meta-row"><span class="meta-actions"><span class="credits-copy">' + esc(t('resetCredits') + ': ' + (usageState.resetCredits ?? '—') + ' ' + t('available')) + '</span><span class="balance">' + esc(t('balance') + ': ' + usageState.creditBalance.displayValue) + '</span></span></div><div class="credit-details">' + details + '</div><div class="divider"></div><div class="meta-row muted"><span class="interval-label">' + esc(t('autoRefresh')) + '<select class="refresh-interval" aria-label="' + esc(t('autoRefresh')) + '"><option value="30"' + (interval === 30 ? ' selected' : '') + '>30 ' + esc(t('seconds')) + '</option><option value="60"' + (interval === 60 ? ' selected' : '') + '>1 ' + esc(t('minute')) + '</option></select></span></div>' + (usageState.error ? '<div class="error-note">' + esc(usageState.error) + '</div>' : '') + '</div>';
  }

  function renderPopover() {
    const target = ensurePopover();
    const dark = document.documentElement.classList.contains('dark') || window.matchMedia('(prefers-color-scheme: dark)').matches;
    target.innerHTML = popoverMarkup(dark);
  }

  function baseModeForWidth(width) {
    if (!Number.isFinite(width) || width >= CONFIG.breakpoints.full) return 'full';
    if (width >= CONFIG.breakpoints.compact) return 'compact';
    if (width >= CONFIG.breakpoints.minimal) return 'minimal';
    return 'nano';
  }

  function resolveMode(width) {
    const h = CONFIG.modeHysteresis;
    if (currentMode === 'full' && width >= CONFIG.breakpoints.full - h) return 'full';
    if (currentMode === 'compact' && width >= CONFIG.breakpoints.compact - h && width < CONFIG.breakpoints.full + h) return 'compact';
    if (currentMode === 'minimal' && width >= CONFIG.breakpoints.minimal - h && width < CONFIG.breakpoints.compact + h) return 'minimal';
    if (currentMode === 'nano' && width < CONFIG.breakpoints.minimal + h) return 'nano';
    return baseModeForWidth(width);
  }

  function visibleRect(element) {
    const rect = element?.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? rect : null;
  }

  function measureTitleNeed(titleRegion) {
    const rect = visibleRect(titleRegion);
    if (!rect) return 160;
    const candidates = [...titleRegion.querySelectorAll('button,a,[role="button"]')].map(visibleRect).filter(Boolean);
    const right = candidates.length ? Math.max(...candidates.map(item => item.right)) : rect.left + 160;
    return Math.max(128, Math.min(320, right - rect.left + 12));
  }

  function measureAvailableWidth(element) {
    const actionGroup = element?.parentElement;
    const newChat = element?.dataset?.placement === 'new-chat';
    const toolbar = newChat ? element?.closest('header') : actionGroup?.parentElement;
    const toolbarRect = visibleRect(toolbar);
    if (!toolbarRect || !actionGroup) return 520;
    const titleRegion = newChat ? null : [...toolbar.children].find(child => child !== actionGroup) || null;
    const titleNeed = newChat ? 160 : measureTitleNeed(titleRegion);
    const native = newChat
      ? (visibleRect(element.nextElementSibling)?.width || 70)
      : [...actionGroup.children].filter(child => child !== element).map(visibleRect).filter(Boolean).reduce((sum, rect) => sum + rect.width, 0);
    return Math.max(0, toolbarRect.width - titleNeed - native - 32);
  }

  function renderHost() {
    if (!host) return;
    host.dataset.mode = currentMode;
    const dark = document.documentElement.classList.contains('dark') || window.matchMedia('(prefers-color-scheme: dark)').matches;
    const p = usageState.primary;
    const s = usageState.secondary;
    const showFiveHours = usageState.showFiveHours !== false;
    const pColor = getQuotaColor(p?.remainingPercent);
    const sColor = getQuotaColor(s?.remainingPercent);
    const pValue = p ? p.remainingPercent + '%' : '—';
    const sValue = s ? s.remainingPercent + '%' : '—';
    const pColorText = getValueColor(p?.remainingPercent, dark);
    const sColorText = getValueColor(s?.remainingPercent, dark);
    const pieItem = showFiveHours ? p : s;
    const pieLabel = showFiveHours ? '5h' : '7d';
    const pieColor = showFiveHours ? pColorText : sColorText;
    const pPie = ' style="--remaining:' + (pieItem?.remainingPercent || 0) + '%;color:' + pieColor + '"';
    let content;
    if (!showFiveHours && currentMode === 'nano') {
      content = '<span class="label">' + pieLabel + '</span><span class="mini-pie"' + pPie + ' aria-hidden="true"></span>';
    } else if (currentMode === 'nano') {
      content = '<span class="label">5h</span><span class="mini-pie"' + pPie + ' aria-hidden="true"></span>';
    } else if (!showFiveHours && currentMode === 'minimal') {
      content = '<span class="label">7d</span><span class="value" style="color:' + sColorText + '">' + sValue + '</span>';
    } else if (!showFiveHours) {
      content = '<span class="label">7d</span><span class="track"><span class="fill" style="width:' + (s?.remainingPercent || 0) + '%;background:' + sColor + '"></span></span><span class="value" style="color:' + sColorText + '">' + sValue + '</span>';
    } else if (currentMode === 'minimal') {
      content = '<span class="label">5h</span><span class="value" style="color:' + pColorText + '">' + pValue + '</span><span class="divider"></span><span class="label">7d</span><span class="value" style="color:' + sColorText + '">' + sValue + '</span>';
    } else if (currentMode === 'compact') {
      content = '<span class="label">5h</span><span class="track"><span class="fill" style="width:' + (p?.remainingPercent || 0) + '%;background:' + pColor + '"></span></span><span class="value" style="color:' + pColorText + '">' + pValue + '</span><span class="divider"></span><span class="label">7d</span><span class="track"><span class="fill" style="width:' + (s?.remainingPercent || 0) + '%;background:' + sColor + '"></span></span><span class="value" style="color:' + sColorText + '">' + sValue + '</span>';
    } else {
      content = '<span class="label">5h</span><span class="track"><span class="fill" style="width:' + (p?.remainingPercent || 0) + '%;background:' + pColor + '"></span></span><span class="value primary-countdown" style="color:' + pColorText + '">' + pValue + ' · ' + (p ? formatDuration(p.secondsRemaining) : '—') + '</span><span class="divider"></span><span class="label">7d</span><span class="track"><span class="fill" style="width:' + (s?.remainingPercent || 0) + '%;background:' + sColor + '"></span></span><span class="value" style="color:' + sColorText + '">' + sValue + '</span>';
    }
    const detailsOpen = popoverState !== 'closed';
    const style = '<style>*{box-sizing:border-box}:host{display:inline-flex;align-items:center;flex:0 0 auto;min-width:0;margin:0;position:relative;z-index:20;pointer-events:auto!important;-webkit-app-region:no-drag;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;user-select:none}.capsule{height:34px;min-width:0;padding:0 9px;border-radius:999px;display:inline-flex;align-items:center;gap:5px;color:' + (dark ? '#F5F5F7' : '#1D1D1F') + ';background:' + (dark ? 'rgba(40,40,42,.90)' : 'rgba(247,247,248,.94)') + ';border:1px solid ' + (dark ? 'rgba(255,255,255,.13)' : 'rgba(0,0,0,.07)') + ';box-shadow:0 1px 3px rgba(0,0,0,.07);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);-webkit-app-region:no-drag;white-space:nowrap;outline:none}.details-trigger{height:32px;padding:0;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:5px;white-space:nowrap}.details-trigger:focus-visible{outline:2px solid ' + (dark ? 'rgba(10,132,255,.72)' : 'rgba(0,122,255,.55)') + ';outline-offset:2px}.label{flex:none;font-size:12px;font-weight:700;letter-spacing:-.15px}.track{flex:none;width:70px;height:12px;overflow:hidden;border-radius:999px;background:' + CONFIG.colors.track + '}.fill{display:block;height:100%;border-radius:999px;transition:width .3s ease,background .3s ease}.mini-pie{width:16px;height:16px;display:inline-block;border-radius:50%;background:conic-gradient(currentColor 0 var(--remaining), ' + CONFIG.colors.track + ' var(--remaining) 100%);transform:rotate(-90deg)}.value{flex:none;font-size:12px;font-weight:560;letter-spacing:-.1px;font-variant-numeric:tabular-nums}.primary-countdown{min-width:0}.divider{flex:none;width:1px;height:16px;margin:0;background:' + (dark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.12)') + '}</style><div class="capsule"><button class="details-trigger" type="button" aria-label="' + esc(t('details')) + '" aria-describedby="' + POPOVER_ID + '" aria-expanded="' + detailsOpen + '">' + content + '</button></div>';
    host.shadowRoot.innerHTML = style;
  }

  function updateMode() {
    if (!host) return;
    const available = measureAvailableWidth(host);
    const next = resolveMode(available);
    host.dataset.mode = currentMode;
    host.dataset.availableWidth = String(Math.round(available));
    if (next !== currentMode) {
      currentMode = next;
      host.dataset.mode = currentMode;
      renderHost();
      if (popover?.classList.contains('is-visible')) requestAnimationFrame(positionPopover);
    }
  }

  function ensureHostHitArea() {
    if (!host) return;
    host.style.setProperty('pointer-events', 'auto', 'important');
    host.style.setProperty('-webkit-app-region', 'no-drag', 'important');
    const parent = host.parentElement;
    if (parent === hitAreaParent) return;
    if (hitAreaParent) {
      if (hitAreaParentStyle === null) hitAreaParent.removeAttribute('style');
      else hitAreaParent.setAttribute('style', hitAreaParentStyle);
    }
    hitAreaParent = null;
    hitAreaParentStyle = null;
    if (parent?.classList.contains('pointer-events-none')) {
      hitAreaParent = parent;
      hitAreaParentStyle = parent.getAttribute('style');
      parent.style.setProperty('pointer-events', 'auto', 'important');
    }
  }

  function bindHostEvents() {
    ensureHostHitArea();
    if (host.__eventsBound) return;
    host.__eventsBound = true;
    // Codex's titlebar is a drag surface with pointer-events disabled on
    // several ancestors. Make the injected island an explicit hit target and
    // keep the usual event path for browsers that deliver pointer events.
    const openFromHost = event => {
      lastPointerX = event.clientX;
      lastPointerY = event.clientY;
      const path = event.composedPath();
      if (path.some(node => node?.classList?.contains('details-trigger')) || path.includes(host)) showPopover();
    };
    host.addEventListener('pointerover', openFromHost, true);
    host.addEventListener('pointerenter', openFromHost, true);
    host.addEventListener('mouseover', openFromHost, true);
    host.addEventListener('mouseenter', openFromHost, true);
    host.addEventListener('pointerleave', scheduleHidePopover, true);
    host.addEventListener('mouseleave', scheduleHidePopover, true);
    host.addEventListener('click', event => {
      const path = event.composedPath();
      if (!path.some(node => node?.classList?.contains('details-trigger'))) return;
      if (popoverState === 'pinned') hidePopover(true);
      else showPopover({ immediate: true, pinned: true });
    }, true);
    host.addEventListener('keydown', event => {
      if (event.key === 'Escape') hidePopover(true);
      if ((event.key === 'Enter' || event.key === ' ') && event.composedPath().some(node => node?.classList?.contains('details-trigger'))) {
        event.preventDefault();
        if (popoverState === 'pinned') hidePopover(true);
        else showPopover({ immediate: true, pinned: true });
      }
    }, true);

    // Coordinate fallback: if Electron routes the physical pointer to the
    // drag surface instead of the shadow button, document-level mousemove can
    // still recognize the component's visible bounds.
    const handleDocumentPointerMove = event => {
      lastPointerX = event.clientX;
      lastPointerY = event.clientY;
      const rect = host.getBoundingClientRect();
      const inside = event.clientX >= rect.left && event.clientX <= rect.right
        && event.clientY >= rect.top && event.clientY <= rect.bottom;
      const popRect = popover?.getBoundingClientRect();
      const insidePopover = popRect && event.clientX >= popRect.left && event.clientX <= popRect.right
        && event.clientY >= popRect.top && event.clientY <= popRect.bottom;
      if (inside || insidePopover) {
        if (popoverHideTimer) clearTimeout(popoverHideTimer);
        popoverHideTimer = null;
      }
      if (inside) showPopover();
      else if (!insidePopover && popoverState !== 'pinned') scheduleHidePopover();
    };
    document.addEventListener('pointermove', handleDocumentPointerMove, true);
    document.addEventListener('mousemove', handleDocumentPointerMove, true);
  }

  function bindResizeObserver() {
    resizeObserver?.disconnect();
    resizeObserver = new ResizeObserver(() => {
      if (layoutFrame) cancelAnimationFrame(layoutFrame);
      layoutFrame = requestAnimationFrame(updateMode);
    });
    const toolbar = host?.parentElement?.parentElement;
    if (toolbar) resizeObserver.observe(toolbar);
    const header = toolbar?.closest('header');
    if (header && header !== toolbar) resizeObserver.observe(header);
  }

  function isVisible(element) {
    const rect = visibleRect(element);
    const style = element ? getComputedStyle(element) : null;
    return Boolean(rect && style && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0 && rect.top < 80 && rect.right > 0 && rect.left < window.innerWidth);
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
    const newChat = !threadAction;
    const nativeRegion = newChat ? [...(header?.children || [])].find(child => child.contains(action)) : null;
    const reference = newChat ? nativeRegion : action;
    const container = newChat ? header : action.parentElement;
    const toolbar = newChat ? header : container?.parentElement;
    if (!header || !container || !toolbar || !header.contains(toolbar)) return null;
    const headerRect = visibleRect(header);
    const toolbarRect = visibleRect(toolbar);
    if (!reference || !headerRect || !toolbarRect || headerRect.height > 80 || (!newChat && toolbarRect.width < 240)) return null;
    return { header, toolbar, container, reference, placement };
  }

  function mountCapsule() {
    const point = resolveMountPoint();
    const existing = document.querySelector(HOST_TAG);
    if (!point) return false;
    if (existing?.isConnected) {
      host = existing;
      if (existing.parentElement !== point.container || existing.nextElementSibling !== point.reference) point.container.insertBefore(existing, point.reference);
      existing.dataset.placement = point.placement;
      existing.style.setProperty('margin-right', point.placement === 'new-chat' ? '6px' : '0px');
      if (!existing.shadowRoot) existing.attachShadow({ mode: 'open' });
      bindHostEvents();
      renderHost();
      bindResizeObserver();
      updateMode();
      return true;
    }
    host = document.createElement(HOST_TAG);
    host.dataset.placement = point.placement;
    host.style.setProperty('margin-right', point.placement === 'new-chat' ? '6px' : '0px');
    host.attachShadow({ mode: 'open' });
    point.container.insertBefore(host, point.reference);
    bindHostEvents();
    renderHost();
    bindResizeObserver();
    updateMode();
    return true;
  }

  function suppressLegacyInstances() {
    LEGACY_COMPONENTS.forEach(tag => document.querySelectorAll(tag).forEach(element => {
      element.style.setProperty('display', 'none', 'important');
      element.style.setProperty('pointer-events', 'none', 'important');
      element.setAttribute('aria-hidden', 'true');
    }));
  }

  function ensureMounted() {
    if (mountTimer) clearTimeout(mountTimer);
    if (mountCapsule()) { mountTimer = null; return; }
    mountTimer = setTimeout(ensureMounted, Math.min(2000, 180 + (++ensureMounted.attempt || 1) * 80));
  }

  function initObserver() {
    ensureMounted();
    mountObserver?.disconnect();
    mountObserver = new MutationObserver(() => {
      suppressLegacyInstances();
      const point = resolveMountPoint();
      if (!host?.isConnected || (point && host.parentElement !== point.container)) ensureMounted();
    });
    mountObserver.observe(document.documentElement, { childList: true, subtree: true });
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = setInterval(() => { suppressLegacyInstances(); ensureMounted(); }, 3000);
  }

  window.__codexUsageHeaderRemount = ensureMounted;
  window.__codexUsageHeaderSetUsage__ = applyUsagePayload;
  window.__codexUsageHeaderSetRefreshError__ = applyRefreshError;
  window.__codexUsageHeaderTeardown__ = () => {
    if (mountTimer) clearTimeout(mountTimer);
    if (healthTimer) clearInterval(healthTimer);
    if (layoutFrame) cancelAnimationFrame(layoutFrame);
    clearRefreshTimers();
    mountObserver?.disconnect();
    resizeObserver?.disconnect();
    document.querySelector(HOST_TAG)?.remove();
    document.querySelectorAll('.' + POPOVER_CLASS).forEach(item => item.remove());
    document.getElementById('codex-usage-popover-style-v24')?.remove();
    if (hitAreaParent) {
      if (hitAreaParentStyle === null) hitAreaParent.removeAttribute('style');
      else hitAreaParent.setAttribute('style', hitAreaParentStyle);
    }
    hitAreaParent = null;
    hitAreaParentStyle = null;
  };
  window.__codexUsageHeaderDebug__ = {
    getState: () => ({ ...usageState, refreshState, refreshRequestId, settings: { ...settings } }),
    getMode: () => currentMode,
    getAvailableWidth: () => measureAvailableWidth(host),
    showPopover: () => showPopover({ immediate: true }),
    hidePopover: () => hidePopover(true),
  };

  document.addEventListener('pointerdown', event => {
    const insideHost = host?.contains(event.target) || host?.shadowRoot?.contains(event.target);
    const insidePopover = popover?.contains(event.target);
    if (!insideHost && !insidePopover) hidePopover(true);
  }, true);
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      hidePopover(true);
    }
  }, true);
  window.addEventListener('resize', () => { updateMode(); positionPopover(); });
  window.addEventListener('scroll', positionPopover, true);
  window.addEventListener('focus', () => { if (!window.__codexUsageHeaderCommand__) requestUsage(); });
  window.addEventListener('storage', event => { if (event.key === SETTINGS_KEY) { settings = safeSettings(); renderAll(); } });

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { initObserver(); requestUsage(); });
  } else {
    initObserver();
    requestUsage();
  }
  setInterval(updateCountdowns, 1000);

  window.__codexUsageHeaderInstalled__ = RUNTIME_VERSION;
})();
