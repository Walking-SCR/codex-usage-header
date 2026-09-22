 /**
  * Codex Quota Header 工具函数
  */
 
 /**
  * 将秒数形式的剩余时间格式化为易读的时长
  * @param {number} seconds - 距离重置的秒数
  * @param {boolean} includeDays - 是否在多日窗口中包含天数
  * @returns {string} 例如 "2h 15m" 或 "3d 14h 20m"
  */
 export function formatCountdown(seconds, includeDays = false, maxSeconds = null) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return '即将重置';
  }
  let sec = Math.max(0, seconds);
  if (Number.isFinite(maxSeconds) && maxSeconds > 0) sec = Math.min(maxSeconds, sec);

  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);

  if (includeDays && d > 0) {
    return h > 0 ? `${d}d ${h}h ${m}m` : `${d}d ${m}m`;
  }
  if (h > 0) {
    return m > 0 ? `${h}h ${m}m` : `${h}h`;
  }
  return `${Math.max(1, m)}m`;
}
 
 /**
  * 格式化额度重置时间（例如 "16:30" 或 "周一 08:00"）
  * @param {number} timestamp - 以秒为单位的 Unix 时间戳
  * @returns {string}
  */
 export function formatResetClock(timestamp) {
   if (!Number.isFinite(timestamp) || timestamp <= 0) return '--:--';
   const date = new Date(timestamp * 1000);
   const now = new Date();
   const isSameDay = date.toDateString() === now.toDateString();
   const hh = String(date.getHours()).padStart(2, '0');
   const mm = String(date.getMinutes()).padStart(2, '0');
 
   if (isSameDay) {
     return `${hh}:${mm}`;
   }
   const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
   return `${weekdays[date.getDay()]} ${hh}:${mm}`;
 }
 
 /**
  * 根据可用宽度确定响应式显示模式
  * @param {number} width - 容器中的可用像素宽度
  * @returns {'full' | 'compact' | 'minimal' | 'nano'}
  */
export function resolveAdaptiveMode(width, currentMode = null, hysteresis = 24) {
  const baseMode = value => {
    if (!Number.isFinite(value) || value >= 520) return 'full';
    if (value >= 340) return 'compact';
    if (value >= 210) return 'minimal';
    return 'nano';
  };
  if (!currentMode) return baseMode(width);
  if (currentMode === 'full' && width >= 520 - hysteresis) return 'full';
  if (currentMode === 'compact' && width >= 340 - hysteresis && width < 520 + hysteresis) return 'compact';
  if (currentMode === 'minimal' && width >= 210 - hysteresis && width < 340 + hysteresis) return 'minimal';
  if (currentMode === 'nano' && width < 210 + hysteresis) return 'nano';
  return baseMode(width);
}
 
 /**
  * 将多种后端结构的限额数据归一化
  * 同时支持 /backend-api/wham/usage 和 account/rateLimits/read
  */
 export function normalizeUsagePayload(raw) {
   if (!raw || typeof raw !== 'object') return null;
 
  // 处理 /backend-api/wham/usage 返回的嵌套 rate_limit
   const root = raw.rate_limit || raw.rateLimits || raw;
   const primary = root.primary_window || root.primary || root.primaryWindow || null;
   const secondary = root.secondary_window || root.secondary || root.secondaryWindow || null;
 
   function parseWindow(win, maxSeconds = null) {
     if (!win) return null;
     const usedPercent = Number(win.used_percent ?? win.usedPercent ?? 0);
     const remainingPercent = Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
     const resetsAt = Number(win.reset_at ?? win.resetsAt ?? 0);
     const nowSec = Math.floor(Date.now() / 1000);
     let secondsRemaining = Math.max(0, resetsAt > 0 ? resetsAt - nowSec : (win.reset_after_seconds ?? 0));
     if (Number.isFinite(maxSeconds) && maxSeconds > 0) {
       secondsRemaining = Math.min(maxSeconds, secondsRemaining);
     }
     return {
       usedPercent: Math.round(usedPercent),
       remainingPercent,
       secondsRemaining,
       resetsAt,
     };
   }
 
  const primaryWindow = parseWindow(primary, 5 * 3600);
  const secondaryWindow = parseWindow(secondary, 7 * 86400);
  const effectivePrimaryWindow = primaryWindow && secondaryWindow?.remainingPercent === 0
    ? { ...primaryWindow, usedPercent: 100, remainingPercent: 0 }
    : primaryWindow;
   const resetCredits = Number(raw.rateLimitResetCredits ?? raw.rate_limit_reset_credits ?? 0);
 
   return {
    primary: effectivePrimaryWindow,
     secondary: secondaryWindow,
     resetCredits: Number.isFinite(resetCredits) ? resetCredits : 0,
     timestamp: Date.now(),
   };
 }
