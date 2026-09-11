'use strict';

/**
 * 行程编排引擎离线测试（不联网、不调用 LLM）。
 * 覆盖：行政区提取 / 时长解析 / 聚类分配 / 必去优先 / 抵达锚定 /
 *       就近配餐 / 返程收束 / 确定性（同输入同输出）。
 *
 * 用法：node scripts/test-itinerary.js
 */

const { extractDistrict, districtOf } = require('../server/lib/district');
const {
  buildItinerary,
  parseVisitHours,
  clusterSights,
  bucketize,
  splitTickets,
  resolveDishes,
  dishMatchScore,
  suggestSights,
  BREAKFAST_MIN,
  LUNCH_MIN,
  DINNER_MIN,
} = require('../server/lib/itinerary');
const { getSightsByCity } = require('../server/data/sights');
const { getHotelsByCity } = require('../server/data/hotels');
const { RESTAURANTS, SPECIALTY_DISHES } = require('../server/data/food');

let pass = 0;
let fail = 0;

function check(name, cond, extra = '') {
  if (cond) {
    pass++;
    console.log(`PASS  ${name}${extra ? '  [' + extra + ']' : ''}`);
  } else {
    fail++;
    process.exitCode = 1;
    console.log(`FAIL  ${name}${extra ? '  [' + extra + ']' : ''}`);
  }
}

// ---------------------------------------------------------------------------
// 1. 行政区提取
// ---------------------------------------------------------------------------

console.log('\n--- 1. 行政区提取 ---');

check('青羊区顺城大街 → 青羊区', extractDistrict('青羊区顺城大街269号', '成都') === '青羊区');
check('上海市浦东新区 → 浦东新区（新区优先于区）', extractDistrict('上海市浦东新区银飞路166号', '上海') === '浦东新区');
check('东城区煤市街 → 东城区（不被「煤市」误吞）', extractDistrict('东城区煤市街廊房头条', '北京') === '东城区');
check('西城区菜市口 → 西城区（不被「菜市」误吞）', extractDistrict('西城区菜市口', '北京') === '西城区');
check('都江堰市公园路 → 都江堰市（县级市保留）', extractDistrict('都江堰市公园路', '成都') === '都江堰市');
check('成都市都江堰市 → 都江堰市（剥离地级市前缀）', extractDistrict('成都市都江堰市公园路', '成都') === '都江堰市');
check('河南省郑州市登封市 → 登封市（剥离省+市）', extractDistrict('河南省郑州市登封市嵩阳路北段', '郑州') === '登封市');
check('石林彝族自治县（民族自治县全称）', extractDistrict('昆明市石林彝族自治县石林中路', '昆明') === '石林彝族自治县');
check('无区名地址时 districtOf 兜底为「市区」', districtOf('人民路88号', '北京') === '市区');
check('空地址时 districtOf 兜底为「市区」', districtOf('', '北京') === '市区');

// 三个演示城市全量覆盖率
let t3 = 0;
let h3 = 0;
for (const c of ['北京', '上海', '成都']) {
  for (const x of [...getSightsByCity(c), ...getHotelsByCity(c)]) {
    t3++;
    if (extractDistrict(x.address, c)) h3++;
  }
}
check('演示三城行政区提取 100% 覆盖', h3 === t3, `${h3}/${t3}`);

// ---------------------------------------------------------------------------
// 2. 时长解析
// ---------------------------------------------------------------------------

console.log('\n--- 2. 时长解析 ---');

check('「2小时」→ 2', parseVisitHours('2小时') === 2);
check('「3-4小时」→ 3.5（区间取中值）', parseVisitHours('3-4小时') === 3.5);
check('「半天」→ 4', parseVisitHours('半天') === 4);
check('「一天」→ 6（封顶到每日预算）', parseVisitHours('一天') === 6);
check('「半天至一天」→ 5', parseVisitHours('半天至一天') === 5);
check('空值 → 默认 2', parseVisitHours('') === 2 && parseVisitHours(null) === 2);

