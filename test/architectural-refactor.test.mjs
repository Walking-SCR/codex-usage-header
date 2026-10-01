import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ExpiredResetTracker } from '../src/monitor.mjs';

console.log('Testing: Architectural refactor & optimization contract...');

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const injectedCode = readFileSync(join(root, 'src/injected.js'), 'utf8');
const monitorCode = readFileSync(join(root, 'src/monitor.mjs'), 'utf8');
const extendedCode = readFileSync(join(root, 'src/extended-usage.mjs'), 'utf8');

// 1. ExpiredResetTracker 测试：过期窗口去重与指数退避
const tracker = new ExpiredResetTracker();
const now = Date.now();
const pastResetSec = Math.floor(now / 1000) - 30;
const expiredAccount = {
  email: 'alice@gmail.com',
  rows: [{ label: 'Gemini 5h', resetTime: pastResetSec }],
};

// 首次检测到过期重置：必须触发即时单次拉取
assert.equal(tracker.checkAccount(expiredAccount, now), true, '首次到期窗口应允许拉取');
tracker.recordResult(expiredAccount, null, now);

// 紧随其后的下一次循环（例如 4 秒后上游仍返回旧的过期时间）：由于初次退避为 8 秒，在 4 秒时绝不能重复拉取
assert.equal(tracker.checkAccount(expiredAccount, now + 4000), false, '退避期内应拦截重复请求');

// 8 秒退避结束后允许第 2 次拉取
assert.equal(tracker.checkAccount(expiredAccount, now + 8500), true, '首轮 8s 退避结束后应允许再次重试');
tracker.recordResult(expiredAccount, null, now + 8500);

// 第 2 次失败后退避增加到 16 秒
assert.equal(tracker.checkAccount(expiredAccount, now + 15000), false, '16s 退避期内应继续拦截');
assert.equal(tracker.checkAccount(expiredAccount, now + 25000), true, '第 2 轮 16s 退避后允许重试');

// 当上游返回新的 resetTime（已重置或刷新）时，自动解除退避
const recoveredAccount = {
  email: 'alice@gmail.com',
  rows: [{ label: 'Gemini 5h', resetTime: Math.floor(now / 1000) + 18000 }],
};
assert.equal(tracker.checkAccount(recoveredAccount, now + 30000), false, '未到期窗口无需抢跑');
assert.equal(tracker.accounts.has('alice@gmail.com'), false, '恢复正常后自动清除退避记录');

// 2. 路由模式切换异步化与 Ack 确认机制契约
assert.match(monitorCode, /triggerToggleFailoverMode\(\)\.then\(async result =>/, 'Failover 切换必须使用 Promise 异步调度');
assert.match(monitorCode, /pushCommandAck\(command\.target,\s*\{[\s\S]*kind:\s*'toggleFailoverMode'/, 'Failover 异步完成必须推送包含 id 的 Ack 确认');
assert.match(injectedCode, /ack\.kind === 'toggleFailoverMode' && ack\.id === failoverRequestId/, '前端必须根据 Ack requestId 确认解除切换态');

// 3. 凭证写入责任边界契约
assert.doesNotMatch(extendedCode, /['"]admin123['"]/, '严禁在管理密钥缺失时尝试 admin123 默认密码');
assert.match(extendedCode, /crossBasename/, '必须使用 crossBasename 兼容 Windows 反斜杠');

// 4. 多数据源刷新解耦契约
assert.match(injectedCode, /refreshSources\s*=\s*\{\s*primary:\s*'loading'/, '刷新状态必须拆分独立数据源');
assert.match(injectedCode, /function checkRefreshSettlement\(\)/, '必须通过多源收敛函数判定全部完成');
assert.match(injectedCode, /partiallyRefreshed/, '允许部分源更新成功提示，避免非黑即白误导');

// 5. 语义化焦点与数据不变不重绘契约
assert.match(injectedCode, /target\.__lastMarkup === nextMarkup/, '必须实现数据不变不重绘以节省 DOM 重排');
assert.match(injectedCode, /function getSemanticFocusKey\(target\)/, '必须提取语义化控件键');
assert.match(injectedCode, /function restoreSemanticFocus\(target,\s*focusKey\)/, '必须具备语义化焦点恢复能力');
assert.match(injectedCode, /SCROLL_CONTAINERS/, '必须统一保留各内部滚动区域状态');

// 6. 脱敏诊断信息契约：严禁泄漏邮箱、凭证与对话
assert.match(injectedCode, /function buildSanitizedDiagnostics\(\)/, '必须具备脱敏诊断信息构建函数');
assert.match(injectedCode, /classifyDiagnosticsError/, '必须提供固定错误分类');

// 验证 buildSanitizedDiagnostics 模板中不含敏感字段捕获
const diagTemplate = injectedCode.match(/function buildSanitizedDiagnostics\(\) \{([\s\S]*?)\n  (?:async )?function copySanitizedDiagnostics/);
assert.ok(diagTemplate, 'buildSanitizedDiagnostics 实现必须存在');
assert.doesNotMatch(diagTemplate[1], /email|access_token|refresh_token|auth_token|api_key|secret|password|bearer|cookie|credential|prompt|message|chat/i, '诊断摘要绝不能包含邮箱、Token密钥或对话正文');

console.log('✓ All architectural refactor & optimization contracts passed!');
