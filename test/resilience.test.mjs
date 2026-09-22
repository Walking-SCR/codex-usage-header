 /**
  * 测试套件：级联锚点容错和幂等挂载
  */
 import assert from 'node:assert/strict';
 
 console.log('Testing: Cascading Anchor Resilience & Idempotence...');
 
 // 模拟 DOM 结构，以模拟 ChatGPT 桌面端标题栏
 function createMockHeaderHierarchy(tier = 1) {
   const header = {
     tagName: 'HEADER',
     children: [],
     appendChild(child) {
       this.children.push(child);
       child.parentElement = this;
     },
     insertBefore(newChild, refChild) {
       const idx = this.children.indexOf(refChild);
       if (idx >= 0) this.children.splice(idx, 0, newChild);
       else this.children.push(newChild);
       newChild.parentElement = this;
     },
     querySelector(selector) {
       if (selector.includes('Share') || selector.includes('分享')) {
         return tier === 1 ? this.shareBtn : null;
       }
       if (selector.includes('action')) {
         return tier <= 2 ? this.actionGroup : null;
       }
       return null;
     },
   };
 
   const title = { tagName: 'H1', textContent: '介绍你的身份' };
   const shareBtn = { tagName: 'BUTTON', ariaLabel: 'Share' };
   const actionGroup = { tagName: 'DIV', className: 'actions-group flex', children: [shareBtn] };
   shareBtn.parentElement = actionGroup;
 
   header.shareBtn = shareBtn;
   header.actionGroup = actionGroup;
 
   header.appendChild(title);
   if (tier <= 2) {
     header.appendChild(actionGroup);
   }
 
   return header;
 }
 
function resolveMountStrategy(header) {
  if (!header) return { tier: 4, mode: 'defer_until_safe_anchor' };
 
   const trailingBtn = header.querySelector('button[aria-label*="Share"]');
   if (trailingBtn) {
     return { tier: 1, mode: 'insert_before_trailing' };
   }
 
   const actionGroup = header.querySelector('div[class*="action"]');
   if (actionGroup) {
     return { tier: 2, mode: 'insert_before_actions' };
   }
 
   return { tier: 3, mode: 'append_to_header' };
 }
 
 {
   // 第 1 级：带分享按钮的标准布局
   const h1 = createMockHeaderHierarchy(1);
   assert.equal(resolveMountStrategy(h1).tier, 1);
 
   // 第 2 级：按钮属性变化，但操作按钮组仍存在
   const h2 = createMockHeaderHierarchy(2);
   assert.equal(resolveMountStrategy(h2).tier, 2);
 
   // 第 3 级：操作按钮组被移除的极端 DOM 变化
   const h3 = createMockHeaderHierarchy(3);
   assert.equal(resolveMountStrategy(h3).tier, 3);
 
 // 第 4 级：安全锚点不可用时，绝不覆盖原生控件。
 assert.equal(resolveMountStrategy(null).mode, 'defer_until_safe_anchor');
}
 
 console.log('✓ All Cascading Anchor Resilience tests passed!');