// ---------------------------------------------------------------------------
// 测试夹具：成都行程篮
// ---------------------------------------------------------------------------

const cdSights = getSightsByCity('成都');
const cdHotels = getHotelsByCity('成都');
const cdFoods = RESTAURANTS.filter((r) => r.city === '成都');

function sightItem(name, mustGo = false) {
  const s = cdSights.find((x) => x.name === name);
  if (!s) throw new Error(`夹具缺失景点：${name}`);
  return { type: 'sight', key: `sight|成都|${name}`, payload: s, mustGo };
}
function hotelItem(name) {
  const h = cdHotels.find((x) => x.name === name);
  if (!h) throw new Error(`夹具缺失酒店：${name}`);
  return { type: 'hotel', key: `hotel|成都|${name}`, payload: h, mustGo: false };
}
function foodItem(id) {
  const f = cdFoods.find((x) => x.id === id);
  if (!f) throw new Error(`夹具缺失餐厅：${id}`);
  return { type: 'food', key: `food|成都|${f.name}`, payload: f, mustGo: false };
}

const arrivalTicket = {
  type: 'ticket',
  key: 'ticket|成都|G8607',
  mustGo: false,
  payload: {
    type: 'train', trainNo: 'G8607', trainType: '高铁',
    depTime: '07:00', arrTime: '14:32', arrDayOffset: 0,
    depStation: '北京西', arrStation: '成都东', durationMin: 452,
    date: '2026-09-20',
  },
};

const departureTicket = {
  type: 'ticket',
  key: 'ticket|成都|G8608',
  mustGo: false,
  payload: {
    type: 'train', trainNo: 'G8608', trainType: '高铁',
    depTime: '18:00', arrTime: '01:30', arrDayOffset: 1,
    depStation: '成都东', arrStation: '北京西', durationMin: 450,
    date: '2026-09-22',
  },
};

// ---------------------------------------------------------------------------
// 3. 分桶与车次判定
// ---------------------------------------------------------------------------

console.log('\n--- 3. 分桶与车次判定 ---');

const sampleItems = [
  arrivalTicket,
  hotelItem(cdHotels[0].name),
  sightItem(cdSights[0].name),
  sightItem(cdSights[1].name),
  foodItem('cd-r-001'),
];

const b = bucketize(sampleItems, '成都');
check('分桶：1 车票 / 1 酒店 / 2 景点 / 1 餐厅',
  b.ticket.length === 1 && b.hotel.length === 1 && b.sight.length === 2 && b.food.length === 1);
check('景点已附加行政区', Boolean(b.sight[0].district), b.sight[0].district);
check('餐厅使用自带 district 而非地址推导', b.food[0].district === cdFoods[0].location.district, b.food[0].district);
check('餐厅带真实坐标', b.food[0].coords !== null && Number.isFinite(b.food[0].coords.lat));
check('景点本地数据无坐标（location: null）', b.sight[0].coords === null);

const single = splitTickets([arrivalTicket]);
check('单程票视为抵达', single.arrival !== null && single.departure === null);
const both = splitTickets([departureTicket, arrivalTicket]);
check('两张票：出发早的为抵达', both.arrival.payload.trainNo === 'G8607');
check('两张票：出发晚的为返程', both.departure.payload.trainNo === 'G8608');

// ---------------------------------------------------------------------------
// 4. 聚类：同区聚集 + 每日预算
// ---------------------------------------------------------------------------

console.log('\n--- 4. 聚类与每日预算 ---');

const manySights = cdSights.slice(0, 9).map((s) => sightItem(s.name));
const bucketed = bucketize(manySights, '成都');
const clusters = clusterSights(bucketed.sight, 3);

