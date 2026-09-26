/** 隔离的 UI 预览：使用真实注入脚本和随包图标，只提供明确标注的模拟用量。 */
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { dirname, extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const css = readFileSync(join(root, 'assets/ui-quota/design.css'), 'utf8');
const icons = {
  logo: 'icons/common/app-logo.svg', refresh: 'icons/header/refresh.svg', clock: 'icons/quota/clock.svg',
  calendar: 'icons/quota/calendar.svg', coupon: 'icons/coupon/coupon.svg', lightning: 'icons/coupon/lightning.svg',
  info: 'icons/coupon/info.svg', sparkle: 'icons/google-ai-pro/sparkle.svg', eye: 'icons/common/eye.svg',
  chevronDown: 'icons/common/chevron-down.svg', tokenChart: 'icons/token/token-chart.svg',
  couponWave: 'backgrounds/coupon-wave.svg',
};
const iconUrls = Object.fromEntries(Object.entries(icons).map(([key, path]) => [key, '/assets/ui-quota/' + path]));

const html = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>用量额度 · 隔离视觉预览</title><style>
*{box-sizing:border-box}body{margin:0;font-family:-apple-system,"PingFang SC",sans-serif;background:#f3f8fe;color:#111827}
header{height:48px;display:flex;align-items:center;justify-content:space-between;padding:0 18px;background:#fff;border-bottom:1px solid #dbe6f1}
.actions{display:flex;justify-content:flex-end;align-items:center;min-width:340px;gap:16px}
header button{border:0;background:transparent;cursor:pointer;color:#53647c}
.preview-note{position:fixed;left:14px;bottom:14px;z-index:1;background:#fff;padding:8px 12px;border-radius:10px;font-size:12px;color:#626c80;box-shadow:0 4px 16px #597ca422}
</style></head><body>
<header><span>Codex · UI 预览</span><div class="actions"><button aria-label="聊天操作">•••</button><button aria-label="分享">分享</button></div></header>
<div class="preview-note">隔离预览 · 所有数字与账号均为模拟数据，不连接真实账号</div>
<script>
localStorage.setItem('codexQuotaHeader.settings.v1',JSON.stringify({locale:'zh-CN',enableGoogleAiPro:true,enableTokenUsage:true,enableResetCredits:true}));
window.__codexUsageHeaderDesignIcons__=${JSON.stringify(iconUrls)};
window.__codexUsageHeaderDesignCSS__=${JSON.stringify(css)};
window.__codexUsageHeaderIcons__={};
</script><script src="/src/injected.js"></script><script>
const now=Math.floor(Date.now()/1000);
window.__codexUsageHeaderSetUsage__({
 rateLimitsByLimitId:{codex:{planType:'plus',primary:{usedPercent:39,resetsAt:now+3*3600+5*60},secondary:{usedPercent:18,resetsAt:now+5*86400+8*3600},credits:{balance:0}}},
 rateLimitResetCredits:{availableCount:3,credits:[
   {id:'preview-1',expiresAt:now+9*86400}, {id:'preview-2',expiresAt:now+10*86400}, {id:'preview-3',expiresAt:now+28*86400}
 ]}
},{fetchedAt:Date.now()});
const rows=[['Gemini 5h',81,now+4*3600],['Gemini 7d',95,now+6*86400],['Claude & GPT 5h',100,now+5*3600],['Claude & GPT 7d',100,now+6*86400]];
const accounts=['shekchoyrong','walkingscr','mancyliao001'].map((label,i)=>({
 label,email:label+'@example.test',rows:rows.map(([name,pct,resetTime])=>({label:name,remainingPercent:pct-i*3,resetTime}))
}));
const total=138000000;
const previewModelIds={gpt:'gpt-5.6-sol',gemini:'gemini-3.8-flash-preview',claude:'claude-sonnet-4-6',glm:'glm-5.2',deepseek:'deepseek-v4-pro',other:'openai-compatible-custom-model'};
const items=[['gpt','GPT',100000000],['gemini','Gemini',29320000],['claude','Claude',4861000],['glm','GLM',2300000],['deepseek','DeepSeek',1000000],['other','其他',519000]]
 .map(([key,label,tokens])=>({key,label,tokens,percent:(tokens/total*100).toFixed(1)+'%',models:[{id:previewModelIds[key],tokens,percent:'100.0%'}]}));
const range={total,items};
const combinedTokens=items.slice(3).reduce((sum,item)=>sum+item.tokens,0);
range.summaryItems=[...items.slice(0,3),{
  key:'overflow',label:'其他模型合计',modelCount:items.length-3,tokens:combinedTokens,
  percent:(combinedTokens/total*100).toFixed(1)+'%',
}];
try { window.__codexUsageHeaderSetExtendedUsage__({antigravity:{status:'ready',accounts,selectedAccount:accounts[0].email,enableDynamicPriority:true,poolStatus:{available:true,primaryAccount:accounts[0].email,rankings:accounts.map((account,index)=>({email:account.email,priority:300-index*100,status:index===2?'COOLING':'ACTIVE'})),accountMap:Object.fromEntries(accounts.map((account,index)=>[account.email,{rankLabel:index===0?'使用中':index===2?'❄ 冷却':'备选1',status:index===2?'COOLING':'ACTIVE'}]))}},tokens:{status:'ready',ranges:{today:range,days7:range,days30:range}}}); } catch {}
try { window.__codexUsageHeaderDebug__?.showPopover(); } catch {}
if(new URLSearchParams(location.search).get('focus')==='provider') requestAnimationFrame(()=>{
 document.querySelector('.quota-extension-section:not([data-section="tokens"])')?.scrollIntoView({block:'start'});
 setTimeout(()=>{
  const tooltip=document.querySelector('codex-usage-header-host')?.shadowRoot?.querySelector('.quota-rebalance-tooltip');
  if(tooltip) tooltip.style.setProperty('display','block','important');
 },300);
});
</script></body></html>`;
const compareHtml = `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>用量面板视觉对照</title>
<style>*{box-sizing:border-box}body{margin:0;padding:10px;background:#eef5fc;font:12px -apple-system,"PingFang SC",sans-serif;color:#334155}.compare{display:grid;grid-template-columns:590px 590px;gap:14px;align-items:start}.compare figure{margin:0}.compare figcaption{height:24px;font-weight:600}.compare img,.compare iframe{display:block;width:590px;border:1px solid #d9e3ef;border-radius:8px;background:#fff}.compare img{height:auto}.compare iframe{height:1040px}.compare.focus{margin-top:16px}.compare.focus iframe{height:410px}@media(max-width:1215px){.compare{grid-template-columns:minmax(0,1fr) minmax(0,1fr)}.compare img,.compare iframe{width:100%}.compare iframe{height:1000px}.compare.focus iframe{height:410px}}</style></head><body>
<div class="compare"><figure><figcaption>参考图：紧凑用量卡</figcaption><img src="/user-reference-main.png" alt="用户提供的用量面板截图"></figure><figure><figcaption>当前实现（生产渲染器 / 模拟数据）</figcaption><iframe src="/" title="用量额度实现"></iframe></figure></div>
<div class="compare focus"><figure><figcaption>参考图：悬停提示与图标比例</figcaption><img src="/user-reference-provider.png" alt="用户提供的 Google AI Pro 截图"></figure><figure><figcaption>当前实现：提示在卡片内展开</figcaption><iframe src="/?focus=provider" title="Google AI Pro 重排提示"></iframe></figure></div></body></html>`;

const port = Number(process.env.PORT || 4173);
createServer((req, res) => {
  const requestPath = new URL(req.url || '/', 'http://127.0.0.1').pathname;
  if (requestPath === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(html); return; }
  if (requestPath === '/compare') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }); res.end(compareHtml); return; }
  if (requestPath === '/user-reference-main.png' || requestPath === '/user-reference-provider.png') {
    const refPath = requestPath.includes('main')
      ? '/var/folders/f0/52x8x6191fb4s_yfn9w1wfbr0000gn/T/codex-clipboard-eacfaaaf-e52b-4c49-8bbe-01065e627887.png'
      : '/var/folders/f0/52x8x6191fb4s_yfn9w1wfbr0000gn/T/codex-clipboard-1da0c945-6a06-48e0-b1a1-a85b4d148484.png';
    try { res.writeHead(200, { 'content-type': 'image/png' }); res.end(readFileSync(requestPath.includes('provider')
      ? '/var/folders/f0/52x8x6191fb4s_yfn9w1wfbr0000gn/T/codex-clipboard-40b60b12-8d75-4fcc-bc94-5e7da2fa8df6.png'
      : refPath)); }
    catch { res.writeHead(404); res.end(); }
    return;
  }
  const path = normalize(decodeURIComponent(requestPath)).replace(/^\/+/, '');
  if (path.includes('..') || (!path.startsWith('assets/ui-quota/') && path !== 'src/injected.js')) {
    res.writeHead(404); res.end(); return;
  }
  try {
    const data = readFileSync(join(root, path));
    res.writeHead(200, { 'content-type': extname(path) === '.svg' ? 'image/svg+xml' : 'text/javascript; charset=utf-8' });
    res.end(data);
  } catch { res.writeHead(404); res.end(); }
}).listen(port, '127.0.0.1', () => console.log(`UI preview ready on http://127.0.0.1:${port}/`));
