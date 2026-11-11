import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getAccountHealth } from '../account-health.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '../..');
const ASSET_DIR = join(ROOT, 'assets');
const DESIGN_DIR = join(ASSET_DIR, 'ui-quota');
const INJECTED_PATH = join(ROOT, 'src', 'injected.js');

const DESIGN_ICONS = {
  logo: 'icons/common/app-logo.svg',
  refresh: 'icons/header/refresh.svg',
  clock: 'icons/quota/clock.svg',
  calendar: 'icons/quota/calendar.svg',
  coupon: 'icons/coupon/coupon.svg',
  lightning: 'icons/coupon/lightning.svg',
  info: 'icons/coupon/info.svg',
  sparkle: 'icons/google-ai-pro/sparkle.svg',
  eye: 'icons/common/eye.svg',
  chevronDown: 'icons/common/chevron-down.svg',
  tokenChart: 'icons/token/token-chart.svg',
  couponWave: 'backgrounds/coupon-wave.svg',
};

function readIconDataUrl(name) {
  const data = readFileSync(join(ASSET_DIR, `${name}.svg`));
  return `data:image/svg+xml;base64,${data.toString('base64')}`;
}

function readImageDataUrl(name, extension, mimeType) {
  const data = readFileSync(join(ASSET_DIR, `${name}.${extension}`));
  return `data:${mimeType};base64,${data.toString('base64')}`;
}

const icons = {
  refresh: readIconDataUrl('refresh'),
  database: readIconDataUrl('database'),
  clock: readIconDataUrl('clock'),
  resetCredit: readImageDataUrl('reset-credit', 'png', 'image/png'),
};

const designIcons = Object.fromEntries(
  Object.entries(DESIGN_ICONS).map(([key, path]) => {
    const data = readFileSync(join(DESIGN_DIR, path));
    return [key, `data:image/svg+xml;base64,${data.toString('base64')}`];
  })
);

const designCss = readFileSync(join(DESIGN_DIR, 'design.css'), 'utf8');
const injectedJs = readFileSync(INJECTED_PATH, 'utf8');

const html = `<!doctype html>
<html lang="zh-CN" class="dark">
<head>
  <meta charset="utf-8">
  <title>Claude Quota Overlay</title>
  <style>
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      width: 100%;
      height: 100%;
      background: transparent !important;
      overflow: hidden;
      user-select: none;
      -webkit-user-select: none;
      font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "SF Pro Text", "Segoe UI Variable Text", sans-serif;
    }
    #overlay-root {
      position: absolute;
      top: 0;
      right: 0;
      display: flex;
      align-items: center;
      justify-content: flex-end;
      padding-top: 3px;
      padding-right: 4px;
      background: transparent;
      z-index: 10;
    }
  </style>
</head>
<body>
  <div id="overlay-root"></div>

  <script>
    window.__forceMountTarget = document.getElementById('overlay-root');
    window.__codexUsageHeaderAccountHealth__ = ${getAccountHealth.toString()};
    window.__codexUsageHeaderIcons__ = ${JSON.stringify(icons)};
    window.__codexUsageHeaderDesignIcons__ = ${JSON.stringify(designIcons)};
    window.__codexUsageHeaderDesignCSS__ = ${JSON.stringify(designCss)};
    window.__codexUsageHeaderSource__ = ${JSON.stringify(ROOT)};
    window.__codexUsageHeaderInitialSnapshot__ = null;

    localStorage.setItem('codexQuotaHeader.settings.v1', JSON.stringify({
      locale: 'zh-CN',
      enableGoogleAiPro: true,
      enableTokenUsage: true,
      enableResetCredits: true,
      maskAccountNames: true
    }));
  </script>
  <script>
    ${injectedJs}
  </script>
  <script>
    let isCurrentlyExpanded = false;

    function checkAndNotify() {
      const popover = document.querySelector('.codex-usage-popover-v24');
      const expanded = Boolean(popover && popover.classList.contains('is-visible'));
      const host = document.querySelector('codex-usage-header-host');
      const capsule = host?.shadowRoot?.querySelector('.capsule');
      const rect = capsule?.getBoundingClientRect();
      const capsuleW = rect ? Math.ceil(rect.width) : 368;
      const capsuleH = rect ? Math.ceil(rect.height) : 34;
      if (expanded) {
        isCurrentlyExpanded = true;
        try {
          window.webkit?.messageHandlers?.overlay?.postMessage({
            expanded: true,
            width: 606,
            height: 670,
            capsuleWidth: capsuleW,
            capsuleHeight: capsuleH
          });
        } catch (e) {}
      } else {
        isCurrentlyExpanded = false;
        const finalW = Math.max(46, Math.min(410, capsuleW + 8));
        const finalH = Math.max(36, Math.min(44, capsuleH + 8));
        try {
          window.webkit?.messageHandlers?.overlay?.postMessage({
            expanded: false,
            width: finalW,
            height: finalH,
            capsuleWidth: capsuleW,
            capsuleHeight: capsuleH
          });
        } catch (e) {}
      }
    }

    const observer = new MutationObserver(() => {
      checkAndNotify();
    });

    observer.observe(document.body, { attributes: true, subtree: true, attributeFilter: ['class'] });

    window.__setOverlayRightInset = function(rightInset) {
      const rootEl = document.getElementById('overlay-root');
      if (rootEl) rootEl.style.paddingRight = (4 + Math.max(0, Number(rightInset) || 0)) + 'px';
    };

    window.__setClaudeLayout = function(availableWidth, windowWidth, rightInset) {
      let changed = false;
      if (Number.isFinite(availableWidth) && window.__claudeAvailableWidth !== availableWidth) {
        window.__claudeAvailableWidth = availableWidth;
        changed = true;
      }
      if (Number.isFinite(windowWidth) && window.__claudeWindowWidth !== windowWidth) {
        window.__claudeWindowWidth = windowWidth;
        changed = true;
      }
      if (Number.isFinite(rightInset)) {
        window.__setOverlayRightInset(rightInset);
      }
      if (changed) {
        if (window.__codexUsageHeaderRelayout) window.__codexUsageHeaderRelayout();
        else window.__codexUsageHeaderRemount?.();
        checkAndNotify();
      }
    };

    window.__setClaudeWidth = function(width) {
      if (window.__claudeWindowWidth === width) return;
      window.__claudeWindowWidth = width;
      if (window.__codexUsageHeaderRelayout) window.__codexUsageHeaderRelayout();
      else window.__codexUsageHeaderRemount?.();
      checkAndNotify();
    };

    window.__setTheme = function(isDark) {
      const root = document.documentElement;
      if (isDark) {
        root.classList.add('dark');
        root.classList.remove('light');
      } else {
        root.classList.remove('dark');
        root.classList.add('light');
      }
      window.__codexUsageHeaderRemount?.();
    };

    window.__updateFromStatusFile = function(data) {
      if (!data) return;
      if (data.codex?.value) {
        window.__codexUsageHeaderSetUsage__?.(data.codex.value, { fetchedAt: data.codex.fetchedAt });
      }
      if (data.extended) {
        window.__codexUsageHeaderSetExtendedUsage__?.(data.extended);
      }
      requestAnimationFrame(checkAndNotify);
    };
  </script>
</body>
</html>
`;

writeFileSync(join(__dirname, 'overlay.html'), html, 'utf8');
console.log('✓ overlay.html generated successfully!');
