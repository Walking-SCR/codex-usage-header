/**
 * Codex Quota Header renderer.
 * The component is mounted through localhost CDP, but never opens a local
 * HTTP bridge. The background monitor owns account reads and scheduling.
 */
(() => {
  'use strict';

  const RUNTIME_VERSION = '3.9.4';
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
    enableGoogleAiPro: false,
    enableTokenUsage: false,
  };

  function safeSettings() {
    try {
      const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
      return {
        locale: saved.locale === 'zh-CN' || saved.locale === 'en-US' ? saved.locale : defaultSettings.locale,
        refreshIntervalSeconds: Number(saved.refreshIntervalSeconds) === 60 ? 60 : 30,
        enableGoogleAiPro: Boolean(saved.enableGoogleAiPro ?? defaultSettings.enableGoogleAiPro),
        enableTokenUsage: Boolean(saved.enableTokenUsage ?? defaultSettings.enableTokenUsage),
      };
    } catch {
      return { ...defaultSettings };
    }
  }

  let settings = safeSettings();
  let googleCollapsed = (typeof localStorage !== 'undefined' ? localStorage.getItem('codexQuotaHeader.googleCollapsed') === 'true' : false);
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
  let extendedUsageState = {
    antigravity: {
      status: 'idle',
      plan: null,
      rows: [],
      fetchedAt: null,
      stale: false,
      error: null,
    },
    tokens: {
      status: 'idle',
      selectedRange: (typeof localStorage !== 'undefined' ? localStorage.getItem('codexQuotaHeader.selectedTokenRange') : null) || 'today',
      ranges: {
        today: null,
        days7: null,
        days30: null,
      },
      coverageStartedAt: null,
      error: null,
    },
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
      subtitle: '合理AI协作，人员更思考，AI负责执行',
      usageTitle: '使用额度',
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
      refreshFailed: '更新失败，当前显示上次数据',
      refreshTimeout: '刷新超时，请重试',
      autoRefresh: '自动刷新',
      seconds: '秒',
      minute: '分钟',
      close: '关闭',
      usage: '使用量',
      resetDetails: '可用重置额度',
      noResetDetails: '暂无可用重置额度明细',
      expires: '到期',
      fullReset: '完全重置（每周 + 5 小时）',
      expiresOn: '将于',
      timezone: 'GMT+8',
      expiresSuffix: '到期',
      locale: '切换语言',
      settingsSaved: '刷新频率已保存',
      geminiTitle: 'Google AI Pro', // Gemini AI Pro compatibility
      tokenUsage: 'Token使用量', // Token处理量
      toggleGoogle: 'Google AI Pro (开启/关闭)',
      toggleStats: 'Token使用量 (开启/关闭)',
      noGoogleAccounts: '未检测到本地 Google AI Pro 账号配置',
      noResetCoupons: '暂无可用重置券',
      today: '今天',
      days7: '近7日',
      days30: '近30日',
      total: '总计',
      other: '其他',
      noData: '暂无数据',
      staleData: '数据可能已过期',
      buildingHistory: '正在整理历史用量',
    },
    'en-US': {
      title: 'Usage quota',
      subtitle: 'People think, AI executes—collaborate wisely',
      usageTitle: 'Usage quota',
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
      refreshFailed: 'Refresh failed, showing previous data',
      refreshTimeout: 'Refresh timed out. Try again',
      autoRefresh: 'Auto refresh',
      seconds: 'sec',
      minute: 'min',
      close: 'Close',
      usage: 'Usage',
      resetDetails: 'Available reset credits',
      noResetDetails: 'No reset credit details available',
      expires: 'Expires',
      fullReset: 'Full reset (Weekly + 5 hr)',
      expiresOn: 'Expires',
      timezone: 'GMT+8',
      expiresSuffix: '',
      locale: 'Switch language',
      settingsSaved: 'Refresh interval saved',
      geminiTitle: 'Google AI Pro', // Gemini AI Pro compatibility
      tokenUsage: 'Token usage',
      toggleGoogle: 'Google AI Pro (Toggle on/off)',
      toggleStats: 'Token usage (Toggle on/off)',
      noGoogleAccounts: 'No local Google AI Pro accounts found',
      noResetCoupons: 'No available reset coupons',
      today: 'Today',
      days7: 'Last 7 days',
      days30: 'Last 30 days',
      total: 'Total',
      other: 'Other',
      noData: 'No data',
      staleData: 'Data may be stale',
      buildingHistory: 'Building usage history',
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
    const cmd = { id, kind, payload, manual, createdAt: Date.now() };
    if (!Array.isArray(window.__codexUsageHeaderCommands__)) {
      window.__codexUsageHeaderCommands__ = [];
    }
    window.__codexUsageHeaderCommands__.push(cmd);
    window.__codexUsageHeaderCommand__ = cmd;
    return id;
  }

  function getQuotaColor(remaining) {
    if (!Number.isFinite(remaining)) return CONFIG.colors.muted;
    if (remaining <= 10) return CONFIG.colors.red;
    if (remaining <= 40) return CONFIG.colors.yellow;
    return CONFIG.colors.green;
  }

  function getValueColor(remaining, dark) {
    if (!Number.isFinite(remaining) || remaining > 40) return dark ? '#F5F5F7' : '#3A3A3C';
    return remaining <= 10 ? (dark ? '#FF453A' : '#FF3B30') : (dark ? '#FFD60A' : '#C66A00');
  }

  function formatCreditBalance(value) {
    if (value === null || value === undefined || value === '') return '—';
    const numeric = Number(value);
    return Number.isFinite(numeric) ? numeric.toFixed(2) : String(value);
  }

  function formatDuration(seconds, maxSeconds = null) {
    if (!Number.isFinite(seconds) || seconds <= 0) return t('imminent');
    let sec = Math.max(0, seconds);
    if (Number.isFinite(maxSeconds) && maxSeconds > 0) sec = Math.min(maxSeconds, sec);
    const d = Math.floor(sec / 86400);
    const h = Math.floor((sec % 86400) / 3600);
    const m = Math.floor((sec % 3600) / 60);
    if (d > 0) {
      if (settings.locale === 'zh-CN') {
        return h > 0 ? d + t('days') + ' ' + h + '小时' : d + t('days');
      }
      return h > 0 ? d + 'd ' + h + 'h' : d + 'd';
    }
    if (h > 0) {
      if (settings.locale === 'zh-CN') {
        return m > 0 ? h + '小时 ' + m + '分钟' : h + '小时';
      }
      return m > 0 ? h + 'h ' + m + 'm' : h + 'h';
    }
    const displayMinutes = Math.max(1, m);
    return settings.locale === 'zh-CN' ? displayMinutes + '分钟' : displayMinutes + 'm';
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

  function isWeeklyExhausted(window) {
    return window?.remainingPercent === 0;
  }

  function weeklyResetSuffix(window) {
    if (!isWeeklyExhausted(window) || !Number.isFinite(window?.resetsAt) || window.resetsAt <= 0) return '';
    return ' · ' + formatDate(window.resetsAt, true) + ' ' + t('resetAt');
  }

  function parseWindow(value, maxSeconds = null) {
    if (!value || typeof value !== 'object') return null;
    const usedRaw = Number(value.usedPercent ?? value.used_percent);
    const used = Number.isFinite(usedRaw) ? Math.max(0, Math.min(100, Math.round(usedRaw))) : 0;
    const resetsAt = Number(value.resetsAt ?? value.reset_at ?? 0);
    const resetAfter = Number(value.resetAfterSeconds ?? value.reset_after_seconds ?? 0);
    const now = Math.floor(Date.now() / 1000);
    let secondsRemaining = Math.max(0, resetsAt > 0 ? resetsAt - now : resetAfter);
    if (Number.isFinite(maxSeconds) && maxSeconds > 0) {
      secondsRemaining = Math.min(maxSeconds, secondsRemaining);
    }
    return {
      usedPercent: used,
      remainingPercent: 100 - used,
      resetsAt,
      secondsRemaining,
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
    const primary = parseWindow(root.primary || root.primary_window || root.primaryWindow, 5 * 3600);
    const secondary = parseWindow(secondarySource, 7 * 86400);
    if (!secondary || (showFiveHours && !primary)) return null;
    // The weekly window is an account-wide ceiling. Once it is exhausted,
    // the shorter window cannot be usable even if its raw bucket is ahead.
    const effectivePrimary = primary && secondary.remainingPercent === 0
      ? { ...primary, usedPercent: 100, remainingPercent: 0 }
      : primary;
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
      primary: effectivePrimary,
      secondary,
      planType: planType || null,
      showFiveHours,
      creditBalance: {
        value: balance,
        displayValue: unlimited ? t('unlimited') : formatCreditBalance(balance),
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

  let lastExpiredRefresh = 0;
  function updateCountdowns() {
    if (!host || !usageState.secondary) return;
    const now = Math.floor(Date.now() / 1000);
    if (usageState.primary && usageState.primary.resetsAt > 0) {
      usageState.primary.secondsRemaining = Math.min(5 * 3600, Math.max(0, usageState.primary.resetsAt - now));
      if (usageState.primary.resetsAt <= now && now - usageState.primary.resetsAt >= 5 && Date.now() - lastExpiredRefresh > 30000) {
        lastExpiredRefresh = Date.now();
        requestUsage({ manual: false });
      }
    }
    if (usageState.secondary && usageState.secondary.resetsAt > 0) {
      usageState.secondary.secondsRemaining = Math.min(7 * 86400, Math.max(0, usageState.secondary.resetsAt - now));
    }
    const anti = extendedUsageState.antigravity;
    if (anti && anti.accounts && anti.accounts.length) {
      const allRows = anti.accounts.flatMap(a => a.rows || []);
      const expiredRow = allRows.find(r => !r.unavailable && r.resetTime && r.resetTime <= now && (now - r.resetTime >= 2));
      if (expiredRow && Date.now() - lastExpiredRefresh > 12000) {
        lastExpiredRefresh = Date.now();
        requestUsage({ manual: false });
      }
    }
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
      const rangeTab = path.find(node => node?.classList?.contains('quota-extension-range-tab'));
      const accountTab = path.find(node => node?.classList?.contains('quota-extension-account-tab'));
      const googleToggle = path.find(node => node?.classList?.contains('quota-extension-toggle'));
      if (refresh && refreshState !== 'loading') requestUsage({ manual: true });
      else if (language) {
        const opt = path.find(node => node?.classList?.contains('lang-opt'));
        const targetLang = opt?.dataset?.lang;
        if (targetLang && targetLang !== settings.locale) {
          settings.locale = targetLang;
          persistSettings();
          renderAll();
        } else if (!opt) {
          switchLocale();
        }
      }
      else if (path.find(node => node?.classList?.contains('google-toggle-btn'))) {
        settings.enableGoogleAiPro = !settings.enableGoogleAiPro;
        persistSettings();
        emitCommand('settings', { enableGoogleAiPro: settings.enableGoogleAiPro });
        if (settings.enableGoogleAiPro) {
          emitCommand('refresh', {}, false);
        }
        renderAll();
        positionPopover();
      }
      else if (path.find(node => node?.classList?.contains('stats-toggle-btn'))) {
        settings.enableTokenUsage = !settings.enableTokenUsage;
        persistSettings();
        emitCommand('settings', { enableTokenUsage: settings.enableTokenUsage });
        if (settings.enableTokenUsage) {
          emitCommand('refresh', {}, false);
        }
        renderAll();
        positionPopover();
      }
      else if (googleToggle) {
        googleCollapsed = !googleCollapsed;
        try { localStorage.setItem('codexQuotaHeader.googleCollapsed', String(googleCollapsed)); } catch { /* ignore */ }
        renderPopover();
        positionPopover();
      } else if (rangeTab) {
        const range = rangeTab.dataset.range;
        if (range && ['today', 'days7', 'days30'].includes(range)) {
          extendedUsageState.tokens.selectedRange = range;
          try { localStorage.setItem('codexQuotaHeader.selectedTokenRange', range); } catch { /* ignore */ }
          renderPopover();
          positionPopover();
        }
      } else if (accountTab) {
        const account = accountTab.dataset.account;
        if (account) {
          extendedUsageState.antigravity.userSelectedAccount = account;
          extendedUsageState.antigravity.selectedAccount = account;
          renderPopover();
          positionPopover();
        }
      }
    });
    (document.body || document.documentElement).appendChild(popover);
    return popover;
  }

  function positionPopover() {
    if (!host || !popover) return;
    const trigger = host.shadowRoot?.querySelector('.details-trigger');
    const rect = trigger?.getBoundingClientRect();
    if (!rect) return;
    const width = Math.min(600, Math.max(360, window.innerWidth - CONFIG.viewportInset * 2));
    popover.style.width = width + 'px';
    popover.style.maxWidth = 'calc(100vw - ' + (CONFIG.viewportInset * 2) + 'px)';
    const height = popover.getBoundingClientRect().height || 260;
    const left = Math.max(CONFIG.viewportInset, Math.min(window.innerWidth - width - CONFIG.viewportInset, rect.right - width));
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
      renderHost();
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
    renderHost();
  }

  function scheduleHidePopover() {
    if (popoverState === 'pinned') return;
    if (popoverShowTimer) clearTimeout(popoverShowTimer);
    if (popoverHideTimer) clearTimeout(popoverHideTimer);
    popoverHideTimer = setTimeout(() => {
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

  function isAccountAvailable(acc) {
    if (!acc || acc.disabled || acc.status === 'error' || acc.status === 'disabled') return false;
    const rows = acc.rows || [];
    if (!rows.length) return false;
    const gemini5h = rows.find(r => r.label === 'Gemini 5h');
    if (gemini5h && gemini5h.remainingPercent === 0) return false;
    const gemini7d = rows.find(r => r.label === 'Gemini 7d');
    if (gemini7d && gemini7d.remainingPercent === 0) return false;
    const valid = rows.filter(r => !r.unavailable && Number.isFinite(r.remainingPercent));
    return valid.length > 0 && valid.some(r => r.remainingPercent > 0);
  }

  function formatDynamicCountdown(row, isZh) {
    if (row.unavailable) return t('noData');
    if (!Number.isFinite(row.resetTime) || row.resetTime <= 0) {
      return isZh ? (row.countdown?.zh || t('imminent')) : (row.countdown?.en || t('imminent'));
    }
    const now = Math.floor(Date.now() / 1000);
    if (row.resetTime <= now) {
      return t('syncing');
    }
    let secondsRemaining = Math.max(0, row.resetTime - now);
    if (row.label && row.label.includes('5h')) {
      secondsRemaining = Math.min(18000, secondsRemaining);
    }
    if (secondsRemaining < 60) {
      return t('imminent');
    }
    if (secondsRemaining < 86400) {
      const hours = Math.floor(secondsRemaining / 3600);
      const mins = Math.floor((secondsRemaining % 3600) / 60);
      if (hours === 0) {
        return isZh ? (mins + 'min后重置') : ('resets in ' + mins + 'm');
      }
      return isZh ? (hours + 'h' + mins + 'min后重置') : ('resets in ' + hours + 'h ' + mins + 'm');
    }
    const days = Math.floor(secondsRemaining / 86400);
    return isZh ? (days + '天后重置') : ('resets in ' + days + 'd');
  }

  function formatExtendedTokenCount(tokens, isZh) {
    if (!Number.isFinite(tokens) || tokens <= 0) return '0';
    if (isZh) {
      if (tokens >= 1e8) return (tokens / 1e8).toFixed(2).replace(/\.?0+$/, '') + '亿';
      if (tokens >= 1e4) return (tokens / 1e4).toFixed(1).replace(/\.?0+$/, '') + '万';
      return String(tokens);
    }
    if (tokens >= 1e9) return (tokens / 1e9).toFixed(2).replace(/\.?0+$/, '') + 'B';
    if (tokens >= 1e6) return (tokens / 1e6).toFixed(2).replace(/\.?0+$/, '') + 'M';
    if (tokens >= 1e3) return (tokens / 1e3).toFixed(1).replace(/\.?0+$/, '') + 'K';
    return String(tokens);
  }

  function renderEmptyState(iconSvg, text) {
    return '<div class="empty-state-box">'
      + '<div class="empty-state-icon">' + iconSvg + '</div>'
      + '<div class="empty-state-text">' + esc(text) + '</div>'
      + '</div>';
  }

  function renderExtendedUsage(dark) {
    const isZh = settings.locale === 'zh-CN';
    const anti = extendedUsageState.antigravity || {};
    const tok = extendedUsageState.tokens || {};

    let tokenSection = '';
    if (settings.enableTokenUsage) {
      const selectedRange = tok.selectedRange || 'today';
      const rangeTabs = '<div class="quota-extension-range-tabs">'
        + '<button type="button" class="quota-extension-range-tab ' + (selectedRange === 'today' ? 'is-active' : '') + '" data-range="today">' + esc(t('today')) + '</button>'
        + '<button type="button" class="quota-extension-range-tab ' + (selectedRange === 'days7' ? 'is-active' : '') + '" data-range="days7">' + esc(t('days7')) + '</button>'
        + '<button type="button" class="quota-extension-range-tab ' + (selectedRange === 'days30' ? 'is-active' : '') + '" data-range="days30">' + esc(t('days30')) + '</button>'
        + '</div>';

      const barChartEmptySvg = '<svg width="22" height="22" viewBox="0 0 24 24" fill="currentColor"><rect x="4" y="13" width="3.5" height="8" rx="1.2"></rect><rect x="10.25" y="8" width="3.5" height="13" rx="1.2"></rect><rect x="16.5" y="3" width="3.5" height="18" rx="1.2"></rect></svg>';

      let tokenContent = '';
      if (tok.status === 'building') {
        tokenContent = renderEmptyState(barChartEmptySvg, t('buildingHistory') + '...');
      } else {
        const rangeData = tok.ranges?.[selectedRange];
        if (!rangeData) {
          tokenContent = renderEmptyState(barChartEmptySvg, t('noData'));
        } else {
          const totalFormatted = formatExtendedTokenCount(rangeData.total, isZh);
          const rawItems = rangeData.items || [];
          const hasGpt = rawItems.some(i => i.key === 'gpt');
          const hasGemini = rawItems.some(i => i.key === 'gemini');
          const hasOther = rawItems.some(i => i.key === 'other');

          const allItems = [...rawItems];
          if (!hasGpt) allItems.unshift({ key: 'gpt', label: 'GPT', tokens: 0, percent: '0.0%' });
          if (!hasGemini) {
            const gptIdx = allItems.findIndex(i => i.key === 'gpt');
            allItems.splice(gptIdx + 1, 0, { key: 'gemini', label: 'Gemini', tokens: 0, percent: '0.0%' });
          }
          if (!hasOther) {
            allItems.push({ key: 'other', label: isZh ? '其他' : 'Other', tokens: 0, percent: '0.0%' });
          }

          const itemRows = allItems.map(item => {
            const label = item.key === 'other' ? t('other') : item.label;
            const formatted = formatExtendedTokenCount(item.tokens, isZh);
            const dotColor = item.key === 'gpt' ? '#007AFF' : item.key === 'gemini' ? '#8B5CF6' : '#9CA3AF';
            return '<div class="token-model-row">'
              + '<span class="token-model-label"><span class="token-model-dot" style="background:' + dotColor + '"></span>' + esc(label) + '</span>'
              + '<span class="token-model-amount">' + esc(formatted) + '</span>'
              + '<span class="token-model-pct">' + esc(item.percent) + '</span>'
              + '</div>';
          }).join('');

          tokenContent = '<div class="quota-extension-token-table">'
            + '<div class="token-summary-col">'
            + '<span class="token-summary-label">' + esc(t('total')) + '</span>'
            + '<div class="token-summary-val"><span class="token-summary-number">' + esc(totalFormatted) + '</span><span class="token-summary-unit"> Token</span></div>'
            + '</div>'
            + '<div class="token-models-col">' + itemRows + '</div>'
            + '</div>';
        }
      }

      const chartSvg = '<svg class="section-icon" width="16" height="16" viewBox="0 0 24 24" fill="#007AFF"><rect x="3" y="11" width="3.8" height="10" rx="1.2"></rect><rect x="10.1" y="6" width="3.8" height="15" rx="1.2"></rect><rect x="17.2" y="2" width="3.8" height="19" rx="1.2"></rect></svg>';

      tokenSection = '<div class="card-section quota-extension-section">'
        + '<div class="quota-extension-header has-rows">'
        + '<div class="quota-extension-title-wrap">'
        + chartSvg
        + '<span class="quota-extension-title">' + esc(t('tokenUsage')) + '</span>'
        + '</div>'
        + rangeTabs
        + '</div>'
        + tokenContent
        + '</div>';
    }

    let geminiSection = '';
    if (!settings.enableGoogleAiPro) {
      if (!tokenSection) return '';
      return '<div class="quota-extension">' + tokenSection + '</div>';
    }

    const accounts = anti.accounts || [];
    const manualAccount = anti.userSelectedAccount ? accounts.find(a => a.email === anti.userSelectedAccount) : null;
    const isManualValid = manualAccount && isAccountAvailable(manualAccount);
    const activeAccount = (isManualValid ? manualAccount : (accounts.find(a => a.email === anti.selectedAccount) || accounts.find(isAccountAvailable))) || accounts[0] || anti;
    const activeRows = activeAccount.rows || anti.rows || [];

    let accountTabsHtml = '';
    if (accounts.length > 1) {
      accountTabsHtml = '<div class="quota-extension-account-tabs">'
        + accounts.map((acc, idx) => {
          const isActive = (acc.email === activeAccount.email);
          const tabLabel = acc.label || (acc.email ? acc.email.split('@')[0] : '') || (isZh ? ('账号' + (idx + 1)) : ('Account ' + (idx + 1)));
          return '<button type="button" class="quota-extension-account-tab ' + (isActive ? 'is-active' : '') + '" data-account="' + esc(acc.email) + '" title="' + esc(acc.email) + '">'
            + esc(tabLabel)
            + '</button>';
        }).join('')
        + '</div>';
    }

    const chevronSvg = '<svg class="chevron-icon" width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">'
      + (googleCollapsed ? '<polyline points="6 9 12 15 18 9"></polyline>' : '<polyline points="18 15 12 9 6 15"></polyline>')
      + '</svg>';

    const docEmptySvg = '<svg width="22" height="24" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M5 3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H5zm3 5a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H9a1 1 0 0 1-1-1zm0 4a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H9a1 1 0 0 1-1-1zm0 4a1 1 0 0 1 1-1h4a1 1 0 1 1 0 2H9a1 1 0 0 1-1-1z"/></svg>';

    let geminiContent = '';
    if (!accounts.length || !activeRows || activeRows.length === 0) {
      geminiContent = renderEmptyState(docEmptySvg, t('noData'));
    } else if (!googleCollapsed) {
        geminiContent = '<div class="quota-extension-rows">'
          + activeRows.map((row, idx) => {
            const color = getQuotaColor(row.remainingPercent);
            const percentText = (row.remainingPercent !== null && row.remainingPercent !== undefined && !row.unavailable)
              ? row.remainingPercent + '%'
              : '0%';
            const countdownStr = formatDynamicCountdown(row, isZh);
            const resetInfo = row.unavailable ? esc(t('noData')) : esc(countdownStr);

            return '<div class="quota-extension-row' + (idx === activeRows.length - 1 ? ' is-last' : '') + '">'
              + '<span class="quota-extension-label">' + esc(row.label) + '</span>'
              + '<span class="quota-extension-track"><span class="quota-extension-fill" style="width:' + (row.unavailable ? 0 : (row.remainingPercent || 0)) + '%;background:' + color + '"></span></span>'
              + '<span class="quota-extension-percent">' + esc(percentText) + '</span>'
              + '<span class="quota-extension-value">' + esc(resetInfo) + '</span>'
              + '</div>';
          }).join('')
          + '</div>';
    }

    const sparkleSvg = '<svg class="section-icon" width="16" height="16" viewBox="0 0 24 24" fill="#1A73E8"><path d="M12 2C12 2 12.5 8.5 15.5 11.5C18.5 14.5 22 15 22 15C22 15 18.5 15.5 15.5 18.5C12.5 21.5 12 22 12 22C12 22 11.5 21.5 8.5 18.5C5.5 15.5 2 15 2 15C2 15 5.5 14.5 8.5 11.5C11.5 8.5 12 2 12 2Z"/></svg>';

    geminiSection = '<div class="card-section quota-extension-section">'
      + '<div class="quota-extension-header' + (!googleCollapsed && activeRows?.length ? ' has-rows' : '') + '">'
      + '<div class="quota-extension-title-wrap">'
      + sparkleSvg
      + '<span class="quota-extension-title">' + esc(t('geminiTitle')) + '</span>'
      + '</div>'
      + '<div class="quota-extension-header-actions">'
      + accountTabsHtml
      + '<button type="button" class="quota-extension-toggle" aria-label="Toggle Google AI Pro">' + chevronSvg + '</button>'
      + '</div>'
      + '</div>'
      + geminiContent
      + '</div>';

    if (!geminiSection && !tokenSection) return '';
    return '<div class="quota-extension">'
      + geminiSection
      + tokenSection
      + '</div>';
  }

  function popoverMarkup(dark) {
    const isZh = settings.locale === 'zh-CN';
    const p = usageState.primary;
    const s = usageState.secondary;
    const showFiveHours = usageState.showFiveHours !== false;
    const weeklyExhausted = isWeeklyExhausted(s);
    const ready = Boolean(s && (!showFiveHours || p));
    const pColor = getQuotaColor(p?.remainingPercent);
    const sColor = getQuotaColor(s?.remainingPercent);
    const message = usageState.status === 'error' ? t('unavailable') : t('syncing');

    const ticketEmptySvg = '<svg width="24" height="20" viewBox="0 0 24 20" fill="currentColor"><path d="M22 6C20.9 6 20 5.1 20 4V3C20 1.9 19.1 1 18 1H6C4.9 1 4 1.9 4 3V4C4 5.1 3.1 6 2 6C0.9 6 0 6.9 0 8V12C0 13.1 0.9 14 2 14C3.1 14 4 14.9 4 16V17C4 18.1 4.9 19 6 19H18C19.1 19 20 18.1 20 17V16C20 14.9 20.9 14 22 14C23.1 14 24 13.1 24 12V8C24 6.9 23.1 6 22 6ZM12 4.5a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1ZM12 11.5a1 1 0 0 1 1 1v2a1 1 0 1 1-2 0v-2a1 1 0 0 1 1-1Z"/></svg>';

    const details = usageState.resetCreditDetails.length
      ? usageState.resetCreditDetails.map(item => {
        const expiry = item.expiresAt
          ? settings.locale === 'zh-CN'
            ? t('expiresOn') + ' ' + formatDate(item.expiresAt, true) + ' ' + t('timezone') + ' ' + t('expiresSuffix')
            : t('expiresOn') + ' ' + formatDate(item.expiresAt, true) + ' ' + t('timezone')
          : t('noResetDetails');
        return '<div class="credit-detail"><strong>' + esc(t('fullReset')) + '</strong><span>' + esc(expiry) + '</span></div>';
      }).join('')
      : renderEmptyState(ticketEmptySvg, t('noResetCoupons'));

    const pPercent = (p?.remainingPercent ?? '—') + '%';
    const sPercent = (s?.remainingPercent ?? '—') + '%';
    const pInfoTime = p ? formatDate(p.resetsAt) + ' ' + t('resetAt') : '--:--';
    const pInfoRemain = weeklyExhausted ? '' : (t('untilReset') + ' ' + formatDuration(p?.secondsRemaining, 5 * 3600));
    const sInfoTime = s ? formatDate(s.resetsAt, true) + ' ' + t('resetAt') : '--:--';
    const sInfoRemain = s ? t('untilReset') + ' ' + formatDuration(s?.secondsRemaining, 7 * 86400) : '';

    const primaryRow = showFiveHours
      ? '<div class="row">'
        + '<span class="label">' + esc(t('fiveHours')) + '</span>'
        + '<span class="track"><span class="fill" style="width:' + (p?.remainingPercent || 0) + '%;background:' + pColor + '"></span></span>'
        + '<span class="percent">' + esc(pPercent) + '</span>'
        + '<span class="value popover-primary-value"><span class="info-time">' + esc(pInfoTime) + '</span><span class="info-remain">' + esc(pInfoRemain) + '</span></span>'
        + '</div>'
      : '';
    const secondaryRow = '<div class="row">'
      + '<span class="label">' + esc(t('sevenDays')) + '</span>'
      + '<span class="track"><span class="fill" style="width:' + (s?.remainingPercent || 0) + '%;background:' + sColor + '"></span></span>'
      + '<span class="percent">' + esc(sPercent) + '</span>'
      + '<span class="value popover-secondary-value"><span class="info-time">' + esc(sInfoTime) + '</span><span class="info-remain">' + esc(sInfoRemain) + '</span></span>'
      + '</div>';

    const usageContent = ready
      ? '<div class="card-section usage-section">'
        + '<div class="card-section-header"><span class="card-section-title">' + esc(t('usageTitle')) + '</span></div>'
        + '<div class="rows">' + primaryRow + secondaryRow + '</div>'
        + '</div>'
      : '<div class="card-section usage-section"><div class="unavailable">' + esc(message) + '</div></div>';

    const ticketSvg = '<svg class="credit-icon" width="18" height="15" viewBox="0 0 24 20" fill="#3B82F6"><path d="M22 6C20.9 6 20 5.1 20 4V3C20 1.9 19.1 1 18 1H6C4.9 1 4 1.9 4 3V4C4 5.1 3.1 6 2 6C0.9 6 0 6.9 0 8V12C0 13.1 0.9 14 2 14C3.1 14 4 14.9 4 16V17C4 18.1 4.9 19 6 19H18C19.1 19 20 18.1 20 17V16C20 14.9 20.9 14 22 14C23.1 14 24 13.1 24 12V8C24 6.9 23.1 6 22 6Z"/><path d="M12 4V16" stroke="white" stroke-width="2" stroke-dasharray="2 2"/></svg>';

    const voucherBanner = '<div class="meta-row">'
      + '<span class="meta-actions">'
      + '<span class="credits-copy">'
      + ticketSvg
      + '<span class="credits-text">' + esc(t('resetCredits') + '：' + (usageState.resetCredits ?? '—') + ' ' + t('available')) + '</span>'
      + '</span>'
      + '<span class="balance">' + esc(t('balance') + '：' + usageState.creditBalance.displayValue) + '</span>'
      + '</span>'
      + '</div>';

    const voucherSection = '<div class="card-section reset-voucher-section">'
      + voucherBanner
      + '<div class="credit-details">' + details + '</div>'
      + '</div>';

    const extensionMarkup = renderExtendedUsage(dark);
    const errorNote = usageState.error ? '<div class="refresh-error-note">' + esc(usageState.error) + '</div>' : '';

    const css = [
      '*{box-sizing:border-box}',
      '.popover-shell{display:block;width:590px;max-width:calc(100vw - 24px);max-height:calc(100vh - 40px);overflow-y:auto;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;color:' + (dark ? '#F5F5F7' : '#1D1D1F') + ';background:' + (dark ? 'rgba(32,32,35,.98)' : 'rgba(255,255,255,.98)') + ';border:1px solid ' + (dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.07)') + ';box-shadow:0 18px 48px rgba(0,0,0,.12),0 4px 12px rgba(0,0,0,.04);backdrop-filter:blur(24px);-webkit-backdrop-filter:blur(24px);border-radius:18px;padding:18px 20px}',
      '.popover-header{display:flex;align-items:flex-start;justify-content:space-between;gap:16px;margin-bottom:12px}',
      '.popover-title-group{display:flex;flex-direction:column;gap:3px}',
      '.popover-title{font-size:18px;font-weight:750;letter-spacing:-.3px;line-height:1.2}',
      '.popover-subtitle{font-size:11.5px;color:' + (dark ? '#A1A1A6' : '#6B7280') + ';line-height:1.3;white-space:nowrap}',
      '.popover-actions{display:flex;align-items:center;gap:8px}',
      '.language-toggle,.card-refresh{height:28px;border-radius:8px;border:1px solid ' + (dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.08)') + ';background:' + (dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.03)') + ';color:' + (dark ? '#F5F5F7' : '#1D1D1F') + ';cursor:pointer;font:600 11.5px -apple-system,BlinkMacSystemFont,"SF Pro Text",sans-serif;transition:all .15s ease}',
      '.language-toggle{padding:0 8px;display:inline-flex;align-items:center;justify-content:center;gap:2px;user-select:none}',
      '.lang-opt{color:' + (dark ? '#8E8E93' : '#8E8E93') + ';font-weight:500;padding:1px 3px;border-radius:4px;transition:all .15s ease}',
      '.lang-opt.is-active{color:#007AFF;font-weight:700}',
      '.lang-sep{color:' + (dark ? 'rgba(255,255,255,.2)' : 'rgba(0,0,0,.15)') + ';font-size:10.5px}',
      '.card-refresh,.google-toggle-btn,.stats-toggle-btn{width:28px;height:28px;padding:0;border-radius:8px;border:1px solid ' + (dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.08)') + ';background:' + (dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.03)') + ';color:' + (dark ? '#8E8E93' : '#8E8E93') + ';cursor:pointer;display:grid;place-items:center;transition:all .15s ease}',
      '.google-toggle-btn:hover,.stats-toggle-btn:hover{background:' + (dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.07)') + ';color:' + (dark ? '#FFFFFF' : '#1D1D1F') + '}',
      '.google-toggle-btn.is-active,.stats-toggle-btn.is-active{background:' + (dark ? 'rgba(10,132,255,.20)' : 'rgba(0,122,255,.10)') + ';border-color:' + (dark ? 'rgba(10,132,255,.45)' : 'rgba(0,122,255,.30)') + ';color:#007AFF}',
      '.card-refresh .icon,.card-refresh svg{width:15px;height:15px;display:block}',
      '.card-refresh.state-loading{color:#007AFF;border-color:' + (dark ? 'rgba(10,132,255,.45)' : 'rgba(0,122,255,.30)') + ';background:' + (dark ? 'rgba(10,132,255,.15)' : 'rgba(0,122,255,.08)') + '}',
      '.card-refresh.state-loading .icon,.card-refresh.state-loading svg{animation:quota-refresh-spin .72s linear infinite}',
      '.language-toggle:hover,.card-refresh:hover{background:' + (dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.07)') + '}',
      '@keyframes quota-refresh-spin{to{transform:rotate(360deg)}}',
      '@keyframes quota-number-shimmer{0%{opacity:.35;filter:blur(0.4px)}50%{opacity:.85;filter:blur(0px)}100%{opacity:.35;filter:blur(0.4px)}}',
      '.popover-shell.is-refreshing .percent,.popover-shell.is-refreshing .row .value,.popover-shell.is-refreshing .quota-extension-percent,.popover-shell.is-refreshing .quota-extension-value,.popover-shell.is-refreshing .token-summary-number,.popover-shell.is-refreshing .token-model-amount,.popover-shell.is-refreshing .token-model-pct,.popover-shell.is-refreshing .credits-text,.popover-shell.is-refreshing .balance{animation:quota-number-shimmer .75s ease-in-out infinite;transition:opacity .2s ease}',
      '.popover-shell.is-refreshing .fill,.popover-shell.is-refreshing .quota-extension-fill{opacity:.45;transition:opacity .2s ease}',
      '.refresh-error-note{font-size:11.5px;color:#FF3B30;margin-top:4px}',

      '.card-section{background:' + (dark ? 'rgba(255,255,255,.04)' : '#F9FAFB') + ';border:1px solid ' + (dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.04)') + ';border-radius:12px;padding:14px 16px;margin-top:10px}',
      '.card-section-header{display:flex;align-items:center;justify-content:space-between;margin-bottom:12px}',
      '.card-section-title{font-size:13.5px;font-weight:700;letter-spacing:-.1px;color:' + (dark ? '#F5F5F7' : '#1D1D1F') + '}',

      '.usage-section .rows{display:flex;flex-direction:column;gap:12px}',
      '.row{display:grid;grid-template-columns:52px minmax(140px,1fr) 46px minmax(110px,auto);align-items:center;gap:10px;min-height:28px}',
      '@media(max-width:520px){.row{grid-template-columns:52px 122px minmax(150px,1fr);gap:10px}}',
      '.row .label{font-size:13px;font-weight:600;text-align:left;white-space:nowrap;width:52px;color:' + (dark ? '#F5F5F7' : '#1D1D1F') + '}',
      '.row .track{height:10px;border-radius:999px;overflow:hidden;background:' + (dark ? 'rgba(120,120,128,.24)' : '#E5E7EB') + '}',
      '.row .fill{display:block;height:100%;border-radius:999px;transition:width .2s ease,background .2s ease}',
      '.row .percent{font-size:13px;font-weight:650;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;color:' + (dark ? '#F5F5F7' : '#1D1D1F') + '}',
      '.row .value{display:flex;flex-direction:column;align-items:flex-end;justify-content:center;text-align:right;line-height:1.35;white-space:nowrap;min-width:110px}',
      '.row .value .info-time{font-size:11.5px;font-weight:500;color:' + (dark ? '#E5E5EA' : '#1D1D1F') + '}',
      '.row .value .info-remain{font-size:11px;color:' + (dark ? '#A1A1A6' : '#6B7280') + '}',

      '.reset-voucher-section{margin-top:10px}',
      '.meta-row{display:flex;align-items:center;width:100%;background:transparent;border:0;border-radius:0;padding:0;margin-bottom:12px}',
      '.meta-actions{display:flex;align-items:center;justify-content:space-between;gap:18px;width:100%;white-space:nowrap;flex-wrap:nowrap}',
      '.credits-copy{display:inline-flex;align-items:center;gap:7px;white-space:nowrap;font-weight:600;font-size:12.5px;color:' + (dark ? '#F5F5F7' : '#1D1D1F') + '}',
      '.credits-copy .credit-icon{display:inline-flex;align-items:center;justify-content:center;flex-shrink:0}',
      '.balance{color:' + (dark ? '#A1A1A6' : '#6B7280') + ';font-size:12px;font-weight:550;white-space:nowrap}',
      '.credit-details{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:5px;margin-top:0;padding-top:0;border-top-width:0px}',
      '.credit-detail{display:flex;flex-direction:column;justify-content:center;align-items:flex-start;padding:12px 16px;font-size:12px;border:1px solid ' + (dark ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.06)') + ';border-radius:10px;background:' + (dark ? 'rgba(255,255,255,.04)' : '#FFFFFF') + ';transition:all .15s ease}',
      '.credit-detail:hover{border-color:' + (dark ? 'rgba(10,132,255,.4)' : 'rgba(0,122,255,.28)') + ';background:' + (dark ? 'rgba(10,132,255,.08)' : 'rgba(0,122,255,.02)') + '}',
      '.credit-detail strong{font-size:12.5px;font-weight:650;white-space:nowrap;color:' + (dark ? '#F5F5F7' : '#1D1D1F') + '}',
      '.credit-detail span{font-size:11px;color:' + (dark ? '#A1A1A6' : '#6B7280') + ';white-space:nowrap;margin-top:4px}',

      '.empty-state-box{display:flex;flex-direction:column;align-items:center;justify-content:center;padding:22px 16px;border:1px solid ' + (dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.05)') + ';border-radius:10px;background:' + (dark ? 'rgba(255,255,255,.02)' : '#FFFFFF') + ';gap:7px}',
      '.credit-details .empty-state-box{grid-column:1 / -1;margin-top:0}',
      '.empty-state-icon{display:flex;align-items:center;justify-content:center;color:' + (dark ? '#636366' : '#9CA3AF') + '}',
      '.empty-state-text{font-size:12px;font-weight:500;color:' + (dark ? '#8E8E93' : '#6B7280') + ';white-space:nowrap}',

      '.quota-extension{}',
      '.quota-extension-section{background:' + (dark ? 'rgba(255,255,255,.04)' : '#F9FAFB') + ';border:1px solid ' + (dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.04)') + ';border-radius:12px;padding:14px 16px;margin-top:10px}',
      '.quota-extension-header{display:flex;align-items:center;justify-content:space-between}',
      '.quota-extension-header.has-rows{margin-bottom:10px}',
      '.quota-extension-title-wrap{display:flex;align-items:center;gap:8px}',
      '.quota-extension-title{font-size:13.5px;font-weight:700;letter-spacing:-.1px;color:' + (dark ? '#F5F5F7' : '#1D1D1F') + '}',
      '.quota-extension-header-actions{display:flex;align-items:center;gap:6px}',
      '.quota-extension-account-tabs{display:inline-flex;align-items:center;gap:2px;background:' + (dark ? 'rgba(255,255,255,.08)' : '#F1F3F5') + ';padding:2px;border-radius:999px}',
      '.quota-extension-account-tab{border:0;background:transparent;color:' + (dark ? '#A1A1A6' : '#6B7280') + ';border-radius:999px;padding:3px 12px;font-size:11.5px;font-weight:500;cursor:pointer;transition:all .15s ease;white-space:nowrap}',
      '.quota-extension-account-tab:hover{color:' + (dark ? '#FFFFFF' : '#1D1D1F') + '}',
      '.quota-extension-account-tab.is-active{background:#007AFF;color:#FFFFFF;box-shadow:0 1px 2px rgba(0,122,255,.25)}',
      '.quota-extension-toggle{border:0;background:transparent;color:' + (dark ? '#A1A1A6' : '#6B7280') + ';padding:4px;border-radius:6px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:all .15s ease}',
      '.quota-extension-toggle:hover{color:' + (dark ? '#FFFFFF' : '#1D1D1F') + ';background:' + (dark ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.05)') + '}',
      '.quota-extension-rows{display:flex;flex-direction:column}',
      '.quota-extension-row{display:grid;grid-template-columns:112px minmax(100px,1fr) 38px 96px;align-items:center;gap:10px;min-height:30px;border-bottom:1px solid ' + (dark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.04)') + ';padding:5px 0}',
      '.quota-extension-row.is-last{border-bottom:0;padding-bottom:0}',
      '.quota-extension-label{font-size:12.5px;font-weight:500;text-align:left;white-space:nowrap;color:' + (dark ? '#F5F5F7' : '#1D1D1F') + '}',
      '.quota-extension-track{height:10px;min-width:100px;border-radius:999px;overflow:hidden;background:' + (dark ? 'rgba(120,120,128,.24)' : '#E5E7EB') + '}',
      '.quota-extension-fill{display:block;height:100%;border-radius:999px;transition:width .2s ease,background .2s ease}',
      '.quota-extension-percent{font-size:12px;font-weight:500;text-align:right;font-variant-numeric:tabular-nums;white-space:nowrap;color:' + (dark ? '#F5F5F7' : '#1D1D1F') + '}',
      '.quota-extension-value{font-size:11.5px;color:' + (dark ? '#A1A1A6' : '#4B5563') + ';white-space:nowrap;font-variant-numeric:tabular-nums;text-align:right}',

      '.quota-extension-range-tabs{display:inline-flex;align-items:center;gap:2px;background:' + (dark ? 'rgba(255,255,255,.08)' : '#F1F3F5') + ';padding:2px;border-radius:999px}',
      '.quota-extension-range-tab{border:0;background:transparent;color:' + (dark ? '#A1A1A6' : '#6B7280') + ';border-radius:999px;padding:3px 12px;font-size:11.5px;font-weight:500;cursor:pointer;transition:all .15s ease}',
      '.quota-extension-range-tab:hover{color:' + (dark ? '#FFFFFF' : '#1D1D1F') + '}',
      '.quota-extension-range-tab.is-active{background:#007AFF;color:#FFFFFF;box-shadow:0 1px 2px rgba(0,122,255,.25)}',

      '.quota-extension-token-table{display:grid;grid-template-columns:minmax(175px,auto) 1fr;align-items:center;gap:0;margin-top:12px}',
      '.token-summary-col{display:flex;flex-direction:column;justify-content:center;padding-right:16px;min-width:170px}',
      '.token-summary-label{font-size:12px;color:' + (dark ? '#A1A1A6' : '#6B7280') + ';font-weight:500;margin-bottom:2px;white-space:nowrap}',
      '.token-summary-val{display:flex;align-items:baseline;gap:3px;white-space:nowrap}',
      '.token-summary-number{font-size:24px;font-weight:750;letter-spacing:-.4px;font-variant-numeric:tabular-nums;color:' + (dark ? '#F5F5F7' : '#1D1D1F') + ';white-space:nowrap;word-break:keep-all}',
      '.token-summary-unit{font-size:12.5px;color:' + (dark ? '#A1A1A6' : '#6B7280') + ';font-weight:450;white-space:nowrap;flex-shrink:0}',
      '.token-models-col{display:flex;flex-direction:column;gap:7px;border-left:1px solid ' + (dark ? 'rgba(255,255,255,.07)' : 'rgba(0,0,0,.06)') + ';padding-left:18px}',
      '.token-model-row{display:grid;grid-template-columns:72px minmax(80px,1fr) 48px;align-items:center;gap:10px;font-size:12.5px}',
      '.token-model-label{display:flex;align-items:center;gap:6px;font-weight:500;color:' + (dark ? '#E5E5EA' : '#374151') + ';white-space:nowrap}',
      '.token-model-dot{width:7.5px;height:7.5px;border-radius:50%;flex-shrink:0}',
      '.token-model-amount{text-align:right;font-weight:650;font-variant-numeric:tabular-nums;color:' + (dark ? '#F5F5F7' : '#1D1D1F') + ';white-space:nowrap}',
      '.token-model-pct{text-align:right;color:' + (dark ? '#A1A1A6' : '#6B7280') + ';font-size:11.5px;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.quota-extension-note{font-size:12px;color:' + (dark ? '#A1A1A6' : '#6B7280') + ';padding:6px 0}',
      '.unavailable{font-size:12.5px;color:' + (dark ? '#A1A1A6' : '#6B7280') + ';padding:8px 0}',
    ].join('');

    return '<style>' + css + '</style>'
      + '<div class="popover-shell' + (refreshState === 'loading' ? ' is-refreshing' : '') + '">'
      + '<div class="popover-header">'
      + '<div class="popover-title-group">'
      + '<div class="popover-title">' + esc(t('title')) + '</div>'
      + '<div class="popover-subtitle">' + esc(t('subtitle')) + '</div>'
      + errorNote
      + '</div>'
      + '<div class="popover-actions">'
      + '<button class="language-toggle" aria-label="' + esc(t('locale')) + '">'
      + '<span class="lang-opt' + (isZh ? ' is-active' : '') + '" data-lang="zh-CN">中</span>'
      + '<span class="lang-sep">/</span>'
      + '<span class="lang-opt' + (!isZh ? ' is-active' : '') + '" data-lang="en-US">EN</span>'
      + '</button> <!-- 中 / EN -->'
      + '<button type="button" class="google-toggle-btn' + (settings.enableGoogleAiPro ? ' is-active' : '') + '" aria-label="' + esc(t('toggleGoogle')) + '" title="' + esc(t('toggleGoogle')) + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2C12 2 12.5 8.5 15.5 11.5C18.5 14.5 22 15 22 15C22 15 18.5 15.5 15.5 18.5C12.5 21.5 12 22 12 22C12 22 11.5 21.5 8.5 18.5C5.5 15.5 2 15 2 15C2 15 5.5 14.5 8.5 11.5C11.5 8.5 12 2 12 2Z"/></svg></button>'
      + '<button type="button" class="stats-toggle-btn' + (settings.enableTokenUsage ? ' is-active' : '') + '" aria-label="' + esc(t('toggleStats')) + '" title="' + esc(t('toggleStats')) + '"><svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor"><rect x="3" y="11" width="3.8" height="10" rx="1.2"></rect><rect x="10.1" y="6" width="3.8" height="15" rx="1.2"></rect><rect x="17.2" y="2" width="3.8" height="19" rx="1.2"></rect></svg></button>'
      + '<button class="card-refresh state-' + refreshState + '" aria-label="' + esc(refreshState === 'loading' ? t('refreshing') : refreshState === 'error' ? t('refreshFailed') : t('refresh')) + '">' + iconMarkup('refresh') + '</button>'
      + '</div>'
      + '</div>'
      + usageContent
      + voucherSection
      + extensionMarkup
      + '</div>';
  }  function renderPopover() {
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
    const weeklyExhausted = isWeeklyExhausted(s);
    const pColor = getQuotaColor(p?.remainingPercent);
    const sColor = getQuotaColor(s?.remainingPercent);
    const pValue = p ? p.remainingPercent + '%' : '—';
    const sValue = s ? s.remainingPercent + '%' : '—';
    const weeklyResetText = currentMode === 'full' ? weeklyResetSuffix(s) : '';
    const pColorText = getValueColor(p?.remainingPercent, dark);
    const sColorText = getValueColor(s?.remainingPercent, dark);
    const pieLabel = showFiveHours ? '5h' : '7d';
    const pPie = ' style="--remaining:' + (p?.remainingPercent || 0) + '%;color:' + pColor + '"';
    const sPie = ' style="--remaining:' + (s?.remainingPercent || 0) + '%;color:' + sColor + '"';
    const detailsOpen = popoverState !== 'closed';
    let content;
    if (!showFiveHours && currentMode === 'nano') {
      content = '<span class="label">' + pieLabel + '</span><span class="mini-pie"' + sPie + ' aria-hidden="true"></span>';
    } else if (currentMode === 'nano') {
      content = '<span class="label">5h</span><span class="mini-pie"' + pPie + ' aria-hidden="true"></span>';
    } else if (!showFiveHours && currentMode === 'minimal') {
      content = '<span class="label">7d</span><span class="mini-pie"' + sPie + ' aria-hidden="true"></span>';
    } else if (!showFiveHours) {
      content = '<span class="label">7d</span><span class="track"><span class="fill" style="width:' + (s?.remainingPercent || 0) + '%;background:' + sColor + '"></span></span><span class="value" style="color:' + sColorText + '">' + sValue + '</span>';
    } else if (currentMode === 'minimal') {
      content = '<span class="label">5h</span><span class="mini-pie"' + pPie + ' aria-hidden="true"></span><span class="divider"></span><span class="label">7d</span><span class="mini-pie"' + sPie + ' aria-hidden="true"></span>';
    } else if (currentMode === 'compact') {
      content = '<span class="label">5h</span><span class="track"><span class="fill" style="width:' + (p?.remainingPercent || 0) + '%;background:' + pColor + '"></span></span><span class="value" style="color:' + pColorText + '">' + pValue + '</span><span class="divider"></span><span class="label">7d</span><span class="track"><span class="fill" style="width:' + (s?.remainingPercent || 0) + '%;background:' + sColor + '"></span></span><span class="value" style="color:' + sColorText + '">' + sValue + '</span>';
    } else {
      content = '<span class="label">5h</span><span class="track"><span class="fill" style="width:' + (p?.remainingPercent || 0) + '%;background:' + pColor + '"></span></span><span class="value primary-countdown" style="color:' + pColorText + '">' + pValue + (weeklyExhausted ? '' : ' · ' + (p ? formatDuration(p.secondsRemaining, 5 * 3600) : '—')) + '</span><span class="divider"></span><span class="label">7d</span><span class="track"><span class="fill" style="width:' + (s?.remainingPercent || 0) + '%;background:' + sColor + '"></span></span><span class="value" style="color:' + sColorText + '">' + sValue + weeklyResetText + '</span>';
    }
    const style = '<style>*{box-sizing:border-box}:host{display:inline-flex;align-items:center;flex:0 0 auto;min-width:0;margin:0;position:relative;z-index:20;pointer-events:auto!important;-webkit-app-region:no-drag;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;user-select:none}.capsule{height:34px;min-width:0;padding:0 9px;border-radius:999px;display:inline-flex;align-items:center;gap:5px;color:' + (dark ? '#F5F5F7' : '#1D1D1F') + ';background:' + (dark ? 'rgba(40,40,42,.90)' : 'rgba(247,247,248,.94)') + ';border:1px solid ' + (dark ? 'rgba(255,255,255,.13)' : 'rgba(0,0,0,.07)') + ';box-shadow:0 1px 3px rgba(0,0,0,.07);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);-webkit-app-region:no-drag;white-space:nowrap;outline:none}.details-trigger{height:32px;padding:0;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:5px;white-space:nowrap}.details-trigger:focus-visible{outline:2px solid ' + (dark ? 'rgba(10,132,255,.72)' : 'rgba(0,122,255,.55)') + ';outline-offset:2px}.label{flex:none;font-size:12px;font-weight:700;letter-spacing:-.15px}.track{flex:none;width:70px;height:12px;overflow:hidden;border-radius:999px;background:' + CONFIG.colors.track + '}.fill{display:block;height:100%;border-radius:999px;transition:width .3s ease,background .3s ease}.mini-pie{width:16px;height:16px;display:inline-block;border-radius:50%;background:conic-gradient(currentColor 0 var(--remaining), ' + CONFIG.colors.track + ' var(--remaining) 100%);transform:rotate(-90deg)}.value{flex:none;font-size:12px;font-weight:560;letter-spacing:-.1px;font-variant-numeric:tabular-nums}.primary-countdown{min-width:0}.divider{flex:none;width:1px;height:16px;margin:0;background:' + (dark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.12)') + '}@keyframes quota-number-shimmer{0%{opacity:.35;filter:blur(0.4px)}50%{opacity:.85;filter:blur(0px)}100%{opacity:.35;filter:blur(0.4px)}}.capsule.is-refreshing .value{animation:quota-number-shimmer .75s ease-in-out infinite}</style><div class="capsule' + (refreshState === 'loading' ? ' is-refreshing' : '') + '"><button class="details-trigger" type="button" aria-label="' + esc(t('details')) + '" aria-describedby="' + POPOVER_ID + '" aria-expanded="' + detailsOpen + '">' + content + '</button></div>';
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

  function applyExtendedUsagePayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.antigravity && typeof payload.antigravity === 'object') {
      extendedUsageState.antigravity = {
        ...extendedUsageState.antigravity,
        ...payload.antigravity,
      };
    }
    if (payload.tokens && typeof payload.tokens === 'object') {
      const savedRange = extendedUsageState.tokens.selectedRange ||
        (typeof localStorage !== 'undefined' ? localStorage.getItem('codexQuotaHeader.selectedTokenRange') : null) ||
        'today';
      extendedUsageState.tokens = {
        ...extendedUsageState.tokens,
        ...payload.tokens,
        selectedRange: savedRange,
      };
    }
    if (popover && popover.classList.contains('is-visible')) {
      renderPopover();
      positionPopover();
    }
  }

  window.__codexUsageHeaderSetExtendedUsage__ = applyExtendedUsagePayload;
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
    getExtendedState: () => ({ ...extendedUsageState }),
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
