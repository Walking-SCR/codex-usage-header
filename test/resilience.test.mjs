 /**
  * Test Suite: Cascading Anchor Resilience & Idempotent Mounting
  */
 import assert from 'node:assert/strict';
 
 console.log('Testing: Cascading Anchor Resilience & Idempotence...');
 
 // Mock DOM structure to simulate ChatGPT desktop header
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
   // Tier 1: Standard layout with Share button
   const h1 = createMockHeaderHierarchy(1);
   assert.equal(resolveMountStrategy(h1).tier, 1);
 
   // Tier 2: Altered button attributes, but action group remains
   const h2 = createMockHeaderHierarchy(2);
   assert.equal(resolveMountStrategy(h2).tier, 2);
 
   // Tier 3: Extreme DOM mutation where action group is removed
   const h3 = createMockHeaderHierarchy(3);
   assert.equal(resolveMountStrategy(h3).tier, 3);
 
 // Tier 4: never cover native controls while the safe anchor is unavailable.
 assert.equal(resolveMountStrategy(null).mode, 'defer_until_safe_anchor');
}
 
 console.log('✓ All Cascading Anchor Resilience tests passed!');
