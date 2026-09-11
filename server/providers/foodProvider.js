'use strict';

/**
 * 美食模块数据源统一入口。
 *
 * 降级链（自动模式，按能力过滤后依次尝试）：
 *   - 餐厅筛选：amap → llm → local（三级，与景点模块一致）
 *     amap - 高德地图 POI 真实数据（需 AMAP_KEY，含评分/人均/营业时间）
 *   - 特色菜品 / 个性化：llm → local（高德无菜品维度与自然语言能力）
 *     llm   - LLM Agent 生成（需 LLM_API_KEY）
 *   - local - 内置数据集（离线兜底，无需任何 Key）
 *
 * 数据源选择（优先级从高到低）：
 *   1. 调用方显式指定 options.source（前端「数据来源」下拉框）
 *   2. 环境变量 FOOD_SOURCE 强制指定：amap / llm / local
 *   3. 自动降级链
 *
 * 其他特性：
 *   - 内存缓存（TTL 30 分钟，key 含数据源与查询参数，避免不同来源结果串台）
 *   - 熔断：某数据源连续失败 3 次后暂停使用 10 分钟，直接降级
 *
 * 对外接口（三个能力均返回 { source, sourceLabel, cached, ...数据 }）：
 *   getSpecialties({ city, category, source })   特色菜品
 *   searchRestaurants({ city, ..., source })     餐厅筛选
 *   personalize({ city, query, source })         个性化推荐
 */

const amap = require('./foodProviderAmap');
const llm = require('./foodProviderLlm');
const {
  SPECIALTY_DISHES,
  RESTAURANTS,
  CITY_LANDMARKS,
  VALID_SLOTS,
} = require('../data/food');
const { findCity } = require('../data/cities');
const { haversineKm } = require('../lib/geo');

/** 数据源注册表（顺序即降级优先级；各源按能力暴露方法，注册顺序与能力无关） */
const SOURCES = [amap, llm];

/** 按能力过滤数据源链（如高德仅实现 searchRestaurants） */
function capabilityChain(chain, method) {
  return chain.filter((s) => typeof s[method] === 'function');
}

// ---------------------------------------------------------------------------
// 时间工具
// ---------------------------------------------------------------------------

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
  return atMin >= open || atMin <= close;
}

// ---------------------------------------------------------------------------
// 本地数据源（离线兜底，永不失败）
// ---------------------------------------------------------------------------

/** 菜品是否在餐厅"可达"（出现在招牌菜 / 餐厅名中） */
function dishAvailableIn(dish, restaurant) {
  const keys = [dish.name, ...(dish.aliases || [])];
  if (restaurant.signatureDishes.some((sd) => keys.some((k) => k === sd))) return true;
  if (keys.some((k) => k && restaurant.name.includes(k))) return true;
  return false;
}

async function localSpecialties(city, category) {
  const list = SPECIALTY_DISHES.filter((d) => d.city === city);
  const filtered =
    !category || category === '全部' ? list : list.filter((d) => d.category === category);

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

  items.sort((a, b) => (b.availableRestaurants - a.availableRestaurants) || a.id.localeCompare(b.id));
  return items;
}

/** 计算餐厅距城市地标的距离（公里）；保留 1 位小数 */
function distanceToLandmark(city, lat, lng) {
  const lm = CITY_LANDMARKS[city];
  if (!lm) return null;
  const km = haversineKm(lat, lng, lm.lat, lm.lng);
  if (km < 0.1) return `${Math.round(km * 1000)} m`;
  return `${km.toFixed(1)} km`;
}

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

async function localRestaurants(city, filters) {
  const {
    cuisines = [],
    priceMin = 0,
    priceMax = Number.MAX_SAFE_INTEGER,
    slot = null,
    openNow = false,
    sort = 'rating',
  } = filters;

  const list = RESTAURANTS.filter((r) => r.city === city);

  let filtered = list.filter((r) => r.avgPrice >= priceMin && r.avgPrice <= priceMax);

  if (cuisines && cuisines.length > 0) {
    filtered = filtered.filter((r) => r.cuisines.some((c) => cuisines.includes(c)));
  }

  if (slot && VALID_SLOTS.includes(slot)) {
    filtered = filtered.filter((r) => r.hours.slots.includes(slot));
  }

  if (openNow) {
    const at = nowMin();
    filtered = filtered.filter((r) => isOpenAt(r.hours, at));
  }

  const at = nowMin();
  const decorated = filtered.map((r) => decorateRestaurant(r, isOpenAt(r.hours, at), city));

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
    decorated.sort((a, b) => (b.rating - a.rating) || (b.reviewCount - a.reviewCount));
  }
  return decorated;
}

