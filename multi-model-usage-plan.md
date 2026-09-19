# 多模型额度与 Token 用量扩展方案

## 1. 方案状态

本文档是 `codex-usage-header` 的最新完整实现方案，目标是在不改变现有下拉卡片内容、样式和交互的前提下，在卡片底部增加：

- Gemini AI Pro 剩余额度；
- 当天、近 7 日、近 30 日 Token 处理量；
- GPT、Gemini 以及其他模型的用量占比。

本方案以低成本、低内存、低 CPU、少代码和低回归风险为优先级，不引入数据库、图表库或新的运行时依赖。

## 2. 设计原则

1. 原有 Codex 卡片保持不变，包括现有数据结构、文案、布局、重置券、额度余额、重置卡、语言切换、刷新动画、悬停和点击行为。
2. 新功能只追加在现有卡片底部，使用独立状态、独立样式和独立错误处理。
3. 卡片打开、悬停和时间范围切换时不读取文件、不访问网络。
4. Gemini 配额低频拉取并缓存；Token 数据只增量解析。
5. 不修改当前 `8318 → 8317 → Antigravity` 路由链路。
6. 不读取或向页面传递 OAuth Token、管理密钥和账号原始信息。
7. 新功能异常时，现有 Codex 卡片仍须正常显示和操作。

## 3. 最终下拉卡片结构

现有卡片完整保留，只在末尾增加两个区域：

```text
┌────────────────────────────────────────────────────┐
│ 当前插件已经实现的全部内容                           │
│                                                    │
│ · 标题、语言切换、刷新                              │
│ · Codex 5 小时/7 天额度                             │
│ · 额度重置券、额度余额                              │
│ · 现有重置卡片                                      │
│                                                    │
│ 以上内容、样式和交互不修改                          │
├────────────────────────────────────────────────────┤
│ Gemini AI Pro                                      │
│ Gemini 5h      [======  ] 68% · 1h32min后重置      │
│ Gemini 7d      [======  ] 68% · 4天后重置          │
│ Claude&GPT 7d  [======  ] 68% · 4天后重置          │
├────────────────────────────────────────────────────┤
│ Token处理量                                         │
│ [今天] [近7日] [近30日]                             │
│                                                    │
│ 总计           1.92M                               │
│ GPT            1.28M    66.7%                      │
│ Gemini         0.64M    33.3%                      │
└────────────────────────────────────────────────────┘
```

### 3.1 原有区域保护规则

不得修改：

- 现有 `usageState` 字段及其含义；
- Codex 额度读取和换算逻辑；
- 额度重置券和额度余额显示；
- 重置卡片的文案、图标、布局和到期时间；
- 现有中英文切换逻辑；
- 悬停打开、移出关闭和点击固定逻辑；
- 刷新按钮的动画、成功和错误状态；
- 原有 CSS 类名及其选择器。

渲染时保留现有函数，将新增内容追加到现有内容末尾：

```js
const existingMarkup = renderExistingCard();
const extensionMarkup = renderExtendedUsage();

return existingMarkup + extensionMarkup;
```

不能为了新增功能整体重写现有卡片。

## 4. 最小技术架构

```text
CLIProxyAPI Management API
          │
          ▼
 GeminiQuotaCache ───────────────┐
                                 │
Codex rollout JSONL              │
          │                      │
          ▼                      ▼
   TokenRollup ───────────→ 扩展内存快照
                                 │
                                 ▼
                  monitor → CDP → 下拉卡片扩展区域
```

### 4.1 文件范围

新增：

```text
src/extended-usage.mjs
```

修改：

```text
src/monitor.mjs
src/injected.js
src/config.mjs
test/run-tests.mjs
```

`extended-usage.mjs` 同时承担：

- Gemini 配额读取和缓存；
- Token 日志增量解析；
- 最近 32 天的每日聚合；
- 首次历史回填 Worker 入口；
- 提供脱敏的扩展数据快照。

不新增：

- SQLite；
- 第三方 npm 包；
- 图表库；
- 常驻 Worker；
- Router 响应解析；
- 单次调用明细数据库；
- 通用 Provider 插件框架。

## 5. 扩展状态隔离

新增独立状态，不把 Gemini 和 Token 字段混入现有 `usageState`：

```js
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
    selectedRange: 'today',
    ranges: {
      today: null,
      days7: null,
      days30: null,
    },
    coverageStartedAt: null,
    error: null,
  },
};
```

新增独立的页面注入接口：

```js
window.__codexUsageHeaderSetExtendedUsage__ = payload => {
  extendedUsageState = normalizeExtendedUsage(payload);
  renderExtensionOnly();
};
```

