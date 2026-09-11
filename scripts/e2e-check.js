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

  // ---- 景点模块：数据源选择 + 搜索成都 → 校验渲染与排序 ----
  await page.goto('http://localhost:3000/sight.html', { waitUntil: 'networkidle' });
  const sightNav = (await page.locator('.module-nav a.is-active').innerText()).trim();
  console.log(`景点模块导航高亮: ${sightNav}`);

  // 数据源选择器：默认 auto 时无提示，切到 llm 显示慢速提示，切回 local 隐藏
  const hintHiddenOnAuto = !(await page.locator('#source-hint').isVisible());
  await page.selectOption('#source-select', 'llm');
  const hintVisibleOnLlm = await page.locator('#source-hint').isVisible();
  const hintText = (await page.locator('#source-hint').innerText()).replace(/\s+/g, ' ');
  console.log(`AI 慢速提示（llm 时显示）: ${hintVisibleOnLlm ? '可见' : '不可见'} - ${hintText.slice(0, 50)}`);
  await page.selectOption('#source-select', 'local');
  const hintHiddenOnLocal = !(await page.locator('#source-hint').isVisible());
  if (!hintHiddenOnAuto || !hintVisibleOnLlm || !hintHiddenOnLocal) {
    throw new Error('数据源慢速提示显隐逻辑异常');
  }

  // 使用本地数据源搜索（秒开，结果确定）
  await page.fill('#city-input', '成都');
  await page.click('#search-btn');
  try {
    await page.waitForSelector('#sight-list .card:not(.skeleton)', { timeout: 10000 });
  } catch {
    console.error('--- 等待景点卡片超时，dump 调试信息 ---');
    console.error('city-input 值:', await page.inputValue('#city-input'));
    console.error('source-select 值:', await page.inputValue('#source-select'));
    console.error('结果区可见性:', await page.locator('#result-section').isVisible());
    console.error('sight-list HTML 前 600 字:');
    console.error((await page.locator('#sight-list').innerHTML()).slice(0, 600));
    throw new Error('景点卡片未在 10s 内渲染');
  }
  const sightCards = await page.locator('#sight-list .card:not(.skeleton)').count();
  console.log(`景点卡片（本地数据源）: ${sightCards} 张`);
  const sightSummary = (await page.locator('#sight-summary').innerText()).replace(/\s+/g, ' ');
  console.log('景点结果摘要:', sightSummary.slice(0, 80));
  if (!sightSummary.includes('本地')) throw new Error('摘要未标注本地数据来源');

  const firstSight = await page.locator('#sight-list .card').first().innerText();
  console.log('首张景点卡片摘要:', firstSight.replace(/\s+/g, ' ').slice(0, 120));

  // 切换排序：评分最高
  await page.selectOption('#sort-select', 'rating');
  await page.waitForTimeout(300);
  const topRated = await page.locator('#sight-list .card .sight-rating').first().innerText();
  console.log('按评分排序后最高分:', topRated.trim());

  await page.screenshot({ path: path.join('.pilotdeck', 'shot-sight.png'), fullPage: false });

  // ---- 设置页：表单加载与状态展示 ----
  await page.goto('http://localhost:3000/settings.html', { waitUntil: 'networkidle' });
  const settingsNav = (await page.locator('.module-nav a.is-active').innerText()).trim();
  console.log(`设置页导航高亮: ${settingsNav}`);
  const llmUrlValue = await page.inputValue('#llm-url');
  const llmModelValue = await page.inputValue('#llm-model');
  const keyPlaceholder = await page.getAttribute('#llm-key', 'placeholder');
  console.log(`设置页加载: 接口=${llmUrlValue.slice(0, 40)} 模型=${llmModelValue}`);
  console.log(`API Key 占位提示: ${keyPlaceholder}`);
  if (!llmUrlValue || !llmModelValue) throw new Error('设置页未加载当前生效配置');
  const statusText = (await page.locator('#settings-status').innerText()).replace(/\s+/g, ' ');
  console.log(`数据源状态: ${statusText.slice(0, 80)}`);
  await page.screenshot({ path: path.join('.pilotdeck', 'shot-settings.png'), fullPage: false });

  // ---- 进入美食模块（三 tab） ----
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.goto('http://localhost:3000/food.html', { waitUntil: 'networkidle' });
  const foodActiveNav = (await page.locator('.module-nav a.is-active').innerText()).trim();
  console.log(`美食模块导航高亮: ${foodActiveNav}`);
  if (foodActiveNav !== '美食') throw new Error(`顶栏 nav 未合并：得到 ${foodActiveNav}`);

  // 城市补全（等 JS 异步加载）
  await page.waitForFunction(() => document.querySelectorAll('#city-list option').length > 0, null, { timeout: 5000 }).catch(() => {});
  const foodCityOptions = await page.locator('#city-list option').count();
  if (foodCityOptions === 0) throw new Error('city-list 为空');
  console.log(`美食城市补全: ${foodCityOptions} 个`);

  // Tab 1: 特色菜品
  await page.fill('#city-input', '成都');
  await page.selectOption('#specialty-category', '小吃');
  await page.click('#form-specialty button[type="submit"]');
  await page.waitForSelector('#specialty-panel .dish-card', { timeout: 5000 });
  const dishCount = await page.locator('#specialty-panel .dish-card').count();
  console.log(`特色菜品（成都 小吃）: ${dishCount} 道`);
  const firstDish = (await page.locator('#specialty-panel .dish-card').first().innerText()).replace(/\s+/g, ' ').slice(0, 120);
  console.log('首顶菜品:', firstDish);
  await page.screenshot({ path: path.join('.pilotdeck', 'shot-food-specialty.png'), fullPage: false });

  // Tab 2: 餐厅推荐
  await page.click('#tab-restaurant');
  await page.waitForSelector('#panel-restaurant:not([hidden])', { timeout: 2000 });
  // 升级 city 为北京 + 选 火锅 + 人均 80–200
  await page.fill('#city-input', '北京');
  await page.click('#cuisine-chips .chip[data-name="火锅"]');
  await page.fill('#price-min', '80');
  await page.fill('#price-max', '200');
  await page.selectOption('#slot-select', '晚餐');
  await page.click('#form-restaurant button[type="submit"]');
  await page.waitForSelector('#restaurant-panel .rest-card', { timeout: 5000 });
  const restCount = await page.locator('#restaurant-panel .rest-card').count();
  console.log(`餐厅（北京/火锅/80–200）: ${restCount} 家`);
  const firstRest = (await page.locator('#restaurant-panel .rest-card').first().innerText()).replace(/\s+/g, ' ').slice(0, 140);
  console.log('首家餐厅:', firstRest);
  // 标题：检查 ·ƙ�餐· / 人均·存在 距地标 参考
  const restCards = page.locator('#restaurant-panel .rest-card');
  for (let i = 0; i < await restCards.count(); i++) {
    const t = await restCards.nth(i).innerText();
    // 顾客经过☎️ + 地区/距地标信息
    if (!t.includes('\ud83d\udccd') && !t.includes('地区') && !t.includes('km')) throw new Error(`餐厅缺少位置`);
    if (!t.includes('人均')) throw new Error('餐厅缺少人均');
  }
  await page.screenshot({ path: path.join('.pilotdeck', 'shot-food-restaurant.png'), fullPage: false });

  // Tab 3: 个性化推荐
  await page.click('#tab-personalize');
  await page.waitForSelector('#panel-personalize:not([hidden])', { timeout: 2000 });
  await page.fill('#city-input', '成都');
  await page.fill('#query-input', '和几个朋友吃宵夜，喜欢辣，150 元每人');
  await page.click('#form-personalize button[type="submit"]');
  await page.waitForSelector('#personalize-list .rest-card', { timeout: 5000 });
  const recCount = await page.locator('#personalize-list .rest-card').count();
  const parsedCount = await page.locator('#parsed-chips .parsed-chip').count();
  console.log(`个性化（成都/朋友/宵夜）: 解析 ${parsedCount} 项 · 推荐 ${recCount} 家`);
  if (parsedCount < 2) throw new Error('个性化解析太少');
  if (recCount < 1) throw new Error('个性化没出推荐');
  // 标题：第一家需包含 号码 + 匹配度
  const firstRec = (await page.locator('#personalize-list .rest-card').first().innerText()).replace(/\s+/g, ' ').slice(0, 180);
  console.log('首家推荐:', firstRec);
  if (!firstRec.includes('分')) throw new Error('个性化匹配度缺失');
  await page.screenshot({ path: path.join('.pilotdeck', 'shot-food-personalize.png'), fullPage: false });

  // 移动端 餐厅 tab 截图
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.click('#tab-restaurant');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join('.pilotdeck', 'shot-food-mobile.png'), fullPage: false });

  // ---- 占位模块页（hotel） ----
  for (const p of ['hotel']) {
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
