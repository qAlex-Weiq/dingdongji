'use strict';

/** 冒烟测试：验证 API 各端点与边界情况（UTF-8 编码，绕过 shell 编码问题） */

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
  // 1. 城市列表
  const cities = await get('/api/cities');
  check('GET /api/cities 返回 200 且非空', cities.status === 200 && Array.isArray(cities.body) && cities.body.length > 0, `共 ${cities.body.length} 城`);

  // 2. 正常查询：北京 → 上海
  const q = '/api/search?from=' + encodeURIComponent('北京') + '&to=' + encodeURIComponent('上海') + '&date=2026-09-12';
  const r1 = await get(q);
  const ok1 = r1.status === 200 && r1.body.flights?.length > 0 && r1.body.trains?.length > 0;
  check('GET /api/search 北京→上海 返回机票+火车票', ok1,
    `航班 ${r1.body.flights?.length} 班 / 车次 ${r1.body.trains?.length} 趟`);
  const f = r1.body.flights?.[0] || {};
  check('航班字段完整', ['flightNo', 'airline', 'depTime', 'arrTime', 'depAirport', 'arrAirport', 'durationMin', 'price'].every((k) => f[k] !== undefined), `${f.flightNo} ${f.depTime}-${f.arrTime} ¥${f.price}`);
  const t = r1.body.trains?.[0] || {};
  check('车次字段完整', ['trainNo', 'depTime', 'arrTime', 'depStation', 'arrStation', 'durationMin', 'seats'].every((k) => t[k] !== undefined), `${t.trainNo} ${t.depTime}-${t.arrTime} 二等座¥${t.seats?.[0]?.price}`);

  // 3. 结果确定性：两次查询结果一致
  const r2 = await get(q);
  check('同一查询结果稳定（确定性模拟）', JSON.stringify(r1.body) === JSON.stringify(r2.body));

  // 4. 拼音匹配
  const r3 = await get('/api/search?from=chengdu&to=xian&date=2026-09-12');
  check('拼音匹配城市（chengdu→xian）', r3.status === 200 && r3.body.query?.from === '成都' && r3.body.query?.to === '西安');

  // 5. 错误处理
  const e1 = await get('/api/search?from=' + encodeURIComponent('北京') + '&to=' + encodeURIComponent('北京') + '&date=2026-09-12');
  check('相同城市返回 400', e1.status === 400 && e1.body.error);
  const e2 = await get('/api/search?from=' + encodeURIComponent('火星') + '&to=' + encodeURIComponent('上海') + '&date=2026-09-12');
  check('不支持的城市返回 404', e2.status === 404 && e2.body.error);
  const e3 = await get('/api/search?from=' + encodeURIComponent('北京') + '&to=' + encodeURIComponent('上海'));
  check('缺少 date 返回 400', e3.status === 400 && e3.body.error);
  const e4 = await get('/api/nothing');
  check('未知 API 返回 404', e4.status === 404 && e4.body.error);

  // 6. 静态页面
  const html = await fetch(BASE + '/').then((r) => r.text());
  check('首页 HTML 可访问且包含关键元素', html.includes('search-form') && html.includes('city-list') && html.includes('叮咚机'));
  const css = await fetch(BASE + '/css/style.css');
  const js = await fetch(BASE + '/js/app.js');
  check('CSS/JS 静态资源可访问', css.status === 200 && js.status === 200);

  console.log(process.exitCode ? '\n存在失败项' : '\n全部通过');
})().catch((err) => {
  console.error('测试执行失败:', err.message);
  process.exit(1);
});