不得改变现有接口的参数或语义：

```js
window.__codexUsageHeaderSetUsage__
```

## 6. Gemini AI Pro 配额

### 6.1 数据来源

复用本机 CLIProxyAPI 管理接口：

```text
GET  http://127.0.0.1:8317/v0/management/auth-files
POST http://127.0.0.1:8317/v0/management/api-call
```

通过 `api-call` 请求：

```text
POST https://daily-cloudcode-pa.googleapis.com/v1internal:retrieveUserQuotaSummary
```

主要解析字段：

```text
groups[].displayName
groups[].buckets[].window
groups[].buckets[].remainingFraction
groups[].buckets[].resetTime
```

后台只向渲染层传递规范化后的百分比、重置时间、显示名称和更新时间。管理密钥、OAuth Token、凭证文件内容和完整账号信息不能进入 CDP payload。

### 6.2 固定显示顺序

```text
Gemini 5h
Gemini 7d
Claude&GPT 7d
```

匹配规则：

| UI 名称 | 分组匹配 | 时间窗口匹配 |
| --- | --- | --- |
| Gemini 5h | Gemini 分组 | `5h`、`five-hour`、`five_hour` |
| Gemini 7d | Gemini 分组 | `7d`、`weekly`、`week` |
| Claude&GPT 7d | Claude、GPT 或共享分组 | `7d`、`weekly`、`week` |

匹配过程应忽略大小写、空格、`&` 和常见分隔符差异。接口返回的其他有效分组可以排在三个标准行之后，并使用接口提供的 `displayName`。

### 6.3 缺失和失败处理

接口没有返回某个标准额度时显示：

```text
Gemini 5h      暂无数据
```

接口失败但存在最近一次成功缓存时继续显示缓存，并标记为旧数据：

```text
Gemini 5h      [======  ] 68% · 1h32min后重置
               数据可能已过期
```

只有接口明确返回 `remainingFraction = 0` 时才显示 `0%`。请求失败、字段缺失和解析失败不能转换成 `0%`。

### 6.4 重置时间格式

中文使用紧凑格式：

```text
小于 1 分钟        即将重置
1 小时 32 分钟     1h32min后重置
4 天 3 小时        4天后重置
```

英文格式：

```text
resets soon
resets in 1h 32m
resets in 4d
```

倒计时按分钟在内存中更新，不因为文案变化重新请求配额接口。

## 7. Token 处理量

### 7.1 数据来源

读取本机 Codex rollout 日志：

```text
~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl
```

使用两类事件：

```text
turn_context.payload.model
event_msg.payload.type == "token_count"
```

`turn_context.model` 用于记录当前回合模型；`token_count.total_token_usage.total_tokens` 用于计算增量。

界面名称必须使用“Token 处理量”，不能描述为计费 Token、官方账单用量或消费金额。

### 7.2 正确计数算法

每个 rollout 文件维护：

```text
inode
offset
lastTotal
currentModel
```

事件处理规则：

```text
turn_context
    → 更新 currentModel

token_count
    → delta = currentTotal - lastTotal
    → delta > 0：计入事件日期和 currentModel
    → delta = 0：重复通知，忽略
    → delta < 0：重新建立计数基线，本次不计入
```

第一版只统计 `total_tokens`，不拆分输入、输出、缓存和推理 Token，以控制代码量并避免重复计算。

### 7.3 模型分类

```text
gpt-*       → GPT
gemini-*    → Gemini
其他模型     → Other
```

聚合结果必须满足：

```text
GPT + Gemini + Other = 总计
```

### 7.4 时间范围

```text
今天     Asia/Shanghai 当日 00:00 至当前
近7日    最近 7 × 24 小时
近30日   最近 30 × 24 小时
```

时间范围切换只对内存中的每日聚合进行求和，不重新扫描文件。

### 7.5 数值格式

```text
932
12.4K
1.92M
1.28B
```

规则：

- 总量根据数量级保留最多两位小数；
- 模型占比保留一位小数；
- 总量为 0 时占比显示 `—`；
- `Other` 仅在用量大于 0 时显示；
- 不得出现 `NaN`、`Infinity` 或负数。

## 8. 低资源聚合存储

不使用 SQLite，只保存最近 32 天的每日聚合和文件游标：

```text
~/Library/Application Support/Codex Quota Header/token-rollup.json
```

结构：

