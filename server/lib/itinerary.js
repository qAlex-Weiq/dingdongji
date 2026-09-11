'use strict';

/**
 * 行程编排引擎（纯函数，不触网、不调用 LLM、可离线单测）。
 *
 * 设计原则 —— 「结构由确定性算法决定，Agent 只负责解释与文案」：
 *   本模块负责「哪天去哪、几点到几点、为什么这样排」的全部结构决策，
 *   输出完全可复现、可断言、可审计。LLM 只在 planner.js 中接收本模块
 *   的产物并撰写每日说明（summary），无权增删或改动任何条目。
 *   这样既保证不会凭空捏造用户没选的景点，也让排期逻辑能当场讲清楚。
 *
 * 编排流程：
 *   1. 解析行程篮 —— 按 type 分桶（ticket / hotel / sight / food）
 *   2. 行政区聚类 —— 用 lib/district 从地址推导行政区，同区景点尽量同天
 *   3. 时段编排   —— 每天 ≤ DAILY_BUDGET_H 小时，按 建议时长 填充
 *   4. 就近配餐   —— 餐厅含真实经纬度，用 haversine 选距当天景点最近者
 *   5. 首尾锚定   —— 抵达车次决定 Day 1 起始时间，返程车次收束末日
 */

const { haversineKm, minutesToHHMM } = require('./geo');
const { districtOf } = require('./district');
const { RESTAURANTS } = require('../data/food');

// ---------------------------------------------------------------------------
// 常量
// ---------------------------------------------------------------------------

/** 每日游览时长预算（小时）—— 超出则顺延到下一天 */
const DAILY_BUDGET_H = 6;

/** 常规一天的起始时刻（分钟） */
const DAY_START_MIN = 9 * 60;      // 09:00

/**
 * 一天的最晚安排时刻（分钟）。
 * 用于钳制晚餐时间并终止景点排期 —— 避免累计时长突破 24:00 后，
 * minutesToHHMM 回绕成「00:02」这类跨零点时刻，
 * 进而在按时间排序时被误排到当天最前面。
 */
const DAY_END_MIN = 21 * 60;       // 21:00

/** 各时段基准时刻 */
const BREAKFAST_MIN = 9 * 60;      // 09:00
const BREAKFAST_DUR_MIN = 30;      // 早餐 30 分钟（09:00-09:30）
const LUNCH_MIN = 12 * 60 + 30;    // 12:30
const DINNER_MIN = 18 * 60 + 30;   // 18:30

/** 景点之间的交通缓冲（分钟） */
const TRANSIT_BUFFER_MIN = 30;

/** 抵达后到入住的缓冲（分钟） */
const CHECKIN_BUFFER_MIN = 60;

/** 默认游览时长（visitHours 无法解析时） */
const DEFAULT_VISIT_H = 2;

// ---------------------------------------------------------------------------
// 工具：时长解析
// ---------------------------------------------------------------------------

/**
 * 解析 visitHours 文案为小时数。
 * 数据集中的实际取值：2小时 / 1-2小时 / 3-4小时 / 半天 / 半日 /
 * 一天 / 1天 / 6-8小时 / 半天至一天 …
 * 区间取中值，「半天」= 4h，「一天」= 6h（封顶到每日预算）。
 */
function parseVisitHours(text) {
  const s = String(text || '').trim();
  if (!s) return DEFAULT_VISIT_H;

  if (/半天至一天|半日至一日/.test(s)) return 5;
  if (/半天|半日/.test(s)) return 4;
  if (/一天|1天|全天/.test(s)) return DAILY_BUDGET_H;

  // 区间：3-4小时 → 3.5
  const range = s.match(/(\d+(?:\.\d+)?)\s*[-~至]\s*(\d+(?:\.\d+)?)\s*小时/);
  if (range) return (Number(range[1]) + Number(range[2])) / 2;

  // 单值：2小时
  const single = s.match(/(\d+(?:\.\d+)?)\s*小时/);
  if (single) return Number(single[1]);

  return DEFAULT_VISIT_H;
}

