 /**
  * Utility functions for Codex Quota Header
  */
 
 /**
  * Formats remaining time in seconds into human-readable duration
  * @param {number} seconds - Seconds until reset
  * @param {boolean} includeDays - Whether to include days for multi-day windows
  * @returns {string} e.g. "2h 15m" or "3d 14h 20m"
  */
 export function formatCountdown(seconds, includeDays = false) {
   if (!Number.isFinite(seconds) || seconds <= 0) {
     return '即将重置';
   }
 
   const d = Math.floor(seconds / 86400);
   const h = Math.floor((seconds % 86400) / 3600);
   const m = Math.floor((seconds % 3600) / 60);
 
   if (includeDays && d > 0) {
     return `${d}d ${h}h ${m}m`;
   }
   if (h > 0) {
     return `${h}h ${m}m`;
   }
   return `${Math.max(1, m)}m`;
 }
 
 /**
  * Formats clock reset time (e.g. "16:30" or "周一 08:00")
  * @param {number} timestamp - Unix timestamp in seconds
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
  * Determines the responsive display mode based on available width
  * @param {number} width - Available pixel width in container
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
  * Normalizes rate limit data from multiple backend shapes
  * Handles both /backend-api/wham/usage and account/rateLimits/read
  */
 export function normalizeUsagePayload(raw) {
   if (!raw || typeof raw !== 'object') return null;
 
   // Handle nested rate_limit from /backend-api/wham/usage
   const root = raw.rate_limit || raw.rateLimits || raw;
   const primary = root.primary_window || root.primary || root.primaryWindow || null;
   const secondary = root.secondary_window || root.secondary || root.secondaryWindow || null;
 
   function parseWindow(win) {
     if (!win) return null;
     const usedPercent = Number(win.used_percent ?? win.usedPercent ?? 0);
     const remainingPercent = Math.max(0, Math.min(100, Math.round(100 - usedPercent)));
     const resetsAt = Number(win.reset_at ?? win.resetsAt ?? 0);
     const nowSec = Math.floor(Date.now() / 1000);
     const secondsRemaining = Math.max(0, resetsAt > 0 ? resetsAt - nowSec : (win.reset_after_seconds ?? 0));
 
     return {
       usedPercent: Math.round(usedPercent),
       remainingPercent,
       secondsRemaining,
       resetsAt,
     };
   }
 
   const primaryWindow = parseWindow(primary);
   const secondaryWindow = parseWindow(secondary);
   const resetCredits = Number(raw.rateLimitResetCredits ?? raw.rate_limit_reset_credits ?? 0);
 
   return {
     primary: primaryWindow,
     secondary: secondaryWindow,
     resetCredits: Number.isFinite(resetCredits) ? resetCredits : 0,
     timestamp: Date.now(),
   };
 }
