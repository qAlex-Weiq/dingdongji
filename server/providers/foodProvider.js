'use strict';

const { haversineKm } = require('../lib/geo');
const {
  SPECIALTY_DISHES,
  RESTAURANTS,
  CITY_LANDMARKS,
  VALID_CATEGORIES,
  VALID_SLOTS,
} = require('../data/food');

/**
 * 美食模块数据源（确定性模拟数据）。
 *
 * 三个导出函数均 async，与现有 flight/train provider 接口风格保持一致，
 * 接入真实餐饮数据时实现同签名的 search/getSpecialties/personalize 即可替换。
 *
 * 返回结构：
 *   getSpecialties({ city, category })
 *     → [{ id, name, category, intro, culture, season, tags, availableRestaurants }]
 *   searchRestaurants({ city, cuisines, priceMin, priceMax, slot, openNow, sort })
 *     → [{ id, name, cuisines, avgPrice, priceRange, location, hours, rating,
 *          reviewCount, tags, signatureDishes, reservation }]
 *   personalize({ city, query })
 *     → { parsed: [{key, matched}], recommendations: [{ restaurant, score, reason }] }
 */

// ------------------ 内部工具 ------------------

function hhmmToMin(hhmm) {
  if (!hhmm) return null;
  const m = String(hhmm).match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h > 23 || min > 59) return null;
  return h * 60 + min;
}

