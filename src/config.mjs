 /**
  * Codex Quota Header 配置
  */
 export const defaultConfig = {
  // 活跃窗口的刷新间隔，单位为秒
   refreshIntervalSeconds: 30,
 
  // 非活跃或隐藏窗口的备用刷新间隔，单位为秒
   idleRefreshIntervalSeconds: 180,
 
  // 手动刷新按钮两次点击之间的最短间隔，单位为毫秒
   debounceCooldownMs: 5000,
 
  // 界面和进度条统一表示剩余额度。
  displayMode: 'remaining',
 
  // Apple 人机界面指南（HIG）配色
   colors: {
     light: {
       green: '#34C759',   // Remaining 41% - 100%
       yellow: '#FF9500',  // Remaining 11% - 40% (Apple Battery Low Power Amber)
       red: '#FF3B30',     // Remaining 0% - 10%
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
 
  // 四级自适应响应模式的断点
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
   if (remainingPercent <= 10) return palette.red;
   if (remainingPercent <= 40) return palette.yellow;
   return palette.green;
 }
