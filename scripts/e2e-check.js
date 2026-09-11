'use strict';

/**
 * 无头浏览器端到端验证：
 * 1. 首页四模块入口 → 2. 进入车票模块查询 北京→上海 → 3. 校验机票/火车票渲染与交互
 * 4. 景点模块搜索成都，校验卡片渲染与排序 → 5. 酒店/饭店占位页可达 → 6. 截图存档
 */

const path = require('path');

(async () => {
  const { chromium } = require('playwright');

  // 优先使用 Playwright 自带浏览器，缺失时回退到系统 Chrome/Edge
  let browser;
  try {
    browser = await chromium.launch();
  } catch {
    browser = await chromium.launch({ channel: 'chrome' });
  }
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });

  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
  });
  page.on('response', (res) => {
    if (res.url().includes('/api/')) console.log(`[api] ${res.status()} ${res.url()}`);
  });

  // ---- 首页：模块选择 ----
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  const moduleCards = await page.locator('.module-card').count();
  console.log(`首页模块入口: ${moduleCards} 个`);
  if (moduleCards !== 4) throw new Error(`期望 4 个模块入口，实际 ${moduleCards}`);
  await page.screenshot({ path: path.join('.pilotdeck', 'shot-home.png') });

  // ---- 进入车票模块 ----
  await page.click('.module-card[href="/ticket.html"]');
  await page.waitForURL('**/ticket.html');
  const activeNav = (await page.locator('.module-nav a.is-active').innerText()).trim();
  console.log(`车票模块导航高亮: ${activeNav}`);

  const cityOptions = await page.locator('#city-list option').count();
  console.log(`城市自动补全选项: ${cityOptions} 个`);

  // 填写表单并提交
  await page.fill('#from-input', '北京');
  await page.fill('#to-input', '上海');
  await page.fill('#date-input', '2026-09-12');
  await page.click('#search-btn');

  // 等待结果渲染（跳过加载骨架屏 .card.skeleton）；超时则 dump 现场辅助排查
  try {
    await page.waitForSelector('#flights-panel .card:not(.skeleton)', { timeout: 10000 });
  } catch {
    console.error('--- 等待机票卡片超时，dump 调试信息 ---');
    console.error('date-input 值:', await page.inputValue('#date-input'));
    console.error('from/to:', await page.inputValue('#from-input'), '/', await page.inputValue('#to-input'));
    console.error('结果区可见性:', await page.locator('#result-section').isVisible());
    console.error('flights-panel HTML 前 600 字:');
    console.error((await page.locator('#flights-panel').innerHTML()).slice(0, 600));
    throw new Error('机票卡片未在 10s 内渲染');
  }
  const flightCards = await page.locator('#flights-panel .card:not(.skeleton)').count();
  console.log(`机票卡片: ${flightCards} 张`);

  // 切换到火车票 tab
  await page.click('#tab-trains');
  await page.waitForSelector('#trains-panel .card:not(.skeleton)', { timeout: 5000 });
  const trainCards = await page.locator('#trains-panel .card:not(.skeleton)').count();
  console.log(`火车票卡片: ${trainCards} 张`);

  const firstTrain = await page.locator('#trains-panel .card').first().innerText();
  console.log('首张火车票卡片摘要:', firstTrain.replace(/\s+/g, ' ').slice(0, 120));

  // 排序
  await page.selectOption('#sort-select', 'price');
  await page.waitForTimeout(300);
  const firstPrice = await page.locator('#trains-panel .card .price').first().innerText();
  console.log('按价格排序后最低价:', firstPrice.trim());

  // 交换城市
  await page.click('#swap-btn');
  const swapped = await page.inputValue('#from-input');
  console.log(`交换后出发城市: ${swapped}`);

  // ---- 截图（桌面 + 移动） ----
  await page.screenshot({ path: path.join('.pilotdeck', 'shot-desktop.png'), fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join('.pilotdeck', 'shot-mobile.png'), fullPage: false });
  await page.setViewportSize({ width: 1200, height: 900 });

  // ---- 景点模块：搜索成都 → 校验渲染与排序 ----
  await page.goto('http://localhost:3000/sight.html', { waitUntil: 'networkidle' });
  const sightNav = (await page.locator('.module-nav a.is-active').innerText()).trim();
  console.log(`景点模块导航高亮: ${sightNav}`);

  await page.fill('#city-input', '成都');
  await page.click('#search-btn');
  try {
    await page.waitForSelector('#sight-list .card:not(.skeleton)', { timeout: 10000 });
  } catch {
    console.error('--- 等待景点卡片超时，dump 调试信息 ---');
    console.error('city-input 值:', await page.inputValue('#city-input'));
    console.error('结果区可见性:', await page.locator('#result-section').isVisible());
    console.error('sight-list HTML 前 600 字:');
    console.error((await page.locator('#sight-list').innerHTML()).slice(0, 600));
    throw new Error('景点卡片未在 10s 内渲染');
  }
  const sightCards = await page.locator('#sight-list .card:not(.skeleton)').count();
  console.log(`景点卡片: ${sightCards} 张`);
  const sightSummary = (await page.locator('#sight-summary').innerText()).replace(/\s+/g, ' ');
  console.log('景点结果摘要:', sightSummary.slice(0, 80));

  const firstSight = await page.locator('#sight-list .card').first().innerText();
  console.log('首张景点卡片摘要:', firstSight.replace(/\s+/g, ' ').slice(0, 120));

  // 切换排序：评分最高
  await page.selectOption('#sort-select', 'rating');
  await page.waitForTimeout(300);
  const topRated = await page.locator('#sight-list .card .sight-rating').first().innerText();
  console.log('按评分排序后最高分:', topRated.trim());

  await page.screenshot({ path: path.join('.pilotdeck', 'shot-sight.png'), fullPage: false });

  // ---- 占位模块页可达（酒店 / 饭店） ----
  for (const p of ['hotel', 'food']) {
    await page.goto(`http://localhost:3000/${p}.html`, { waitUntil: 'networkidle' });
    const heading = (await page.locator('.coming-soon h1').innerText()).trim();
    const badge = (await page.locator('.cs-badge').innerText()).trim();
    console.log(`${p}.html: ${heading}（${badge}）`);
  }

  await browser.close();

  if (errors.length) {
    console.log('\n页面错误:');
    errors.forEach((e) => console.log(' -', e));
    process.exit(1);
  }
  console.log('\n端到端验证通过，无页面错误');
})().catch((err) => {
  console.error('验证失败:', err.message);
  process.exit(1);
});
