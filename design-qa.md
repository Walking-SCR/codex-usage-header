# Design QA — Codex Quota Header

- Source visual truth: `/Users/scr/Documents/Codex/2026-09-18/ni/outputs/codex-usage-header/audit/2026-09-18-quota-header/03-target-design.png`
- Implementation screenshot: `/Users/scr/Documents/Codex/2026-09-18/ni/outputs/codex-usage-header/audit/2026-09-18-quota-header/04-implementation-wide-popover.png`
- Normalized implementation: `/Users/scr/Documents/Codex/2026-09-18/ni/outputs/codex-usage-header/audit/2026-09-18-quota-header/05-implementation-normalized.png`
- Combined comparison: `/Users/scr/Documents/Codex/2026-09-18/ni/outputs/codex-usage-header/audit/2026-09-18-quota-header/comparison.html`
- Source pixels: 1444 × 308
- Implementation pixels: 2880 × 1640
- CSS viewport: 1440 × 820
- Device pixel ratio: 2 for the captured Electron surface
- Density normalization: implementation downsampled to 1440 × 820; source and implementation compared at approximately equal CSS width
- State: light theme, Full header mode, details card open, live remaining-quota data

## Findings

No actionable P0, P1, or P2 differences remain.

- The component is inserted before the native Chat Actions button and preserves a 6px gap. The native button remains visible and clickable at every tested width.
- The header keeps a fixed 34px height and transitions through Full, Compact, Minimal, and Nano without overlap or mode oscillation.
- The details card matches the target hierarchy: two quota rows, progress tracks, reset-credit row, divider rhythm, and last-updated row.
- The source uses consumed-quota wording. The implementation intentionally uses remaining-quota percentages, progress widths, and copy because the user explicitly requested that product behavior.
- The source and implementation use the same compact system-font hierarchy and neutral Apple-style surface treatment. The implementation uses Codex-native density so it remains optically aligned with the 46px desktop toolbar.
- Semantic colors are intentional: healthy remaining quota is green, 11–20% is amber, and 0–10% is red. Normal reset text remains neutral instead of always red.
- Refresh, database, and clock artwork are packaged Heroicons assets rather than text glyphs or CSS-drawn substitutes. They render sharply at the desktop device scale.
- Copy is complete and coherent: remaining percentage, exact reset time, distance to reset, reset-credit count, and last update time are all visible.

## Responsive And Interaction Evidence

`npm run test:live` passed against the running Codex renderer:

| Viewport | Mode | Host width | Height | Internal gap | Track height | Gap to native More | Overlap |
| --- | --- | ---: | ---: | ---: | ---: | ---: | --- |
| 1440px | Full | 406.84px | 34px | 5px | 12px | 6px | No |
| 1100px | Compact | 298.28px | 34px | 5px | 12px | 6px | No |
| 900px | Minimal | 165.70px | 34px | 5px | 12px | 6px | No |
| 760px | Nano | 90.70px | 34px | 5px | hidden | 6px | No |

Verified interactions:

- Pointer enter opens the details card.
- Moving from the capsule into the card keeps it open; leaving both closes it.
- Clicking the capsule toggles the details card open and closed.
- Enter opens the card and Escape closes it.
- The card uses fixed positioning, accepts pointer events, and remains within the viewport.
- Refresh enters a disabled, `aria-busy` loading state with `quota-refresh-spin` animation.
- Refresh exits loading only after a new acknowledged payload is received and then shows success.
- Reduced-motion CSS disables rotation while preserving state feedback.

## Required Fidelity Surfaces

- Fonts and typography: passed. System UI stack, compact weights, tabular quota digits, and single-line reset copy are consistent with the target and Codex chrome.
- Spacing and layout rhythm: passed. Capsule height, progress-bar thickness, card padding, row spacing, dividers, corner radius, and elevation are coherent and stable.
- Colors and tokens: passed. Neutral copy and semantic quota colors replace the former always-red values.
- Image quality and asset fidelity: passed. All three visible icons use packaged vector assets and render at their intended sizes.
- Copy and content: passed with the user-requested remaining-quota semantic deviation documented above.

## Comparison History

1. Initial implementation had a P0 fixed-position fallback that could cover native actions, a non-positioned popover wrapper, always-red remaining text, and a timer-only refresh animation. These were replaced with safe header insertion, a fixed portal, semantic colors, and an acknowledged refresh state machine.
2. First live visual pass found a P1 invisible refresh icon caused by an unsupported mask rendering path. The icon was changed to a packaged image asset.
3. Second live pass found a P1 missing CSS brace that nested refresh styles under the divider. The rule was closed, the icon became visible at 17px, and the loading animation was verified from computed style.
4. Final full-view and focused-region comparison found no remaining P0/P1/P2 issues.
5. Follow-up visual calibration tightened the internal 5h/7d rhythm from 7px to 5px, removed the divider's extra side margins, and set the header and card progress tracks to 12px to match the reference weight. The live screenshot and focused header/card comparison show the tighter spacing without changing remaining-quota semantics or native-button clearance.
6. The interaction repair introduced runtime component v23 and explicitly marks the titlebar host, capsule, refresh button, and details card as Electron `no-drag` regions. It also supports the new-chat right-side control group as a safe mount anchor, excluding hidden duplicate toolbar layers. The final live pass verifies v23, the 12px track, 5px internal gap, Nano-mode track hiding, real mouse hover opening, card pointer-bridge retention, click toggling, refresh loading/success feedback, and the source-level Escape dismissal contract.

## Follow-up Polish

- P3: If a future Codex release changes toolbar density, remeasure the 34px capsule against the new native toolbar before changing dimensions.

final result: passed