check('聚类产出 3 天', clusters.length === 3);
check('所有景点都被分配', clusters.reduce((n, c) => n + c.sights.length, 0) === 9);
// 9 个景点合计 24.5h，超过 3 天 × 6h = 18h 的总预算，
// 因此必然溢出 —— 正确行为是「均摊溢出」而非「丢弃景点」。
const totalH = clusters.reduce((n, c) => n + c.hours, 0);
check('总时长守恒（无景点被丢弃）', Math.abs(totalH - 24.5) < 0.01, `${totalH}h`);
const spread = Math.max(...clusters.map((c) => c.hours)) - Math.min(...clusters.map((c) => c.hours));
check('超预算时在各天间均摊（极差 ≤ 3h）', spread <= 3,
  clusters.map((c) => `${c.hours}h`).join(' / '));

// 预算内的场景才应严格不超
const lightItems = cdSights.slice(3, 7).map((s) => sightItem(s.name)); // 2.5+2+2+2.5 = 9h
const lightClusters = clusterSights(bucketize(lightItems, '成都').sight, 3);
check('总量在预算内时每天严格 ≤ 6h',
  lightClusters.every((c) => c.hours <= 6),
  lightClusters.map((c) => `${c.hours}h`).join(' / '));

// 必去优先
const withMustGo = [
  sightItem(cdSights[5].name, true), // 靠后的景点标为必去
  ...cdSights.slice(0, 5).map((s) => sightItem(s.name)),
];
const mgClusters = clusterSights(bucketize(withMustGo, '成都').sight, 3);
const mustGoDay = mgClusters.findIndex((c) => c.sights.some((s) => s.mustGo));
check('必去景点被排进 Day 1', mustGoDay === 0, `实际 Day ${mustGoDay + 1}`);

// ---------------------------------------------------------------------------
// 5. 完整编排：抵达锚定
// ---------------------------------------------------------------------------

console.log('\n--- 5. 抵达锚定 ---');

const fullItems = [
  arrivalTicket,
  hotelItem(cdHotels[0].name),
  sightItem(cdSights[0].name),
  sightItem(cdSights[1].name),
  sightItem(cdSights[2].name),
  sightItem(cdSights[3].name),
  foodItem('cd-r-001'),
  foodItem('cd-r-002'),
];

const r1 = buildItinerary({ city: '成都', days: 3, startDate: '2026-09-20', items: fullItems });

check('生成 3 天', r1.itinerary.length === 3);
check('Day 1 首个时段为「抵达」', r1.itinerary[0].slots[0].slot === '抵达');
check('抵达时间取车次 arrTime', r1.itinerary[0].slots[0].time === '14:32');
check('抵达理由含 12306 实时查询字样', /12306/.test(r1.itinerary[0].slots[0].reason));

const checkin = r1.itinerary[0].slots.find((s) => s.slot === '入住');
check('Day 1 抵达后安排入住', Boolean(checkin));
check('入住时间 = 抵达 + 60 分钟缓冲', checkin && checkin.time === '15:32', checkin && checkin.time);

const day1Sights = r1.itinerary[0].slots.filter((s) => s.type === 'sight');
check('Day 1 因下午抵达而减少景点', day1Sights.length <= 2, `${day1Sights.length} 个`);
check('抵达偏晚时给出提示', r1.warnings.some((w) => /抵达时间/.test(w)));

check('日期正确推进', r1.itinerary[1].date === '2026-09-21' && r1.itinerary[2].date === '2026-09-22');

// ---------------------------------------------------------------------------
// 6. 就近配餐
// ---------------------------------------------------------------------------

console.log('\n--- 6. 就近配餐 ---');

const meals = r1.itinerary.flatMap((d) => d.slots.filter((s) => s.type === 'food'));
check('餐厅被排入行程', meals.length > 0, `${meals.length} 餐`);
check('餐厅不重复使用', new Set(meals.map((m) => m.item.name)).size === meals.length);
check('配餐理由含距离或同区说明', meals.every((m) => /km|同在|就近|营业|人均/.test(m.reason)),
  meals[0] && meals[0].reason);

// ---------------------------------------------------------------------------
// 7. 返程收束
// ---------------------------------------------------------------------------

console.log('\n--- 7. 返程收束 ---');