// 本地个性化推荐（词典解析 + 加权打分）
const KEYWORDS = {
  '不辣': { weight: 0.4, type: 'taste', hint: '口味清淡' },
  '辣': { weight: 0.4, type: 'taste', hint: '麻辣口味' },
  '麻辣': { weight: 0.5, type: 'taste', hint: '麻辣口味' },
  '清淡': { weight: 0.4, type: 'taste', hint: '清淡口味' },
  '甜': { weight: 0.3, type: 'taste', hint: '甜口' },
  '酸': { weight: 0.3, type: 'taste', hint: '酸口' },
  '烧烤': { weight: 0.4, type: 'taste', hint: '烧烤口味' },
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
  '早餐': { weight: 0.3, type: 'slot', hint: '早餐时段' },
  '午餐': { weight: 0.3, type: 'slot', hint: '午餐时段' },
  '下午茶': { weight: 0.4, type: 'slot', hint: '下午茶时段' },
  '晚餐': { weight: 0.3, type: 'slot', hint: '晚餐时段' },
  '宵夜': { weight: 0.3, type: 'slot', hint: '夜宵时段' },
  '夜宵': { weight: 0.3, type: 'slot', hint: '夜宵时段' },
  '深夜': { weight: 0.3, type: 'slot', hint: '深夜时段' },
  '24小时': { weight: 0.4, type: 'slot', hint: '24小时营业' },
  '包间': { weight: 0.5, type: 'facility', hint: '支持包间' },
  '停车': { weight: 0.3, type: 'facility', hint: '支持停车' },
  '外卖': { weight: 0.2, type: 'facility', hint: '支持外卖' },
  '排队': { weight: 0.2, type: 'facility', hint: '需排队' },
  '便宜': { weight: 0.3, type: 'price', hint: '低价位' },
  '实惠': { weight: 0.3, type: 'price', hint: '低价位' },
  '高端': { weight: 0.3, type: 'price', hint: '高价位' },
};

const CUISINES_SET = new Set([
  '川菜', '粤菜', '浙菜', '鲁菜', '苏菜', '闽菜', '湘菜', '鄂菜', '滇菜', '西北菜',
  '烧烤', '火锅', '面食', '海鲜', '西餐', '日料', '韩餐', '甜品 / 下午茶',
]);

/** 从 query 中抽取价格区间：支持 "150/人" / "100-200元" / "100到200" */
function extractBudget(text) {
  const range = text.match(/(\d{2,4})\s*(?:-|\s*到\s*)\s*(\d{2,4})/);
  if (range) {
    return { min: Number(range[1]), max: Number(range[2]) };
  }
  const single = text.match(/(\d{2,4})\s*(?:元)?\s*(?:\/|每)\s*人/);
  if (single) {
    const v = Number(single[1]);
    return { min: Math.round(v * 0.7), max: Math.round(v * 1.3) };
  }
  return null;
}

async function localPersonalize(city, query) {
  const text = String(query || '');
  const parsed = [];
  const matchedKeys = [];

  for (const key of Object.keys(KEYWORDS)) {
    if (text.includes(key)) {
      parsed.push({ key, matched: true, hint: KEYWORDS[key].hint, type: KEYWORDS[key].type });
      matchedKeys.push(key);
    }
  }

  const budget = extractBudget(text);
  if (budget) {
    parsed.push({ key: `预算 ${budget.min}-${budget.max}`, matched: true, hint: '预算区间', type: 'budget' });
  }

  const candidates = RESTAURANTS.filter((r) => r.city === city);
  const at = nowMin();
  const scored = candidates.map((r) => {
    let score = 0;
    const reasons = [];

    for (const k of matchedKeys) {
      const meta = KEYWORDS[k];
      if (r.tags.some((t) => t.includes(k) || k.includes(t))) {
        score += meta.weight;
        reasons.push(`标签「${k}」`);
      }
      if (meta.type === 'slot' && r.hours.slots.includes(k)) {
        score += 0.3;
        reasons.push(`供应「${k}」`);
      }
    }

    for (const k of matchedKeys) {
      if (CUISINES_SET.has(k) && r.cuisines.includes(k)) {
        score += 0.6;
        reasons.push(`菜系「${k}」`);
      }
    }

    for (const k of matchedKeys) {
      if (r.signatureDishes.some((sd) => sd.includes(k))) {
        score += 0.2;
        reasons.push(`招牌菜含「${k}」`);
      }
    }

    if (budget && r.avgPrice >= budget.min && r.avgPrice <= budget.max) {
      score += 0.5;
      reasons.push(`人均 ${r.avgPrice} 元符合预算 ${budget.min}-${budget.max}`);
    }

    if (isOpenAt(r.hours, at)) {
      score += 0.1;
    }

    score += (r.rating - 4.0) * 0.3;
    if (score < 0) score = 0;

    return { r, score, reasons };
  });

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

const localSource = {
  meta: { name: 'local', label: '本地数据', requiresKey: null },
  isConfigured: () => true,
  getSpecialties: localSpecialties,
  searchRestaurants: localRestaurants,
  personalize: localPersonalize,
};

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 分钟
const cache = new Map(); // key: JSON 字符串 -> { data, expireAt }

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expireAt) {
    cache.delete(key);
    return null;
  }
  return entry.data;
}

