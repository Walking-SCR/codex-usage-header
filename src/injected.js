/**
 * Codex Quota Header 渲染器。
 * 组件通过本机 CDP 挂载，但不会打开本地 HTTP 桥接。
 * 账号读取和调度由后台监控器负责。
 */
(() => {
  'use strict';

  const RUNTIME_VERSION = '3.13.2';
  // 内容标识：launcher 在注入前把本占位符替换为注入脚本的 sha256。
  // 任何代码改动都会改变哈希，从而触发 teardown + 重装，无需手动升版本。
  const CONTENT_HASH = '__INJECTED_CONTENT_HASH__';
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
  if (window.__codexUsageHeaderInstalled__ === RUNTIME_VERSION
      && window.__codexUsageHeaderContentHash__ === CONTENT_HASH) {
    window.__codexUsageHeaderRemount?.();
    return;
  }
  window.__codexUsageHeaderTeardown__?.();
  const ICONS = window.__codexUsageHeaderIcons__ || {};
  const DESIGN_ICONS = window.__codexUsageHeaderDesignIcons__ || {};
  const getAccountHealth = window.__codexUsageHeaderAccountHealth__ || (account => account.health || { state: 'healthy', code: 'ok', zh: '', en: '' });
  const designIcon = (name, className = '') => DESIGN_ICONS[name]
    ? '<img class="' + className + '" src="' + DESIGN_ICONS[name] + '" alt="" aria-hidden="true">'
    : '';
  const docLang = (typeof document !== "undefined" ? document.documentElement?.lang : "") || "";
  const navLang = (typeof navigator !== "undefined" && navigator?.language) || "";
  const defaultSettings = {
    locale: /^zh/i.test(docLang || navLang) ? "zh-CN" : "en-US",
    refreshIntervalSeconds: 30,
    enableGoogleAiPro: false,
    enableTokenUsage: false,
    enableResetCredits: false,
    maskAccountNames: false,
  };

  function readLocalSetting(key, fallback = null) {
    try {
      return window.localStorage.getItem(key) ?? fallback;
    } catch {
      return fallback;
    }
  }

  function safeSettings() {
    try {
      const saved = JSON.parse(readLocalSetting(SETTINGS_KEY, '{}') || '{}');
      return {
        locale: saved.locale === 'zh-CN' || saved.locale === 'en-US' ? saved.locale : defaultSettings.locale,
        refreshIntervalSeconds: Number(saved.refreshIntervalSeconds) === 60 ? 60 : 30,
        enableGoogleAiPro: Boolean(saved.enableGoogleAiPro ?? defaultSettings.enableGoogleAiPro),
        enableTokenUsage: Boolean(saved.enableTokenUsage ?? defaultSettings.enableTokenUsage),
        enableResetCredits: Boolean(saved.enableResetCredits ?? defaultSettings.enableResetCredits),
        maskAccountNames: Boolean(saved.maskAccountNames ?? defaultSettings.maskAccountNames),
      };
    } catch {
      return { ...defaultSettings };
    }
  }

  let settings = safeSettings();
  let claudeGptCollapsed = readLocalSetting(
    'codexQuotaHeader.claudeGptCollapsed',
    readLocalSetting('codexQuotaHeader.googleCollapsed', 'false'),
  ) === 'true';
  let usageState = {
    status: 'loading',
    primary: null,
    secondary: null,
    planType: null,
    showFiveHours: true,
    creditBalance: { value: null, displayValue: '—', unlimited: false },
    resetCredits: null,
    resetCreditDetails: [],
    resetCreditDetailsLoaded: false,
    lastUpdated: null,
    error: null,
  };
  let vouchersLoading = false;
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
      selectedRange: readLocalSetting('codexQuotaHeader.selectedTokenRange') || 'today',
      selectedModel: readLocalSetting('codexQuotaHeader.selectedTokenModel') || 'all',
      ranges: {
        today: null,
        days7: null,
        days30: null,
      },
      coverageStartedAt: null,
        earliestRecordedDate: null,
      error: null,
    },
    failover: {
      available: false,
      mode: 'openai',
      lifecycle_state: 'OPENAI_ACTIVE',
      external_model: null,
      resets_at: null,
      resets_at_iso: null,
    },
  };
  let failoverSwitching = false;
  let lastManualRefresh = 0;
  let tokenModelMenuOpen = false;
  let currentMode = 'full';
  let host = null;
  let popover = null;
  let popoverState = 'closed';
  let suppressHoverUntilLeave = false;
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
  let countdownTimer = null;
  // document/window 级监听器注册表：teardown 时统一移除，防止重复注入叠加。
  const trackedListeners = [];
  function on(target, type, listener, options) {
    target.addEventListener(type, listener, options);
    trackedListeners.push([target, type, listener, options]);
  }
  function offAllTrackedListeners() {
    for (const [target, type, listener, options] of trackedListeners.splice(0)) {
      try { target.removeEventListener(type, listener, options); } catch { /* ignore */ }
    }
  }
  let commandCounter = 0;
  let hitAreaParent = null;
  let hitAreaParentStyle = null;
  let lastPointerX = null;
  let lastPointerY = null;

  const I18N = {
    'zh-CN': {
      title: '用量额度',
      subtitle: '合理AI协作，人员负责思考，AI负责执行',
      usageTitle: '使用额度',
      details: 'Codex 用量额度详情',
      toggleDetails: '展开或收起用量详情',
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
      usageErrorTimeout: 'Codex 额度读取超时，稍后将自动重试',
      usageErrorAuth: '无法读取 Codex 额度，请确认账号已登录',
      usageErrorProtocol: 'Codex 额度接口版本不兼容，兼容模式仍读取失败',
      usageErrorServer: 'Codex App Server 暂时不可用，正在自动重连',
      usageErrorUnknown: 'Codex 额度读取失败，稍后将自动重试',
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
      model: '模型',
      allModels: '汇总',
      familySubtotal: '小计',
      shareOfTotal: '占总计',
      shareOfFamily: '占分类',
      otherModelsTotal: '其他模型合计',
      modelFamilies: '类',
      noModelUsage: '当前周期暂无型号用量',
      unknownModel: '未知型号',
      toggleGoogle: 'Google AI Pro (开启/关闭)',
      toggleStats: 'Token使用量 (开启/关闭)',
      toggleVouchers: '额度重置券 (开启/关闭)',
      toggleAccountMask: '显示/隐藏账号名称',
      toggleClaudeRows: '显示/隐藏 Claude 用量行',
      loadingVouchers: '正在加载重置券…',
      noGoogleAccounts: '未检测到本地 Google AI Pro 账号配置',
      noResetCoupons: '暂无可用重置券',
      today: '今天',
      days7: '近7日',
      days30: '近30日',
      allTime: '累计',
      singleModelDedicated: '独占承载',
      familyUsage: '用量',
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
      toggleDetails: 'Toggle usage details',
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
      usageErrorTimeout: 'Codex quota request timed out. It will retry automatically.',
      usageErrorAuth: 'Codex quota unavailable. Confirm the account is signed in.',
      usageErrorProtocol: 'Codex quota protocol mismatch. Compatibility fallback also failed.',
      usageErrorServer: 'Codex App Server is temporarily unavailable. Reconnecting automatically.',
      usageErrorUnknown: 'Codex quota request failed. It will retry automatically.',
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
      model: 'Model',
      allModels: 'Summary',
      familySubtotal: 'Subtotal',
      shareOfTotal: 'of total',
      shareOfFamily: 'of family',
      otherModelsTotal: 'Other models',
      modelFamilies: 'families',
      noModelUsage: 'No model usage in this period',
      unknownModel: 'Unknown model',
      toggleGoogle: 'Google AI Pro (Toggle on/off)',
      toggleStats: 'Token usage (Toggle on/off)',
      toggleVouchers: 'Reset credits (Toggle on/off)',
      toggleAccountMask: 'Toggle account name mask',
      toggleClaudeRows: 'Show/hide Claude usage rows',
      loadingVouchers: 'Loading reset credits…',
      noGoogleAccounts: 'No local Google AI Pro accounts found',
      noResetCoupons: 'No available reset coupons',
      today: 'Today',
      days7: 'Last 7 days',
      days30: 'Last 30 days',
      allTime: 'All time',
      singleModelDedicated: 'Dedicated',
      familyUsage: 'Usage',
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
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)); } catch { /* 尽力保存，失败时忽略 */ }
  }

  function persistTokenModel(model) {
    extendedUsageState.tokens.selectedModel = model;
    try { localStorage.setItem('codexQuotaHeader.selectedTokenModel', model); } catch { /* 忽略保存异常 */ }
  }

  function hasTokenModelUsage(rangeData, model) {
    return Boolean(rangeData?.items?.some(item => item.key === model && item.tokens > 0));
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
      return m > 0 ? (h + 'h' + m + 'min') : (h + 'h');
    }
    const displayMinutes = Math.max(1, m);
    return displayMinutes + 'min';
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
    // 周窗口是账号级别的总上限。一旦周窗口耗尽，
    // 即使短窗口的原始数值仍然较高，也不能继续使用。
    const effectivePrimary = primary && secondary.remainingPercent === 0
      ? { ...primary, usedPercent: 100, remainingPercent: 0 }
      : primary;
    const credits = root.credits || raw.credits || {};
    const balance = credits.balance ?? credits.balanceText ?? raw.balance ?? null;
    const resetCredits = raw.rateLimitResetCredits;
    const availableCount = typeof resetCredits === 'object'
      ? Number(resetCredits.availableCount ?? resetCredits.available_count)
      : Number(resetCredits ?? raw.rate_limit_reset_credits);
    const hasDetailsArray = typeof resetCredits === 'object' && Array.isArray(resetCredits.credits);
    const details = hasDetailsArray
      ? resetCredits.credits.map(item => ({
        id: item.id || null,
        status: item.status || null,
        title: item.title || null,
        description: item.description || null,
        expiresAt: Number(item.expiresAt || 0),
      }))
      : [];
    if (hasDetailsArray) vouchersLoading = false;
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
      resetCreditDetailsLoaded: hasDetailsArray,
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

  function applyUsageError(errorInfo = {}, metadata = {}) {
    const kind = typeof errorInfo === 'string' ? errorInfo : errorInfo?.kind;
    const errorKey = ({
      timeout: 'usageErrorTimeout',
      auth: 'usageErrorAuth',
      protocol: 'usageErrorProtocol',
      server: 'usageErrorServer',
      unknown: 'usageErrorUnknown',
    })[kind] || 'usageErrorUnknown';
    const message = t(errorKey);

    if (usageState.status === 'ready') {
      // 已有有效快照：保留旧数值，只提示当前刷新失败，避免闪空。
      usageState = { ...usageState, error: message };
    } else {
      // 首次加载失败：必须结束 loading，不能永久显示“正在同步”。
      usageState = {
        ...usageState,
        status: 'error',
        error: message,
        lastUpdated: Number(metadata.fetchedAt) || Date.now(),
      };
      vouchersLoading = false;
    }

    renderAll();

    if (refreshState === 'loading' && metadata.requestId === refreshRequestId) {
      settleRefresh('error', message);
    }
    return true;
  }

  function saveInterval(value) {
    const seconds = Number(value) === 60 ? 60 : 30;
    settings.refreshIntervalSeconds = seconds;
    persistSettings();
    emitCommand('settings', { refreshIntervalSeconds: seconds });
    if (popover) renderPopover();
  }

  function toggleUsageModule(module) {
    const config = {
      reset: { key: 'enableResetCredits', command: 'enableResetCredits' },
      google: { key: 'enableGoogleAiPro', command: 'enableGoogleAiPro' },
      tokens: { key: 'enableTokenUsage', command: 'enableTokenUsage' },
    }[module];
    if (!config) return;
    settings[config.key] = !settings[config.key];
    if (module === 'reset' && settings[config.key] && !usageState.resetCreditDetailsLoaded) vouchersLoading = true;
    persistSettings();
    emitCommand('settings', { [config.command]: settings[config.key] });
    if (settings[config.key]) emitCommand('refresh', {}, false);
    renderAll();
    positionPopover();
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
    // P2：每秒只更新倒计时文本节点，避免全量重写胶囊 DOM。
    // 胶囊上唯一随秒变化的是 full 模式的 .primary-countdown（"41% · 2h5min"），
    // 7d 的 weeklyResetSuffix 显示的是绝对日期，不需要每秒刷新。
    const countdownEl = host.shadowRoot?.querySelector('.primary-countdown');
    if (countdownEl && usageState.primary) {
      // 与 renderHost() 的 full 模式文案逐字一致，避免跳变
      const p = usageState.primary;
      countdownEl.textContent = p.remainingPercent + '%'
        + (isWeeklyExhausted(usageState.secondary) ? '' : ' · ' + formatDuration(p.secondsRemaining, 5 * 3600));
    }
    if (popover?.classList.contains('is-visible')) updatePopoverCountdowns();
  }

  function updatePopoverCountdowns() {
    if (!popover || !popover.classList.contains('is-visible')) return;
    const isZh = settings.locale === 'zh-CN';
    const p = usageState.primary;
    const s = usageState.secondary;
    const weeklyExhausted = isWeeklyExhausted(s);

    const pRemainEl = popover.querySelector('.popover-primary-value .info-remain');
    if (pRemainEl && p) {
      pRemainEl.textContent = weeklyExhausted ? '' : (t('untilReset') + ' ' + formatDuration(p.secondsRemaining, 5 * 3600));
    }
    const sRemainEl = popover.querySelector('.popover-secondary-value .info-remain');
    if (sRemainEl && s) {
      sRemainEl.textContent = t('untilReset') + ' ' + formatDuration(s.secondsRemaining, 7 * 86400);
    }

    const anti = extendedUsageState.antigravity;
    if (settings.enableGoogleAiPro && anti?.accounts?.length) {
      const accounts = anti.accounts;
      const manualAccount = anti.userSelectedAccount ? accounts.find(a => a.email === anti.userSelectedAccount) : null;
      const isManualValid = Boolean(manualAccount);
      const activeAccount = (isManualValid ? manualAccount : (accounts.find(a => a.email === anti.selectedAccount) || accounts.find(isAccountAvailable))) || accounts[0] || anti;
      const rows = activeAccount.rows || [];

      const rowEls = popover.querySelectorAll('.quota-extension-row');
      rowEls.forEach((rowEl, idx) => {
        const rowData = rows[idx];
        if (!rowData) return;
        const valEl = rowEl.querySelector('.quota-extension-value');
        if (valEl) {
          valEl.textContent = rowData.unavailable ? t('noData') : formatDynamicCountdown(rowData, isZh);
        }
      });
    }
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
    host?.shadowRoot?.querySelector('.capsule-toggle')?.setAttribute('aria-expanded', String(expanded));
    host?.shadowRoot?.querySelector('.capsule-arrow')?.classList.toggle('is-expanded', expanded);
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
    popover.addEventListener('pointerover', event => {
      const btn = event.target.closest('.quota-rebalance-pill-btn');
      const tooltip = popover.querySelector('.quota-rebalance-tooltip');
      if (btn && tooltip) {
        tooltip.classList.add('is-active');
      }
    });
    popover.addEventListener('pointerout', event => {
      const btn = event.target.closest('.quota-rebalance-pill-btn');
      const tooltip = popover.querySelector('.quota-rebalance-tooltip');
      if (btn && tooltip && !btn.contains(event.relatedTarget)) {
        tooltip.classList.remove('is-active');
      }
    });
    popover.addEventListener('click', event => {
      const path = event.composedPath();
      const refresh = path.find(node => node?.classList?.contains('card-refresh'));
      const language = path.find(node => node?.classList?.contains('language-toggle'));
      const rangeTab = path.find(node => node?.classList?.contains('quota-extension-range-tab'));
      const modelButton = path.find(node => node?.classList?.contains('quota-extension-model-button'));
      const modelOption = path.find(node => node?.classList?.contains('quota-extension-model-option'));
      const accountTab = path.find(node => node?.classList?.contains('quota-extension-account-tab'));
      const rebalanceBtn = path.find(node => node?.classList?.contains('quota-rebalance-pill-btn') || node?.closest?.('.quota-rebalance-pill-btn'));
      const googleToggle = path.find(node => node?.classList?.contains('quota-extension-toggle'));
      const foldToggle = path.find(node => node?.classList?.contains('token-folded-toggle'));
      if (foldToggle) {
        extendedUsageState.tokens.otherModelsExpanded = !extendedUsageState.tokens.otherModelsExpanded;
        renderPopover();
        positionPopover();
        return;
      }
      const failoverBtn = path.find(node => node?.classList?.contains('failover-toggle-btn') || node?.closest?.('.failover-toggle-btn'));
      if (failoverBtn) {
        if (failoverSwitching) return;
        failoverSwitching = true;
        emitCommand('toggleFailoverMode', {});
        renderPopover();
        positionPopover();
        return;
      }
      const moduleToggle = path.find(node => node?.classList?.contains('header-module-toggle'));
      if (tokenModelMenuOpen && !modelButton && !modelOption) {
        tokenModelMenuOpen = false;
        renderPopover();
        positionPopover();
      }
      if (moduleToggle) toggleUsageModule(moduleToggle.dataset.module);
      else if (rebalanceBtn) {
        rebalanceBtn.classList.add('is-loading');
        emitCommand('rebalance', {}, true);
        setTimeout(() => {
          rebalanceBtn.classList.remove('is-loading');
          requestUsage({ manual: true });
        }, 1200);
      }
      else if (refresh && refreshState !== 'loading') requestUsage({ manual: true });
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
      else if (path.find(node => node?.classList?.contains('account-mask-toggle-btn'))) {
        settings.maskAccountNames = !settings.maskAccountNames;
        persistSettings();
        renderPopover();
        positionPopover();
      }
      else if (googleToggle) {
        claudeGptCollapsed = !claudeGptCollapsed;
        try { localStorage.setItem('codexQuotaHeader.claudeGptCollapsed', String(claudeGptCollapsed)); } catch { /* 忽略保存异常 */ }
        renderPopover();
        positionPopover();
      } else if (rangeTab) {
        const range = rangeTab.dataset.range;
        if (range && ['today', 'days7', 'days30', 'allTime'].includes(range)) {
          extendedUsageState.tokens.selectedRange = range;
          extendedUsageState.tokens.otherModelsExpanded = false;
          try { localStorage.setItem('codexQuotaHeader.selectedTokenRange', range); } catch { /* 忽略保存异常 */ }
          const selectedModel = extendedUsageState.tokens.selectedModel || 'all';
          if (selectedModel !== 'all'
            && !hasTokenModelUsage(extendedUsageState.tokens.ranges?.[range], selectedModel)) {
            persistTokenModel('all');
          }
          renderPopover();
          positionPopover();
        }
      } else if (modelButton) {
        tokenModelMenuOpen = !tokenModelMenuOpen;
        renderPopover();
        positionPopover();
        if (tokenModelMenuOpen) popover?.querySelector('.quota-extension-model-option[aria-selected="true"]')?.focus();
        else popover?.querySelector('.quota-extension-model-button')?.focus();
      } else if (modelOption) {
        const model = modelOption.dataset.model;
        if (model) {
          persistTokenModel(model);
        extendedUsageState.tokens.otherModelsExpanded = false;
          tokenModelMenuOpen = false;
          renderPopover();
          positionPopover();
          popover?.querySelector('.quota-extension-model-button')?.focus();
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
    const trigger = host.shadowRoot?.querySelector('.capsule');
    const rect = trigger?.getBoundingClientRect();
    const shell = popover.querySelector('.popover-shell');
    if (!rect || !shell) return;
    // 下拉层沿用旧版 590px 宽度，参考图只用于内容比例与视觉语言。
    const width = Math.min(590, Math.max(280, window.innerWidth - CONFIG.viewportInset * 2));
    popover.style.width = width + 'px';
    popover.style.maxWidth = 'calc(100vw - ' + (CONFIG.viewportInset * 2) + 'px)';
    const left = Math.max(CONFIG.viewportInset, Math.min(window.innerWidth - width - CONFIG.viewportInset, rect.right - width));
    const inset = CONFIG.viewportInset;
    const below = rect.bottom + CONFIG.popoverGap;
    const maxHeight = Math.max(140, window.innerHeight - 40);
    shell.style.maxHeight = maxHeight + 'px';
    const naturalHeight = shell.scrollHeight;
    const belowSpace = Math.max(0, window.innerHeight - below - inset);
    const aboveSpace = Math.max(0, rect.top - CONFIG.popoverGap - inset);
    const side = belowSpace >= Math.min(naturalHeight, 200) || belowSpace >= aboveSpace ? 'bottom' : 'top';
    const availableSpace = side === 'bottom' ? belowSpace : aboveSpace;
    const boundedHeight = Math.max(120, Math.min(maxHeight, availableSpace));
    shell.style.maxHeight = boundedHeight + 'px';
    const height = Math.min(shell.scrollHeight, boundedHeight);
    const top = side === 'bottom'
      ? Math.max(inset, Math.min(below, window.innerHeight - height - inset))
      : Math.max(inset, rect.top - CONFIG.popoverGap - height);
    popover.dataset.side = side;
    popover.style.left = left + 'px';
    popover.style.top = top + 'px';
  }

  function showPopover({ immediate = false, pinned = false } = {}) {
    if (popoverShowTimer) clearTimeout(popoverShowTimer);
    if (popoverHideTimer) clearTimeout(popoverHideTimer);
    // 已点击固定展开时，后续悬停不能把它降级为移出即关闭的状态。
    if (!pinned && popoverState === 'pinned') return;
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
    tokenModelMenuOpen = false;
    popover?.classList.remove('is-visible');
    popover?.setAttribute('aria-hidden', 'true');
    updateExpanded(false);
    renderHost();
  }

  function togglePopoverFromCapsule() {
    if (popoverState !== 'closed') {
      suppressHoverUntilLeave = true;
      hidePopover(true);
    } else {
      suppressHoverUntilLeave = false;
      showPopover({ immediate: true, pinned: true });
    }
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

  function maskAccountName(name) {
    if (!name || typeof name !== 'string') return '';
    const len = name.length;
    if (len <= 5) return '*****';
    const maskLen = 5;
    const start = Math.floor((len - maskLen) / 2);
    const end = start + maskLen;
    return name.slice(0, start) + '*****' + name.slice(end);
  }

  function tokenFamilyLabel(item, isZh) {
    if (!item) return t('allModels');
    if (item.key === 'overflow') {
      return isZh
        ? t('otherModelsTotal') + '（' + item.modelCount + t('modelFamilies') + '）'
        : t('otherModelsTotal') + ' (' + item.modelCount + ' ' + t('modelFamilies') + ')';
    }
    if (item.key === 'other') return t('other');
    return item.label || item.key;
  }

  function tokenFamilyColor(key) {
    return ({
      gpt: '#1688FF', gemini: '#7A5AF8', claude: '#4AA9FF', glm: '#2979D2',
      deepseek: '#8D73F7', minimax: '#5C9FED', other: '#9EACC0', overflow: '#9EACC0',
    })[key] || '#9EACC0';
  }

  function percentWidth(value) {
    const number = Number.parseFloat(value);
    return Number.isFinite(number) ? Math.max(0, Math.min(100, number)) : 0;
  }

  function formatStartDate(dateStr, isZh) {
    if (!dateStr) return '';
    const parts = String(dateStr).split('-');
    if (parts.length >= 3) {
      const month = Number(parts[1]);
      const day = Number(parts[2]);
      return isZh ? (month + '月' + day + '日') : (month + '/' + day);
    }
    return dateStr;
  }

  function getModelProfile(modelId, isZh) {
    const id = String(modelId || '').toLowerCase();
    if (id.includes('claude')) return isZh ? '长上下文深度推理' : 'Deep Reasoning';
    if (id.includes('luna')) return isZh ? '极速经济型推理' : 'Fast & Affordable';
    if (id.includes('astra') || id.includes('ultra') || id.includes('o1') || id.includes('o3')) return isZh ? '复杂高智力任务' : 'Complex Reasoning';
    if (id.includes('sol')) return isZh ? '主力编码推理' : 'Primary Coding';
    if (id.includes('flash') || id.includes('gemini')) return isZh ? '多模态闪电响应' : 'Flash Multimodal';
    if (id.includes('deepseek')) return isZh ? '代码与逻辑专长' : 'Code Specialist';
    return isZh ? '通用算力模型' : 'General Model';
  }

  function tokenDonutStops(rangeData) {
    const selectedModel = extendedUsageState.tokens?.selectedModel || "all";
    const active = (rangeData?.items || []).filter(item => Number(item.tokens) > 0)
      .sort((a, b) => b.tokens - a.tokens);
    const top = active.slice(0, 5);
    const other = active.slice(5).reduce((sum, item) => sum + Number(item.tokens), 0);
    if (other > 0) top.push({ key: 'overflow', tokens: other });
    const total = Math.max(Number(rangeData?.total) || 0, active.reduce((sum, item) => sum + Number(item.tokens), 0));
    if (!total) return '#E5E9F0';
    let from = 0;
    const stops = top.map(item => {
      const to = Math.min(100, from + Number(item.tokens) / total * 100);
      let color = tokenFamilyColor(item.key);
      if (selectedModel && selectedModel !== 'all') {
        color = item.key === selectedModel ? tokenFamilyColor(item.key) : '#E5E9F0';
      }
      const segment = color + ' ' + from.toFixed(2) + '% ' + to.toFixed(2) + '%';
      from = to;
      return segment;
    });
    if (from < 100) stops.push('#E5E9F0 ' + from.toFixed(2) + '% 100%');
    return 'conic-gradient(' + stops.join(',') + ')';
  }

  function renderTokenFamilyRow(item, isZh) {
    const label = tokenFamilyLabel(item, isZh);
    return '<div class="token-model-row">'
      + '<span class="token-model-label" title="' + esc(label) + '"><span class="token-model-dot" style="background:' + tokenFamilyColor(item.key) + '"></span>' + esc(label) + '</span>'
      + '<span class="token-model-bar"><span class="token-model-bar-fill" style="width:' + percentWidth(item.percent) + '%;background:' + tokenFamilyColor(item.key) + '"></span></span>'
      + '<span class="token-model-pct">' + esc(item.percent || '—') + '</span>'
      + '<span class="token-model-amount">' + esc(formatExtendedTokenCount(item.tokens, isZh)) + '</span>'
      + '</div>';
  }

  function renderTokenModelRow(model, familyKey, isZh) {
    const modelName = model.id === 'unknown' ? t('unknownModel') : model.id;
    return '<div class="token-model-row is-model-detail">'
      + '<span class="token-model-label" title="' + esc(modelName) + '"><span class="token-model-dot" style="background:' + tokenFamilyColor(familyKey) + '"></span>' + esc(modelName) + '</span>'
      + '<span class="token-model-bar"><span class="token-model-bar-fill" style="width:' + percentWidth(model.percent) + '%;background:' + tokenFamilyColor(familyKey) + '"></span></span>'
      + '<span class="token-model-pct">' + esc(model.percent || '—') + '</span>'
      + '<span class="token-model-amount">' + esc(formatExtendedTokenCount(model.tokens, isZh)) + '</span>'
      + '</div>';
  }

  function renderFailoverToggleButton(dark, isZh) {
    const failover = extendedUsageState.failover || {};
    const mode = failover.mode || 'openai';
    const isExternal = mode === 'external';
    const p = usageState.primary;
    const pRemain = p?.remainingPercent;
    const pUsed = p?.usedPercent;
    const pExhausted = (pRemain === 0 || pUsed >= 100);
    const pCountdown = formatDuration(p?.secondsRemaining, 5 * 3600);

    let modeLabel = isZh ? '当前模式：官方原生' : 'Current: Native OpenAI';
    let desc = '';
    let action = '';

    if (failoverSwitching) {
      modeLabel = isZh ? '正在切换模式' : 'Switching Mode';
      desc = isZh ? '正在切换模型路由并平滑重启服务，请稍候…' : 'Switching model routing & reloading service…';
      action = isZh ? '命令执行中…' : 'Executing command…';
    } else if (isExternal) {
      modeLabel = isZh ? '当前模式：自定义模型' : 'Current: External Model';
      if (!pExhausted && pRemain > 0) {
        desc = isZh ? '官方额度已重置满格！' : 'OpenAI quota has fully reset!';
        action = isZh ? '👉 点击切回「官方原生模式」，用回官方 GPT' : '👉 Click to switch back to Native OpenAI mode';
      } else {
        desc = isZh
          ? ('当前免鉴权使用第三方模型。官方额度还需 ' + pCountdown + ' 重置')
          : ('Using third-party models. OpenAI quota resets in ' + pCountdown);
        action = isZh ? '点击可强制切回官方原生模式' : 'Click to force switch back to Native OpenAI mode';
      }
    } else {
      modeLabel = isZh ? '当前模式：官方原生' : 'Current: Native OpenAI';
      if (pExhausted) {
        desc = isZh
          ? ('官方用量已耗尽（将在 ' + pCountdown + ' 后重置）')
          : ('5-hour quota exhausted (resets in ' + pCountdown + ')');
        action = isZh
          ? '👉 点击切换至「自定义模型模式」，继续可用 Gemini / Claude'
          : '👉 Click to switch to External Model mode to continue';
      } else {
        desc = isZh
          ? ('官方 GPT 链路运行正常（剩余 ' + (pRemain ?? '—') + '%）')
          : ('OpenAI pipeline running smoothly (' + (pRemain ?? '—') + '% remaining)');
        action = isZh ? '点击可随时切换至自定义接入模型' : 'Click to switch to External Model mode';
      }
    }

    const swapSvg = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" class="failover-swap-icon"><path d="M4 8h12l-4-4m4 4l-4 4"></path><path d="M20 16H8l4-4m-4 4l4 4"></path></svg>';

    return '<div class="failover-toggle-wrap">'
      + '<button type="button" class="quota-icon-btn failover-toggle-btn ' + (isExternal ? 'is-external' : 'is-openai') + (failoverSwitching ? ' is-loading' : '') + '" aria-label="' + esc(modeLabel) + '" title="' + esc(modeLabel) + '">'
      + swapSvg
      + '</button>'
      + '<div class="failover-tooltip">'
      + '<div class="failover-tooltip-header">' + esc(modeLabel) + '</div>'
      + '<div class="failover-tooltip-desc">' + esc(desc) + '</div>'
      + '<div class="failover-tooltip-action">' + esc(action) + '</div>'
      + '</div>'
      + '</div>';
  }

  function renderExtendedUsage(dark) {
    const isZh = settings.locale === 'zh-CN';
    const anti = extendedUsageState.antigravity || {};
    const tok = extendedUsageState.tokens || {};

    let tokenSection = '';
    let modelSelectorMarkup = '';
    if (settings.enableTokenUsage) {
      const selectedRange = tok.selectedRange || 'today';
      const rangeTabs = '<div class="quota-extension-range-tabs">'
        + '<button type="button" class="quota-extension-range-tab ' + (selectedRange === 'today' ? 'is-active' : '') + '" data-range="today">' + esc(t('today')) + '</button>'
        + '<button type="button" class="quota-extension-range-tab ' + (selectedRange === 'days7' ? 'is-active' : '') + '" data-range="days7">' + esc(t('days7')) + '</button>'
        + '<button type="button" class="quota-extension-range-tab ' + (selectedRange === 'days30' ? 'is-active' : '') + '" data-range="days30">' + esc(t('days30')) + '</button>'
        + '<button type="button" class="quota-extension-range-tab ' + (selectedRange === 'allTime' ? 'is-active' : '') + '" data-range="allTime">' + esc(t('allTime')) + '</button>'
        + '</div>';

      const barChartEmptySvg = designIcon('tokenChart', 'section-icon');

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
          const selectedModel = tok.selectedModel || 'all';
          const selectedFamily = rawItems.find(item => item.key === selectedModel);
          const selectedLabel = selectedModel === 'all' ? t('allModels') : tokenFamilyLabel(selectedFamily, isZh);
          const modelOptions = rawItems.filter(item => item.key === 'gpt' || item.key === 'gemini' || item.tokens > 0);
          const optionItems = [{ key: 'all', label: t('allModels'), tokens: rangeData.total }, ...modelOptions];
          const modelMenu = tokenModelMenuOpen
            ? '<div class="quota-extension-model-menu" role="listbox" aria-label="' + esc(t('model')) + '">'
              + optionItems.map(item => {
                const label = item.key === 'all' ? t('allModels') : tokenFamilyLabel(item, isZh);
                const amount = item.key === 'all' ? '' : formatExtendedTokenCount(item.tokens, isZh);
                const active = item.key === selectedModel;
                return '<button type="button" role="option" aria-selected="' + active + '" class="quota-extension-model-option' + (active ? ' is-active' : '') + '" data-model="' + esc(item.key) + '">'
                  + '<span>' + esc(label) + '</span>'
                  + (amount ? '<span class="quota-extension-model-option-amount">' + esc(amount) + '</span>' : '')
                  + '</button>';
              }).join('')
              + '</div>'
            : '';
          modelSelectorMarkup = '<div class="token-model-selector-row">'
            + '<button type="button" class="quota-extension-model-button" aria-haspopup="listbox" aria-expanded="' + tokenModelMenuOpen + '">'
            + esc(selectedLabel)
            + designIcon('chevronDown', 'quota-extension-model-chevron-icon')
            + '</button>' + modelMenu + '</div>';

          let itemRows = '';
          if (selectedModel === 'all') {
            const summaryItems = rangeData.summaryItems || rawItems;
            itemRows = summaryItems.map(item => renderTokenFamilyRow(item, isZh)).join('');
          } else if (selectedFamily?.models?.length) {
            const models = selectedFamily.models;
            const familyColor = tokenFamilyColor(selectedFamily.key);
            if (models.length === 1) {
              const m = models[0];
              const profile = getModelProfile(m.id, isZh);
              itemRows = '<div class="single-model-hero-card is-model-detail">'
                + '<div class="hero-top-row">'
                + '<div class="hero-name"><span class="hero-dot" style="background:' + familyColor + '"></span>' + esc(m.id) + '</div>'
                + '<div class="hero-badge" style="background:' + familyColor + '18;color:' + familyColor + '">✦ ' + esc(t('singleModelDedicated')) + ' · 100%</div>'
                + '</div>'
                + '<div class="hero-progress-bar"><div class="hero-progress-fill" style="background:' + familyColor + '"></div></div>'
                + '<div class="hero-stats-deck">'
                + '<div class="hero-stat-box"><span class="hero-stat-label">' + esc(isZh ? '分类消耗' : 'Family Usage') + '</span><span class="hero-stat-val" style="color:' + familyColor + '">' + esc(formatExtendedTokenCount(m.tokens, isZh)) + ' Token</span></div>'
                + '<div class="hero-stat-box"><span class="hero-stat-label">' + esc(t('shareOfTotal')) + '</span><span class="hero-stat-val">' + esc(selectedFamily.percent || '100%') + '</span></div>'
                + '<div class="hero-stat-box"><span class="hero-stat-label">' + esc(isZh ? '承载属性' : 'Profile') + '</span><span class="hero-stat-val hero-stat-desc">' + esc(profile) + '</span></div>'
                + '</div>'
                + '</div>';
            } else if (models.length === 2) {
              itemRows = '<div class="dual-cards-stack is-model-detail">'
                + models.map(m => {
                  return '<div class="dual-subcard">'
                    + '<div class="dual-subcard-header">'
                    + '<div class="dual-subcard-title"><span class="hero-dot" style="background:' + familyColor + '"></span>' + esc(m.id) + '</div>'
                    + '<div class="dual-subcard-num">' + esc(formatExtendedTokenCount(m.tokens, isZh)) + '</div>'
                    + '</div>'
                    + '<div class="dual-subcard-body">'
                    + '<div class="dual-subcard-bar"><div style="height:100%;width:' + percentWidth(m.percent) + '%;background:' + familyColor + ';border-radius:3.5px;"></div></div>'
                    + '<div class="dual-subcard-pct">' + esc(m.percent || '—') + '</div>'
                    + '</div>'
                    + '</div>';
                }).join('')
                + '</div>';
            } else if (models.length > 4) {
              const topModels = models.slice(0, 3);
              const restModels = models.slice(3);
              const restTokens = restModels.reduce((sum, item) => sum + (Number(item.tokens) || 0), 0);
              const restPctVal = selectedFamily.tokens > 0 ? (restTokens / selectedFamily.tokens * 100).toFixed(1) : '0.0';
              const restPercent = restPctVal + '%';
              const isExpanded = Boolean(extendedUsageState.tokens.otherModelsExpanded);

              if (!isExpanded) {
                const otherLabel = isZh ? ('其他 (' + restModels.length + '个模型) ▾') : ('Other (' + restModels.length + ' models) ▾');
                const otherRow = '<div class="token-model-row is-model-detail is-folded-other token-folded-toggle" role="button" tabindex="0" title="' + esc(isZh ? '点击展开长尾模型明细' : 'Click to expand detail') + '">'
                  + '<span class="token-model-label" title="' + esc(otherLabel) + '"><span class="token-model-dot" style="background:#94a3b8"></span>' + esc(otherLabel) + '</span>'
                  + '<span class="token-model-bar"><span class="token-model-bar-fill" style="width:' + percentWidth(restPercent) + '%;background:#94a3b8"></span></span>'
                  + '<span class="token-model-pct">' + esc(restPercent) + '</span>'
                  + '<span class="token-model-amount">' + esc(formatExtendedTokenCount(restTokens, isZh)) + '</span>'
                  + '</div>';
                itemRows = topModels.map(model => renderTokenModelRow(model, selectedFamily.key, isZh)).join('') + otherRow;
              } else {
                const topRows = topModels.map(model => renderTokenModelRow(model, selectedFamily.key, isZh)).join('');
                const restRows = restModels.map(model => renderTokenModelRow(model, selectedFamily.key, isZh)).join('');
                const collapseLabel = isZh ? ('收起长尾模型 (' + restModels.length + '个) ▴') : ('Collapse (' + restModels.length + ' models) ▴');
                const collapseRow = '<div class="token-collapse-wrap">'
                  + '<div class="token-collapse-btn token-folded-toggle" role="button" tabindex="0" title="' + esc(isZh ? '点击收起' : 'Click to collapse') + '">'
                  + '<span class="token-model-dot" style="background:var(--quota-blue)"></span>'
                  + '<span>' + esc(collapseLabel) + '</span>'
                  + '</div>'
                  + '</div>';
                itemRows = topRows + restRows + collapseRow;
              }
            } else {
              itemRows = selectedFamily.models.map(model => renderTokenModelRow(model, selectedFamily.key, isZh)).join('');
            }
          } else {
            itemRows = renderEmptyState(barChartEmptySvg, t('noModelUsage'));
          }

          let donutCenterHtml = '';
          if (selectedModel === 'all') {
            donutCenterHtml = '<span class="token-summary-number">' + esc(totalFormatted) + '</span><span class="token-summary-unit">Token</span>';
          } else if (selectedFamily) {
            donutCenterHtml = '<span class="token-summary-number">' + esc(formatExtendedTokenCount(selectedFamily.tokens, isZh)) + '</span>'
              + '<span class="token-summary-unit">' + esc(tokenFamilyLabel(selectedFamily, isZh)) + ' ' + esc(t('familyUsage')) + '</span>'
              + '<span class="token-donut-badge">' + esc(t('shareOfTotal')) + ' ' + esc(selectedFamily.percent) + '</span>';
          } else {
            donutCenterHtml = '<span class="token-summary-number">' + esc(totalFormatted) + '</span><span class="token-summary-unit">Token</span>';
          }

          const globalLabel = selectedRange === 'allTime'
            ? (isZh ? '累计总计' : 'All-time')
            : (isZh ? '全局总计' : 'Total');

          const globalStatTopHtml = selectedModel !== 'all'
            ? '<div class="token-global-stat">'
              + '<span class="token-global-stat-label">' + esc(globalLabel) + '</span>'
              + '<span class="token-global-stat-value">' + esc(totalFormatted) + '</span>'
              + '</div>'
            : '';

          tokenContent = '<div class="quota-extension-token-table">'
            + '<div class="token-summary-col">'
            + globalStatTopHtml
            + '<div class="token-donut" style="--donut-stops:' + tokenDonutStops(rangeData) + '">'
            + '<div class="token-donut-center">' + donutCenterHtml + '</div>'
            + '</div>'
            + '</div>'
            + '<div class="token-models-col">' + itemRows + '</div>'
            + '</div>';
        }
      }

      const chartSvg = designIcon('tokenChart', 'section-icon');

      tokenSection = '<div class="card-section quota-extension-section" data-section="tokens">'
        + '<div class="quota-extension-header has-rows">'
        + '<div class="quota-extension-title-wrap">'
        + chartSvg
        + '<span class="quota-extension-title">' + esc(t('tokenUsage')) + '</span>'
        + '</div>'
        + '<div class="quota-token-controls">' + rangeTabs + modelSelectorMarkup + '</div>'
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
    const isManualValid = Boolean(manualAccount);
    const activeAccount = (isManualValid ? manualAccount : (accounts.find(a => a.email === anti.selectedAccount) || accounts.find(isAccountAvailable))) || accounts[0] || anti;
    const activeRows = activeAccount.rows || anti.rows || [];
    const enableDynamic = Boolean(anti.enableDynamicPriority && anti.poolStatus?.available);
    const poolStatus = anti.poolStatus || {};
    const accountHealth = acc => getAccountHealth(acc, poolStatus.accountMap?.[String(acc.email || '').toLowerCase()]);

    let accountTabsHtml = '';
    if (accounts.length > 0) {
      let fallbackIndex = 1;
      accountTabsHtml = '<div class="quota-extension-account-tabs">'
        + accounts.map((acc, idx) => {
          const isSelected = (acc.email === activeAccount.email);
          const rawLabel = acc.label || (acc.email ? acc.email.split('@')[0] : '') || (isZh ? ('账号' + (idx + 1)) : ('Account ' + (idx + 1)));
          const displayName = settings.maskAccountNames ? maskAccountName(rawLabel) : rawLabel;
          let tabLabel = esc(displayName);
          let statusForAccess = '';
          const health = accountHealth(acc);
          if (enableDynamic) {
            const norm = (acc.email || '').toLowerCase();
            const info = poolStatus.accountMap?.[norm];
            const primaryEmail = String(poolStatus.primaryAccount || '').toLowerCase();
            const isInUse = info?.status === 'COOLING'
              ? false
              : primaryEmail
                ? norm === primaryEmail
                : Boolean(info?.isPrimary || info?.rankLabel === '使用中');
            if (isInUse) {
              statusForAccess = isZh ? '使用中' : 'In Use';
              if (health.state !== 'unavailable') tabLabel = '<span class="quota-tab-dot" aria-hidden="true"></span>' + tabLabel;
            } else if (info?.status === 'COOLING') {
              statusForAccess = isZh ? '冷却中' : 'Cooling';
              tabLabel += ' · ❄ ' + (isZh ? '冷却' : 'Cooling');
            } else {
              statusForAccess = isZh ? ('备选' + fallbackIndex) : ('Backup ' + fallbackIndex);
              tabLabel += ' · ' + (isZh ? ('备' + fallbackIndex) : statusForAccess);
              fallbackIndex++;
            }
          }
          if (health.state === 'unavailable') tabLabel = '<span class="quota-tab-dot is-error" aria-hidden="true"></span>' + tabLabel;
          if (health.state !== 'healthy') statusForAccess = (health.state === 'unavailable' ? (isZh ? '暂不可用' : 'Unavailable') : statusForAccess) + ' · ' + (isZh ? health.zh : health.en);
          const accountDescription = displayName + (statusForAccess ? ' · ' + statusForAccess : '');
          const rawTitle = (settings.maskAccountNames ? maskAccountName(acc.email) : acc.email) || displayName;
          const tabTitle = rawTitle + (statusForAccess ? ' · ' + statusForAccess : '');
          return '<button type="button" class="quota-extension-account-tab ' + (isSelected ? 'is-active' : '') + '" aria-pressed="' + isSelected + '" data-account="' + esc(acc.email) + '" aria-label="' + esc(accountDescription) + '" title="' + esc(tabTitle) + '">'
            + tabLabel
            + '</button>';
        }).join('')
        + '</div>';
    }

    let queueBackupIndex = 1;
    const primaryEmail = String(poolStatus.primaryAccount || poolStatus.rankings?.[0]?.email || '').toLowerCase();
    const queueLabels = (Array.isArray(poolStatus.rankings) ? poolStatus.rankings : []).map((rank, index) => {
      const email = String(rank.email || '').trim().toLowerCase();
      const account = accounts.find(item => String(item.email || '').trim().toLowerCase() === email);
      const rawName = account?.label || (rank.email ? String(rank.email).split('@')[0] : '');
      const name = settings.maskAccountNames ? maskAccountName(rawName) : rawName;
      const health = accountHealth(account || { email: rank.email });
      let state;
      if (health.state === 'unavailable') state = isZh ? '暂不可用' : 'Unavailable';
      else if (rank.status === 'COOLING') state = isZh ? '冷却中' : 'Cooling';
      else if (email === primaryEmail || index === 0) state = isZh ? '使用中' : 'In Use';
      else {
        state = isZh ? ('备选' + queueBackupIndex) : ('Backup ' + queueBackupIndex);
        queueBackupIndex++;
      }
      return name + ' (' + state + ')';
    });
    const queueText = queueLabels.join(' → ') || (isZh ? '暂无账号排序信息' : 'No account order available');
    const healthNotes = accounts.map(acc => {
      const health = accountHealth(acc);
      if (health.state === 'healthy' || health.state === 'cooling') return null;
      const rawName = acc.label || String(acc.email || '').split('@')[0];
      const name = settings.maskAccountNames ? maskAccountName(rawName) : rawName;
      return { name, health, technicalCode: (health.httpStatus ? health.httpStatus + ' ' : '') + health.code };
    }).filter(Boolean);
    const healthDescription = healthNotes.map(({ name, health, technicalCode }) => name + '：' + (isZh ? health.zh : health.en) + ' [' + technicalCode + ']').join(' ');
    const healthNotesHtml = healthNotes.length
      ? '<div class="quota-account-health-notes"><strong>' + (isZh ? '账号状态' : 'Account status') + '</strong>'
        + healthNotes.map(({ name, health, technicalCode }) => '<div class="quota-account-health-note' + (health.state === 'unavailable' ? ' is-error' : '') + '"><b>' + esc(name) + '</b>：' + esc(isZh ? health.zh : health.en) + ' <span class="quota-account-health-code">' + esc(technicalCode) + '</span></div>').join('') + '</div>'
      : '';
    const unassignedAuthError = anti.error && getAccountHealth({ error: anti.error }).code === 'auth_unavailable'
      && !healthNotes.some(({ health }) => health.state === 'unavailable');
    const poolWarning = unassignedAuthError
      ? (isZh ? '代理当前没有可调用的登录凭证，但错误未指明具体账号；请检查登录授权状态。' : 'The proxy has no usable login credentials, but the error does not identify an account. Check login authorization.')
      : '';
    const rebalanceDescription = isZh
      ? '重排。队列顺序：' + queueText + '。调度规则：优先临近重置 · Pro 高配额优先。' + healthDescription + poolWarning
      : 'Reorder. Queue: ' + queueText + '. Rules: imminent reset first · Pro tier priority. ' + healthDescription + poolWarning;
    const rebalanceButtonHtml = accounts.length > 1 && enableDynamic
      ? '<div class="quota-rebalance-wrap">'
        + '<button type="button" class="quota-rebalance-pill-btn" aria-label="' + esc(rebalanceDescription) + '" aria-describedby="quota-rebalance-tooltip">'
        + '<span>' + esc(isZh ? '重排' : 'Reorder') + '</span>'
        + '</button>'
        + '</div>'
      : '';
    const rebalanceTooltipHtml = accounts.length > 1 && enableDynamic
      ? '<div id="quota-rebalance-tooltip" class="quota-rebalance-tooltip" role="tooltip">'
        + (isZh ? '排队顺序：' + esc(queueText) + '<br/>调度规则：优先临近重置 · Pro 高配额优先' : 'Queue: ' + esc(queueText) + '<br/>Rules: Imminent reset first · Pro tier priority')
        + healthNotesHtml
        + (poolWarning ? '<div class="quota-account-health-notes">' + esc(poolWarning) + '</div>' : '')
        + '</div>'
      : '';

    const chevronSvg = designIcon('chevronDown', 'chevron-icon' + (claudeGptCollapsed ? '' : ' is-expanded'));
    const visibleProviderRows = claudeGptCollapsed
      ? activeRows.filter(row => !/claude\s*&\s*gpt/i.test(row.label || ''))
      : activeRows;

    const docEmptySvg = '<svg width="22" height="24" viewBox="0 0 24 24" fill="currentColor"><path fill-rule="evenodd" clip-rule="evenodd" d="M5 3a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2H5zm3 5a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H9a1 1 0 0 1-1-1zm0 4a1 1 0 0 1 1-1h6a1 1 0 1 1 0 2H9a1 1 0 0 1-1-1zm0 4a1 1 0 0 1 1-1h4a1 1 0 1 1 0 2H9a1 1 0 0 1-1-1z"/></svg>';

    let geminiContent = '';
    if (!accounts.length || !activeRows || activeRows.length === 0) {
      geminiContent = renderEmptyState(docEmptySvg, t('noData'));
    } else if (visibleProviderRows.length) {
        geminiContent = '<div class="quota-extension-rows">'
          + visibleProviderRows.map((row, idx) => {
            const color = getQuotaColor(row.remainingPercent);
            const percentText = (row.remainingPercent !== null && row.remainingPercent !== undefined && !row.unavailable)
              ? row.remainingPercent + '%'
              : '0%';
            const countdownStr = formatDynamicCountdown(row, isZh);
            const resetInfo = row.unavailable ? esc(t('noData')) : esc(countdownStr);

            const providerLabel = /^Claude\s*&\s*GPT\b/i.test(row.label || '')
              ? String(row.label).replace(/^Claude\s*&\s*GPT/i, 'Claude')
              : row.label;
            return '<div class="quota-extension-row' + (idx === visibleProviderRows.length - 1 ? ' is-last' : '') + '">'
              + '<span class="quota-extension-label">' + esc(providerLabel) + '</span>'
              + '<span class="quota-extension-track"><span class="quota-extension-fill" style="width:' + (row.unavailable ? 0 : (row.remainingPercent || 0)) + '%;background:' + color + '"></span></span>'
              + '<span class="quota-extension-percent">' + esc(percentText) + '</span>'
              + '<span class="quota-extension-value">' + esc(resetInfo) + '</span>'
              + '</div>';
          }).join('')
          + '</div>';
    }

    const sparkleSvg = designIcon('sparkle', 'section-icon');

    const maskButton = '<button type="button" class="account-mask-toggle-btn' + (settings.maskAccountNames ? ' is-active' : '') + '" aria-label="' + esc(t('toggleAccountMask')) + '" title="' + esc(t('toggleAccountMask')) + '">'
      + designIcon('eye')
      + '</button>';
    geminiSection = '<div class="card-section quota-extension-section">'
      + '<div class="quota-extension-header' + (visibleProviderRows.length ? ' has-rows' : '') + '">'
      + '<div class="quota-extension-title-wrap">'
      + sparkleSvg
      + '<span class="quota-extension-title">' + esc(t('geminiTitle')) + '</span>'
      + maskButton
      + rebalanceButtonHtml
      + '</div>'
      + '<div class="quota-extension-header-actions">'
      + accountTabsHtml
      + '<button type="button" class="quota-extension-toggle" aria-label="' + esc(t('toggleClaudeRows')) + '" title="' + esc(t('toggleClaudeRows')) + '" aria-expanded="' + !claudeGptCollapsed + '">' + chevronSvg + '</button>'
      + '</div>'
      + '</div>'
      + rebalanceTooltipHtml
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

    const voucherUnavailable = Boolean(usageState.error) && !usageState.resetCreditDetailsLoaded;
    const isVoucherLoading = !voucherUnavailable
      && (vouchersLoading || (settings.enableResetCredits && !usageState.resetCreditDetailsLoaded));
    const details = voucherUnavailable
      ? renderEmptyState(ticketEmptySvg, usageState.error || t('unavailable'))
      : isVoucherLoading
      ? ('<div class="empty-state-box is-loading">'
          + '<div class="voucher-loading-spinner"></div>'
          + '<div class="empty-state-text">' + esc(t('loadingVouchers')) + '</div>'
          + '</div>')
      : (usageState.resetCreditDetails.length
          ? usageState.resetCreditDetails.map(item => {
            const expiry = item.expiresAt
              ? settings.locale === 'zh-CN'
                ? t('expiresOn') + ' ' + formatDate(item.expiresAt, true) + ' ' + t('timezone') + ' ' + t('expiresSuffix')
                : t('expiresOn') + ' ' + formatDate(item.expiresAt, true) + ' ' + t('timezone')
              : t('noResetDetails');
            return '<div class="credit-detail">'
              + designIcon('lightning', 'coupon-lightning')
              + '<div class="coupon-copy"><strong>' + esc(t('fullReset')) + '</strong><span>' + esc(expiry) + '</span></div>'
              + designIcon('couponWave', 'coupon-wave') + '</div>';
          }).join('')
          : renderEmptyState(ticketEmptySvg, t('noResetCoupons')));

    const pPercent = (p?.remainingPercent ?? '—') + '%';
    const sPercent = (s?.remainingPercent ?? '—') + '%';
    const pInfoTime = p ? formatDate(p.resetsAt) + ' ' + t('resetAt') : '--:--';
    const pInfoRemain = weeklyExhausted ? '' : (t('untilReset') + ' ' + formatDuration(p?.secondsRemaining, 5 * 3600));
    const sInfoTime = s ? formatDate(s.resetsAt, true) + ' ' + t('resetAt') : '--:--';
    const sInfoRemain = s ? t('untilReset') + ' ' + formatDuration(s?.secondsRemaining, 7 * 86400) : '';

    const primaryRow = showFiveHours
      ? '<div class="row">'
        + '<span class="usage-icon">' + designIcon('clock') + '</span>'
        + '<span class="usage-label"><span class="label">' + esc(t('fiveHours')) + '</span></span>'
        + '<span class="track"><span class="fill" style="width:' + (p?.remainingPercent || 0) + '%;background:' + pColor + '"></span></span>'
        + '<span class="percent">' + esc(pPercent) + '</span>'
        + '<span class="value popover-primary-value"><span class="info-time">' + esc(pInfoTime) + '</span><span class="info-remain">' + esc(pInfoRemain) + '</span></span>'
        + '</div>'
      : '';
    const secondaryRow = '<div class="row">'
      + '<span class="usage-icon">' + designIcon('calendar') + '</span>'
      + '<span class="usage-label"><span class="label">' + esc(t('sevenDays')) + '</span></span>'
      + '<span class="track"><span class="fill" style="width:' + (s?.remainingPercent || 0) + '%;background:' + sColor + '"></span></span>'
      + '<span class="percent">' + esc(sPercent) + '</span>'
      + '<span class="value popover-secondary-value"><span class="info-time">' + esc(sInfoTime) + '</span><span class="info-remain">' + esc(sInfoRemain) + '</span></span>'
      + '</div>';

    const usageContent = ready
      ? '<div class="card-section usage-section">'
        + '<div class="card-section-header"><span class="card-section-heading">' + designIcon('clock', 'section-icon') + '<span class="card-section-title">' + esc(t('usageTitle')) + '</span></span></div>'
        + '<div class="rows">' + primaryRow + secondaryRow + '</div>'
        + '</div>'
      : '<div class="card-section usage-section"><div class="unavailable">' + esc(message) + '</div></div>';

    const ticketSvg = designIcon('coupon', 'credit-icon');

    const resetCountText = voucherUnavailable
      ? '<strong class="credits-count">—</strong> ' + esc(t('available'))
      : isVoucherLoading && usageState.resetCredits === null
      ? esc(t('syncing')) : '<strong class="credits-count">' + esc(usageState.resetCredits ?? '—') + '</strong> ' + esc(t('available'));
    const voucherBanner = '<div class="meta-row">'
      + '<span class="meta-actions">'
      + '<span class="credits-copy">'
      + ticketSvg
      + '<span class="credits-text">' + esc(t('resetCredits')) + ' ' + resetCountText + '</span>'
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
      '.card-refresh,.header-module-toggle{width:28px;height:28px;padding:0;border-radius:8px;border:1px solid ' + (dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.08)') + ';background:' + (dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.03)') + ';color:' + (dark ? '#8E8E93' : '#8E8E93') + ';cursor:pointer;display:grid;place-items:center;transition:all .15s ease}',
      '.header-module-toggle:hover{background:' + (dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.07)') + ';color:' + (dark ? '#FFFFFF' : '#1D1D1F') + '}',
      '.header-module-toggle.is-active{background:' + (dark ? 'rgba(10,132,255,.20)' : 'rgba(0,122,255,.10)') + ';border-color:' + (dark ? 'rgba(10,132,255,.45)' : 'rgba(0,122,255,.30)') + ';color:#007AFF}',
      '.card-refresh,.header-module-toggle{width:28px;height:28px;padding:0;border-radius:8px;border:1px solid ' + (dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.08)') + ';background:' + (dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.03)') + ';color:' + (dark ? '#8E8E93' : '#8E8E93') + ';cursor:pointer;display:grid;place-items:center;transition:all .15s ease}',
      '.header-module-toggle:hover{background:' + (dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.07)') + ';color:' + (dark ? '#FFFFFF' : '#1D1D1F') + '}',
      '.header-module-toggle.is-active{background:' + (dark ? 'rgba(10,132,255,.20)' : 'rgba(0,122,255,.10)') + ';border-color:' + (dark ? 'rgba(10,132,255,.45)' : 'rgba(0,122,255,.30)') + ';color:#007AFF}',
      '.failover-toggle-wrap{position:relative;display:inline-flex;align-items:center}',
      '.failover-toggle-btn{width:28px;height:28px;padding:0;border-radius:8px;border:1px solid ' + (dark ? 'rgba(255,255,255,.14)' : 'rgba(0,0,0,.08)') + ';background:' + (dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.03)') + ';cursor:pointer;display:grid;place-items:center;transition:all .15s ease}',
      '.failover-toggle-btn.is-external{background:' + (dark ? 'rgba(122,90,248,.20)' : 'rgba(122,90,248,.10)') + ';border-color:' + (dark ? 'rgba(122,90,248,.50)' : 'rgba(122,90,248,.35)') + ';color:#7A5AF8}',
      '.failover-toggle-btn.is-openai{background:' + (dark ? 'rgba(50,199,106,.18)' : 'rgba(50,199,106,.10)') + ';border-color:' + (dark ? 'rgba(50,199,106,.45)' : 'rgba(50,199,106,.30)') + ';color:#32C76A}',
      '.failover-toggle-btn.is-loading .failover-swap-icon{animation:quota-refresh-spin .8s linear infinite}',
      '.failover-tooltip{position:absolute;top:calc(100% + 8px);right:0;width:250px;padding:10px 12px;border-radius:10px;background:' + (dark ? '#242428' : '#FFFFFF') + ';color:' + (dark ? '#F5F5F7' : '#1D1D1F') + ';border:1px solid ' + (dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.08)') + ';box-shadow:0 6px 20px rgba(0,0,0,.15);backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);font-size:11.5px;line-height:1.45;pointer-events:none;opacity:0;visibility:hidden;transform:translateY(-4px);transition:all .15s cubic-bezier(0.16,1,0.3,1);z-index:1000;white-space:normal}',
      '.failover-toggle-wrap:hover .failover-tooltip{opacity:1;visibility:visible;transform:translateY(0)}',
      '.failover-tooltip-header{font-weight:700;font-size:12px;margin-bottom:4px;color:#007AFF}',
      '.failover-tooltip-desc{color:' + (dark ? '#A1A1A6' : '#6B7280') + ';margin-bottom:6px}',
      '.failover-tooltip-action{font-weight:600;color:' + (dark ? '#30D158' : '#34C759') + ';border-top:1px solid ' + (dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.06)') + ';padding-top:6px}',
      '.account-mask-toggle-btn{width:20px;height:20px;padding:0;border:0;background:transparent;color:' + (dark ? '#8E8E93' : '#9CA3AF') + ';border-radius:5px;cursor:pointer;display:inline-flex;align-items:center;justify-content:center;transition:all .15s ease;margin-left:4px}',
      '.account-mask-toggle-btn:hover{background:' + (dark ? 'rgba(255,255,255,.10)' : 'rgba(0,0,0,.06)') + ';color:' + (dark ? '#F5F5F7' : '#1D1D1F') + '}',
      '.account-mask-toggle-btn.is-active{color:#007AFF}',
      '.voucher-loading-spinner{width:18px;height:18px;border:2px solid ' + (dark ? 'rgba(255,255,255,.15)' : 'rgba(0,0,0,.10)') + ';border-top-color:#007AFF;border-radius:50%;animation:quota-refresh-spin .72s linear infinite}',
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
      '.quota-tab-dot{width:5px;height:5px;background-color:#34C759;border-radius:50%;display:inline-block;margin-right:5px;vertical-align:middle}',
      '.quota-tab-dot.is-error{background-color:#FF3B30;box-shadow:0 0 0 1px rgba(255,255,255,.8)}',
      '.quota-account-health-notes{margin-top:7px;padding-top:7px;border-top:1px solid rgba(128,128,128,.2)}.quota-account-health-note{margin-top:4px;line-height:1.5}.quota-account-health-note.is-error b{color:#FF3B30}.quota-account-health-code{font-size:10px;opacity:.7;white-space:nowrap}',
      '.quota-rebalance-wrap{position:relative;display:inline-flex;align-items:center;margin-left:6px}',
      '.quota-rebalance-pill-btn{display:inline-flex;align-items:center;gap:4px;padding:2px 8px;border-radius:12px;border:1px solid ' + (dark ? 'rgba(255,255,255,.15)' : 'rgba(0,0,0,.1)') + ';background:' + (dark ? 'rgba(255,255,255,.08)' : '#FFFFFF') + ';color:' + (dark ? '#F5F5F7' : '#1D1D1F') + ';font-size:11px;font-weight:500;cursor:pointer;transition:all .15s ease;box-shadow:0 1px 2px rgba(0,0,0,.04)}',
      '.quota-rebalance-pill-btn:hover{background:' + (dark ? 'rgba(255,255,255,.14)' : '#F5F5F7') + ';border-color:' + (dark ? 'rgba(255,255,255,.25)' : 'rgba(0,0,0,.18)') + '}',
      '.quota-rebalance-pill-btn:active{transform:scale(0.96)}',
      '.quota-rebalance-pill-btn.is-loading svg{animation:quota-spin .8s linear infinite}',
      '.quota-extension-header:hover + .quota-rebalance-tooltip,.quota-extension-header:focus-within + .quota-rebalance-tooltip,.quota-rebalance-tooltip:hover{display:block}',
      '.quota-rebalance-tooltip{display:none;position:static;width:100%;max-width:100%;margin:0 0 7px;transform:none;opacity:1;visibility:visible;transition:none;background:' + (dark ? 'rgba(30,30,30,.96)' : 'rgba(255,255,255,.96)') + ';backdrop-filter:blur(20px);-webkit-backdrop-filter:blur(20px);border:1px solid ' + (dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.08)') + ';border-radius:8px;box-shadow:0 4px 16px rgba(0,0,0,.15);padding:8px 12px;font-size:11px;line-height:1.5;color:' + (dark ? '#F5F5F7' : '#1D1D1F') + ';white-space:normal;overflow-wrap:anywhere;pointer-events:auto;z-index:auto}',
      '@keyframes quota-spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}',
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
      '.token-model-row{display:grid;grid-template-columns:minmax(112px,1.3fr) minmax(70px,1fr) 48px;align-items:center;gap:10px;font-size:12.5px}',
      '.token-model-label{display:flex;align-items:center;gap:6px;min-width:0;overflow:hidden;text-overflow:ellipsis;font-weight:500;color:' + (dark ? '#E5E5EA' : '#374151') + ';white-space:nowrap}',
      '.token-model-dot{width:7.5px;height:7.5px;border-radius:50%;flex-shrink:0}',
      '.token-model-amount{text-align:right;font-weight:650;font-variant-numeric:tabular-nums;color:' + (dark ? '#F5F5F7' : '#1D1D1F') + ';white-space:nowrap}',
      '.token-model-pct{text-align:right;color:' + (dark ? '#A1A1A6' : '#6B7280') + ';font-size:11.5px;font-variant-numeric:tabular-nums;white-space:nowrap}',
      '.token-model-selector-row{position:relative;display:flex;flex-direction:column;align-items:flex-end;gap:5px;margin:0 0 5px}',
      '.quota-extension-model-button{display:inline-flex;align-items:center;gap:8px;min-height:28px;padding:3px 10px;border:1px solid ' + (dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.08)') + ';border-radius:8px;background:' + (dark ? 'rgba(255,255,255,.06)' : '#FFFFFF') + ';color:' + (dark ? '#E5E5EA' : '#374151') + ';font:inherit;font-size:11.5px;cursor:pointer;white-space:nowrap}',
      '.quota-extension-model-button:hover,.quota-extension-model-button[aria-expanded="true"]{border-color:rgba(0,122,255,.35);background:' + (dark ? 'rgba(10,132,255,.12)' : 'rgba(0,122,255,.05)') + '}',
      '.quota-extension-model-chevron{font-size:13px;color:' + (dark ? '#A1A1A6' : '#6B7280') + '}',
      '.quota-extension-model-menu{position:absolute;top:calc(100% + 6px);right:0;display:flex;flex-direction:column;gap:2px;width:min(100%,220px);max-height:180px;overflow-y:auto;padding:4px;border:1px solid ' + (dark ? 'rgba(255,255,255,.12)' : 'rgba(0,0,0,.08)') + ';border-radius:10px;background:' + (dark ? '#2A2A2D' : '#FFFFFF') + ';box-shadow:0 8px 24px rgba(0,0,0,.12);z-index:30}',
      '.quota-extension-model-option{display:flex;align-items:center;justify-content:space-between;gap:10px;width:100%;min-height:27px;padding:4px 8px;border:0;border-radius:6px;background:transparent;color:' + (dark ? '#E5E5EA' : '#374151') + ';font:inherit;font-size:11.5px;text-align:left;cursor:pointer}',
      '.quota-extension-model-option:hover{background:' + (dark ? 'rgba(255,255,255,.08)' : '#F3F4F6') + '}',
      '.quota-extension-model-option.is-active{background:' + (dark ? 'rgba(10,132,255,.18)' : 'rgba(0,122,255,.10)') + ';color:#007AFF;font-weight:650}',
      '.quota-extension-model-option-amount{color:' + (dark ? '#A1A1A6' : '#6B7280') + ';font-variant-numeric:tabular-nums}',
      '.token-family-summary{display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;margin-top:8px;padding:6px 10px;background:' + (dark ? 'rgba(255,255,255,.05)' : 'rgba(0,0,0,.03)') + ';border:1px solid ' + (dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.05)') + ';border-radius:8px;width:min(100%,140px);box-sizing:border-box;gap:2px}',
      '.token-family-summary strong{font-size:11.5px;color:' + (dark ? '#F5F5F7' : '#1D1D1F') + ';font-weight:650}',
      '.token-family-summary-line1{font-size:11.5px;color:' + (dark ? '#E5E5EA' : '#1D1D1F') + ';white-space:nowrap}',
      '.token-family-summary-line2{font-size:11px;color:' + (dark ? '#A1A1A6' : '#6B7280') + ';white-space:nowrap}',
      '.token-model-columns{display:grid;grid-template-columns:minmax(112px,1.3fr) minmax(70px,1fr) 48px;align-items:center;gap:10px;padding:0 0 3px;color:' + (dark ? '#8E8E93' : '#8A8A8E') + ';font-size:10.5px;text-align:right}',
      '.token-model-columns span:first-child{text-align:left}',
      '.token-model-row.is-model-detail .token-model-label{font-variant-numeric:tabular-nums}',
      '.quota-extension-note{font-size:12px;color:' + (dark ? '#A1A1A6' : '#6B7280') + ';padding:6px 0}',
      '.unavailable{font-size:12.5px;color:' + (dark ? '#A1A1A6' : '#6B7280') + ';padding:8px 0}',
    ].join('');

    const moduleButton = (module, icon, label, active) =>
      '<button type="button" class="quota-icon-btn header-module-toggle' + (active ? ' is-active' : '') + '" data-module="' + module + '" aria-label="' + esc(label) + '" title="' + esc(label) + '" aria-pressed="' + active + '">'
      + designIcon(icon) + '</button>';
    return '<style>' + css + (window.__codexUsageHeaderDesignCSS__ || '') + '</style>'
      + '<div class="popover-shell quota-dashboard' + (dark ? ' is-dark' : '') + (refreshState === 'loading' ? ' is-refreshing' : '') + '">'
      + '<div class="popover-header">'
      + '<div class="popover-brand">' + designIcon('logo', 'brand-logo')
      + '<div class="popover-title-group">'
      + '<div class="popover-title">' + esc(t('title')) + '</div>'
      + '<div class="popover-subtitle">' + esc(t('subtitle')) + '</div>'
      + errorNote
      + '</div>'
      + '</div>'
      + '<div class="popover-actions">'
      + renderFailoverToggleButton(dark, isZh)
      + '<button class="language-toggle" aria-label="' + esc(t('locale')) + '">'
      + '<span class="lang-opt' + (isZh ? ' is-active' : '') + '" data-lang="zh-CN">中</span>'
      + '<span class="lang-sep">/</span>'
      + '<span class="lang-opt' + (!isZh ? ' is-active' : '') + '" data-lang="en-US">EN</span>'
      + '</button> <!-- 中 / EN -->'
      + moduleButton('reset', 'coupon', t('toggleVouchers'), settings.enableResetCredits)
      + moduleButton('google', 'sparkle', t('toggleGoogle'), settings.enableGoogleAiPro)
      + moduleButton('tokens', 'tokenChart', t('toggleStats'), settings.enableTokenUsage)
      + '<button type="button" class="quota-icon-btn card-refresh state-' + refreshState + '" aria-label="' + esc(refreshState === 'loading' ? t('refreshing') : refreshState === 'error' ? t('refreshFailed') : t('refresh')) + '">' + designIcon('refresh') + '</button>'
      + '</div>'
      + '</div>'
      + usageContent
      + (settings.enableResetCredits ? voucherSection : '')
      + extensionMarkup
      + '</div>';
  }

  function renderPopover() {
    const target = ensurePopover();
    const previousScroll = target.querySelector('.popover-shell')?.scrollTop || 0;
    const dark = document.documentElement.classList.contains('dark') || window.matchMedia('(prefers-color-scheme: dark)').matches;
    target.innerHTML = popoverMarkup(dark);
    const shell = target.querySelector('.popover-shell');
    if (shell) shell.scrollTop = previousScroll;
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

  function measureTitleNeed(titleRegion) {
    const rect = visibleRect(titleRegion);
    if (!rect) return 160;
    const candidates = [...titleRegion.querySelectorAll('button,a,[role="button"]')].map(visibleRect).filter(Boolean);
    const right = candidates.length ? Math.max(...candidates.map(item => item.right)) : rect.left + 160;
    return Math.max(128, Math.min(320, right - rect.left + 12));
  }

  function measureAvailableWidth(element) {
    if (!element) return 520;
    const header = element.closest('header') || element.closest('[data-app-shell-header-toolbar="true"]') || element.closest('[role="toolbar"]') || document.querySelector('header');
    const headerRect = visibleRect(header);
    const actionGroup = element.parentElement;
    const newChat = element.dataset?.placement === 'new-chat';
    const chat = element.dataset?.placement === 'chat';

    if (chat) {
      const referenceRect = visibleRect(element.nextElementSibling);
      const toolbar = header?.querySelector('[data-app-shell-header-toolbar="true"]')
        || document.querySelector('[data-app-shell-header-toolbar="true"]');
      const toolbarRect = visibleRect(toolbar);
      const titleRegion = toolbar?.firstElementChild;
      const titleNeed = measureTitleNeed(titleRegion);
      if (!referenceRect || !toolbarRect) return 520;
      return Math.max(0, referenceRect.left - toolbarRect.left - titleNeed - 12);
    }

    let toolbar = newChat ? header : actionGroup?.parentElement;
    let toolbarRect = visibleRect(toolbar);

    const hasCodexShellToolbar = Boolean(header?.querySelector('[data-app-shell-header-toolbar="true"]')
      || document.querySelector('[data-app-shell-header-toolbar="true"]'));

    // 核心修复：纯对话页面中（无 Codex 主工具栏），右侧按钮容器非常紧凑（仅约 160px）。
    // 此时应回退到 header 容器进行真实可用空间计算，防止误判为 nano 模式。
    if (!hasCodexShellToolbar && headerRect && headerRect.width >= 400) {
      toolbar = header;
      toolbarRect = headerRect;
    }

    if (!toolbarRect || !actionGroup) return 520;

    const isTopHeader = (toolbar === header);
    let titleNeed = 160;
    if (isTopHeader && headerRect) {
      let maxLeftRight = headerRect.left + 160;
      const hostRect = visibleRect(element);
      const hostLeft = hostRect ? hostRect.left : headerRect.right - 200;
      const leftCandidates = [...header.querySelectorAll('button,a,[role="button"],[role="tab"],h1,h2,.title')].filter(isVisible);
      for (const el of leftCandidates) {
        if (element.contains(el)) continue;
        const r = visibleRect(el);
        if (r && r.right < hostLeft && r.width < headerRect.width * 0.6) {
          if (r.right > maxLeftRight) maxLeftRight = r.right;
        }
      }
      titleNeed = Math.max(160, maxLeftRight - headerRect.left + 16);
    } else if (!newChat) {
      const titleRegion = [...toolbar.children].find(child => child !== actionGroup) || null;
      titleNeed = measureTitleNeed(titleRegion);
    }

    const nativeRects = [...actionGroup.querySelectorAll('button,[role="button"]')].filter(button => !element.contains(button)).map(visibleRect).filter(Boolean);
    const native = newChat
      ? (visibleRect(element.nextElementSibling)?.width || 70)
      : nativeRects.length
        ? Math.max(...nativeRects.map(rect => rect.right)) - Math.min(...nativeRects.map(rect => rect.left))
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
    const style = `<style>
      *{box-sizing:border-box}
      :host{display:inline-flex;align-items:center;flex:0 0 auto;min-width:0;margin:0;position:relative;z-index:20;pointer-events:auto!important;-webkit-app-region:no-drag;font-family:-apple-system,BlinkMacSystemFont,"SF Pro Text","Segoe UI",sans-serif;user-select:none}
      :host([data-space-hidden="true"]){display:none!important}
      .capsule{height:34px;min-width:0;padding:0 0 0 9px;border-radius:999px;display:inline-flex;align-items:center;gap:0;color:${dark ? '#F5F5F7' : '#1D1D1F'};background:${dark ? 'rgba(40,40,42,.90)' : 'rgba(247,247,248,.94)'};border:1px solid ${dark ? 'rgba(255,255,255,.13)' : 'rgba(0,0,0,.07)'};box-shadow:0 1px 3px rgba(0,0,0,.07);backdrop-filter:blur(16px);-webkit-backdrop-filter:blur(16px);-webkit-app-region:no-drag;white-space:nowrap;outline:none}
      .details-trigger{height:32px;padding:0 8px 0 0;border:0;background:transparent;color:inherit;font:inherit;cursor:pointer;display:inline-flex;align-items:center;gap:5px;white-space:nowrap}
      .details-trigger:focus-visible,.capsule-toggle:focus-visible{outline:2px solid ${dark ? 'rgba(10,132,255,.72)' : 'rgba(0,122,255,.55)'};outline-offset:-2px}
      .capsule-separator{flex:none;width:1px;height:18px;margin-right:2px;background:${dark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.12)'}}
      .capsule-toggle{flex:none;width:30px;height:32px;padding:0;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:0 999px 999px 0;background:transparent;color:inherit;cursor:pointer;transition:background .15s ease}
      .capsule-toggle:hover{background:${dark ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.035)'}}
      .capsule-arrow{display:block;width:14px;height:14px;opacity:.72;transition:transform .16s ease}
      .capsule-arrow.is-expanded{transform:rotate(180deg)}
      .label{flex:none;font-size:12px;font-weight:700;letter-spacing:-.15px}
      .track{flex:none;width:70px;height:12px;overflow:hidden;border-radius:999px;background:${CONFIG.colors.track}}
      .fill{display:block;height:100%;border-radius:999px;transition:width .3s ease,background .3s ease}
      .mini-pie{width:16px;height:16px;display:inline-block;border-radius:50%;background:conic-gradient(currentColor 0 var(--remaining), ${CONFIG.colors.track} var(--remaining) 100%);transform:rotate(-90deg)}
      .value{flex:none;font-size:12px;font-weight:560;letter-spacing:-.1px;font-variant-numeric:tabular-nums}
      .primary-countdown{min-width:0}
      .divider{flex:none;width:1px;height:16px;margin:0;background:${dark ? 'rgba(255,255,255,.18)' : 'rgba(0,0,0,.12)'}}
      @keyframes quota-number-shimmer{0%{opacity:.35;filter:blur(.4px)}50%{opacity:.85;filter:blur(0)}100%{opacity:.35;filter:blur(.4px)}}
      .capsule.is-refreshing .value{animation:quota-number-shimmer .75s ease-in-out infinite}
    </style>`
      + '<div class="capsule' + (refreshState === 'loading' ? ' is-refreshing' : '') + '">'
      + '<button class="details-trigger" type="button" aria-label="' + esc(t('details')) + '" aria-describedby="' + POPOVER_ID + '" aria-controls="' + POPOVER_ID + '" aria-expanded="' + detailsOpen + '">' + content + '</button>'
      + '<span class="capsule-separator" aria-hidden="true"></span>'
      + '<button class="capsule-toggle" type="button" aria-label="' + esc(t('toggleDetails')) + '" aria-controls="' + POPOVER_ID + '" aria-expanded="' + detailsOpen + '">'
      + designIcon('chevronDown', 'capsule-arrow' + (detailsOpen ? ' is-expanded' : ''))
      + '</button>'
      + '</div>';
    host.shadowRoot.innerHTML = style;
  }
  function updateMode() {
    if (!host) return;
    const available = measureAvailableWidth(host);
    const next = resolveMode(available);
    const spaceHidden = host.dataset.placement === 'chat' && available < 64;
    const spaceHiddenChanged = host.dataset.spaceHidden !== String(spaceHidden);
    host.dataset.spaceHidden = String(spaceHidden);
    host.dataset.mode = currentMode;
    host.dataset.availableWidth = String(Math.round(available));
    if (next !== currentMode || spaceHiddenChanged) {
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
    // Codex 标题栏是拖拽区域，多个祖先节点上禁用了 pointer-events。
    // 将注入区域设置为明确的命中目标，并保留浏览器正常派发
    // pointer 事件时使用的事件路径。
    const openFromHost = event => {
      lastPointerX = event.clientX;
      lastPointerY = event.clientY;
      if (suppressHoverUntilLeave) return;
      const path = event.composedPath();
      if (path.some(node => node?.classList?.contains('details-trigger')) || path.includes(host)) showPopover();
    };
    host.addEventListener('pointerover', openFromHost, true);
    host.addEventListener('pointerenter', openFromHost, true);
    host.addEventListener('mouseover', openFromHost, true);
    host.addEventListener('mouseenter', openFromHost, true);
    const onHostLeave = () => {
      suppressHoverUntilLeave = false;
      scheduleHidePopover();
    };
    host.addEventListener('pointerleave', onHostLeave, true);
    host.addEventListener('mouseleave', onHostLeave, true);
    host.addEventListener('click', event => {
      const path = event.composedPath();
      if (!path.some(node => node?.classList?.contains('details-trigger') || node?.classList?.contains('capsule-toggle'))) return;
      togglePopoverFromCapsule();
    }, true);
    host.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        suppressHoverUntilLeave = true;
        hidePopover(true);
      }
      if ((event.key === 'Enter' || event.key === ' ') && event.composedPath().some(node => node?.classList?.contains('details-trigger') || node?.classList?.contains('capsule-toggle'))) {
        event.preventDefault();
        togglePopoverFromCapsule();
      }
    }, true);

    // 坐标兜底：如果 Electron 将物理指针事件路由到拖拽区域，
    // 而不是影子按钮，文档级 mousemove 仍可识别组件的可见边界。
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
      if (inside && !suppressHoverUntilLeave) showPopover();
      else if (!insidePopover && popoverState !== 'pinned') scheduleHidePopover();
    };
    on(document, 'pointermove', handleDocumentPointerMove, true);
    on(document, 'mousemove', handleDocumentPointerMove, true);
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

  // __MOUNT_POINT_LOGIC_BEGIN__
  // 挂载点解析核心：只从有效顶栏中寻找锚点按钮。
  // 候选按钮不合格（例如侧栏里的同名按钮）时继续查找下一个，
  // 绝不因第一个同名按钮不合格而直接返回 null。
  // 本块为连续代码，供 test/mount-point.test.mjs 提取做回归测试。
  function visibleRect(element) {
    const rect = element?.getBoundingClientRect();
    return rect && rect.width > 0 && rect.height > 0 ? rect : null;
  }

  function isVisible(element) {
    const rect = visibleRect(element);
    const style = element ? getComputedStyle(element) : null;
    return Boolean(rect && style && style.display !== 'none' && style.visibility !== 'hidden' && Number(style.opacity) > 0
      && rect.top < 80 && rect.bottom > 0 && rect.right > 0 && rect.left < window.innerWidth);
  }

  const THREAD_ACTION_RE = /^聊天操作$|^chat actions?$|^more$/i;
  const NEWCHAT_ACTION_RES = [
    /^切换底部面板显示$|^toggle bottom panel visibility$|^toggle bottom panel$/i,
    /^显示\/隐藏侧边面板$|^show\/hide side panel$|^toggle side panel$/i,
    /^(?:新聊天|新建聊天|开启新聊天|创建新聊天|新会话|新建会话|新标签页|新建标签页|新标签|新建标签|打开新标签页|new\s*chat|create\s*(?:new\s*)?chat|open\s*new\s*chat|start\s*new\s*chat|new\s*tab|create\s*(?:new\s*)?tab|open\s*new\s*tab|add\s*tab|new\s*conversation)(?:\s*[\(（][^\)）]+[\)）])?$/i,
    /^[+＋]$/,
  ];
  const SHARE_ACTION_RE = /^分享$|^share$/i;

  function isNewChatAction(button) {
    if (!button) return false;
    const label = button.getAttribute('aria-label') || button.getAttribute('title') || '';
    if (NEWCHAT_ACTION_RES.some(re => re.test(label))) return true;
    const text = button.textContent?.trim() || '';
    if (text && NEWCHAT_ACTION_RES.some(re => re.test(text))) return true;
    const testId = button.getAttribute('data-testid') || '';
    if (/^(?:new-chat|create-(?:new-)?chat|new-tab|add-tab)(?:-button)?$/i.test(testId)) return true;
    return false;
  }

  // 校验原生按钮所在顶栏，兼容新版的 display:contents 包装及无 header 的显式工具栏。
  // 仍要求顶部位置、足够宽度和已知原生操作，不能挂载到侧栏或正文。
  // 返回挂载点描述；不合格返回 null，调用方继续尝试下一个候选。
  function validateActionAnchor(button, isNewChat) {
    const shellToolbar = button.closest('[data-app-shell-header-toolbar="true"]');
    const header = button.closest('header') || shellToolbar || button.closest('[role="toolbar"]');
    if (!header) return null;

    const headerRect = visibleRect(header);
    const buttonRect = visibleRect(button);
    if (!headerRect || !buttonRect || headerRect.height > 80 || headerRect.width < 400) return null;

    const minLeft = typeof window !== 'undefined' ? window.innerWidth * 0.35 : 300;
    if (buttonRect.left < minLeft) return null;

    // 从 button 自底向上寻找直接的排版定位容器（unwrap display: contents、span 与单个小尺寸包装 div）
    let reference = button;
    while (reference?.parentElement && reference.parentElement !== header) {
      const parent = reference.parentElement;
      const pStyle = getComputedStyle(parent);
      if (pStyle.display === 'contents' || parent.tagName === 'SPAN') {
        reference = parent;
        continue;
      }
      if (isNewChat) {
        const pRect = visibleRect(parent);
        if (parent.children.length === 1 && pRect && pRect.width < 80 && parent.parentElement && parent !== header) {
          reference = parent;
          continue;
        }
      }
      break;
    }

    const container = reference?.parentElement || header;
    const toolbar = (container === header) ? header : (shellToolbar || container.parentElement || header);
    if (!container || !toolbar || !header.contains(toolbar)) return null;

    const toolbarRect = visibleRect(toolbar);
    if (!toolbarRect) return null;
    if (!isNewChat && toolbarRect.width < 240) return null;

    return { header, toolbar, container, reference, placement: isNewChat ? 'new-chat' : 'thread' };
  }

  function resolveShellToolbarPoint(doc) {
    const shellToolbars = [...doc.querySelectorAll('[data-app-shell-header-toolbar="true"]')];
    const shellToolbar = shellToolbars.find(candidate => {
      const rect = visibleRect(candidate);
      return rect && rect.top < 80 && rect.height <= 80;
    });
    if (!shellToolbar) return null;
    const header = shellToolbar.closest('header') || shellToolbar;
    const headerRect = visibleRect(header);
    if (!headerRect || headerRect.top >= 80 || headerRect.height > 80 || headerRect.width < 400) return null;

    // 新版 Work 的原生操作在显式 App Shell 工具栏内，不一定有 obstacle 属性。
    for (const button of [...shellToolbar.querySelectorAll('button')].filter(isVisible)) {
      const label = button.getAttribute('aria-label') || button.getAttribute('title') || button.textContent?.trim() || '';
      const isNewChat = isNewChatAction(button);
      if (!isNewChat && !THREAD_ACTION_RE.test(label) && !SHARE_ACTION_RE.test(label)) continue;
      if (visibleRect(button)?.left < window.innerWidth * 0.35) continue;
      const point = validateActionAnchor(button, isNewChat);
      if (point) return { ...point, placement: SHARE_ACTION_RE.test(label) ? 'chat' : point.placement };
    }

    const obstacles = [...header.querySelectorAll('[data-app-shell-header-obstacle="true"]')];
    for (const obstacle of obstacles) {
      const obstacleRect = visibleRect(obstacle);
      if (!obstacleRect || obstacleRect.left < window.innerWidth * 0.35) continue;
      const obstacleButtons = [...obstacle.querySelectorAll('button,[role="button"]')].filter(isVisible);
      const shareButton = obstacleButtons.find(button => SHARE_ACTION_RE.test(button.getAttribute('aria-label') || button.textContent || ''));
      const fallbackButton = obstacleButtons.find(button => /^(聊天操作|更多|更多选项|更多操作|chat actions?|more(?: options)?)$/i.test(button.getAttribute('aria-label') || button.textContent || ''));
      const anchorButton = shareButton || fallbackButton;
      if (!anchorButton) continue;
      let reference = anchorButton;
      while (reference.parentElement && reference.parentElement !== obstacle) reference = reference.parentElement;
      if (reference.parentElement !== obstacle) continue;
      return { header, toolbar: shellToolbar, container: obstacle, reference, placement: 'chat' };
    }
    return null;
  }

  function resolveMountPoint(doc = document) {
    const buttons = [...doc.querySelectorAll('button')].filter(isVisible);
    // 按水平从右至左排序，优先匹配顶栏右侧的操作按钮
    const rightwardButtons = [...buttons].sort((a, b) => (visibleRect(b)?.left || 0) - (visibleRect(a)?.left || 0));

    // Tier 1：对话页顶栏。遍历全部同名候选并逐个校验，
    // 侧栏里的同名按钮（不在 <header> 内）会被跳过。
    for (const button of rightwardButtons) {
      if (!THREAD_ACTION_RE.test(button.getAttribute('aria-label') || '')) continue;
      const point = validateActionAnchor(button, false);
      if (point) return point;
    }
    // Tier 2：新对话页顶栏（匹配新建聊天/新标签页/面板切换等原生操作）。
    for (const button of rightwardButtons) {
      if (!isNewChatAction(button)) continue;
      const point = validateActionAnchor(button, true);
      if (point) return point;
    }
    // Tier 3：App Shell 工具栏。
    const shellPoint = resolveShellToolbarPoint(doc);
    if (shellPoint) return shellPoint;
    // Tier 4：分享按钮兜底（同样逐个校验）。
    for (const button of rightwardButtons) {
      if (!SHARE_ACTION_RE.test(button.getAttribute('aria-label') || button.textContent || '')) continue;
      const point = validateActionAnchor(button, false);
      if (point) return point;
    }
    // Tier 5：新版主页/工作台顶栏右侧按钮兜底（聊天/工作 Tab 右侧的新建[+]按钮）。
    const candidateButtons = rightwardButtons.filter(btn => {
      const h = btn.closest?.('header') || btn.closest?.('[data-app-shell-header-toolbar="true"]');
      const r = visibleRect(btn);
      return Boolean(h && r && r.left >= (typeof window !== 'undefined' ? window.innerWidth * 0.4 : 350));
    });
    if (candidateButtons.length > 0) {
      const point = validateActionAnchor(candidateButtons[0], true);
      if (point) return point;
    }
    return null;
  }
  // __MOUNT_POINT_LOGIC_END__

  function mountCapsule() {
    const point = resolveMountPoint();
    const existing = document.querySelector(HOST_TAG);
    if (!point) return false;
    if (existing?.isConnected) {
      host = existing;
      if (existing.parentElement !== point.container || existing.nextElementSibling !== point.reference) {
        point.container.insertBefore(existing, point.reference);
      }
      existing.dataset.placement = point.placement;
      if (point.placement === 'new-chat') {
        existing.style.setProperty('margin-left', 'auto');
        existing.style.setProperty('margin-right', '6px');
      } else {
        existing.style.removeProperty('margin-left');
        existing.style.setProperty('margin-right', '0px');
      }
      if (!existing.shadowRoot) existing.attachShadow({ mode: 'open' });
      bindHostEvents();
      renderHost();
      bindResizeObserver();
      updateMode();
      return true;
    }
    host = document.createElement(HOST_TAG);
    host.dataset.placement = point.placement;
    if (point.placement === 'new-chat') {
      host.style.setProperty('margin-left', 'auto');
      host.style.setProperty('margin-right', '6px');
    } else {
      host.style.removeProperty('margin-left');
      host.style.setProperty('margin-right', '0px');
    }
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
    if (mountCapsule()) { mountTimer = null; ensureMounted.attempt = 0; return; }
    mountTimer = setTimeout(ensureMounted, Math.min(2000, 180 + (++ensureMounted.attempt || 1) * 80));
  }

  function initObserver() {
    ensureMounted();
    mountObserver?.disconnect();
    const headerSelectors = 'header,[role="toolbar"],[data-app-shell-header-toolbar="true"],[data-app-shell-header-obstacle="true"]';
    const isHeaderMutation = record => {
      const target = record.target?.nodeType === 1 ? record.target : record.target?.parentElement;
      if (target?.closest?.(headerSelectors)) return true;
      const containsHeader = [...(record.addedNodes || []), ...(record.removedNodes || [])].some(node => {
        if (node.nodeType !== 1) return false;
        return node.matches?.(headerSelectors) || Boolean(node.querySelector?.(headerSelectors));
      });
      if (containsHeader) return true;
      if (target?.closest?.('main')) return false;
      return false;
    };
    mountObserver = new MutationObserver(records => {
      if (!records.some(isHeaderMutation)) return;
      suppressLegacyInstances();
      const point = resolveMountPoint();
      if (!host?.isConnected || (point && (host.parentElement !== point.container
        || host.nextElementSibling !== point.reference || host.dataset.placement !== point.placement))) ensureMounted();
    });
    mountObserver.observe(document.documentElement, { childList: true, subtree: true });
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = setInterval(() => { suppressLegacyInstances(); ensureMounted(); }, 3000);
  }

  window.__codexUsageHeaderRemount = ensureMounted;
  window.__codexUsageHeaderSetUsage__ = applyUsagePayload;
  window.__codexUsageHeaderSetRefreshError__ = applyRefreshError;
  window.__codexUsageHeaderSetUsageError__ = applyUsageError;

  function applyExtendedUsagePayload(payload) {
    if (!payload || typeof payload !== 'object') return;
    if (payload.antigravity && typeof payload.antigravity === 'object') {
      extendedUsageState.antigravity = {
        ...extendedUsageState.antigravity,
        ...payload.antigravity,
      };
    }
    if (payload.failover && typeof payload.failover === 'object') {
      extendedUsageState.failover = {
        ...extendedUsageState.failover,
        ...payload.failover,
      };
      failoverSwitching = false;
    }
    if (payload.tokens && typeof payload.tokens === 'object') {
      const savedRange = extendedUsageState.tokens.selectedRange ||
        readLocalSetting('codexQuotaHeader.selectedTokenRange') ||
        'today';
      const savedModel = extendedUsageState.tokens.selectedModel ||
        readLocalSetting('codexQuotaHeader.selectedTokenModel') || 'all';
      extendedUsageState.tokens = {
        ...extendedUsageState.tokens,
        ...payload.tokens,
        selectedRange: savedRange,
        selectedModel: savedModel,
      };
      const rangeData = extendedUsageState.tokens.ranges?.[savedRange];
      if (savedModel !== 'all' && rangeData && !hasTokenModelUsage(rangeData, savedModel)) {
        persistTokenModel('all');
        tokenModelMenuOpen = false;
      }
    }
    if (popover && popover.classList.contains('is-visible')) {
      renderPopover();
      positionPopover();
    }
  }

  window.__codexUsageHeaderSetExtendedUsage__ = applyExtendedUsagePayload;
  // 完整 teardown：清理全部定时器、document/window 监听器与 DOM，
  // 再由新版本判断内容哈希决定是否重装。重复注入不得叠加组件。
  window.__codexUsageHeaderTeardown__ = () => {
    if (mountTimer) clearTimeout(mountTimer);
    mountTimer = null;
    if (healthTimer) clearInterval(healthTimer);
    healthTimer = null;
    if (countdownTimer) clearInterval(countdownTimer);
    countdownTimer = null;
    if (layoutFrame) cancelAnimationFrame(layoutFrame);
    layoutFrame = null;
    clearRefreshTimers();
    offAllTrackedListeners();
    mountObserver?.disconnect();
    mountObserver = null;
    resizeObserver?.disconnect();
    resizeObserver = null;
    document.querySelector(HOST_TAG)?.remove();
    document.querySelectorAll('.' + POPOVER_CLASS).forEach(item => item.remove());
    document.getElementById('codex-usage-popover-style-v24')?.remove();
    // 旧版本遗留节点：仅隐藏不够，彻底移除
    LEGACY_COMPONENTS.forEach(tag => document.querySelectorAll(tag).forEach(el => el.remove()));
    document.querySelectorAll('[data-quota-capsule]').forEach(el => el.remove());
    if (hitAreaParent) {
      if (hitAreaParentStyle === null) hitAreaParent.removeAttribute('style');
      else hitAreaParent.setAttribute('style', hitAreaParentStyle);
    }
    hitAreaParent = null;
    hitAreaParentStyle = null;
    host = null;
    popover = null;
    window.__codexUsageHeaderInstalled__ = null;
    window.__codexUsageHeaderContentHash__ = null;
  };
  window.__codexUsageHeaderDebug__ = {
    getState: () => ({ ...usageState, refreshState, refreshRequestId, settings: { ...settings } }),
    getMode: () => currentMode,
    getAvailableWidth: () => measureAvailableWidth(host),
    getMountPoint: () => {
      const point = resolveMountPoint();
      if (!point) return null;
      const rect = visibleRect(point.reference);
      return { placement: point.placement, referenceX: rect ? Math.round(rect.left) : null };
    },
    showPopover: (options = {}) => showPopover({ immediate: true, ...options }),
    hidePopover: () => hidePopover(true),
    getExtendedState: () => ({ ...extendedUsageState }),
  };

  on(document, 'pointerdown', event => {
    const insideHost = host?.contains(event.target) || host?.shadowRoot?.contains(event.target);
    const insidePopover = popover?.contains(event.target);
    if (!insideHost && !insidePopover) hidePopover(true);
  }, true);
  on(document, 'keydown', event => {
    const modelButton = popover?.querySelector('.quota-extension-model-button');
    const modelOptions = [...(popover?.querySelectorAll('.quota-extension-model-option') || [])];
    if (tokenModelMenuOpen && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      const currentIndex = modelOptions.indexOf(document.activeElement);
      if (document.activeElement === modelButton || currentIndex >= 0) {
        event.preventDefault();
        const nextIndex = currentIndex < 0
          ? (event.key === 'ArrowDown' ? 0 : modelOptions.length - 1)
          : (currentIndex + (event.key === 'ArrowDown' ? 1 : -1) + modelOptions.length) % modelOptions.length;
        modelOptions[nextIndex]?.focus();
        return;
      }
    }
    if (event.key === 'Escape' && tokenModelMenuOpen) {
      tokenModelMenuOpen = false;
      renderPopover();
      positionPopover();
      popover?.querySelector('.quota-extension-model-button')?.focus();
      event.preventDefault();
      event.stopPropagation();
    } else if (event.key === 'Escape') {
      hidePopover(true);
    }
  }, true);
  on(window, 'resize', () => { updateMode(); positionPopover(); });
  on(window, 'scroll', positionPopover, true);
  on(window, 'focus', () => { if (!window.__codexUsageHeaderCommand__) requestUsage(); });
  on(window, 'storage', event => { if (event.key === SETTINGS_KEY) { settings = safeSettings(); renderAll(); } });

  if (document.readyState === 'loading') {
    on(document, 'DOMContentLoaded', () => { initObserver(); requestUsage(); });
  } else {
    initObserver();
    requestUsage();
  }
  countdownTimer = setInterval(updateCountdowns, 1000);

  window.__codexUsageHeaderInstalled__ = RUNTIME_VERSION;
  window.__codexUsageHeaderContentHash__ = CONTENT_HASH;
})();