const r2 = buildItinerary({
  city: '成都', days: 3, startDate: '2026-09-20',
  items: [...fullItems, departureTicket],
});
const lastDay = r2.itinerary[2];
const ret = lastDay.slots.find((s) => s.slot === '返程');
check('末日含返程时段', Boolean(ret));
check('返程时间取车次 depTime', ret && ret.time === '18:00');
check('返程理由提示提前赶车', ret && /提前/.test(ret.reason));

// ---------------------------------------------------------------------------
// 8. 确定性
// ---------------------------------------------------------------------------

console.log('\n--- 8. 确定性（同输入同输出）---');

const a = buildItinerary({ city: '成都', days: 3, startDate: '2026-09-20', items: fullItems });
const bb = buildItinerary({ city: '成都', days: 3, startDate: '2026-09-20', items: fullItems });
check('两次编排结果完全一致', JSON.stringify(a.itinerary) === JSON.stringify(bb.itinerary));

const shuffled = [...fullItems].reverse();
const c = buildItinerary({ city: '成都', days: 3, startDate: '2026-09-20', items: shuffled });
check('输入顺序不影响编排结果', JSON.stringify(a.itinerary) === JSON.stringify(c.itinerary));

// ---------------------------------------------------------------------------
// 9. 边界
// ---------------------------------------------------------------------------

console.log('\n--- 9. 边界情况 ---');

const noTicket = buildItinerary({
  city: '成都', days: 2, startDate: null,
  items: [hotelItem(cdHotels[0].name), sightItem(cdSights[0].name), sightItem(cdSights[1].name)],
});
check('无车票时 Day 1 从 09:00 开始', noTicket.itinerary[0].slots[0].time === '09:00');
check('无 startDate 时 date 为 null', noTicket.itinerary[0].date === null);

const noHotel = buildItinerary({
  city: '成都', days: 1, startDate: null,
  items: [sightItem(cdSights[0].name), sightItem(cdSights[1].name)],
});
check('无酒店时不产生住宿时段', !noHotel.itinerary[0].slots.some((s) => s.type === 'hotel'));

const twoHotels = buildItinerary({
  city: '成都', days: 2, startDate: null,
  items: [hotelItem(cdHotels[0].name), hotelItem(cdHotels[1].name),
          sightItem(cdSights[0].name), sightItem(cdSights[1].name)],
});
check('多酒店时给出提示', twoHotels.warnings.some((w) => /酒店/.test(w)));

check('每个时段都有 slot/type/item 三要素',
  r1.itinerary.every((d) => d.slots.every((s) => s.slot && s.type && s.item && s.item.name)));
check('每个时段都有排期理由',
  r1.itinerary.every((d) => d.slots.every((s) => typeof s.reason === 'string')));

// ---------------------------------------------------------------------------
// 10. 特色菜 → 餐厅自动解析（Task 2）
// ---------------------------------------------------------------------------

console.log('\n--- 10. 特色菜自动匹配餐厅 ---');

const bjRest = RESTAURANTS.filter((r) => r.city === '北京');
const quanjude = bjRest.find((r) => r.name.includes('全聚德'));

check('招牌菜精确命中得 3 分',
  dishMatchScore(quanjude, ['北京烤鸭']) === 3,
  `${quanjude && quanjude.name} → ${dishMatchScore(quanjude, ['北京烤鸭'])}`);
check('完全不相关的菜得 0 分', dishMatchScore(quanjude, ['提拉米苏']) === 0);
check('子串互含得 1 分（烤鸭 ↔ 焖炉烤鸭）', dishMatchScore(
  { name: 'X', signatureDishes: ['焖炉烤鸭'] }, ['烤鸭']) === 1);

const duckDish = SPECIALTY_DISHES.find((d) => d.city === '北京' && d.name === '北京烤鸭');
const dishBucket = bucketize(
  [{ type: 'dish', key: 'dish|北京|北京烤鸭', payload: duckDish, mustGo: false }],
  '北京'
);
check('dish 类型被正确分桶', dishBucket.dish.length === 1);

