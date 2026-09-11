'use strict';

/**
 * 高德地图 POI 美食数据源（可选，仅支持餐厅筛选）。
 * 使用高德 Web 服务 API v5 place/text 搜索城市餐饮 POI：
 *   https://restapi.amap.com/v5/place/text
 *
 * 能力说明：
 *   - searchRestaurants  ✅ 高德餐饮 POI（含评分 rating / 人均 cost / 营业时间 opentime）
 *   - getSpecialties     ❌ 高德无菜品维度数据（走 LLM / 本地）
 *   - personalize        ❌ 高德无法解析自然语言需求（走 LLM / 本地）
 *
 * 配置来源（优先级从高到低）：
 *   1. 设置页面保存的 .settings.json（amapKey 字段）
 *   2. 环境变量 .env：AMAP_KEY（Web 服务类型 Key，免费额度充足）
 */

const { findCity } = require('../data/cities');
const settings = require('../lib/settings');
const { CUISINES } = require('../data/food');

const AMAP_V5_URL = 'https://restapi.amap.com/v5/place/text';

/** 餐饮服务大类（高德 POI 分类码，与景点模块的 110000 风景名胜同表） */
const FOOD_TYPES = '050000';

/** provider 元信息 */
const meta = {
  name: 'amap',
  label: '高德地图',
  requiresKey: 'AMAP_KEY',
};

// ---------------------------------------------------------------------------
// 时间工具（与 foodProvider._internal 同构，独立实现避免循环依赖）
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

/** 营业中（跨夜班次按跨夜处理，如 22:00–06:00） */
function isOpenAt(open, close, atMin) {
  const o = hhmmToMin(open);
  const c = hhmmToMin(close);
  if (o === null || c === null) return false;
  if (o < c) return atMin >= o && atMin <= c;
  return atMin >= o || atMin <= c;
}

/** 由营业时间推导供应时段（近似） */
function deriveSlots(open, close) {
  const o = hhmmToMin(open);
  const c = hhmmToMin(close);
  if (o === null || c === null) return [];
  const closeOrOvernight = c < o ? c + 24 * 60 : c;
  const slots = [];
  if (o <= 8 * 60) slots.push('早餐');
  if (o <= 11 * 60 + 30 && closeOrOvernight >= 13 * 60) slots.push('午餐');
  if (o <= 14 * 60 && closeOrOvernight >= 16 * 60) slots.push('下午茶');
  if (o <= 18 * 60 && closeOrOvernight >= 19 * 60) slots.push('晚餐');
  if (closeOrOvernight >= 22 * 60 || c < o) slots.push('夜宵');
  return slots;
}

// ---------------------------------------------------------------------------
// 菜系匹配（复用 data/food 的 CUISINES 名称与别名）
// ---------------------------------------------------------------------------

/** 「甜品 / 下午茶」→「甜品」这类名称取主干 */
function cuisineCore(name) {
  return String(name).replace(/\s*\/.*$/, '').trim();
}

/** 菜系名 → 高德 type/tag 文本的匹配模式（含别名） */
const CUISINE_PATTERNS = new Map(
  CUISINES.map((c) => [c.name, [cuisineCore(c.name), ...c.aliases]]),
);

/**
 * 从 POI 的 type + tag 文本中识别菜系。
 * @param {string} text   poi.type 与 business.tag 拼接文本
 * @param {string[]|null} requested 用户筛选的菜系（有则只在该集合内匹配）
 */
function matchCuisines(text, requested) {
  const scope = requested && requested.length ? requested : CUISINES.map((c) => c.name);
  const hits = scope.filter((name) => {
    const pats = CUISINE_PATTERNS.get(name) || [cuisineCore(name)];
    return pats.some((p) => p && text.includes(p));
  });
  if (hits.length) return hits;
  // 未匹配到具体菜系：有筛选时信任关键词搜索结果，无筛选时归为中餐/美食
  return requested && requested.length ? [...requested] : ['美食'];
}

// ---------------------------------------------------------------------------
// 配置
// ---------------------------------------------------------------------------

function getAmapKey() {
  return (settings.getEffective().amapKey || '').trim();
}

function isConfigured() {
  return Boolean(getAmapKey());
}

