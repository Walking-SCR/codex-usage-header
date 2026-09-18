 /**
  * Codex Quota Header Configuration
  */
 export const defaultConfig = {
   // Active window refresh interval in seconds
   refreshIntervalSeconds: 30,
 
   // Inactive/hidden window fallback refresh interval in seconds
   idleRefreshIntervalSeconds: 180,
 
   // Minimum time in ms between manual refresh button clicks
   debounceCooldownMs: 5000,
 
  // The UI and progress bars consistently describe remaining quota.
  displayMode: 'remaining',
 
   // Apple Human Interface Guidelines (HIG) Colors
   colors: {
     light: {
       green: '#34C759',   // Remaining >= 40%
       yellow: '#FF9500',  // Remaining 20% - 40% (Apple Battery Low Power Amber)
       red: '#FF3B30',     // Remaining < 20%
       purple: '#AF52DE',  // 7d weekly window
       bgTrack: 'rgba(0, 0, 0, 0.08)',
       capsuleBg: 'rgba(255, 255, 255, 0.88)',
       capsuleBorder: 'rgba(0, 0, 0, 0.08)',
       textPrimary: '#1D1D1F',
       textSecondary: '#86868B',
     },
     dark: {
       green: '#30D158',
       yellow: '#FFD60A',
       red: '#FF453A',
       purple: '#BF5AF2',
       bgTrack: 'rgba(255, 255, 255, 0.12)',
       capsuleBg: 'rgba(30, 30, 30, 0.85)',
       capsuleBorder: 'rgba(255, 255, 255, 0.12)',
       textPrimary: '#F5F5F7',
       textSecondary: '#A1A1A6',
     },
   },
 
   // Breakpoints for 4-tier adaptive responsive modes
  breakpoints: {
    full: 520,
    compact: 330,
    minimal: 190,
    nano: 140,
    hysteresis: 20,
  },
};
 
 export function resolveTheme(isDark = false) {
   return isDark ? defaultConfig.colors.dark : defaultConfig.colors.light;
 }
 
 export function getQuotaColor(remainingPercent, isDark = false) {
   const palette = resolveTheme(isDark);
   if (remainingPercent <= 20) return palette.red;
   if (remainingPercent <= 40) return palette.yellow;
   return palette.green;
 }