```json
{
  "schemaVersion": 1,
  "timezone": "Asia/Shanghai",
  "files": {
    "/path/rollout.jsonl": {
      "inode": 12345,
      "offset": 1048576,
      "lastTotal": 54012724,
      "currentModel": "gemini-3.7-flash-high"
    }
  },
  "days": {
    "2026-09-19": {
      "gpt-5.6-luna": 1280000,
      "gemini-3.8-flash-high": 640000
    }
  },
  "coverageStartedAt": "2026-08-21T03:19:11Z"
}
```

持久化规则：

- 只保留最近 32 天；
- 文件权限为 `0600`；
- 先写临时文件，再原子 `rename`；
- 最多每分钟落盘一次；
- 数据没有变化时不写入；
- 不保存提示词、回复正文、账号信息或单次请求明细。

## 9. 首次历史回填

首次运行可能需要扫描约 1 GB rollout 日志，不能在主线程同步执行。

处理方式：

1. 插件先正常启动，原有顶部组件和 Codex 卡片立即可用；
2. 启动短生命周期 Worker，流式扫描最近 30 天日志；
3. 每次只读取 64～256 KB；
4. 分批处理并主动让出 CPU；
5. 新区域显示“正在整理历史用量”；
6. 生成每日聚合文件；
7. Worker 完成后立即退出。

首次回填期间不得影响：

- 顶部组件刷新；
- 下拉卡片悬停和点击；
- 原有刷新按钮；
- Codex 主界面交互。

后续启动直接读取聚合文件，不重新扫描历史。

## 10. 日常增量更新

每 30 秒执行一次轻量检查：

1. 对已知 rollout 文件执行 `stat`；
2. 只读取 `size > offset` 的新增部分；
3. 每 5 分钟发现一次新文件；
4. 更新内存聚合；
5. 有变化时按节流规则持久化。

如果出现以下情况，则后台重建最近 30 天聚合：

```text
inode 变化
文件大小小于 offset
聚合文件损坏
schemaVersion 不匹配
```

不实现复杂的逐事件回滚或逐文件贡献抵扣。

## 11. 刷新与调度

三类数据独立调度：

| 数据 | 窗口可见 | 窗口隐藏 |
| --- | ---: | ---: |
| 现有 Codex 额度 | 保持当前 30 秒 | 保持现有逻辑 |
| Token 增量 | 30 秒 | 180 秒 |
| Gemini 配额 | 180 秒 | 600 秒 |

每个任务独立维护：

```text
nextRunAt
inFlight
lastSuccess
lastError
revision
```

禁止同类任务并发。

### 11.1 手动刷新

点击原有刷新按钮时：

```text
原有 Codex 刷新 ──→ 继续控制原有按钮动画及成功/失败状态
Gemini 刷新 ───────→ 后台异步执行
Token 增量读取 ────→ 后台异步执行
```

新增任务不能延长或阻塞原有刷新动画：

- Codex 刷新成功后，原有按钮正常结束旋转；
- Gemini 失败不能触发“Codex 刷新失败”；
- Token 失败不能影响额度区域；
- 新增区域分别显示自己的加载、旧数据或错误状态；
- 手动刷新使用 5 秒防抖。

## 12. 样式与交互隔离

新增区域使用独立命名空间：

```css
.quota-extension {}
.quota-extension-section {}
.quota-extension-title {}
.quota-extension-row {}
.quota-extension-track {}
.quota-extension-range {}
.quota-extension-token-row {}
```

禁止复用容易影响现有样式的通用类：

```text
.row
.title
.track
.value
.divider
```

建议布局：

```css
.quota-extension {
  margin-top: 14px;
  padding-top: 14px;
  border-top: 1px solid var(--quota-extension-border);
}

.quota-extension-row {
  display: grid;
  grid-template-columns: 112px minmax(100px, 1fr) auto;
  align-items: center;
  gap: 10px;
  min-height: 30px;
}

.quota-extension-track {
  height: 12px;
  min-width: 100px;
  border-radius: 999px;
}
```

新增区域应使用现有用量配色规则：

| 剩余比例 | Light 模式颜色 |
| --- | --- |
| 41%–100% | `#34C759` |
| 11%–40% | `#FF9500` |
| 0%–10% | `#FF3B30` |
| 无数据 | `#8E8E93` |

卡片整体需要限制最大高度，内容超出时仅卡片内部滚动：

```css
.popover-shell {
  max-height: calc(100vh - 24px);
  overflow-y: auto;
}
```

不得因为新区域改变现有进度条的高度、宽度、间距和对齐。

## 13. 中英文

现有语言切换同时作用于新增区域，但不改变现有文案键。

新增文案至少包括：

