/** 账号健康状态的只读展示规则。只输出固定错误码与文案，不输出上游原始错误或验证链接。 */
export function getAccountHealth(account = {}, routing = {}) {
  const messages = {
    ok: ['healthy', '', ''],
    auth_unavailable: ['unavailable', '暂无可用登录凭证，当前无法调用；请检查这个账号的登录与授权状态。', 'No usable login credentials. Check this account’s login and authorization.'],
    validation_required: ['unavailable', 'Google 要求验证这个账号，验证完成前无法调用；请按账号验证流程处理。', 'Google requires account verification before requests can resume.'],
    auth_expired: ['unavailable', '登录授权已失效或被拒绝，当前无法调用；请检查或重新授权这个账号。', 'Login authorization has expired or was rejected. Check or reauthorize this account.'],
    disabled: ['unavailable', '这个账号已被停用，不会参与调用。', 'This account is disabled and will not be used for requests.'],
    account_blocked: ['unavailable', '这个账号暂不可用；请检查登录授权或账号限制。', 'This account is unavailable. Check its authorization or account restrictions.'],
    cooling: ['cooling', '这个账号正在限流或额度冷却中，等待恢复后再使用。', 'This account is rate-limited or cooling down. Wait for recovery.'],
    quota_read_failed: ['unknown', '暂时无法读取这个账号的额度；显示的可能是上次数据，这不一定代表账号无法调用。', 'Quota could not be read. Displayed values may be cached; this does not necessarily mean requests are unavailable.'],
  };
  const recognize = (value, httpStatus) => {
    let text = '';
    try { text = (typeof value === 'string' ? value : JSON.stringify(value || '')).slice(0, 65536).toLowerCase(); } catch {}
    if (messages[text] && text !== 'ok') return text;
    if (/validation_required|validation required/.test(text)) return 'validation_required';
    if (/auth_unavailable|token unavailable|token_unavailable|no usable credentials/.test(text)) return 'auth_unavailable';
    if (/invalid_grant|invalid_token|unauthorized|unauthenticated|token.{0,25}expir/.test(text) || Number(httpStatus) === 401) return 'auth_expired';
    if (/^disabled$/.test(text)) return 'disabled';
    return null;
  };
  const result = code => {
    const [state, zh, en] = messages[code] || messages.quota_read_failed;
    const httpStatus = Number(account.httpStatus || account.health?.httpStatus || account.routingHealth?.httpStatus || routing.httpStatus || routing.last_error?.status_code || routing.last_error?.code);
    return { state, code, zh, en, httpStatus: httpStatus >= 100 && httpStatus <= 599 ? httpStatus : null };
  };
  if (account.disabled || String(account.status || '').toLowerCase() === 'disabled') return result('disabled');
  // 后台已脱敏的健康快照可直接用于渲染；成功的新快照会替换旧异常。
  if (account.health && messages[account.health.code]) return result(account.health.code);
  if (account.routingHealth && messages[account.routingHealth.code]) return result(account.routingHealth.code);
  const rankCode = recognize({ reason: routing.reason, last_error: routing.last_error, error: routing.error }, routing.httpStatus);
  if (rankCode) return result(rankCode);
  const rankStatus = String(routing.status || '').toUpperCase();
  if (['BLOCKED', 'DISABLED', 'UNAVAILABLE', 'ERROR'].includes(rankStatus)) return result('account_blocked');
  const errorCode = recognize(account.errorCode || account.error, account.httpStatus);
  if (errorCode) return result(errorCode);
  if (rankStatus === 'COOLING') return result('cooling');
  if (account.error || String(account.status || '').toLowerCase() === 'error') return result('quota_read_failed');
  return result('ok');
}
