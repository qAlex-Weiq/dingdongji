'use strict';

/**
 * 无头浏览器端到端验证：
 * 1. 首页四模块入口 → 2. 进入车票模块查询 北京→上海 → 3. 校验机票/火车票渲染与交互
 * 4. 景点模块搜索成都，校验卡片渲染与排序 → 5. 美食模块三 tab 校验
 * 6. 酒店模块偏好筛选 + 渲染校验 → 7. 截图存档
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
  let muteConsoleErrors = false; // 预期中的 4xx 响应测试期间静默（浏览器会把 400 记为资源加载错误）
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => {
    if (msg.type() === 'error' && !muteConsoleErrors) errors.push(`console.error: ${msg.text()}`);
  });
  page.on('response', (res) => {
    if (res.url().includes('/api/')) console.log(`[api] ${res.status()} ${res.url()}`);
  });

  // ---- 首页：模块选择 ----
  await page.goto('http://localhost:3000/', { waitUntil: 'networkidle' });
  const moduleCards = await page.locator('.gallery-card').count();
  console.log(`首页模块入口: ${moduleCards} 个`);
  if (moduleCards !== 4) throw new Error(`期望 4 个模块入口，实际 ${moduleCards}`);
  await page.screenshot({ path: path.join('.pilotdeck', 'shot-home.png') });

  // ---- 进入车票模块 ----
  await page.click('.gallery-card[href="/ticket.html"]');
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

  // 火车数据源徽标（12306 实时 / 模拟数据）
  const trainNote = (await page.locator('#trains-panel .source-note').first().innerText()).trim();
  if (!/12306 实时数据|模拟数据/.test(trainNote)) throw new Error(`火车数据源徽标异常：${trainNote}`);
  console.log(`火车数据源徽标: ${trainNote}`);

  // 排序
  await page.selectOption('#sort-select', 'price');
  await page.waitForTimeout(300);
  const firstPrice = await page.locator('#trains-panel .card .price').first().innerText();
  console.log('按价格排序后最低价:', firstPrice.trim());

  // 交换城市
  await page.click('#swap-btn');
  const swapped = await page.inputValue('#from-input');
  console.log(`交换后出发城市: ${swapped}`);
  // ---- 本次增强：快捷路线芯片 / 筛选胶囊 / 准点率徽标 ----
  // 快捷路线芯片：点击后自动填充并重新查询
  const [chipResp] = await Promise.all([
    page.waitForResponse((r) => r.url().includes('/api/ticket/search') && r.status() === 200, { timeout: 20000 }),
    page.click('.quick-chips .chip[data-from="北京"][data-to="上海"]'),
  ]);
  await page.waitForTimeout(600);
  const chipFrom = await page.inputValue('#from-input');
  const chipTo = await page.inputValue('#to-input');
  if (chipFrom !== '北京' || chipTo !== '上海') throw new Error(`快捷芯片填充异常：${chipFrom} → ${chipTo}`);
  console.log(`快捷路线芯片: ${chipFrom} → ${chipTo}，自动查询完成（HTTP ${chipResp.status()}）`);

  // 筛选胶囊：车型「高铁动车」过滤 + 计数 N/M + 恢复
  const totalTrains = await page.locator('#trains-panel .card').count();
  await page.click('#filter-type .pill[data-v="hsr"]');
  await page.waitForTimeout(200);
  const hsrTrains = await page.locator('#trains-panel .card').count();
  const hsrCount = (await page.locator('#train-count').innerText()).trim();
  if (hsrTrains >= totalTrains) throw new Error(`高铁筛选未生效（${hsrTrains}/${totalTrains}）`);
  if (!/^\d+\/\d+$/.test(hsrCount)) throw new Error(`筛选后计数应显示 N/M，实际 "${hsrCount}"`);
  const hsrTexts = await page.locator('#trains-panel .card').allInnerTexts();
  if (!hsrTexts.every((t) => /[GDC]\d+/.test(t.replace(/\s+/g, ' ')))) {
    throw new Error('高铁动车筛选后存在非 G/D/C 车次');
  }
  console.log(`车型筛选（高铁动车）: ${hsrCount}，全部为 G/D/C 车次`);

  // 时段筛选叠加：上午（06:00-12:00 出发）
  await page.click('#filter-dep .pill[data-v="morning"]');
  await page.waitForTimeout(200);
  const morningCount = (await page.locator('#train-count').innerText()).trim();
  console.log(`叠加时段筛选（上午）: ${morningCount}`);
  await page.click('#filter-type .pill[data-v="all"]');
  await page.click('#filter-dep .pill[data-v="all"]');
  await page.waitForTimeout(200);
  const restored = await page.locator('#trains-panel .card').count();
  if (restored !== totalTrains) throw new Error(`清除筛选未恢复（${restored}/${totalTrains}）`);
  console.log('筛选恢复（全部）: 正常');

  // 准点率徽标：切回机票 tab 校验分级徽标
  await page.click('#tab-flights');
  await page.waitForTimeout(300);
  const pkBadges = await page.locator('#flights-panel .tag-punctual').count();
  if (pkBadges > 0) {
    const pkText = (await page.locator('#flights-panel .tag-punctual').first().innerText()).trim();
    if (!/^准点率 \d+% · /.test(pkText)) throw new Error(`准点率徽标文案异常："${pkText}"`);
    const pkClass = await page.locator('#flights-panel .tag-punctual').first().getAttribute('class');
    if (!/pk-(hi|mid|lo)/.test(pkClass)) throw new Error(`准点率徽标缺少分级 class："${pkClass}"`);
    console.log(`准点率徽标: ${pkBadges} 个，样例「${pkText}」（${pkClass.match(/pk-\w+/)[0]}）`);
  } else {
    console.log('准点率徽标: 当前数据源无准点率数据，跳过校验');
  }

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

  // 数据源选择器：auto 选项已移除，默认 local 无提示，切到 llm 显示慢速提示，切回 local 隐藏
  const autoOptionCount = await page.locator('#source-select option[value="auto"]').count();
  if (autoOptionCount !== 0) throw new Error('数据源下拉框仍存在 auto 选项');
  const defaultSource = await page.inputValue('#source-select');
  if (defaultSource !== 'local') throw new Error(`数据源默认值应为 local，实际 ${defaultSource}`);
  const hintHiddenOnDefault = !(await page.locator('#source-hint').isVisible());
  await page.selectOption('#source-select', 'llm');
  const hintVisibleOnLlm = await page.locator('#source-hint').isVisible();
  const hintText = (await page.locator('#source-hint').innerText()).replace(/\s+/g, ' ');
  console.log(`AI 慢速提示（llm 时显示）: ${hintVisibleOnLlm ? '可见' : '不可见'} - ${hintText.slice(0, 50)}`);
  await page.selectOption('#source-select', 'local');
  const hintHiddenOnLocal = !(await page.locator('#source-hint').isVisible());
  if (!hintHiddenOnDefault || !hintVisibleOnLlm || !hintHiddenOnLocal) {
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
  // LLM 分阶段进度组件已加载（AI 慢速查询时显示横幅）
  const llmProgressOk = await page.evaluate(() =>
    typeof window.LLMProgress === 'object' &&
    typeof window.LLMProgress.start === 'function' &&
    typeof window.LLMProgress.stop === 'function'
  );
  if (!llmProgressOk) throw new Error('LLMProgress 分阶段进度组件未加载');
  console.log('LLM 分阶段进度组件: 已加载');

  // 快捷城市芯片：点击成都自动重搜
  await page.click('.quick-chips .chip[data-city="成都"]');
  await page.waitForSelector('#sight-list .card:not(.skeleton)', { timeout: 10000 });
  const chipCity = await page.inputValue('#city-input');
  if (chipCity !== '成都') throw new Error(`城市芯片填充异常：${chipCity}`);
  console.log('快捷城市芯片（成都）: 自动查询正常');

  const firstSight = await page.locator('#sight-list .card').first().innerText();
  console.log('首张景点卡片摘要:', firstSight.replace(/\s+/g, ' ').slice(0, 120));

  // 切换排序：评分最高
  await page.selectOption('#sort-select', 'rating');
  await page.waitForTimeout(300);
  const topRated = await page.locator('#sight-list .card .sight-rating').first().innerText();
  console.log('按评分排序后最高分:', topRated.trim());

  // 点击景点卡片 → 地图弹窗展示实际位置（高德搜索页，本地数据无经纬度）
  await page.click('#sight-list .card');
  await page.waitForSelector('#map-modal:not([hidden])', { timeout: 5000 });
  const mapName = (await page.locator('#map-modal-name').innerText()).trim();
  const mapFrameSrc = await page.getAttribute('#map-frame', 'src');
  console.log(`地图弹窗景点: ${mapName}`);
  console.log(`地图 iframe 地址: ${mapFrameSrc.slice(0, 90)}`);
  if (!mapName) throw new Error('地图弹窗未显示景点名称');
  if (!mapFrameSrc.includes('uri.amap.com')) throw new Error('地图弹窗 iframe 未指向高德地图');
  await page.click('#map-modal-close');
  const mapClosed = await page.locator('#map-modal').isHidden();
  if (!mapClosed) throw new Error('地图弹窗关闭失败');
  console.log('地图弹窗打开/关闭: 正常');

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
  await page.selectOption('#source-select', 'local');
  await page.fill('#city-input', '成都');
  await page.selectOption('#specialty-category', '小吃');
  await page.click('#form-specialty button[type="submit"]');
  await page.waitForSelector('#specialty-panel .sight-card', { timeout: 5000 });
  const dishCount = await page.locator('#specialty-panel .sight-card').count();
  console.log(`特色菜品（成都 小吃）: ${dishCount} 道`);
  const firstDish = (await page.locator('#specialty-panel .sight-card').first().innerText()).replace(/\s+/g, ' ').slice(0, 120);
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
  await page.waitForSelector('#restaurant-panel .sight-card', { timeout: 60000 });
  const restCount = await page.locator('#restaurant-panel .sight-card').count();
  console.log(`餐厅（北京/火锅/80–200）: ${restCount} 家`);
  const firstRest = (await page.locator('#restaurant-panel .sight-card').first().innerText()).replace(/\s+/g, ' ').slice(0, 140);
  console.log('首家餐厅:', firstRest);
  // 标题：检查 ·ƙ�餐· / 人均·存在 距地标 参考
  const restCards = page.locator('#restaurant-panel .sight-card');
  for (let i = 0; i < await restCards.count(); i++) {
    const t = await restCards.nth(i).innerText();
    // 顾客经过☎️ + 地区/距地标信息
    if (!t.includes('地址') && !t.includes('km')) throw new Error(`餐厅缺少位置`);
    if (!t.includes('人均')) throw new Error('餐厅缺少人均');
  }
  await page.screenshot({ path: path.join('.pilotdeck', 'shot-food-restaurant.png'), fullPage: false });

  // Tab 3: 个性化推荐
  await page.click('#tab-personalize');
  await page.waitForSelector('#panel-personalize:not([hidden])', { timeout: 2000 });
  await page.fill('#city-input', '成都');
  await page.fill('#query-input', '和几个朋友吃宵夜，喜欢辣，150 元每人');
  await page.click('#form-personalize button[type="submit"]');
  await page.waitForSelector('#personalize-list .sight-card', { timeout: 60000 });
  const recCount = await page.locator('#personalize-list .sight-card').count();
  const parsedCount = await page.locator('#parsed-chips .parsed-chip').count();
  console.log(`个性化（成都/朋友/宵夜）: 解析 ${parsedCount} 项 · 推荐 ${recCount} 家`);
  if (parsedCount < 2) throw new Error('个性化解析太少');
  if (recCount < 1) throw new Error('个性化没出推荐');
  // 标题：第一家需包含 号码 + 匹配度
  const firstRec = (await page.locator('#personalize-list .sight-card').first().innerText()).replace(/\s+/g, ' ').slice(0, 180);
  console.log('首家推荐:', firstRec);
  if (!firstRec.includes('匹配指数')) throw new Error('个性化匹配度缺失');
  await page.screenshot({ path: path.join('.pilotdeck', 'shot-food-personalize.png'), fullPage: false });

  // 移动端 餐厅 tab 截图
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(300);
  await page.click('#tab-restaurant');
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join('.pilotdeck', 'shot-food-mobile.png'), fullPage: false });

  // 数据来源选择：切到「本地数据」重新查询，验证 source 参数传递与徽标渲染
  await page.setViewportSize({ width: 1200, height: 900 });
  await page.selectOption('#source-select', 'local');
  await page.click('#tab-specialty');
  await page.waitForTimeout(200);
  await page.click('#form-specialty button[type="submit"]');
  await page.waitForSelector('#specialty-panel .sight-card', { timeout: 5000 });
  const badgeText = (await page.locator('#result-summary .source-badge').innerText()).trim();
  console.log(`美食数据源徽标: ${badgeText}`);
  if (!badgeText.includes('本地数据')) throw new Error(`source 徽标异常：得到 ${badgeText}`);
  // AI 慢速提示显隐验证
  await page.selectOption('#source-select', 'llm');
  await page.waitForTimeout(200);
  const hintVisible = await page.locator('#source-hint').isVisible();
  if (!hintVisible) throw new Error('source=llm 时慢速提示未显示');
  await page.selectOption('#source-select', 'auto');
  await page.waitForTimeout(200);
  const hintHidden = !(await page.locator('#source-hint').isVisible());
  if (!hintHidden) throw new Error('source=auto 时慢速提示应隐藏');
  console.log('数据来源选择（下拉切换 + 徽标 + 慢速提示）验证通过');

  // 高德数据源：仅餐厅 tab 可选，其他 tab 禁用并说明原因
  const amapOption = page.locator('#source-select option[value="amap"]');
  if (!(await amapOption.isDisabled())) throw new Error('特色菜品 tab 下高德选项应禁用');
  const amapLabel = (await amapOption.innerText()).trim();
  if (!amapLabel.includes('仅餐厅筛选')) throw new Error(`禁用态文案异常：${amapLabel}`);
  await page.click('#tab-restaurant');
  await page.waitForTimeout(200);
  if (await amapOption.isDisabled()) throw new Error('餐厅 tab 下高德选项应可用');
  // 切到高德提交：未配置 Key 时应展示明确错误；已配置时应返回真实餐厅数据
  const amapCfgOn = await page.evaluate(async () => {
    const r = await fetch('/api/food/sources');
    const d = await r.json();
    return Boolean((d.sources || []).find((s) => s.name === 'amap' && s.configured));
  });
  await page.selectOption('#source-select', 'amap');
  muteConsoleErrors = true; // 预期 400（未配置 Key）：忽略浏览器资源加载报错
  await page.click('#form-restaurant button[type="submit"]');
  await page.waitForTimeout(1200);
  if (!amapCfgOn) {
    const errTip = await page.locator('#empty-tip').innerText().catch(() => '');
    if (!String(errTip).includes('未配置')) throw new Error(`未配置高德 Key 应提示未配置，实际：${errTip}`);
    console.log(`高德未配置 Key 时的错误提示: ${String(errTip).trim()}`);
  } else {
    await page.waitForSelector('#restaurant-panel .sight-card', { timeout: 30000 });
    const amapBadge = (await page.locator('#result-summary .source-badge').innerText()).trim();
    if (!amapBadge.includes('高德地图')) throw new Error(`高德徽标异常：${amapBadge}`);
    console.log(`高德真实数据徽标: ${amapBadge}`);
  }
  muteConsoleErrors = false;
  // 收尾：切回 auto 并回到特色 tab
  await page.selectOption('#source-select', 'auto');
  await page.click('#tab-specialty');
  console.log('高德数据源（餐厅 tab 可用 / 其他 tab 禁用 + 提交验证）验证通过');


  // ---- 酒店模块：偏好选择 + 搜索成都 → 校验渲染与筛选 ----
  await page.goto('http://localhost:3000/hotel.html', { waitUntil: 'networkidle' });
  const hotelNav = (await page.locator('.module-nav a.is-active').innerText()).trim();
  console.log(`酒店模块导航高亮: ${hotelNav}`);

  // 偏好 chips：默认「不限」，点击药丸选中舒适型 + 市中心（input 视觉隐藏，点击可见的 label）
  const chipCount = await page.locator('.chip input').count();
  console.log(`偏好选项（价格档位 + 位置偏好）: ${chipCount} 个`);
  await page.click('.chip:has(input[name="tier"][value="comfort"])');
  await page.click('.chip:has(input[name="location"][value="downtown"])');
  const tierChecked = await page.isChecked('input[name="tier"][value="comfort"]');
  const locChecked = await page.isChecked('input[name="location"][value="downtown"]');
  if (!tierChecked || !locChecked) throw new Error('偏好 chip 选中态异常');

  // 本地数据源搜索（秒开，结果确定）
  await page.selectOption('#source-select', 'local');
  await page.fill('#city-input', '成都');
  await page.click('#search-btn');
  try {
    await page.waitForSelector('#hotel-list .card:not(.skeleton)', { timeout: 10000 });
  } catch {
    console.error('--- 等待酒店卡片超时，dump 调试信息 ---');
    console.error('city-input 值:', await page.inputValue('#city-input'));
    console.error('tier/location checked:', await page.isChecked('input[name="tier"][value="comfort"]'), '/', await page.isChecked('input[name="location"][value="downtown"]'));
    console.error('source-select 值:', await page.inputValue('#source-select'));
    console.error('结果区可见性:', await page.locator('#result-section').isVisible());
    console.error('hotel-list HTML 前 600 字:');
    console.error((await page.locator('#hotel-list').innerHTML()).slice(0, 600));
    throw new Error('酒店卡片未在 10s 内渲染');
  }
  const hotelCards = await page.locator('#hotel-list .card:not(.skeleton)').count();
  console.log(`酒店卡片（¥200 - ¥450 · 市中心）: ${hotelCards} 张`);
  const hotelSummary = (await page.locator('#hotel-summary').innerText()).replace(/\s+/g, ' ');
  console.log('酒店结果摘要:', hotelSummary.slice(0, 80));
  if (!hotelSummary.includes('¥200 - ¥450')) throw new Error('摘要未包含价格档位条件');
  const firstHotel = await page.locator('#hotel-list .card').first().innerText();
  console.log('首张酒店卡片摘要:', firstHotel.replace(/\s+/g, ' ').slice(0, 120));
  const tierTag = await page.locator('#hotel-list .card .tier-tag').first().innerText();
  if (tierTag.trim() !== '舒适型') throw new Error(`首张卡片档位异常: ${tierTag}`);

  // 切换排序：低价优先
  await page.selectOption('#sort-select', 'priceAsc');
  await page.waitForTimeout(300);
  const lowestPrice = await page.locator('#hotel-list .card .hotel-price em').first().innerText();
  console.log('按价格升序后最低价:', lowestPrice.trim());

  // ---- ¥200以下 严格价格过滤回归（本次 bug 修复核心场景）----
  await page.click('.chip:has(input[name="tier"][value="budget"])');
  await page.click('.chip:has(input[name="location"][value="any"])');
  await page.click('#search-btn');
  await page.waitForSelector('#hotel-list .card:not(.skeleton)', { timeout: 10000 });
  const priceTexts = await page.locator('#hotel-list .card .hotel-price em').allInnerTexts();
  const budgetPrices = priceTexts.map((t) => Number(String(t).replace(/[^\d.]/g, ''))).filter((n) => Number.isFinite(n));
  if (budgetPrices.length < 3) throw new Error(`「¥200以下」应返回 ≥3 家真实低价酒店，实际 ${budgetPrices.length} 张`);
  if (!budgetPrices.every((p) => p <= 200)) {
    throw new Error(`「¥200以下」存在越界价格（必须全部 ≤ ¥200）: ¥${budgetPrices.join(' / ¥')}`);
  }
  const budgetSummary = (await page.locator('#hotel-summary').innerText()).replace(/\s+/g, ' ');
  if (!budgetSummary.includes('¥200以下')) throw new Error(`摘要未包含 ¥200以下 条件: ${budgetSummary}`);
  console.log(`¥200以下卡片: ${budgetPrices.length} 张，价格 ¥${[...budgetPrices].sort((a, b) => a - b).join(' / ¥')}（全部 ≤ 200 ✓）`);

  await page.screenshot({ path: path.join('.pilotdeck', 'shot-hotel.png'), fullPage: false });

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