const dr = resolveDishes(dishBucket.dish, '北京', new Set(['东城区']), new Set());
check('「北京烤鸭」解析出餐厅', dr.resolved.length === 1, dr.resolved[0] && dr.resolved[0].payload.name);
check('解析结果类型为 food', dr.resolved[0] && dr.resolved[0].type === 'food');
check('解析结果保留来源菜名', dr.resolved[0] && dr.resolved[0].fromDish === '北京烤鸭');
check('解析优先同区（东城区）',
  dr.resolved[0] && dr.resolved[0].payload.location.district === '东城区',
  dr.resolved[0] && dr.resolved[0].payload.location.district);

// 已占用的餐厅不会被重复选中
const taken = new Set([dr.resolved[0].payload.name]);
const dr2 = resolveDishes(dishBucket.dish, '北京', new Set(['东城区']), taken);
check('已占用的餐厅不被重复选中',
  dr2.resolved.length === 0 || dr2.resolved[0].payload.name !== dr.resolved[0].payload.name);

// 匹配不到时给出提示而非静默丢弃
const weird = bucketize(
  [{ type: 'dish', key: 'd', payload: { name: '银河系烩面', city: '北京' }, mustGo: false }],
  '北京'
);
const dr3 = resolveDishes(weird.dish, '北京', new Set(), new Set());
check('无法匹配的菜给出 warning', dr3.resolved.length === 0 && dr3.warnings.length === 1,
  dr3.warnings[0]);

// 端到端：dish 条目进入编排后落到餐厅时段
const bjSights = getSightsByCity('北京');
const e2e = buildItinerary({
  city: '北京', days: 2, startDate: '2026-10-01',
  items: [
    { type: 'sight', key: 's1', payload: bjSights.find((s) => s.name === '故宫博物院'), mustGo: true },
    { type: 'sight', key: 's2', payload: bjSights[1], mustGo: false },
    { type: 'sight', key: 's3', payload: bjSights[2], mustGo: false },
    { type: 'sight', key: 's4', payload: bjSights[3], mustGo: false },
    { type: 'dish', key: 'd1', payload: duckDish, mustGo: false },
  ],
  autoFill: false,
});
const duckSlot = e2e.itinerary
  .flatMap((d) => d.slots)
  .find((s) => s.reason && s.reason.includes('为「北京烤鸭」匹配'));
check('端到端：特色菜落成餐厅时段', Boolean(duckSlot), duckSlot && duckSlot.item.name);
check('端到端：stats 统计特色菜数量', e2e.stats.dishes === 1);

// ---------------------------------------------------------------------------
// 11. 三餐时段标准化（Task 2）
// ---------------------------------------------------------------------------

console.log('\n--- 11. 三餐时段 ---');

check('午餐基准为 12:30', LUNCH_MIN === 12 * 60 + 30);
check('晚餐基准为 18:30', DINNER_MIN === 18 * 60 + 30);
check('早餐基准为 09:00', BREAKFAST_MIN === 9 * 60);

const mealPlan = buildItinerary({
  city: '成都', days: 2, startDate: '2026-09-20',
  items: [
    hotelItem(cdHotels[0].name),
    sightItem(cdSights[0].name),
    sightItem(cdSights[1].name),
    sightItem(cdSights[2].name),
    foodItem('cd-r-001'),
    foodItem('cd-r-002'),
  ],
  autoFill: false,
});
const allMealSlots = mealPlan.itinerary.flatMap((d) => d.slots);
const breakfasts = allMealSlots.filter((s) => s.slot === '早餐');
const lunches = allMealSlots.filter((s) => s.slot === '午餐');
const dinners = allMealSlots.filter((s) => s.slot === '晚餐');

check('生成早餐时段', breakfasts.length > 0, `${breakfasts.length} 顿`);
check('早餐时间为 09:00', breakfasts.every((b) => b.time === '09:00'));
check('早餐使用独立 breakfast 类型（不消耗餐厅池）',
  breakfasts.every((b) => b.type === 'breakfast'));
