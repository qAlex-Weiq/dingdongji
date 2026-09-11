'use strict';

/**
 * 无头浏览器端到端验证：
 * 1. 打开首页 → 2. 填表查询 北京→上海 → 3. 校验机票/火车票渲染 → 4. 截图存档
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
  // 记录 API 请求与响应状态，便于排查
  page.on('response', (res) => {
    if (res.url().includes('/api/')) console.log(`[api] ${res.status()} ${res.url()}`);
  });

  await page.goto('http://localhost:3000', { waitUntil: 'networkidle' });

  // 城市自动补全已加载
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

  // 抽查第一张火车票卡片内容
  const firstTrain = await page.locator('#trains-panel .card').first().innerText();
  console.log('首张火车票卡片摘要:', firstTrain.replace(/\s+/g, ' ').slice(0, 120));

  // 排序切换：价格最低
  await page.selectOption('#sort-select', 'price');
  await page.waitForTimeout(300);
  const firstPrice = await page.locator('#trains-panel .card .price').first().innerText();
  console.log('按价格排序后最低价:', firstPrice.trim());

  // 交换按钮
  await page.click('#swap-btn');
  const swapped = await page.inputValue('#from-input');
  console.log(`交换后出发城市: ${swapped}`);

  // 截图（桌面 + 移动）
  await page.screenshot({ path: path.join('.pilotdeck', 'shot-desktop.png'), fullPage: false });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join('.pilotdeck', 'shot-mobile.png'), fullPage: false });

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