function cacheSet(key, data) {
  cache.set(key, { data, expireAt: Date.now() + CACHE_TTL_MS });
}

/** 清空全部缓存（设置更新后调用，避免旧数据源结果残留） */
function clearCache() {
  cache.clear();
}

// ---------------------------------------------------------------------------
// 熔断器
// ---------------------------------------------------------------------------

const BREAK_THRESHOLD = 3;                 // 连续失败次数阈值
const BREAK_COOLDOWN_MS = 10 * 60 * 1000;  // 熔断冷却时间

const breakers = new Map(); // sourceName -> { fails, openUntil }

function isBroken(sourceName) {
  const b = breakers.get(sourceName);
  return Boolean(b && b.openUntil > Date.now());
}

function recordFailure(sourceName) {
  const b = breakers.get(sourceName) || { fails: 0, openUntil: 0 };
  b.fails += 1;
  if (b.fails >= BREAK_THRESHOLD) {
    b.openUntil = Date.now() + BREAK_COOLDOWN_MS;
    b.fails = 0;
  }
  breakers.set(sourceName, b);
}

function recordSuccess(sourceName) {
  breakers.delete(sourceName);
}

// ---------------------------------------------------------------------------
// 数据源选择与统一入口
// ---------------------------------------------------------------------------

/** 解析生效数据源：显式指定 > 环境变量（仅 auto 时） > 自动降级链 */
function resolveChain(requested) {
  const src = String(requested || 'auto').trim().toLowerCase();
  if (!['auto', 'local', 'llm', 'amap'].includes(src)) {
    throw new Error(`无效的数据源「${requested}」，可选：auto / local / llm / amap`);
  }

  let effective = src;
  if (src === 'auto' && process.env.FOOD_SOURCE && ['amap', 'llm', 'local'].includes(process.env.FOOD_SOURCE)) {
    effective = process.env.FOOD_SOURCE;
  }

  if (effective === 'local') return { chain: [localSource], explicit: true };
  if (effective === 'llm') return { chain: [llm], explicit: true };
  if (effective === 'amap') return { chain: [amap], explicit: true };
  // auto：降级链 amap → llm → local（高德/LLM 未配置/熔断时自动跳过）
  const chain = SOURCES.filter((s) => !isBroken(s.meta.name));
  return { chain: [...chain, localSource], explicit: false };
}

/**
 * 通用执行器：按降级链依次尝试数据源，带缓存与熔断。
 * @param {string}  cacheKey 缓存键
 * @param {Array}   chain    数据源链
 * @param {Function} runner   (source) => Promise<data>
 * @param {boolean} explicit 显式指定单一数据源（失败不降级，直接抛错）
 */
