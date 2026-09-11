'use strict';

/** 临时截图脚本：景点列表布局 + 地图弹窗（复现 e2e 的浏览器回退逻辑） */
const path = require('path');

(async () => {
  const { chromium } = require('playwright');
  let browser;
  try {
    browser = await chromium.launch();
  } catch {
    browser = await chromium.launch({ channel: 'chrome' });
  }
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));

  // 1) 景点页：搜索成都（本地数据源，秒开）
  await page.goto('http://localhost:3000/sight.html', { waitUntil: 'networkidle' });
  await page.fill('#city-input', '成都');
  await page.click('#search-btn');
  await page.waitForSelector('#sight-list .card', { timeout: 10000 });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join('shot-sight-layout.png'), fullPage: false });

  // 2) 打开地图弹窗
  await page.click('#sight-list .card');
  await page.waitForSelector('#map-modal:not([hidden])', { timeout: 5000 });
  await page.waitForTimeout(2500);
  await page.screenshot({ path: path.join('shot-map-modal.png') });

  await browser.close();
  console.log('screenshots saved; page errors:', errors.length);
})().catch((err) => {
  console.error('截图失败:', err.message);
  process.exit(1);
});