check('早餐落在酒店或街边', breakfasts.every((b) => /酒店早餐|街边早点/.test(b.item.name)),
  breakfasts[0] && breakfasts[0].item.name);
check('午餐不早于 12:30', lunches.every((l) => l.time >= '12:30'),
  lunches.map((l) => l.time).join(' / '));
check('晚餐不早于 18:30', dinners.every((d) => d.time >= '18:30'),
  dinners.map((d) => d.time).join(' / '));

// ---------------------------------------------------------------------------
// 12. 行程补全建议（Task 5）
// ---------------------------------------------------------------------------

console.log('\n--- 12. 行程补全建议 ---');

const sparseItems = [
  { type: 'sight', key: 's1', payload: bjSights.find((s) => s.name === '故宫博物院'), mustGo: true },
  { type: 'sight', key: 's2', payload: bjSights[1], mustGo: false },
];
const sparseBucket = bucketize(sparseItems, '北京');

const sg = suggestSights(sparseBucket.sight, '北京', 4);
check('4 天 2 景点触发补全', sg.suggestions.length === 6, `补充 ${sg.suggestions.length} 个`);
check('补全项标记 suggested', sg.suggestions.every((s) => s.suggested === true));
check('补全项不与已选重复',
  !sg.suggestions.some((s) => s.payload.name === '故宫博物院'));
check('补全给出说明文案', typeof sg.note === 'string' && /建议|宽松/.test(sg.note));

const enough = suggestSights(
  bucketize(bjSights.slice(0, 8).map((s, i) => ({ type: 'sight', key: 's' + i, payload: s, mustGo: false })), '北京').sight,
  '北京', 3
);
check('景点充足时不补全', enough.suggestions.length === 0 && enough.note === null);

const sparsePlan = buildItinerary({ city: '北京', days: 4, startDate: '2026-10-01', items: sparseItems });
const sparseSlots = sparsePlan.itinerary.flatMap((d) => d.slots).filter((s) => s.type === 'sight');
const suggSlots = sparseSlots.filter((s) => s.suggested);
const userSlots = sparseSlots.filter((s) => !s.suggested);

check('编排结果含 AI 建议时段', suggSlots.length > 0, `${suggSlots.length} 个`);
check('用户选的景点保留且未被标记建议', userSlots.length === 2, `${userSlots.length} 个`);
check('必去景点仍在 Day 1',
  sparsePlan.itinerary[0].slots.some((s) => s.item.name === '故宫博物院'));
check('AI 建议的理由说明来源', suggSlots.every((s) => /AI 建议/.test(s.reason)),
  suggSlots[0] && suggSlots[0].reason);
check('stats 报告补全数量', sparsePlan.stats.suggested === suggSlots.length ||
  sparsePlan.stats.suggested > 0, `stats.suggested=${sparsePlan.stats.suggested}`);

// autoFill: false 时完全不补全（对应前端「移除所有 AI 建议」）
const noFill = buildItinerary({
  city: '北京', days: 4, startDate: '2026-10-01', items: sparseItems, autoFill: false,
});
check('autoFill=false 时不产生建议',
  noFill.itinerary.flatMap((d) => d.slots).every((s) => !s.suggested));
check('autoFill=false 时 stats.suggested 为 0', noFill.stats.suggested === 0);

// 补全后仍保持确定性
const sp1 = buildItinerary({ city: '北京', days: 4, startDate: '2026-10-01', items: sparseItems });
const sp2 = buildItinerary({ city: '北京', days: 4, startDate: '2026-10-01', items: sparseItems });
check('补全结果确定（同输入同输出）',
  JSON.stringify(sp1.itinerary) === JSON.stringify(sp2.itinerary));

// ---------------------------------------------------------------------------

console.log(`\n${fail === 0 ? '全部通过' : '存在失败项'}：${pass} 通过 / ${fail} 失败`);
