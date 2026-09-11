'use strict';

/**
 * foodProviderAmap 离线管线测试：mock 高德 v5 响应，验证
 * 请求参数构造 / POI 归一化 / 价格·时段·营业中过滤 / 排序 / 空 POI 抛错。
 * 运行：node scripts/test-food-amap.js（无需真实 Key / 网络）
 */

process.env.AMAP_KEY = 'test-key-123';

const assert = require('assert');
const provider = require('../server/providers/foodProviderAmap');

let lastUrl = null;

function makePoi(overrides = {}) {
  return Object.assign({
    id: 'B0FF012345',
    name: '测试火锅店',
    type: '餐饮服务;中餐厅;四川菜(川菜)',
    typecode: '050301',
    pname: '四川省', cityname: '成都市', adname: '锦江区',
    address: '中纱帽街 8 号',
    location: '104.081,30.655',
    business: {
      business_area: '春熙路',
      opentime_today: '11:00-02:00',
      opentime_week: '周一至周日 11:00-02:00',
      tel: '028-12345678',
      rating: '4.6',
      cost: '130',
      tag: '辣,火锅,深夜食堂',
    },
  }, overrides);
}

async function mockFetch(body) {
  return {
    ok: true,
    status: 200,
    json: async () => body,
  };
}

const realFetch = global.fetch;