/** 简易 fetch 带超时 */
async function fetchWithTimeout(url, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// POI 归一化
// ---------------------------------------------------------------------------

/** 从 opentime_today / opentime_week 文本中提取 HH:MM-HH:MM */
function parseOpenTime(...texts) {
  for (const t of texts) {
    if (!t) continue;
    const m = String(t).match(/(\d{1,2}:\d{2})\s*[-–~]\s*(\d{1,2}:\d{2})/);
    if (m) return { open: m[1], close: m[2] };
  }
  return null;
}

function normalizePoi(poi, requestedCuisines) {
  if (!poi || !poi.name) return null;
  const biz = poi.business || {};
  const typeText = `${poi.type || ''} ${biz.tag || ''}`;

  // 人均消费
  const cost = Number(biz.cost);
  const avgPrice = Number.isFinite(cost) && cost > 0 ? Math.round(cost) : null;

  // 营业时间
  const parsed = parseOpenTime(biz.opentime_today, biz.opentime_week);
  const at = nowMin();
  const hours = parsed
    ? {
        open: parsed.open,
        close: parsed.close,
        isOpenNow: isOpenAt(parsed.open, parsed.close, at),
        slots: deriveSlots(parsed.open, parsed.close),
      }
    : { open: '--', close: '--', isOpenNow: false, slots: [] };

  // 特色标签
  const tags = String(biz.tag || '')
    .split(/[,，、;；]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 4);

  return {
    id: String(poi.id || poi.name),
    name: String(poi.name),
    cuisines: matchCuisines(typeText, requestedCuisines),
    avgPrice,
    priceRange: avgPrice ? `¥${Math.round(avgPrice * 0.7)}–${Math.round(avgPrice * 1.3)}` : '以现场为准',
    location: {
      address: String(poi.address || `${poi.cityname || ''}${poi.adname || ''}` || '地址详见地图'),
      district: String(poi.adname || ''),
      nearLandmark: biz.business_area ? `近${biz.business_area}商圈` : '',
    },
    hours,
    rating: (() => {
      const r = Number(biz.rating);
      return Number.isFinite(r) && r > 0 ? Math.min(5, Math.round(r * 10) / 10) : 0;
    })(),
    reviewCount: 0, // 高德不返回评价数，前端显示「评价数暂无」
    tags,
    signatureDishes: [], // 高德无招牌菜数据
    reservation: false, // 高德无预订信息
  };
}

// ---------------------------------------------------------------------------
// 对外接口：餐厅筛选
// ---------------------------------------------------------------------------

/**
 * @param {string} cityName 城市名（规范中文名）
 * @param {object} filters { cuisines, priceMin, priceMax, slot, openNow, sort }
 * @returns {Promise<Array>} 与本地数据源同构的餐厅数组
 */
async function searchRestaurants(cityName, filters = {}) {
  const {
    cuisines = [],
    priceMin = 0,
    priceMax = Number.MAX_SAFE_INTEGER,
    slot = null,
    openNow = false,
    sort = 'rating',
  } = filters;

  const city = findCity(cityName);
  const region = city ? city.name : cityName;

  // 关键词：优先用第一个菜系（如「川菜」），否则用「美食」
  const keyword = cuisines && cuisines.length ? cuisineCore(cuisines[0]) : '美食';

  const params = new URLSearchParams({
    key: getAmapKey(),
    keywords: keyword,
    types: FOOD_TYPES,
    region,
    city_limit: 'true',
    show_fields: 'business',
    page_size: '25',
    page_num: '1',
  });

  const res = await fetchWithTimeout(`${AMAP_V5_URL}?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`高德接口 HTTP ${res.status}`);
  }
  const data = await res.json();
  if (data.errcode !== 0 || String(data.status) !== '1') {
    throw new Error(`高德接口错误: ${data.errmsg || data.info || '未知错误'}`);
  }

  const pois = Array.isArray(data.pois) ? data.pois : [];
  if (pois.length === 0) {
    // 与景点模块一致：搜不到任何 POI 视为该源失败，允许 auto 模式降级
    throw new Error(`高德未返回「${region}」的餐饮数据`);
  }

  // 归一化 + 过滤
  let items = pois.map((p) => normalizePoi(p, cuisines)).filter(Boolean);

  if (openNow) {
    items = items.filter((r) => r.hours.isOpenNow === true);
  }
  if (slot) {
    // 营业时间未知的门店无法判断，视为满足（价格未知同理，保持宽松）
    items = items.filter((r) => r.hours.slots.length === 0 || r.hours.slots.includes(slot));
  }
  items = items.filter((r) => r.avgPrice === null || (r.avgPrice >= priceMin && r.avgPrice <= priceMax));

  // 排序（与本地数据源同构；人均未知排末尾）
  if (sort === 'priceAsc') {
    items.sort((a, b) => (a.avgPrice ?? Infinity) - (b.avgPrice ?? Infinity));
  } else if (sort === 'priceDesc') {
    items.sort((a, b) => (b.avgPrice ?? -1) - (a.avgPrice ?? -1));
  } else if (sort === 'openFirst') {
    items.sort((a, b) => {
      if (a.hours.isOpenNow !== b.hours.isOpenNow) return a.hours.isOpenNow ? -1 : 1;
      return b.rating - a.rating;
    });
  } else {
    items.sort((a, b) => b.rating - a.rating);
  }

  return items;
}

module.exports = { meta, isConfigured, searchRestaurants };
