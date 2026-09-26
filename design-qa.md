# Design QA — quota panel refinements (2026-09-25)

## Comparison setup

- Source images for this pass: `/var/folders/f0/52x8x6191fb4s_yfn9w1wfbr0000gn/T/codex-clipboard-eacfaaaf-e52b-4c49-8bbe-01065e627887.png` (1228 × 1466) and `/var/folders/f0/52x8x6191fb4s_yfn9w1wfbr0000gn/T/codex-clipboard-1da0c945-6a06-48e0-b1a1-a85b4d148484.png` (1226 × 582); packaged reference: `assets/ui-quota/reference/dashboard-reference.png` (1085 × 1450).
- Side-by-side renderer capture: `http://127.0.0.1:4197/compare` in the Codex in-app Browser; the implementation uses clearly labeled synthetic data.
- Viewport: 1280 × 720 CSS px, DPR 1. The comparison frame displays source panels at 590px wide and the implementation at the matching 590px panel width. The dropdown caps at 590px and dynamically limits height to free space around its trigger.
- State: light theme, Chinese locale, all modules visible, Google/Claude section expanded, Token summary selected.

## Findings

No actionable P0, P1, or P2 differences remain for the requested compact dropdown.

- Removed the redundant “5小时额度 / 每周额度” captions.
- Shortened quota rows from 51px to 38px, reset cards from 70px to 52px, and provider rows from 31px to 24px, with matching reductions to icon and padding sizes.
- Reset cards remain three-across on one row; the narrow layout scrolls horizontally instead of moving a card to a second row.
- The Google chevron now hides only Claude rows. Gemini 5h/7d remain visible. “Claude & GPT 5h/7d” is displayed as “Claude 5h/7d”.
- Full model IDs are allowed to wrap. Token rows read name → shorter bar → percentage → amount; the summary selector sits beside period tabs in the section header.
- The 590px dropdown uses its previous maximum-height behavior, now further bounded by free space below/above the header capsule. Overflow remains inside the card, not over the toolbar.
- Top three buttons directly toggle reset credits, Google AI Pro, and Token usage; each uses the same SVG at 24px as its section heading. Their compact hit targets are 36px square. Refresh remains separate. The Claude disclosure uses a 36px target with a centered 24px arrow.
- Latest screenshot pass: added the missing 22px usage-heading icon; the reset-credit, Google, and Token section icons are 22px. The 5h/7d row icons and reset-card bolt icons are 18px.
- Fixed the reorder tooltip overlap by removing its duplicate native title tooltip and moving the full hover/focus explanation into normal layout flow beneath the Google header. This reserves space and pushes the quota rows down instead of covering the reset cards or usage rows. The reorder button keeps its full accessible label.

## Responsive and interaction verification

- `npm test`: 19/19 suites passed.
- In the isolated production-renderer preview, toggled all three modules off/on; the matching sections disappeared and returned. Collapsing the Claude disclosure hid Claude rows while retaining both Gemini rows.
- Selected Gemini from the model dropdown and verified the full `gemini-3.8-flash-preview` model ID; the row's percentage precedes its token amount.
- Side-by-side inspection covered the 590px desktop dropdown. The 480px narrow state was also inspected: no horizontal page overflow, cards stay in one horizontal scroller, and content scrolls within the height cap.
- The three header module icons, their section-title counterparts, and the Claude disclosure arrow render at 24px. Header controls and the disclosure target are 36px, preserving a visible inset around each icon.
- `npm test`: 19/19 suites passed; `git diff --check` passed. The browser comparison confirms the icon sizes and filled usage-icon slot. UI contract tests verify that the tooltip is in normal flow and opens on hover/focus; native-window live-account hover was not automated.
- Installed runtime after sync: `mountedCount: 1`, `failedCount: 0`; monitor is running. Live-account UI interactions were not automated in the native Codex window; visual and interaction tests used the same production renderer with synthetic data.

## Fidelity surfaces

- Typography: removed duplicate copy; reduced labels/countdowns remain readable; full model IDs wrap instead of truncating.
- Layout: quota, reset, and provider areas are shorter; reset cards are one row; dropdown selector aligns with period tabs; popover avoids covering its trigger.
- Colors: existing remaining-quota green/amber/red thresholds and Token palette retained.
- Assets: supplied local SVG assets reused; top controls match their corresponding module icons.
- Copy and behavior: reset wording stays unchanged; Claude display label and disclosure scope match the request.

## Comparison history

1. Prior screen had duplicate 5h/7d subtitles and tall rows/cards; removed captions and reduced key row heights about one quarter.
2. The earlier chevron collapsed all Google rows; changed it to affect Claude-only rows and renamed those labels.
3. Verified final expanded and collapsed states, three-card row, full model ID, percent/amount order, and adaptive dropdown height in the comparison preview.

Follow-up P3: day-over-day Token trend remains omitted because the local source has no previous-period comparison metric.

final result: passed