/** "HH:MM" → 分钟；解析失败返回 null */
function hhmmToMinutes(text) {
  const m = String(text || '').match(/^(\d{1,2}):(\d{2})/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** 从 openTime（"07:30-18:00"）取闭园时刻（分钟） */
function closingMinutes(openTime) {
  const m = String(openTime || '').match(/(\d{1,2}):(\d{2})\s*$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

// ---------------------------------------------------------------------------
// 工具：条目取值（兼容四个模块各自的数据形状）
// ---------------------------------------------------------------------------

/** 取条目坐标：餐厅有真实 lat/lng；景点/酒店本地数据为 null，高德数据有值 */
function coordsOf(payload) {
  if (!payload) return null;
  const loc = payload.location;
  if (loc && Number.isFinite(loc.lat) && Number.isFinite(loc.lng)) {
    return { lat: loc.lat, lng: loc.lng };
  }
  return null;
}

/** 取条目地址（景点/酒店为 address 字符串，餐厅在 location.address） */
function addressOf(payload) {
  if (!payload) return '';
  if (typeof payload.address === 'string' && payload.address) return payload.address;
  if (payload.location && typeof payload.location.address === 'string') {
    return payload.location.address;
  }
  return '';
}

/** 取行政区：餐厅数据自带 district，景点/酒店从地址推导 */
function districtOfItem(payload, cityName) {
  if (payload && payload.location && payload.location.district) {
    return payload.location.district;
  }
  return districtOf(addressOf(payload), cityName);
}

// ---------------------------------------------------------------------------
// 1) 解析行程篮
// ---------------------------------------------------------------------------

/**
 * 按 type 分桶，并标注 mustGo。
 * @param {Array} items 行程篮条目 [{type, key, payload, mustGo}]
 */
function bucketize(items, cityName) {
  const buckets = { ticket: [], hotel: [], sight: [], food: [], dish: [] };
  for (const it of items || []) {
    if (!it || !buckets[it.type]) continue;
    buckets[it.type].push({
      ...it,
      district: districtOfItem(it.payload, cityName),
      coords: coordsOf(it.payload),
    });
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// 1.5) 特色菜 → 餐厅自动解析
// ---------------------------------------------------------------------------

/**
 * 判断一家餐厅是否供应某道菜。
 *
 * 匹配优先级（分数越高越匹配）：
 *   3  招牌菜精确命中（signatureDishes 含该菜名或其别名）
 *   2  店名含菜名（「全聚德烤鸭」对「北京烤鸭」）
 *   1  菜名与招牌菜互为子串（「烤鸭」↔「焖炉烤鸭」）
 *   0  不匹配
 *
 * 菜名常带地域前缀（「北京烤鸭」），而店家招牌写作「烤鸭」「焖炉烤鸭」，
 * 因此同时用全名和去掉地名前缀的短名做匹配。
 */
function dishMatchScore(restaurant, dishNames) {
  const sig = (restaurant.signatureDishes || []).map((s) => String(s));
  const name = String(restaurant.name || '');
  let best = 0;

  for (const dish of dishNames) {
    const d = String(dish || '').trim();
    if (!d) continue;

    if (sig.some((s) => s === d)) { best = Math.max(best, 3); continue; }
    if (name.includes(d)) { best = Math.max(best, 2); continue; }
    if (sig.some((s) => s.includes(d) || d.includes(s))) best = Math.max(best, 1);
  }
  return best;
}

/**
 * 把「特色菜」条目解析成具体餐厅。
 *
 * 用户在美食页加入的是「北京烤鸭」这道菜（type: 'dish'），而行程里要落到
 * 「今晚去全聚德」。这里按以下顺序挑选承载餐厅：
 *   1. 菜品匹配度（招牌菜 > 店名 > 子串）
 *   2. 是否落在当天行程涉及的行政区（同区优先，减少奔波）
 *   3. 评分降序 → 名称升序（确定性兜底）
 *
 * 已在行程篮中的餐厅不会被重复选入；解析不到的菜给出 warning。
 *
 * @param {Array} dishItems 行程篮中的 dish 条目
 * @param {string} city 目的地城市
 * @param {Set<string>} preferredDistricts 优先的行政区集合（当天/全程景点所在区）
 * @param {Set<string>} takenNames 已被占用的餐厅名
 * @returns {{resolved: Array, warnings: Array}}
 */
function resolveDishes(dishItems, city, preferredDistricts, takenNames) {
  const resolved = [];
  const warnings = [];
  if (!dishItems || dishItems.length === 0) return { resolved, warnings };

  const pool = RESTAURANTS.filter((r) => r.city === city);

  for (const item of dishItems) {
    const p = item.payload || {};
    const dishNames = [p.name, ...(p.aliases || [])].filter(Boolean);
    if (dishNames.length === 0) continue;

    const scored = pool
      .filter((r) => !takenNames.has(r.name))
      .map((r) => ({
        r,
        score: dishMatchScore(r, dishNames),
        sameDistrict: preferredDistricts.has((r.location && r.location.district) || ''),
      }))
      .filter((x) => x.score > 0);

    if (scored.length === 0) {
      warnings.push(`未能为「${p.name}」匹配到本地餐厅，已按就近原则安排其他餐厅`);
      continue;
    }

    scored.sort((a, b) => {
      if (a.score !== b.score) return b.score - a.score;
      if (a.sameDistrict !== b.sameDistrict) return a.sameDistrict ? -1 : 1;
      const ra = Number(a.r.rating) || 0;
      const rb = Number(b.r.rating) || 0;
      if (ra !== rb) return rb - ra;
      return String(a.r.name).localeCompare(String(b.r.name), 'zh');
    });

    const best = scored[0];
    takenNames.add(best.r.name);
    resolved.push({
      type: 'food',
      key: `food|${city}|${best.r.name}`,
      payload: best.r,
      mustGo: Boolean(item.mustGo),
      // 记录来源菜品，供排期理由展示「为『北京烤鸭』匹配」
      fromDish: p.name,
    });
  }

  return { resolved, warnings };
}

// ---------------------------------------------------------------------------
// 2) 行政区聚类 + 3) 时段编排
// ---------------------------------------------------------------------------

/**
 * 把景点分配到各天：同行政区聚在一起，每天不超过时长预算。
 *
 * 排序规则（确定性，无随机）：
 *   1. mustGo 优先 —— 用户钉住的景点排在最前，必定进入靠前的日子
 *   2. 行政区规模降序 —— 景点多的区先安排，避免碎片化
 *   3. 区内按热度降序，热度相同按名称升序（保证结果稳定可复现）
 */
function clusterSights(sights, days) {
  const byDistrict = new Map();
  for (const s of sights) {
    const d = s.district;
    if (!byDistrict.has(d)) byDistrict.set(d, []);
    byDistrict.get(d).push(s);
  }

  // 区内排序：mustGo → 热度 → 名称
  for (const list of byDistrict.values()) {
    list.sort((a, b) => {
      if (a.mustGo !== b.mustGo) return a.mustGo ? -1 : 1;
      const pa = Number(a.payload && a.payload.popularity) || 0;
      const pb = Number(b.payload && b.payload.popularity) || 0;
      if (pa !== pb) return pb - pa;
      return String(a.payload && a.payload.name).localeCompare(String(b.payload && b.payload.name), 'zh');
    });
  }

  // 区排序：含 mustGo 的区优先 → 景点数降序 → 区名升序
  const districts = [...byDistrict.entries()].sort((a, b) => {
    const ma = a[1].some((x) => x.mustGo);
    const mb = b[1].some((x) => x.mustGo);
    if (ma !== mb) return ma ? -1 : 1;
    if (a[1].length !== b[1].length) return b[1].length - a[1].length;
    return a[0].localeCompare(b[0], 'zh');
  });

  // 依次装入各天：优先「同区已开张、且放得下」的一天，其次最空的一天。
  // 这样既保证同区聚集，又不会把景点全堆在同一天。
  const buckets = Array.from({ length: days }, () => ({ sights: [], hours: 0, districts: new Set() }));

  /** 当前最空的一天（时长相同时取序号小的，保证确定性） */
  function emptiest() {
    let min = 0;
    for (let i = 1; i < days; i++) {
      if (buckets[i].hours < buckets[min].hours) min = i;
    }
    return min;
  }

  for (const [district, list] of districts) {
    for (const s of list) {
      const h = parseVisitHours(s.payload && s.payload.visitHours);

      // 1) 已有同区行程、且加上仍不超预算的一天（序号最小者优先）
      let target = -1;
      for (let i = 0; i < days; i++) {
        if (buckets[i].districts.has(district) && buckets[i].hours + h <= DAILY_BUDGET_H) {
          target = i;
          break;
        }
      }

      // 2) 否则放进最空的一天（若放得下）
      if (target === -1) {
        const e = emptiest();
        if (buckets[e].hours + h <= DAILY_BUDGET_H) target = e;
      }

      // 3) 所有天都超预算：仍放最空的一天，宁可略超也不丢条目
      if (target === -1) target = emptiest();

      buckets[target].sights.push(s);
      buckets[target].hours += h;
      buckets[target].districts.add(district);
    }
  }
  return buckets;
}

// ---------------------------------------------------------------------------
// 4) 就近配餐
// ---------------------------------------------------------------------------

/**
 * 为某一天挑选餐厅：优先同行政区，其次按与当天景点的球面距离最近。
 * 餐厅数据自带真实经纬度，这里的距离计算是有意义的（景点/酒店本地数据
 * 无坐标，因此不参与距离计算，只做行政区匹配）。
 *
 * @returns {{item: object, distanceKm: number|null, sameDistrict: boolean}|null}
 */
function pickRestaurant(pool, dayDistricts, daySights, slot) {
  const candidates = pool.filter((r) => {
    if (r.used) return false;
    const slots = (r.payload && r.payload.hours && r.payload.hours.slots) || [];
    return slots.length === 0 || slots.includes(slot);
  });
  if (candidates.length === 0) return null;

  // 计算每个候选到当天景点的最近距离（仅当双方都有坐标时）
  const anchorCoords = daySights.map((s) => s.coords).filter(Boolean);

  const scored = candidates.map((r) => {
    const sameDistrict = dayDistricts.has(r.district);
    let distanceKm = null;
    if (r.coords && anchorCoords.length > 0) {
      distanceKm = Math.min(
        ...anchorCoords.map((c) => haversineKm(c.lat, c.lng, r.coords.lat, r.coords.lng))
      );
    }
    return { r, sameDistrict, distanceKm };
  });

  scored.sort((a, b) => {
    // mustGo 餐厅最优先
    if (a.r.mustGo !== b.r.mustGo) return a.r.mustGo ? -1 : 1;
    // 同区优先
    if (a.sameDistrict !== b.sameDistrict) return a.sameDistrict ? -1 : 1;
    // 有距离的按距离升序；无坐标的排在有坐标之后
    if (a.distanceKm !== null && b.distanceKm !== null) {
      if (Math.abs(a.distanceKm - b.distanceKm) > 1e-9) return a.distanceKm - b.distanceKm;
    } else if (a.distanceKm !== null) return -1;
    else if (b.distanceKm !== null) return 1;
    // 兜底：评分降序 → 名称升序（确定性）
    const ra = Number(a.r.payload && a.r.payload.rating) || 0;
    const rb = Number(b.r.payload && b.r.payload.rating) || 0;
    if (ra !== rb) return rb - ra;
    return String(a.r.payload.name).localeCompare(String(b.r.payload.name), 'zh');
  });

  const best = scored[0];
  best.r.used = true;
  return { item: best.r, distanceKm: best.distanceKm, sameDistrict: best.sameDistrict };
}

// ---------------------------------------------------------------------------
// 5) 主编排
// ---------------------------------------------------------------------------

/**
 * 判定车次是抵达还是返程。
 * 单程票视为抵达；若存在两张票，出发时间较晚的一张视为返程。
 */
function splitTickets(tickets) {
  if (tickets.length === 0) return { arrival: null, departure: null };
  if (tickets.length === 1) return { arrival: tickets[0], departure: null };
  const sorted = [...tickets].sort((a, b) => {
    const ta = hhmmToMinutes(a.payload && a.payload.depTime) || 0;
    const tb = hhmmToMinutes(b.payload && b.payload.depTime) || 0;
    return ta - tb;
  });
  return { arrival: sorted[0], departure: sorted[sorted.length - 1] };
}

/** 车次显示名：G321 北京西→成都东 / ZH4954 北京→成都 */
function ticketLabel(p) {
  if (!p) return '';
  if (p.trainNo) return `${p.trainNo} ${p.depStation || ''}→${p.arrStation || ''}`.trim();
  if (p.flightNo) return `${p.flightNo} ${p.depAirport || ''}→${p.arrAirport || ''}`.trim();
  return p.name || '车次';
}

/** 日期推进：'2026-09-12' + n 天 */
function addDays(dateStr, n) {
  const d = new Date(`${dateStr}T00:00:00+08:00`);
  if (Number.isNaN(d.getTime())) return null;
  d.setDate(d.getDate() + n);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * 生成行程结构。
 *
 * @param {object} input
 * @param {string} input.city 目的地城市
 * @param {number} input.days 天数
 * @param {string} [input.startDate] 起始日期 YYYY-MM-DD
 * @param {Array}  input.items 行程篮条目
 * @returns {{itinerary: Array, warnings: Array, stats: object}}
 */
function buildItinerary({ city, days, startDate, items }) {
  const warnings = [];
  const buckets = bucketize(items, city);
  const { arrival, departure } = splitTickets(buckets.ticket);

  const dayBuckets = clusterSights(buckets.sight, days);
  const hotel = buckets.hotel[0] || null;

  // —— 特色菜 → 餐厅：把「想吃北京烤鸭」解析成「去全聚德」——
  // 优先落在行程涉及的行政区内，避免为一道菜跨城奔波。
  const sightDistricts = new Set(buckets.sight.map((s) => s.district));
  const takenNames = new Set(buckets.food.map((f) => f.payload && f.payload.name).filter(Boolean));
  const { resolved: dishFoods, warnings: dishWarnings } = resolveDishes(
    buckets.dish,
    city,
    sightDistricts,
    takenNames
  );
  warnings.push(...dishWarnings);

  // 解析出的餐厅与用户手选的餐厅合流，一同参与就近配餐
  const foodPool = [...buckets.food, ...dishFoods.map((f) => ({
    ...f,
    district: districtOfItem(f.payload, city),
    coords: coordsOf(f.payload),
  }))].map((f) => ({ ...f, used: false }));

  if (buckets.hotel.length > 1) {
    warnings.push(`行程篮含 ${buckets.hotel.length} 家酒店，已采用「${buckets.hotel[0].payload.name}」作为每晚住宿`);
  }

  const itinerary = [];

  for (let i = 0; i < days; i++) {
    const bucket = dayBuckets[i];
    const slots = [];
    const isFirst = i === 0;
    const isLast = i === days - 1;

    // —— 起始时刻：首日若有抵达车次，从到达时间 + 缓冲开始 ——
    let clock = DAY_START_MIN;
    if (isFirst && arrival) {
      const arrMin = hhmmToMinutes(arrival.payload && arrival.payload.arrTime);
      const p = arrival.payload || {};
      slots.push({
        slot: '抵达',
        time: p.arrTime || '',
        type: 'ticket',
        item: { name: ticketLabel(p), address: p.arrStation || p.arrAirport || '' },
        reason: p.trainNo
          ? `12306 实时查询：${p.depTime} 发车，历时 ${Math.round((p.durationMin || 0) / 60)} 小时`
          : `${p.airline || '航班'} ${p.depTime} 起飞，历时 ${Math.round((p.durationMin || 0) / 60)} 小时`,
      });
      if (arrMin !== null) clock = arrMin + CHECKIN_BUFFER_MIN;

      // 抵达当天先入住
      if (hotel) {
        slots.push({
          slot: '入住',
          time: minutesToHHMM(clock),
          type: 'hotel',
          item: hotel.payload,
          reason: `${hotel.district} · ${(hotel.payload.tags || []).slice(0, 2).join(' / ') || '当晚住宿'}`,
        });
        clock += TRANSIT_BUFFER_MIN;
      }
      if (arrMin !== null && arrMin >= 14 * 60) {
        warnings.push(`抵达时间为 ${p.arrTime}，Day 1 已相应减少游览安排`);
      }
    } else if (isFirst && hotel) {
      // 无车票但有酒店：首日开场即入住
      slots.push({
        slot: '入住',
        time: minutesToHHMM(clock),
        type: 'hotel',
        item: hotel.payload,
        reason: `${hotel.district} · ${(hotel.payload.tags || []).slice(0, 2).join(' / ') || '当晚住宿'}`,
      });
      clock += TRANSIT_BUFFER_MIN;
    }

    // —— 末日若有返程车次，预留出发前的收束时间 ——
    let hardStop = null;
    if (isLast && departure) {
      const depMin = hhmmToMinutes(departure.payload && departure.payload.depTime);
      if (depMin !== null) hardStop = depMin - 90; // 提前 90 分钟赶车
    }

    // —— 早餐：09:00-09:30，酒店附近或街边小吃 ——
    // 仅在当天确实从早上开始时安排（抵达日下午才到店就跳过），
    // 且不占用 foodPool —— 早餐是「酒店/街边」，不消耗用户选的正餐餐厅。
    if (clock <= BREAKFAST_MIN && bucket.sights.length > 0) {
      slots.push(breakfastSlot(hotel, city));
      clock = Math.max(clock, BREAKFAST_MIN) + BREAKFAST_DUR_MIN;
    }

    // —— 依次排入当天景点，中途插入午/晚餐 ——
    let lunchDone = false;
    let dinnerDone = false;

    for (const s of bucket.sights) {
      const h = parseVisitHours(s.payload && s.payload.visitHours);
      const durMin = Math.round(h * 60);

      // 午餐：越过 12:30 且尚未安排
      if (!lunchDone && clock >= LUNCH_MIN) {
        const pick = pickRestaurant(foodPool, bucket.districts, bucket.sights, '午餐');
        if (pick) {
          slots.push(mealSlot('午餐', clock, pick));
          clock += 60 + TRANSIT_BUFFER_MIN;
        }
        lunchDone = true;
      }

      if (hardStop !== null && clock + durMin > hardStop) {
        warnings.push(`「${s.payload.name}」因返程时间冲突未能排入，建议改到前一天`);
        continue;
      }

      // 当天时间已排满（超过 DAY_END_MIN）：顺延提示，不再往深夜硬塞
      if (clock >= DAY_END_MIN) {
        warnings.push(`「${s.payload.name}」当日时间不足，建议调整天数或移除部分景点`);
        continue;
      }

      // 闭园时间校验：开始时刻已过闭园则不排入
      const close = closingMinutes(s.payload && s.payload.openTime);
      if (close !== null && clock >= close) {
        warnings.push(`「${s.payload.name}」${s.payload.openTime} 闭园，当日已无法安排`);
        continue;
      }
      if (close !== null && clock + durMin > close) {
        warnings.push(`「${s.payload.name}」${s.payload.openTime} 闭园，当日时间偏紧`);
      }

      slots.push({
        slot: clock < LUNCH_MIN ? '上午' : (clock < 17 * 60 ? '下午' : '傍晚'),
        time: minutesToHHMM(clock),
        type: 'sight',
        item: s.payload,
        reason: buildSightReason(s, h),
      });
      clock += durMin + TRANSIT_BUFFER_MIN;
    }

    // 当天景点排完后仍未安排午餐（例如全是下午场），补一顿
    if (!lunchDone && bucket.sights.length > 0) {
      const pick = pickRestaurant(foodPool, bucket.districts, bucket.sights, '午餐');
      if (pick) slots.push(mealSlot('午餐', LUNCH_MIN, pick));
    }

    // —— 晚餐：钳制在当日 DINNER_MIN ~ DAY_END_MIN 之间，避免跨零点 ——
    if (!dinnerDone && (hardStop === null || DINNER_MIN < hardStop)) {
      const dinnerAt = Math.min(Math.max(clock, DINNER_MIN), DAY_END_MIN);
      const pick = pickRestaurant(foodPool, bucket.districts, bucket.sights, '晚餐');
      if (pick) {
        slots.push(mealSlot('晚餐', dinnerAt, pick));
        dinnerDone = true;
      }
    }

    // —— 末日返程 ——
    if (isLast && departure) {
      const p = departure.payload || {};
      slots.push({
        slot: '返程',
        time: p.depTime || '',
        type: 'ticket',
        item: { name: ticketLabel(p), address: p.depStation || p.depAirport || '' },
        reason: '建议提前 90 分钟抵达车站/机场',
      });
    }

    // —— 非首末日的住宿提示 ——
    if (hotel && !isFirst) {
      slots.push({
        slot: '住宿',
        time: '',
        type: 'hotel',
        item: hotel.payload,
        reason: '延续入住，无需换酒店',
      });
    }

    // 时间升序（无时间的排在末尾，保持插入顺序）
    slots.sort((a, b) => {
      const ta = hhmmToMinutes(a.time);
      const tb = hhmmToMinutes(b.time);
      if (ta === null && tb === null) return 0;
      if (ta === null) return 1;
      if (tb === null) return -1;
      return ta - tb;
    });

    itinerary.push({
      day: i + 1,
      date: startDate ? addDays(startDate, i) : null,
      district: [...bucket.districts].join(' / ') || '市区',
      hours: Math.round(bucket.hours * 10) / 10,
      summary: '',           // 由 planner.js 交给 LLM 填写
      slots,
    });
  }

  // 未被排入任何一天的餐厅提示
  const unusedFood = foodPool.filter((f) => !f.used);
  if (unusedFood.length > 0) {
    warnings.push(`${unusedFood.length} 家餐厅未排入（每天仅安排午/晚两餐）：${unusedFood.map((f) => f.payload.name).join('、')}`);
  }

  return {
    itinerary,
    warnings,
    stats: {
      tickets: buckets.ticket.length,
      hotels: buckets.hotel.length,
      sights: buckets.sight.length,
      foods: buckets.food.length,
      districts: [...new Set(buckets.sight.map((s) => s.district))],
    },
  };
}

/** 组装早餐时段：酒店早餐优先，否则街边小吃 */
function breakfastSlot(hotel, city) {
  const hasHotel = Boolean(hotel && hotel.payload);
  const name = hasHotel ? `${hotel.payload.name} · 酒店早餐` : `${city}街边早点`;
  return {
    slot: '早餐',
    time: minutesToHHMM(BREAKFAST_MIN),
    type: 'breakfast',   // 独立类型，不参与就近配餐逻辑
    item: {
      name,
      address: hasHotel ? addressOf(hotel.payload) : '',
    },
    reason: hasHotel
      ? '在住宿地用早餐，省去往返时间'
      : '酒店附近的街边早点，尝一口当地人的早晨',
  };
}

/** 组装餐厅时段条目 */
function mealSlot(slot, clock, pick) {
  const p = pick.item.payload;
  const bits = [];
  // 由特色菜解析而来时，先说清「这顿是为哪道菜安排的」
  if (pick.item.fromDish) bits.push(`为「${pick.item.fromDish}」匹配`);
  if (pick.distanceKm !== null) bits.push(`距上一站约 ${pick.distanceKm.toFixed(1)}km`);
  else if (pick.sameDistrict) bits.push(`与当日行程同在${pick.item.district}`);
  if (p.hours && p.hours.close) bits.push(`营业至 ${p.hours.close}`);
  if (p.avgPrice) bits.push(`人均 ¥${p.avgPrice}`);
  return {
    slot,
    time: minutesToHHMM(clock),
    type: 'food',
    item: p,
    reason: bits.join(' · ') || '就近用餐',
  };
}

/** 组装景点排期理由 */
function buildSightReason(s, hours) {
  const p = s.payload || {};
  const bits = [];
  if (s.mustGo) bits.push('必去项，已优先安排');
  bits.push(`${s.district}片区`);
  bits.push(`建议游览 ${hours} 小时`);
  if (p.openTime && p.openTime !== '以现场公示为准') bits.push(`开放 ${p.openTime}`);
  return bits.join(' · ');
}

module.exports = {
  buildItinerary,
  // 导出内部纯函数供单测直接断言
  parseVisitHours,
  clusterSights,
  bucketize,
  splitTickets,
  resolveDishes,
  dishMatchScore,
  DAILY_BUDGET_H,
  BREAKFAST_MIN,
  LUNCH_MIN,
  DINNER_MIN,
};
