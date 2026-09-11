#!/usr/bin/env node
/**
 * 机票 Amadeus 数据源离线单测（不联网）
 * 覆盖：ISO8601 历时解析、时刻/跨天解析、offer 归一化（含防御性拒绝）、城市/航司映射完备性
 * 运行：node scripts/test-flight-amadeus.js
 */
const path = require('path');
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { _internal: amadeus } = require(path.join(__dirname, '../server/providers/flightProviderAmadeus'));
const { CITIES } = require(path.join(__dirname, '../server/data/cities'));

let pass = 0;
const fails = [];
function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok - ${name}`);
  } catch (e) {
    fails.push(name);
    console.error(`  FAIL - ${name}: ${e.message}`);
  }
}

console.log('ISO8601 历时解析（parseIsoDuration）:');
test('PT2H35M -> 155 分钟', () => { if (amadeus.parseIsoDuration('PT2H35M') !== 155) throw new Error(String(amadeus.parseIsoDuration('PT2H35M'))); });
test('PT18H -> 1080 分钟', () => { if (amadeus.parseIsoDuration('PT18H') !== 1080) throw new Error('bad'); });
test('PT55M -> 55 分钟', () => { if (amadeus.parseIsoDuration('PT55M') !== 55) throw new Error('bad'); });
test('P1DT2H -> 1560 分钟（跨天）', () => { if (amadeus.parseIsoDuration('P1DT2H') !== 1560) throw new Error(String(amadeus.parseIsoDuration('P1DT2H'))); });
test('空串/乱码 -> null', () => { if (amadeus.parseIsoDuration('') !== null || amadeus.parseIsoDuration('abc') !== null) throw new Error('bad'); });

console.log('offer 归一化（官方 Flight Offers Search v2 响应结构）:');
const from = CITIES.find((c) => c.name === '上海');
const to = CITIES.find((c) => c.name === '北京');
const sampleOffer = {
  itineraries: [{
    duration: 'PT2H35M',
    segments: [{
      departure: { iataCode: 'SHA', terminal: '2', at: '2026-09-15T08:30:00+08:00' },
      arrival: { iataCode: 'PEK', terminal: '3', at: '2026-09-15T11:05:00+08:00' },
      carrierCode: 'MU', number: '5101', duration: 'PT2H35M',
    }],
  }],
  price: { currency: 'CNY', total: '553.40', grandTotal: '553.40' },
};
test('MU5101 SHA->PEK 归一化：航班号/时刻/含税价/机场中文/实时价标签', () => {
  const f = amadeus.normalizeOffer(sampleOffer, from, to, { carriers: { MU: 'China Eastern Airlines' } });
  if (!f
    || f.type !== 'flight' || f.flightNo !== 'MU5101' || f.airline !== '中国东方航空'
    || f.depTime !== '08:30' || f.arrTime !== '11:05' || f.arrDayOffset !== 0
    || !f.depAirport.includes('虹桥') || !f.arrAirport.includes('首都')
    || f.durationMin !== 155 || f.price !== 553 || f.discountLabel !== '实时价' || f.punctuality !== null) {
    throw new Error(JSON.stringify(f));
  }
});
test('跨天航班（20:00 -> 次日 14:00）arrDayOffset=1', () => {
  const overnight = {
    itineraries: [{ duration: 'PT18H', segments: [{
      departure: { iataCode: 'SHA', at: '2026-09-15T20:00:00+08:00' },
      arrival: { iataCode: 'PEK', at: '2026-09-16T14:00:00+08:00' },
      carrierCode: 'CA', number: '1502', duration: 'PT18H',
    }] }],
    price: { currency: 'CNY', total: '1200.00' },
  };
  const f = amadeus.normalizeOffer(overnight, from, to, {});
  if (!f || f.arrDayOffset !== 1 || f.durationMin !== 1080) throw new Error(JSON.stringify(f));
});
test('防御：负价/天价/缺时刻/缺航段 -> null 不产出', () => {
  if (amadeus.normalizeOffer({ ...sampleOffer, price: { total: '-5' } }, from, to, {}) !== null) throw new Error('负价未拒绝');
  if (amadeus.normalizeOffer({ ...sampleOffer, price: { total: '99999' } }, from, to, {}) !== null) throw new Error('天价未拒绝');
  if (amadeus.normalizeOffer({ ...sampleOffer, itineraries: [] }, from, to, {}) !== null) throw new Error('缺航段未拒绝');
  if (amadeus.normalizeOffer(null, from, to, {}) !== null) throw new Error('空 offer 未拒绝');
});
test('英文航司名兜底：本地映射缺失时用 dictionaries 值', () => {
  const f = amadeus.normalizeOffer({ ...sampleOffer, itineraries: [{ duration: 'PT2H', segments: [{ departure: { iataCode: 'SHA', at: '2026-09-15T09:00:00+08:00' }, arrival: { iataCode: 'PEK', at: '2026-09-15T11:00:00+08:00' }, carrierCode: 'XY', number: '123', duration: 'PT2H' }] }], price: { total: '800.00' } }, from, to, { carriers: { XY: 'Xiamen Air' } });
  if (!f || f.airline !== 'Xiamen Air') throw new Error(JSON.stringify(f && f.airline));
});

console.log('映射完备性:');
test('25 个支持城市全部有 IATA 城市码', () => {
  const missing = CITIES.filter((c) => !amadeus.CITY_IATA[c.name]).map((c) => c.name);
  if (missing.length > 0) throw new Error(`缺映射: ${missing.join('、')}`);
});
test('航司中文映射含数字开头代码（3U/9C）', () => {
  if (amadeus.AIRLINE_CN['3U'] !== '四川航空' || amadeus.AIRLINE_CN['9C'] !== '春秋航空') throw new Error('bad');
});

console.log(`\n${fails.length === 0 ? '✅' : '❌'} Amadeus 数据源单测: ${pass} 通过 / ${fails.length} 失败`);
process.exit(fails.length === 0 ? 0 : 1);
