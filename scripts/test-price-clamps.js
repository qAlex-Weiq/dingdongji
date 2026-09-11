#!/usr/bin/env node
/**
 * 价格真实性防线离线单测（不联网）
 * 覆盖：12306 票价/余票/历时/折扣价（明文 yp_info）解析、酒店档位价格 clamp、餐厅人均价格 clamp
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

console.log('12306 明文 yp_info（实际折扣价）解析:');
test('parseYpInfo G547 实测样本 -> 商务2156/一等967/二等576', () => { if (!eq(t12306.parseYpInfo('9215600011M096700013O057600021O057603000'), { 9: 2156, M: 967, O: 576 })) throw new Error(JSON.stringify(t12306.parseYpInfo('9215600011M096700013O057600021O057603000'))); });
test('parseYpInfo Z174 普速样本 -> 硬座273.5/硬卧463.5/软卧734.5（重复硬座=无座额度跳过）', () => { if (!eq(t12306.parseYpInfo('1027350021407345000030463500001027353104'), { 1: 273.5, 3: 463.5, 4: 734.5 })) throw new Error('bad'); });
test('parseYpInfo 空串/乱码/奇数长度 -> {}（回退公布价）', () => { if (!eq(t12306.parseYpInfo(''), {}) || !eq(t12306.parseYpInfo('abcdefghij'), {}) || !eq(t12306.parseYpInfo('921560001'), {})) throw new Error('bad'); });
test('findYpField 优先取 [39]，异常时向后扫描兜底', () => { const fields = Array(40).fill(''); if (t12306.findYpField(fields) !== '') throw new Error('空值应返回空串'); fields[39] = '9215600011M096700013O057600021O057603000'; if (t12306.findYpField(fields).slice(0, 10) !== '9215600011') throw new Error('[39] 未命中'); });
test('discountLabelOf 576/795 -> 7.2折；967/1272 -> 7.6折', () => { if (t12306.discountLabelOf(576, 795) !== '7.2折' || t12306.discountLabelOf(967, 1272) !== '7.6折') throw new Error('bad'); });
test('discountLabelOf 全价/近全价（794/795）-> undefined 不展示', () => { if (t12306.discountLabelOf(795, 795) !== undefined || t12306.discountLabelOf(794, 795) !== undefined) throw new Error('bad'); });

console.log('酒店价格 clamp（normalizeTierPrice）:');
test('null 守卫：非数字/≤50/>50000 -> null', () => { if (hotel.normalizeTierPrice(NaN, '豪华型') !== null || hotel.normalizeTierPrice(50, '豪华型') !== null || hotel.normalizeTierPrice(60000, '豪华型') !== null) throw new Error('bad'); });
test('豪华型下限 640：500 -> 640', () => { if (hotel.normalizeTierPrice(500, '豪华型') !== 640) throw new Error(String(hotel.normalizeTierPrice(500, '豪华型'))); });
test('经济型上限 240：1000 -> 240', () => { if (hotel.normalizeTierPrice(1000, '经济型') !== 240) throw new Error(String(hotel.normalizeTierPrice(1000, '经济型'))); });
test('舒适型区间 [160,540]：300 原样保留', () => { if (hotel.normalizeTierPrice(300, '舒适型') !== 300) throw new Error('bad'); });
test('指定档位不裁剪（clamp=false）：450 标经济型原样保留', () => { if (hotel.normalizeTierPrice(450, '经济型', false) !== 450) throw new Error(String(hotel.normalizeTierPrice(450, '经济型', false))); });
test('不限档：合理价原样保留', () => { if (hotel.normalizeTierPrice(450, '不限') !== 450) throw new Error('bad'); });
test('未知档位标签回退不限：8888 保留', () => { if (hotel.normalizeTierPrice(8888, '不存在的档') !== 8888) throw new Error('bad'); });
test('四舍五入：178.6 -> 179', () => { if (hotel.normalizeTierPrice(178.6, '经济型') !== 179) throw new Error('bad'); });

console.log('酒店档位区间（priceInTier，严格左开右闭）:');
const prefs = require(path.join(__dirname, '../server/lib/hotelPrefs'));
test('budget：¥200 含、¥201 不含', () => { if (!prefs.priceInTier(200, 'budget') || prefs.priceInTier(201, 'budget')) throw new Error('bad'); });
test('comfort：¥200 不含、¥450 含', () => { if (prefs.priceInTier(200, 'comfort') || !prefs.priceInTier(450, 'comfort')) throw new Error('bad'); });
test('upscale：¥450 不含、¥800 含', () => { if (prefs.priceInTier(450, 'upscale') || !prefs.priceInTier(800, 'upscale')) throw new Error('bad'); });
test('luxury：¥800 不含、¥801 含', () => { if (prefs.priceInTier(800, 'luxury') || !prefs.priceInTier(801, 'luxury')) throw new Error('bad'); });
test('价格未知/为 null 不匹配任何档位', () => { if (prefs.priceInTier(null, 'budget') || prefs.priceInTier(NaN, 'comfort') || prefs.priceInTier(undefined, 'luxury')) throw new Error('bad'); });
test('tierFromPrice 与区间一致：128 -> 经济型、260 -> 舒适型、480 -> 高档型、1680 -> 豪华型', () => { if (prefs.tierFromPrice(128) !== '经济型' || prefs.tierFromPrice(260) !== '舒适型' || prefs.tierFromPrice(480) !== '高档型' || prefs.tierFromPrice(1680) !== '豪华型') throw new Error('bad'); });

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
