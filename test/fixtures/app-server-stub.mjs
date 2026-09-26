/** 隔离的 App Server 协议桩：拒绝初始化完成前的额度请求。 */
import { createInterface } from 'node:readline';
let initialized = false;
let initializeCount = 0;
const send = message => process.stdout.write(JSON.stringify(message) + '\n');
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line);
  if (message.method === 'initialize') {
    initializeCount++;
    setTimeout(() => send({ id: message.id, result: { userAgent: 'test-app-server' } }), 15);
  } else if (message.method === 'initialized') {
    initialized = true;
  } else if (message.method === 'account/rateLimits/read') {
    if (!initialized || initializeCount !== 1) return send({ id: message.id, error: { message: 'Not initialized' } });
    send({ id: message.id, result: { rateLimitsByLimitId: { codex: {
      planType: 'plus', primary: { usedPercent: 22, resetsAt: 1790444241 }, secondary: { usedPercent: 65, resetsAt: 1790771283 },
    } }, rateLimitResetCredits: null } });
  }
});