function nowMin(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

/** 营业中（按当前分钟与 hours.open/hours.close 比对；过夜班按跨夜处理） */
function isOpenAt(hours, atMin) {
  const open = hhmmToMin(hours.open);
  const close = hhmmToMin(hours.close);
  if (open === null || close === null) return false;
  if (open < close) {
    return atMin >= open && atMin <= close;
  }
  // 跨夜（如 22:00–06:00）
  return atMin >= open || atMin <= close;
}

/** 计算餐厅距城市地标的距离（公里）；保留 1 位小数 */
function distanceToLandmark(city, lat, lng) {
  const lm = CITY_LANDMARKS[city];
  if (!lm) return null;
  const km = haversineKm(lat, lng, lm.lat, lm.lng);
  if (km < 0.1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

/** 菜品是否在餐厅"可达"（出现在招牌菜 / 餐厅名中） */
function dishAvailableIn(dish, restaurant) {
  const keys = [dish.name, ...(dish.aliases || [])];
  if (restaurant.signatureDishes.some((sd) => keys.some((k) => k === sd))) return true;
  if (keys.some((k) => k && restaurant.name.includes(k))) return true;
  return false;
}

// ------------------ 1. 特色菜品 ------------------

async function getSpecialties({ city, category } = {}) {
  const list = SPECIALTY_DISHES.filter((d) => d.city === city);
  const filtered =
    !category || category === '全部' ? list : list.filter((d) => d.category === category);

  // 按可用店铺数聚合：扫描该城市餐厅统计每个菜品的覆盖数
  const cityRestaurants = RESTAURANTS.filter((r) => r.city === city);
  const items = filtered.map((d) => ({
    id: d.id,
    name: d.name,
    category: d.category,
    intro: d.intro,
    culture: d.culture,
    season: d.season,
    tags: d.tags,
    availableRestaurants: cityRestaurants.filter((r) => dishAvailableIn(d, r)).length,
  }));

  // 固定按"可用店铺数"倒序，便于 e2e 断言；并列时按 id 字典序保持稳定
  items.sort((a, b) => (b.availableRestaurants - a.availableRestaurants) || a.id.localeCompare(b.id));
  return items;
}

// ------------------ 2. 餐厅筛选 ------------------

/** 计算每个餐厅的额外展示字段，返回给前端的最小可用结构 */
function decorateRestaurant(r, isOpenNowFlag, city) {
  const distance = distanceToLandmark(city, r.location.lat, r.location.lng);
  const distText = distance ? `距${CITY_LANDMARKS[city].name} ${distance}` : '';
  return {
    id: r.id,
    name: r.name,
    cuisines: r.cuisines,
    avgPrice: r.avgPrice,
    priceRange: `¥${r.priceMin}–${r.priceMax}`,
    location: {
      address: r.location.address,
      district: r.location.district,
      nearLandmark: distText,
    },
    hours: {
      open: r.hours.open,
      close: r.hours.close,
      isOpenNow: isOpenNowFlag,
      slots: r.hours.slots,
    },
    rating: r.rating,
    reviewCount: r.reviewCount,
    tags: r.tags,
    signatureDishes: r.signatureDishes,
    reservation: r.reservation,
  };
}

async function searchRestaurants({
  city,
  cuisines = [],
  priceMin = 0,
  priceMax = Number.MAX_SAFE_INTEGER,
  slot = null,
  openNow = false,
  sort = 'rating',
} = {}) {
  const list = RESTAURANTS.filter((r) => r.city === city);

  // 过滤：人均区间
  let filtered = list.filter((r) => r.avgPrice >= priceMin && r.avgPrice <= priceMax);

  // 过滤：菜系（数组至少命中一条）
  if (cuisines && cuisines.length > 0) {
    filtered = filtered.filter((r) => r.cuisines.some((c) => cuisines.includes(c)));
  }

  // 过滤：营业时段
  if (slot && VALID_SLOTS.includes(slot)) {
    filtered = filtered.filter((r) => r.hours.slots.includes(slot));
  }

  // 过滤：营业中
  if (openNow) {
    const at = nowMin();
    filtered = filtered.filter((r) => isOpenAt(r.hours, at));
  }

  // 计算 isOpenNow 展示字段（即便不过滤也展示）
  const at = nowMin();
  const decorated = filtered.map((r) => decorateRestaurant(r, isOpenAt(r.hours, at), city));

  // 排序
  if (sort === 'priceAsc') {
    decorated.sort((a, b) => a.avgPrice - b.avgPrice);
  } else if (sort === 'priceDesc') {
    decorated.sort((a, b) => b.avgPrice - a.avgPrice);
  } else if (sort === 'openFirst') {
    decorated.sort((a, b) => {
      if (a.hours.isOpenNow !== b.hours.isOpenNow) return a.hours.isOpenNow ? -1 : 1;
      return b.rating - a.rating;
    });
  } else {
    // 'rating' 默认
    decorated.sort((a, b) => (b.rating - a.rating) || (b.reviewCount - a.reviewCount));
  }
  return decorated;
}

// ------------------ 3. 个性化推荐 ------------------

// 关键词词典：{ key: { weight, type, hint } }
const KEYWORDS = {
  // 口味
  '不辣': { weight: 0.4, type: 'taste', hint: '口味清淡' },
  '辣': { weight: 0.4, type: 'taste', hint: '麻辣口味' },
  '麻辣': { weight: 0.5, type: 'taste', hint: '麻辣口味' },
  '清淡': { weight: 0.4, type: 'taste', hint: '清淡口味' },
  '甜': { weight: 0.3, type: 'taste', hint: '甜口' },
  '酸': { weight: 0.3, type: 'taste', hint: '酸口' },
  '烧烤': { weight: 0.4, type: 'taste', hint: '烧烤口味' },
  // 场景 / 同行人
  '父母': { weight: 0.4, type: 'companion', hint: '适合父母' },
  '老人': { weight: 0.4, type: 'companion', hint: '适合老人' },
  '儿童': { weight: 0.4, type: 'companion', hint: '亲子友好' },
  '孩子': { weight: 0.4, type: 'companion', hint: '亲子友好' },
  '情侣': { weight: 0.4, type: 'companion', hint: '情侣约会' },
  '朋友': { weight: 0.3, type: 'companion', hint: '朋友聚会' },
  '同事': { weight: 0.3, type: 'companion', hint: '商务聚会' },
  '家庭': { weight: 0.3, type: 'companion', hint: '家庭聚餐' },
  '聚餐': { weight: 0.3, type: 'companion', hint: '聚餐场景' },
  '约会': { weight: 0.3, type: 'companion', hint: '约会场景' },
  '商务': { weight: 0.3, type: 'companion', hint: '商务聚会' },
  '独自': { weight: 0.2, type: 'companion', hint: '独自用餐' },
  // 时段
  '早餐': { weight: 0.3, type: 'slot', hint: '早餐时段' },
  '午餐': { weight: 0.3, type: 'slot', hint: '午餐时段' },
  '下午茶': { weight: 0.4, type: 'slot', hint: '下午茶时段' },
  '晚餐': { weight: 0.3, type: 'slot', hint: '晚餐时段' },
  '宵夜': { weight: 0.3, type: 'slot', hint: '夜宵时段' },
  '夜宵': { weight: 0.3, type: 'slot', hint: '夜宵时段' },
  '深夜': { weight: 0.3, type: 'slot', hint: '深夜时段' },
  '24小时': { weight: 0.4, type: 'slot', hint: '24小时营业' },
  // 设施
  '包间': { weight: 0.5, type: 'facility', hint: '支持包间' },
  '停车': { weight: 0.3, type: 'facility', hint: '支持停车' },
  '外卖': { weight: 0.2, type: 'facility', hint: '支持外卖' },
  '排队': { weight: 0.2, type: 'facility', hint: '需排队' },
  // 价位偏好
  '便宜': { weight: 0.3, type: 'price', hint: '低价位' },
  '实惠': { weight: 0.3, type: 'price', hint: '低价位' },
  '高端': { weight: 0.3, type: 'price', hint: '高价位' },
};

/** 从 query 中抽取价格区间：支持 "150/人" / "150元每人" / "100-200元" / "100到200" */
function extractBudget(text) {
  // 区间：100-200 元 / 100到200
  const range = text.match(/(\d{2,4})\s*(?:-|\s*到\s*)\s*(\d{2,4})/);
  if (range) {
    return { min: Number(range[1]), max: Number(range[2]) };
  }
  // 单点：150元/人 / 150/人 / 150每人
  const single = text.match(/(\d{2,4})\s*(?:元)?\s*(?:\/|每)\s*人/);
  if (single) {
    const v = Number(single[1]);
    return { min: Math.round(v * 0.7), max: Math.round(v * 1.3) };
  }
  return null;
}

async function personalize({ city, query } = {}) {
  const text = String(query || '');
  const parsed = [];
  const matchedKeys = [];

  // 1) 关键词命中
  for (const key of Object.keys(KEYWORDS)) {
    if (text.includes(key)) {
      parsed.push({ key, matched: true, hint: KEYWORDS[key].hint, type: KEYWORDS[key].type });
      matchedKeys.push(key);
    }
  }

  // 2) 预算区间
  const budget = extractBudget(text);
  if (budget) {
    parsed.push({ key: `预算 ${budget.min}-${budget.max}`, matched: true, hint: '预算区间', type: 'budget' });
  }

  // 3) 打分
  const candidates = RESTAURANTS.filter((r) => r.city === city);
  const at = nowMin();
  const scored = candidates.map((r) => {
    let score = 0;
    const reasons = [];

    // 关键词命中 tag
    for (const k of matchedKeys) {
      const meta = KEYWORDS[k];
      if (r.tags.some((t) => t.includes(k) || k.includes(t))) {
        score += meta.weight;
        reasons.push(`标签「${k}」`);
      }
      // 时段命中
      if (meta.type === 'slot' && r.hours.slots.includes(k)) {
        score += 0.3;
        reasons.push(`供应「${k}」`);
      }
    }

    // 命中菜系：偏好"川菜/火锅/烧烤"等 → cuisines
    for (const k of matchedKeys) {
      if (CUISINES_LIST.has(k) && r.cuisines.includes(k)) {
        score += 0.6;
        reasons.push(`菜系「${k}」`);
      }
    }

    // 命中招牌菜字面量
    for (const k of matchedKeys) {
      if (r.signatureDishes.some((sd) => sd.includes(k))) {
        score += 0.2;
        reasons.push(`招牌菜含「${k}」`);
      }
    }

    // 预算区间
    if (budget && r.avgPrice >= budget.min && r.avgPrice <= budget.max) {
      score += 0.5;
      reasons.push(`人均 ${r.avgPrice} 元符合预算 ${budget.min}-${budget.max}`);
    }

    // 营业中加分（用户没说要营业中的不要硬塞）
    if (isOpenAt(r.hours, at)) {
      score += 0.1;
    }

    // 评分做软加成（最高 +0.3）
    score += (r.rating - 4.0) * 0.3;
    if (score < 0) score = 0;

    return { r, score, reasons };
  });

  // 4) 选 Top N（阈值 0.4；不足时降到 0.2 兜底）
  let threshold = 0.4;
  let picked = scored.filter((x) => x.score >= threshold).sort((a, b) => b.score - a.score).slice(0, 6);
  let hint = null;
  if (picked.length < 3) {
    threshold = 0.2;
    picked = scored.filter((x) => x.score >= threshold).sort((a, b) => b.score - a.score).slice(0, 6);
    if (picked.length > 0) {
      hint = '放宽偏好后命中这些餐厅';
    }
  }

  // 5) 归一化 + 拼 reason
  const maxScore = Math.max(...picked.map((p) => p.score), 1);
  const recommendations = picked.map((p) => {
    const r = p.r;
    const parts = [];
    if (budget && r.avgPrice >= budget.min && r.avgPrice <= budget.max) {
      parts.push(`人均 ${r.avgPrice} 元符合预算`);
    }
    const tagHits = p.reasons.filter((t) => t.startsWith('标签'));
    if (tagHits.length) parts.push(`标签命中：${tagHits.map((t) => t.replace('标签「', '').replace('」', '')).join('、')}`);
    const slotHits = p.reasons.filter((t) => t.startsWith('供应'));
    if (slotHits.length) parts.push(slotHits.map((t) => t.replace('供应「', '').replace('」', '')).join('、') + ' 时段');
    const cuisineHits = p.reasons.filter((t) => t.startsWith('菜系'));
    if (cuisineHits.length) parts.push(cuisineHits.map((t) => t.replace('菜系「', '').replace('」', '')).join('、'));
    if (parts.length === 0) parts.push(`评分 ${r.rating}，本地口碑不错`);
    return {
      restaurant: decorateRestaurant(r, isOpenAt(r.hours, at), city),
      score: Number((p.score / maxScore).toFixed(2)),
      reason: parts.join('；'),
    };
  });

  return { parsed, recommendations, hint };
}

// 构建菜系名集合（仅在 personalize 阶段使用）
const CUISINES_LIST = new Set([
  '川菜', '粤菜', '浙菜', '鲁菜', '苏菜', '闽菜', '湘菜', '鄂菜', '滇菜', '西北菜',
  '烧烤', '火锅', '面食', '海鲜', '西餐', '日料', '韩餐', '甜品 / 下午茶',
]);

module.exports = {
  getSpecialties,
  searchRestaurants,
  personalize,
  // 暴露内部工具，便于测试与扩展
  _internal: { hhmmToMin, nowMin, isOpenAt, distanceToLandmark, dishAvailableIn, extractBudget },
};