async function runWithSources(cacheKey, chain, runner, explicit) {
  // 1) 缓存命中直接返回
  const cached = cacheGet(cacheKey);
  if (cached) {
    return { ...cached, cached: true };
  }

  // 2) 显式指定单一数据源：失败直接抛错（不降级）
  if (explicit && chain.length === 1) {
    const src = chain[0];
    if (src.meta.requiresKey && !src.isConfigured()) {
      throw new Error(`${src.meta.label} 未配置 API Key，请先在「设置」页面配置`);
    }
    const data = await runner(src);
    const result = { source: src.meta.name, sourceLabel: src.meta.label, cached: false, ...data };
    cacheSet(cacheKey, result);
    return result;
  }

  // 3) 自动降级链
  const errors = [];
  for (const src of chain) {
    if (src.meta.requiresKey && !src.isConfigured()) {
      errors.push(`[${src.meta.name}] 未配置 API Key`);
      continue;
    }
    try {
      const data = await runner(src);
      const result = { source: src.meta.name, sourceLabel: src.meta.label, cached: false, ...data };
      recordSuccess(src.meta.name);
      cacheSet(cacheKey, result);
      return result;
    } catch (err) {
      recordFailure(src.meta.name);
      errors.push(`[${src.meta.name}] ${err.message}`);
    }
  }

  throw new Error(`所有美食数据源均失败: ${errors.join(' | ')}`);
}

// ---------------------------------------------------------------------------
// 对外接口（返回 { source, sourceLabel, cached, ...数据 }）
// ---------------------------------------------------------------------------

/** 特色菜品：按推荐店铺数倒序（高德无菜品数据，能力过滤后走 llm → local） */
async function getSpecialties({ city, category, source } = {}) {
  const found = findCity(city);
  const canonical = found ? found.name : city;
  const { chain } = resolveChain(source);
  const capable = capabilityChain(chain, 'getSpecialties');
  if (!capable.length) {
    throw new Error(`「${chain[0].meta.label}」数据源不支持特色菜品查询，请选择「AI 联网搜索」或「本地数据」`);
  }
  const cacheKey = JSON.stringify(['specialties', canonical, category || '全部', capable.map((s) => s.meta.name).join('>')]);
  return runWithSources(cacheKey, capable, (src) =>
    src.getSpecialties(canonical, category).then((specialties) => ({ specialties })), capable.length === 1 && chain.length === 1);
}

/** 餐厅筛选：菜系 / 人均 / 时段 / 营业中 / 排序（三级降级 amap → llm → local，与景点一致） */
async function searchRestaurants({
  city,
  cuisines = [],
  priceMin = 0,
  priceMax = Number.MAX_SAFE_INTEGER,
  slot = null,
  openNow = false,
  sort = 'rating',
  source,
} = {}) {
  const found = findCity(city);
  const canonical = found ? found.name : city;
  const { chain } = resolveChain(source);
  const capable = capabilityChain(chain, 'searchRestaurants');
  if (!capable.length) {
    throw new Error(`「${chain[0].meta.label}」数据源不支持餐厅筛选`);
  }
  const cacheKey = JSON.stringify([
    'restaurants', canonical, cuisines, priceMin, priceMax, slot, Boolean(openNow), sort,
    capable.map((s) => s.meta.name).join('>'),
  ]);
  return runWithSources(cacheKey, capable, (src) =>
    src.searchRestaurants(canonical, { cuisines, priceMin, priceMax, slot, openNow, sort }).then((restaurants) => ({ restaurants })), capable.length === 1 && chain.length === 1);
}

/** 个性化推荐：自然语言需求（高德无法解析，能力过滤后走 llm → local） */
async function personalize({ city, query, source } = {}) {
  const found = findCity(city);
  const canonical = found ? found.name : city;
  const { chain } = resolveChain(source);
  const capable = capabilityChain(chain, 'personalize');
  if (!capable.length) {
    throw new Error(`「${chain[0].meta.label}」数据源不支持个性化推荐，请选择「AI 联网搜索」或「本地数据」`);
  }
  const cacheKey = JSON.stringify(['personalize', canonical, String(query), capable.map((s) => s.meta.name).join('>')]);
  return runWithSources(cacheKey, capable, (src) => src.personalize(canonical, String(query)), capable.length === 1 && chain.length === 1);
}

/** 各数据源配置状态（前端提示用） */
function getSourceStatus() {
  const all = [amap, llm, localSource];
  return all.map((s) => ({
    name: s.meta.name,
    label: s.meta.label,
    requiresKey: s.meta.requiresKey,
    configured: s.isConfigured(),
    broken: isBroken(s.meta.name),
  }));
}

module.exports = {
  getSpecialties,
  searchRestaurants,
  personalize,
  getSourceStatus,
  clearCache,
  // 暴露内部工具，便于测试与扩展
  _internal: { hhmmToMin, nowMin, isOpenAt, distanceToLandmark, dishAvailableIn, extractBudget },
};