async function main() {
  // ---- 1) 请求参数 + 归一化 ----
  lastUrl = null;
  global.fetch = async (url) => {
    lastUrl = url;
    return mockFetch({ status: '1', info: 'OK', infocode: '10000', errcode: 0, pois: [makePoi()] });
  };
  let rs = await provider.searchRestaurants('成都', { cuisines: ['川菜'] });
  assert.ok(lastUrl.includes('types=050000'), 'types 应为餐饮服务大类');
  assert.ok(lastUrl.includes('show_fields=business'), 'show_fields 应含 business');
  assert.ok(lastUrl.includes('region='), '应带 region');
  assert.ok(lastUrl.includes('city_limit=true'), '应限定城市');
  assert.ok(lastUrl.includes('keywords='), '应带关键词');
  assert.strictEqual(rs.length, 1);
  const r = rs[0];
  assert.strictEqual(r.name, '测试火锅店');
  assert.strictEqual(r.avgPrice, 130, 'cost → avgPrice');
  assert.ok(r.priceRange.startsWith('¥'), 'priceRange 形如 ¥91–169');
  assert.strictEqual(r.rating, 4.6, 'rating 字符串转数字');
  assert.strictEqual(r.reviewCount, 0, '高德无评价数');
  assert.deepStrictEqual(r.cuisines, ['川菜'], '菜系匹配');
  assert.ok(r.location.nearLandmark.includes('春熙路'), '商圈 → 近地标');
  assert.strictEqual(r.hours.open, '11:00', 'opentime_today 解析');
  assert.strictEqual(r.hours.close, '02:00', '跨夜 close');
  assert.ok(r.hours.slots.length >= 2, '推导供应时段');
  assert.strictEqual(typeof r.hours.isOpenNow, 'boolean', 'isOpenNow 布尔');
  assert.ok(r.tags.includes('深夜食堂'), 'tag 拆分');
  console.log('PASS 请求参数构造 + POI 归一化（cost/rating/opentime/tag/商圈）');

  // ---- 2) 缺 business 字段的容错 ----
  global.fetch = async () => mockFetch({
    status: '1', errcode: 0,
    pois: [makePoi({ id: 'B1', name: '无名小店', type: '餐饮服务;快餐厅', business: {} })],
  });
  rs = await provider.searchRestaurants('成都', {});
  assert.strictEqual(rs[0].avgPrice, null, '无 cost → null');
  assert.strictEqual(rs[0].priceRange, '以现场为准');
  assert.strictEqual(rs[0].hours.open, '--', '无营业时间 → --');
  assert.ok(['美食', '中餐'].includes(rs[0].cuisines[0]) || rs[0].cuisines.length >= 1, '菜系兜底');
  console.log('PASS 缺失字段容错（avgPrice=null / hours=-- / 菜系兜底）');

  // ---- 3) 过滤：价格 / 时段 / 营业中 ----
  const pois = [
    makePoi({ id: 'A1', name: '贵店', business: Object.assign(makePoi().business, { cost: '500', rating: '4.9' }) }),
    makePoi({ id: 'A2', name: '平价店', business: Object.assign(makePoi().business, { cost: '60', rating: '4.2' }) }),
    makePoi({ id: 'A3', name: '午市店', business: Object.assign(makePoi().business, { cost: '100', rating: '4.5', opentime_today: '11:00-14:00' }) }),
    makePoi({ id: 'A4', name: '未知价', business: { rating: '4.0', opentime_today: '11:00-22:00' } }),
  ];
  global.fetch = async () => mockFetch({ status: '1', errcode: 0, pois });
  // 价格区间 50-200：A2/A3 过，A1 淘汰，A4 未知价过（宽松策略）
  rs = await provider.searchRestaurants('成都', { priceMin: 50, priceMax: 200 });
  assert.deepStrictEqual(rs.map((x) => x.name).sort(), ['午市店', '平价店', '未知价'], `价格过滤: ${rs.map((x) => x.name)}`);
  // 时段=晚餐：全天店过，午市店（11:00-14:00 不覆盖晚餐）淘汰，未知时段店过（宽松）
  rs = await provider.searchRestaurants('成都', { slot: '晚餐' });
  const names = rs.map((x) => x.name).sort();
  assert.ok(!names.includes('午市店'), '时段过滤应淘汰午市店');
  assert.ok(names.includes('贵店') && names.includes('未知价'), '时段过滤应保留全天/未知');
  // 排序：评分降序（贵店4.9 > 午市4.5 > 平价4.2 > 未知4.0）
  rs = await provider.searchRestaurants('成都', {});
  const ratings = rs.map((x) => x.rating);
  assert.deepStrictEqual(ratings, [4.9, 4.5, 4.2, 4.0], `评分排序: ${ratings}`);
  // 价格升序：未知价（null）排最后
  rs = await provider.searchRestaurants('成都', { sort: 'priceAsc' });
  assert.strictEqual(rs[rs.length - 1].name, '未知价', '价格排序未知价垫底');
  console.log('PASS 过滤（价格/时段）+ 排序（评分/价格，未知值容错）');

  // ---- 4) 空 POI → 抛错（auto 模式可降级） ----
  global.fetch = async () => mockFetch({ status: '1', errcode: 0, pois: [] });
  await assert.rejects(
    () => provider.searchRestaurants('成都', {}),
    /高德未返回/,
    '空 POI 应抛错供降级',
  );
  console.log('PASS 空 POI 抛错（供 auto 降级）');

  // ---- 5) 接口错误码 → 抛错 ----
  global.fetch = async () => mockFetch({ status: '0', errcode: 20003, errmsg: 'INVALID_USER_KEY', pois: [] });
  await assert.rejects(() => provider.searchRestaurants('成都', {}), /高德接口错误/);
  console.log('PASS 高德错误码抛错');

  // ---- 6) 元信息与配置 ----
  assert.strictEqual(provider.meta.name, 'amap');
  assert.strictEqual(provider.meta.requiresKey, 'AMAP_KEY');
  assert.strictEqual(provider.isConfigured(), true, 'env AMAP_KEY 视为已配置');
  assert.strictEqual(typeof provider.searchRestaurants, 'function');
  assert.strictEqual(provider.getSpecialties, undefined, '不支持特色菜品');
  assert.strictEqual(provider.personalize, undefined, '不支持个性化');
  console.log('PASS 元信息 / 能力声明（仅 searchRestaurants）');

  console.log('\n全部通过：foodProviderAmap 离线管线测试');
}

main().then(() => {
  global.fetch = realFetch;
}).catch((e) => {
  global.fetch = realFetch;
  console.error('FAIL:', e.message);
  process.exit(1);
});
