'use strict';

/** 冒烟测试：验证 API 各端点与边界情况 + 页面可达性（UTF-8 编码，绕过 shell 编码问题） */

const BASE = 'http://localhost:3000';

async function get(path) {
  const res = await fetch(BASE + path);
  return { status: res.status, body: await res.json() };
}

function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) process.exitCode = 1;
}

(async () => {
  // 1. 城市列表（各模块共享）
  const cities = await get('/api/cities');
  check('GET /api/cities 返回 200 且非空', cities.status === 200 && Array.isArray(cities.body) && cities.body.length > 0, `共 ${cities.body.length} 城`);

  // 2. 车票模块：正常查询 北京 → 上海
  const q = '/api/ticket/search?from=' + encodeURIComponent('北京') + '&to=' + encodeURIComponent('上海') + '&date=2026-09-12';
  const r1 = await get(q);
  const ok1 = r1.status === 200 && r1.body.flights?.length > 0 && r1.body.trains?.length > 0;
  check('GET /api/ticket/search 北京→上海 返回机票+火车票', ok1,
    `航班 ${r1.body.flights?.length} 班 / 车次 ${r1.body.trains?.length} 趟`);
  const f = r1.body.flights?.[0] || {};
  check('航班字段完整', ['flightNo', 'airline', 'depTime', 'arrTime', 'depAirport', 'arrAirport', 'durationMin', 'price'].every((k) => f[k] !== undefined), `${f.flightNo} ${f.depTime}-${f.arrTime} ¥${f.price}`);
  const t = r1.body.trains?.[0] || {};
  check('车次字段完整', ['trainNo', 'depTime', 'arrTime', 'depStation', 'arrStation', 'durationMin', 'seats'].every((k) => t[k] !== undefined), `${t.trainNo} ${t.depTime}-${t.arrTime}`);

  // 3. 确定性：同条件两次查询结果一致
  const r2 = await get(q);
  check('同条件查询结果确定（哈希稳定）', JSON.stringify(r1.body) === JSON.stringify(r2.body));

  // 4. 拼音匹配
  const qp = '/api/ticket/search?from=beijing&to=shanghai&date=2026-09-12';
  const r3 = await get(qp);
  check('拼音匹配城市（beijing→shanghai）', r3.status === 200 && r3.body.query?.from === '北京' && r3.body.query?.to === '上海');

  // 5. 错误处理
  const e1 = await get('/api/ticket/search?from=北京&to=上海');
  check('缺少 date 返回 400', e1.status === 400 && e1.body.error);
  const e2 = await get('/api/ticket/search?from=北京&to=北京&date=2026-09-12');
  check('相同城市返回 400', e2.status === 400 && e2.body.error);
  const e3 = await get('/api/ticket/search?from=北京&to=火星&date=2026-09-12');
  check('不支持的城市返回 404', e3.status === 404 && e3.body.error);
  const e4 = await get('/api/nothing');
  check('未知 API 返回 404', e4.status === 404 && e4.body.error);

  // 6. 景点模块：正常查询（显式 local 数据源，快速且确定）
  const s1 = await get('/api/sight/search?city=' + encodeURIComponent('成都') + '&source=local');
  const okS1 = s1.status === 200 && s1.body.sights?.length > 0 && s1.body.source === 'local' && s1.body.count > 0;
  check('GET /api/sight/search 成都&source=local 返回景点列表', okS1,
    `来源 ${s1.body.source} / ${s1.body.count} 个景点`);
  const s = s1.body.sights?.[0] || {};
  check('景点字段完整', ['name', 'rating', 'type', 'ticket', 'openTime', 'address', 'desc', 'score', 'rank'].every((k) => s[k] !== undefined), `No.${s.rank} ${s.name}（score ${s.score}）`);
  const scores = (s1.body.sights || []).map((x) => x.score);
  check('景点按综合得分降序排列', scores.every((v, i) => i === 0 || scores[i - 1] >= v));

  // 7. 景点模块：拼音匹配 + 缓存
  const s2 = await get('/api/sight/search?city=hangzhou&source=local');
  check('拼音匹配城市（hangzhou → 杭州）', s2.status === 200 && s2.body.city === '杭州' && s2.body.sights?.length > 0);
  const s3 = await get('/api/sight/search?city=hangzhou&source=local');
  check('同城市同数据源二次查询命中缓存', s3.status === 200 && s3.body.cached === true);

  // 8. 景点模块：错误处理 + 数据源状态 + source 参数
  const se1 = await get('/api/sight/search');
  check('景点查询缺少 city 返回 400', se1.status === 400 && se1.body.error);
  const se2 = await get('/api/sight/search?city=火星');
  check('景点查询不支持的城市返回 404', se2.status === 404 && se2.body.error);
  const se3 = await get('/api/sight/sources');
  const okSe3 = se3.status === 200 && Array.isArray(se3.body.sources) && se3.body.sources.some((x) => x.name === 'local');
  check('GET /api/sight/sources 返回数据源状态', okSe3,
    se3.body.sources?.map((x) => `${x.name}:${x.configured ? 'on' : 'off'}`).join(' '));
  const se4 = await get('/api/sight/search?city=' + encodeURIComponent('北京') + '&source=xxx');
  check('非法 source 参数返回 400', se4.status === 400 && se4.body.error);

  // 9. 设置模块：读取 / 保存 / 恢复 / 密钥脱敏
  const st1 = await get('/api/settings');
  const okSt1 = st1.status === 200 && st1.body.effective && typeof st1.body.effective.llmReady === 'boolean' && typeof st1.body.user.llmApiKeyMasked !== 'undefined';
  check('GET /api/settings 返回配置状态', okSt1,
    `llm:${st1.body.effective?.llmReady ? 'on' : 'off'} amap:${st1.body.effective?.amapReady ? 'on' : 'off'}`);
  check('设置接口不返回明文密钥', !/(sk-[A-Za-z0-9_-]{20,})/.test(JSON.stringify(st1.body)));
  const put1 = await fetch(BASE + '/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ llmModel: 'smoke-test-model' }),
  });
  check('PUT /api/settings 保存成功', put1.status === 200);
  const st2 = await get('/api/settings');
  check('保存后生效模型已更新', st2.status === 200 && st2.body.effective.llmModel === 'smoke-test-model');
  // 恢复原值（用户原本未配置时写空串清除，回退 .env）
  const restoreModel = st1.body.user.llmModel || '';
  await fetch(BASE + '/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ llmModel: restoreModel }),
  });
  const st3 = await get('/api/settings');
  check('测试后恢复原模型配置', st3.status === 200 && st3.body.effective.llmModel === (st1.body.effective.llmModel || 'glm-4-flash'),
    `当前生效: ${st3.body.effective.llmModel}`);
  const putEmpty = await fetch(BASE + '/api/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({}),
  });
  check('PUT 空配置返回 400', putEmpty.status === 400);

  // 10. 景点模块：auto 模式（真实降级链，LLM 已配置时约 10~40 秒）
  const sAuto = await get('/api/sight/search?city=' + encodeURIComponent('西安'));
  const okAuto = sAuto.status === 200 && sAuto.body.sights?.length > 0 && ['amap', 'llm', 'local'].includes(sAuto.body.source);
  check('GET /api/sight/search 西安（auto 降级链）', okAuto,
    `来源 ${sAuto.body.source} / ${sAuto.body.count} 个景点`);

  // 9. 页面：首页四模块入口
  const home = await fetch(BASE + '/').then((r) => r.text());
  const cardCount = (home.match(/class="module-card"/g) || []).length;
  check('首页包含 4 个模块入口', home.includes('module-grid') && cardCount === 4, `实际 ${cardCount} 个`);
  check('首页景点模块状态为可用', /href="\/sight\.html"[\s\S]*?st-live/.test(home));

  // 10. 车票页保留完整查询功能
  const ticket = await fetch(BASE + '/ticket.html').then((r) => r.text());
  check('车票页包含查询表单与城市补全', ticket.includes('search-form') && ticket.includes('city-list') && ticket.includes('module-nav'));

  // 11. 景点页为可用页面（非占位），含数据源选择器与慢速提示
  const sight = await fetch(BASE + '/sight.html').then((r) => r.text());
  check('景点页包含查询表单与结果区', sight.includes('sight-form') && sight.includes('sight-list') && sight.includes('city-list') && !sight.includes('coming-soon'));
  check('景点页包含数据源选择器与 AI 慢速提示', sight.includes('source-select') && sight.includes('source-hint') && sight.includes('AI 联网搜索'));

  // 12. 设置页可达且包含配置表单
  const settingsPage = await fetch(BASE + '/settings.html');
  const spHtml = await settingsPage.text();
  check('GET /settings.html 返回 200 且包含配置表单', settingsPage.status === 200 && spHtml.includes('settings-form') && spHtml.includes('llm-key') && spHtml.includes('llm-url'));
  check('首页与车票页导航包含设置入口', home.includes('settings.html') && ticket.includes('settings.html'));

  // 13. 占位模块页可达（酒店 / 饭店），且导航含设置入口
  for (const p of ['hotel', 'food']) {
    const res = await fetch(`${BASE}/${p}.html`);
    const html = await res.text();
    check(`GET /${p}.html 返回 200 且为占位页`, res.status === 200 && html.includes('coming-soon') && html.includes('开发中') && html.includes('settings.html'));
  }

  // 14. 静态资源
  const css = await fetch(BASE + '/css/style.css');
  const js = await fetch(BASE + '/js/app.js');
  const sightJs = await fetch(BASE + '/js/sight.js');
  const settingsJs = await fetch(BASE + '/js/settings.js');
  check('CSS/JS 静态资源可访问', css.status === 200 && js.status === 200 && sightJs.status === 200 && settingsJs.status === 200);

  console.log(process.exitCode ? '\n存在失败项' : '\n全部通过');
})().catch((err) => {
  console.error('测试执行失败:', err.message);
  process.exit(1);
});
