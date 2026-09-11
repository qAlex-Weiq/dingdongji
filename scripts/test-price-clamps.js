#!/usr/bin/env node
/**
 * 价格真实性防线离线单测（不联网）
 * 覆盖：12306 票价/余票/历时解析、酒店档位价格 clamp、餐厅人均价格 clamp
 * 运行：node scripts/test-price-clamps.js
 */
const path = require('path');
process.env.NODE_ENV = process.env.NODE_ENV || 'test';
const { _internal: t12306 } = require(path.join(__dirname, '../server/providers/trainProvider12306'));
const { _internal: hotel } = require(path.join(__dirname, '../server/providers/hotelProviderLlm'));
const { _internal: food } = require(path.join(__dirname, '../server/providers/foodProviderLlm'));

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
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('12306 解析:');
test('parsePrice "07950" -> 795', () => { if (t12306.parsePrice('07950') !== 795) throw new Error(String(t12306.parsePrice('07950'))); });
test('parsePrice "01775" -> 177.5（末位十分位）', () => { if (t12306.parsePrice('01775') !== 177.5) throw new Error(String(t12306.parsePrice('01775'))); });
test('parsePrice "00000" -> null（零价）', () => { if (t12306.parsePrice('00000') !== null) throw new Error('not null'); });
test('parsePrice 非法输入 -> null', () => { if (t12306.parsePrice('') !== null || t12306.parsePrice('79') !== null || t12306.parsePrice(undefined) !== null) throw new Error('should be null'); });
test('availToStatus "有" -> 有票', () => { if (t12306.availToStatus('有') !== '有票') throw new Error('bad'); });
test('availToStatus "3" -> 少量（≤20）', () => { if (t12306.availToStatus('3') !== '少量') throw new Error('bad'); });
test('availToStatus "100" -> 有票（>20）', () => { if (t12306.availToStatus('100') !== '有票') throw new Error('bad'); });
test('availToStatus "无" -> 候补', () => { if (t12306.availToStatus('无') !== '候补') throw new Error('bad'); });
test('availToStatus "" -> null（席别不存在）', () => { if (t12306.availToStatus('') !== null) throw new Error('bad'); });
test('parseLishi "05:30" -> 330 分钟', () => { if (t12306.parseLishi('05:30') !== 330) throw new Error(String(t12306.parseLishi('05:30'))); });
test('parseLishi 非法 -> null', () => { if (t12306.parseLishi('abc') !== null) throw new Error('bad'); });
test('trainTypeOf G/D/K 前缀', () => { if (t12306.trainTypeOf('G101') !== '高铁' || t12306.trainTypeOf('D5') !== '动车' || t12306.trainTypeOf('K408') !== '普速') throw new Error('bad'); });

console.log('酒店价格 clamp（normalizeTierPrice）:');
test('null 守卫：非数字/≤50/>50000 -> null', () => { if (hotel.normalizeTierPrice(NaN, '豪华型') !== null || hotel.normalizeTierPrice(50, '豪华型') !== null || hotel.normalizeTierPrice(60000, '豪华型') !== null) throw new Error('bad'); });
test('豪华型下限 800：500 -> 800', () => { if (hotel.normalizeTierPrice(500, '豪华型') !== 800) throw new Error(String(hotel.normalizeTierPrice(500, '豪华型'))); });
test('经济型上限 360：1000 -> 360', () => { if (hotel.normalizeTierPrice(1000, '经济型') !== 360) throw new Error(String(hotel.normalizeTierPrice(1000, '经济型'))); });
test('舒适型区间 [240,720]：300 原样保留', () => { if (hotel.normalizeTierPrice(300, '舒适型') !== 300) throw new Error('bad'); });
test('不限档：合理价原样保留', () => { if (hotel.normalizeTierPrice(450, '不限') !== 450) throw new Error('bad'); });
test('未知档位标签回退不限：8888 保留', () => { if (hotel.normalizeTierPrice(8888, '不存在的档') !== 8888) throw new Error('bad'); });
test('四舍五入：349.6 -> 350', () => { if (hotel.normalizeTierPrice(349.6, '经济型') !== 350) throw new Error('bad'); });

console.log('餐厅价格 clamp（normalizeRestaurant）:');
const r1 = food.normalizeRestaurant({ name: '测试馆', avgPrice: 4 });
test('avgPrice 4（幻觉低价）-> null + priceRange null', () => { if (r1.avgPrice !== null || r1.priceRange !== null) throw new Error(JSON.stringify({ avgPrice: r1.avgPrice, priceRange: r1.priceRange })); });
const r2 = food.normalizeRestaurant({ name: '测试馆', avgPrice: 99999 });
test('avgPrice 99999（幻觉高价）-> null', () => { if (r2.avgPrice !== null) throw new Error(String(r2.avgPrice)); });
const r3 = food.normalizeRestaurant({ name: '测试馆', avgPrice: 3500 });
test('avgPrice 3500 -> clamp 到 3000', () => { if (r3.avgPrice !== 3000) throw new Error(String(r3.avgPrice)); });
const r4 = food.normalizeRestaurant({ name: '测试馆', avgPrice: 130 });
test('avgPrice 130 原样保留 + priceRange 跟随（¥78–195）', () => { if (r4.avgPrice !== 130 || r4.priceRange !== '¥78–195') throw new Error(JSON.stringify({ avgPrice: r4.avgPrice, priceRange: r4.priceRange })); });
const r5 = food.normalizeRestaurant({ name: '测试馆', reviewCount: -5, rating: 9.9 });
test('reviewCount -5 -> 0；rating 9.9 -> clamp 5', () => { if (r5.reviewCount !== 0 || r5.rating !== 5) throw new Error(JSON.stringify({ reviewCount: r5.reviewCount, rating: r5.rating })); });
const r6 = food.normalizeRestaurant({ name: '测试馆', reviewCount: 999999 });
test('reviewCount 999999 -> 500000', () => { if (r6.reviewCount !== 500000) throw new Error(String(r6.reviewCount)); });
test('缺名称 -> null', () => { if (food.normalizeRestaurant({ avgPrice: 100 }) !== null) throw new Error('should be null'); });
test('价格字段中文别名（人均: 88）识别', () => { const r = food.normalizeRestaurant({ 名称: '川菜馆', 人均: 88 }); if (r.avgPrice !== 88) throw new Error(String(r.avgPrice)); });

console.log(`\n${fails.length === 0 ? '✅' : '❌'} 价格防线单测: ${pass} 通过 / ${fails.length} 失败`);
process.exit(fails.length === 0 ? 0 : 1);
