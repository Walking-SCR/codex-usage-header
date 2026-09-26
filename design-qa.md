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

## 2026-09-26：账号异常红点与通俗说明

- 本次视觉参考：`/var/folders/f0/52x8x6191fb4s_yfn9w1wfbr0000gn/T/codex-clipboard-240c6b46-530b-4e49-b9e2-502ef5b6de59.png`。
- 生产渲染器隔离预览：`http://127.0.0.1:4270/compare`，全部账号与错误均为模拟数据。
- 已检查正常绿色标记、503 认证不可用红点、403 验证异常和深色提示；不改变字体、其余配色、图标资产或路由排序。
- 新测试验证缓存不会掩盖认证失败、账号错误严格匹配、恢复清除红点、验证链接不进入渲染快照、异常账号可只读选中查看。21/21 套测试通过。
- 当时的阻断：系统盘剩余约 163MB，预览保存失败。此后可用空间恢复至约 3.6GB，本次安装完成；未通过删除用户文件释放空间。
- 对比归档：`audit/2026-09-26-account-health/comparison.png`（1280 × 1000）；英文窄屏：`audit/2026-09-26-account-health/narrow-en.png`（480 × 900）。异常红点与选中高亮独立，点选账号仅查看统计，不改变调用优先级。

## 2026-09-26：Codex 26.924 更新适配

- 实机确认内置 CLI 从 `Contents/Resources/codex` 移至 `Contents/Resources/codex-cli/bin/codex`，版本为 `codex-cli 0.158.0-alpha.2`。新版路径已经成功完成初始化并读取额度。
- Work 页面仍使用 `app://-/index.html`，并非已证实的独立 renderer 问题。实际原因是原生操作按钮外新增两层 `display: contents` 包装，旧挂载逻辑读取了零尺寸容器。
- 新逻辑跳过透明布局包装，保留顶栏尺寸与位置校验；明确的 App Shell 工具栏可作为无 `header` 场景的安全锚点。目标筛选仍排除付款、头像与独立窗口。
- 合并安装目录已有热修复的 RPC 参数兼容、有限重连和 CDP 注入重试；没有回退源码新版 Token 界面。失败提示结束首次加载，已有额度快照保留；不向页面推送原始 stderr 或 RPC 错误数据。
- `npm test`：24/24 套通过；新增路径、并发初始化、断线重建、旧 RPC 参数与首次失败/缓存失败的行为回归。语法检查与 `git diff --check` 通过。
- 已在运行中的 Work 页面热更新，无需重启桌面应用。原生页面只读检查：组件数量 1，挂载 `thread`，高度 34px，父容器为 `flex`；用量状态 `ready`，连接 `initialized: true`、`lastError: null`。组件右边缘与同一操作组原生按钮间距 6px，无遮挡。
- 本次没有自动操作原生窗口中的账号、路由或模块设置；原生窗口点击/悬停未自动验证，交互行为由生产渲染器预览及测试覆盖。

## 2026-09-26：新版实机全功能回归

- `npm test`：24/24 套通过；包含新版 CLI 路径发现、App Server 初始化/断线重连、RPC 新旧参数兼容、CDP 超时重试、Work 顶栏挂载、失败状态提示、账号健康和 Token 聚合。
- `test/live-renderer.test.mjs` 与 `test/interactive-v3.test.mjs` 均在 Codex 26.924 实际 renderer 运行通过：五种视口宽度、胶囊展开/收起、悬停卡片、语言切换、额度刷新、重置券、Google/Claude 折叠、Token 周期与模型、模块显隐、账号仅查看切换、账号名称遮罩。
- 修正了旧实机断言：模型筛选时比较全局总量与模型小计、误期望胶囊留缝、误用旧账号标签和旧布局间距。生产 UI 未因测试而改动。
- 实机回归截图存于忽略跟踪的 `audit/2026-09-26-live-regression/04-implementation-wide-popover.png`；既有验收截图未覆盖。
- 测试后恢复窄屏模拟、收起弹卡并恢复模块可见状态；Codex App Server 仍为已初始化、额度为 ready。未改动账号路由或优先级。

final result: passed