| 中文 | 英文 |
| --- | --- |
| Gemini AI Pro | Gemini AI Pro |
| Token处理量 | Token usage |
| 今天 | Today |
| 近7日 | Last 7 days |
| 近30日 | Last 30 days |
| 总计 | Total |
| 其他 | Other |
| 暂无数据 | No data |
| 数据可能已过期 | Data may be stale |
| 正在整理历史用量 | Building usage history |

## 14. 安全要求

- CLIProxyAPI 地址固定为 `127.0.0.1`；
- 管理密钥只允许在后台进程内存中使用；
- 管理密钥和 OAuth Token 不得写入日志；
- 不得通过 CDP 向页面传递任何凭证；
- 不得读取或保存对话正文；
- 聚合文件权限必须为 `0600`；
- 错误信息进入页面前必须去除 URL 参数、Token、账号和文件内容。

## 15. 性能目标

| 指标 | 目标 |
| --- | ---: |
| 聚合状态文件 | 小于 100 KB |
| 稳态额外内存 | 小于 10 MB |
| Token 增量单次额外内存 | 小于 5 MB |
| 首次回填额外内存 | 小于 40 MB |
| 主线程连续阻塞 | 小于 50 ms |
| 常规单次增量处理 | 小于 20 ms |
| Gemini 网络请求 | 可见状态每 180 秒最多一次 |
| 卡片打开和时间切换 | 不产生文件或网络 I/O |
| 聚合数据保留 | 32 天 |

## 16. 测试方案

### 16.1 Token 单元测试

- 同一任务中 GPT → Gemini → GPT 切换；
- 重复 `token_count` 不重复计数；
- `total_tokens` 下降时重新建立基线；
- JSONL 最后一行不完整；
- 单行 JSON 损坏；
- 文件追加、轮转和 inode 变化；
- 跨越 Asia/Shanghai 日期边界；
- 7 日和 30 日滚动窗口；
- 聚合文件损坏和 schema 升级；
- 总计等于各模型分类之和；
- 0 Token 时不产生 `NaN%`。

### 16.2 Gemini 单元测试

- 驼峰和下划线字段；
- `5h`、`five-hour`、`five_hour`；
- `7d`、`weekly`、`week`；
- Gemini 与 Claude/GPT 共享分组匹配；
- 额度为 0；
- 分组不存在；
- 401、403、429、超时和无效 JSON；
- 失败后继续使用最近一次缓存；
- 失败不能被转换成 0%；
- 多余分组追加到标准分组之后。

### 16.3 UI 测试

- 原有卡片 DOM、文案和样式快照不变；
- 只有原有 Codex 数据；
- Codex + Gemini，无 Token 数据；
- Codex + Token，无 Gemini 数据；
- 三类数据完整；
- 中文和英文切换；
- 长模型名称；
- 窄窗口和低高度窗口；
- 卡片内部滚动；
- 时间范围切换不触发网络和文件读取；
- 新功能失败时原有悬停、点击和刷新继续工作；
- 原有刷新动画不等待新增任务。

### 16.4 性能与安全测试

- 约 1 GB 日志首次回填；
- 回填期间连续悬停、点击和手动刷新；
- 监控内存峰值和事件循环延迟；
- 增量运行 30 分钟无持续内存增长；
- 检查 CDP payload 不包含凭证；
- 检查日志不包含管理密钥、OAuth Token 和账号原文；
- 检查聚合文件权限为 `0600`。

## 17. 验收标准

实现完成必须满足：

1. 当前插件已经实现的卡片内容、样式和交互无回归。
2. 新增区域只出现在原有卡片内容下方。
3. Gemini 5h、Gemini 7d、Claude&GPT 7d 按固定顺序显示。
4. Gemini 接口失败时不显示伪造的 `0%`。
5. Token 支持今天、近 7 日、近 30 日切换。
6. Token 总计与 GPT、Gemini、Other 分类之和一致。
7. 悬停打开卡片和切换时间范围时没有磁盘或网络 I/O。
8. 首次历史回填不阻塞 Codex 主界面及原有刷新。
9. 新功能异常不会导致原有卡片消失或刷新失败。
10. 不引入 SQLite、第三方依赖、图表库或 Router 修改。
11. 全部单元测试、UI 回归测试、性能测试和安全检查通过。

## 18. 实施顺序

1. 锁定现有卡片快照和交互测试，建立回归基线。
2. 实现 Token 每日聚合、游标和首次回填。
3. 实现 Gemini 配额读取、映射和缓存。
4. 在现有卡片末尾追加隔离的扩展区域。
5. 接入中英文、时间切换和独立错误状态。
6. 完成单元、回归、性能和安全测试。
7. 在真实 CLIProxyAPI 与 Codex 环境进行只读验证。

预计开发、测试和真实环境验证需要 2～3 个工程日。
