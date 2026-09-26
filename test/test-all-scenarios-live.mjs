import { evaluateInTarget, fetchCdpTargets, selectUsageTargets } from '../src/launcher.mjs';

async function run() {
  const targets = await fetchCdpTargets();
  const selected = selectUsageTargets(targets);
  const target = selected[0];
  if (!target) return;

  console.log('Testing live scenarios on client:');

  // 1. 切换到近30日
  await evaluateInTarget(target.webSocketDebuggerUrl, `(() => {
    document.querySelector('.quota-extension-range-tab[data-range="days30"]')?.click();
  })()`);
  await new Promise(r => setTimeout(r, 200));

  const stateDays30 = await evaluateInTarget(target.webSocketDebuggerUrl, `(() => {
    const folded = document.querySelector('.token-model-row.is-folded-other');
    const rows = [...document.querySelectorAll('.token-model-row')].map(r => r.textContent.trim());
    return {
      range: 'days30',
      total: document.querySelector('.token-global-stat')?.textContent,
      center: document.querySelector('.token-donut-center')?.textContent,
      rowCount: rows.length,
      hasFoldedRow: Boolean(folded),
      foldedText: folded?.textContent?.trim()
    };
  })()`);
  console.log('Scenario 1 (days30 - GPT):', stateDays30);

  // 2. 打开下拉菜单选择 Claude
  await evaluateInTarget(target.webSocketDebuggerUrl, `(() => {
    document.querySelector('.quota-extension-model-button')?.click();
  })()`);
  await new Promise(r => setTimeout(r, 150));
  await evaluateInTarget(target.webSocketDebuggerUrl, `(() => {
    document.querySelector('.quota-extension-model-option[data-model="claude"]')?.click();
  })()`);
  await new Promise(r => setTimeout(r, 200));

  const stateClaude = await evaluateInTarget(target.webSocketDebuggerUrl, `(() => {
    const heroCard = document.querySelector('.single-model-hero-card');
    return {
      model: 'claude',
      total: document.querySelector('.token-global-stat')?.textContent,
      center: document.querySelector('.token-donut-center')?.textContent,
      hasHeroCard: Boolean(heroCard),
      heroName: heroCard?.querySelector('.hero-name')?.textContent?.trim(),
      heroBadge: heroCard?.querySelector('.hero-badge')?.textContent?.trim(),
      heroStats: [...(heroCard?.querySelectorAll('.hero-stat-box') || [])].map(b => b.textContent.trim())
    };
  })()`);
  console.log('Scenario 2 (Claude - Single Model Hero Card):', stateClaude);

  // 3. 恢复为今天和 all
  await evaluateInTarget(target.webSocketDebuggerUrl, `(() => {
    document.querySelector('.quota-extension-range-tab[data-range="today"]')?.click();
  })()`);
  await new Promise(r => setTimeout(r, 150));
  await evaluateInTarget(target.webSocketDebuggerUrl, `(() => {
    document.querySelector('.quota-extension-model-button')?.click();
  })()`);
  await new Promise(r => setTimeout(r, 150));
  await evaluateInTarget(target.webSocketDebuggerUrl, `(() => {
    document.querySelector('.quota-extension-model-option[data-model="all"]')?.click();
  })()`);
  console.log('All live scenario tests completed successfully!');
}

run();
