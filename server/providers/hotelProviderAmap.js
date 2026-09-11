'use strict';

/**
 * 高德地图 POI 酒店数据源（推荐）。
 *
 * 两种检索方式：
 *   - 位置不限：v5 place/text 城市范围内搜索住宿服务
 *   - 指定位置偏好（市中心/火车站/机场/景点周边）：
 *     先解析锚点坐标（市中心用城市坐标，其余走 v3 geocode 地理编码），
 *     再 v5 place/around 周边搜索，实现真实的「XX附近酒店」。
 *
 * 价格档位：v5 business.cost（人均消费，酒店场景近似每晚均价）过滤。
 *
 * 配置来源（优先级从高到低）：
 *   1. 设置页面保存的 .settings.json（amapKey 字段）
 *   2. 环境变量 .env：AMAP_KEY（Web 服务类型 Key）
 */

const { findCity } = require('../data/cities');
const { getSightsByCity } = require('../data/sights');
const { priceInTier, tierFromPrice, TIERS } = require('../lib/hotelPrefs');
const settings = require('../lib/settings');

const AMAP_TEXT_URL = 'https://restapi.amap.com/v5/place/text';
const AMAP_AROUND_URL = 'https://restapi.amap.com/v5/place/around';
const AMAP_GEOCODE_URL = 'https://restapi.amap.com/v3/geocode/geo';

/** 住宿服务 POI 分类码（高德 POI 分类） */
const HOTEL_TYPES = '100000';

/** 位置偏好 → 周边搜索半径（米） */
const RADIUS = {
  downtown: 5000,
  station: 3000,
  airport: 5000,
  scenic: 4000,
};

/** provider 元信息 */
const meta = {
  name: 'amap',
  label: '高德地图',
  requiresKey: 'AMAP_KEY',
};

/** 获取生效的高德 Key（设置页优先，环境变量兜底） */
function getAmapKey() {
  return (settings.getEffective().amapKey || '').trim();
}

/** 是否可用（配置了 AMAP_KEY 即启用） */
function isConfigured() {
  return Boolean(getAmapKey());
}

/** 简易 fetch 带超时 */
async function fetchWithTimeout(url, timeoutMs = 10000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 解析 v5 返回的坐标 "lng,lat" */
function parseLocation(loc) {
  if (typeof loc !== 'string') return null;
  const [lng, lat] = loc.split(',').map(Number);
  if (!Number.isFinite(lng) || !Number.isFinite(lat)) return null;
  return { lng, lat };
}

/** v5 photos 取第一张缩略图 */
function pickPhoto(pois) {
  const url = pois && typeof pois.url === 'string' ? pois.url : '';
  return url ? [{ url }] : null;
}

/** business.cost 归一化为每晚价格（元） */
function parseCost(business) {
  const raw = business && business.cost;
  if (raw === undefined || raw === null || raw === '') return null;
  const n = Number(String(raw).replace(/[^\d.]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** business.rating 归一化为 0-5 评分 */
function parseRating(business) {
  const raw = business && business.rating;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.min(5, Number(n.toFixed(1)));
}

/** 高德返回校验：v5 用 status/infocode 表达结果（个别网关也会带 errcode，两者兼容） */
function assertOk(data) {
  const errcodeOk = data.errcode === undefined || data.errcode === 0;
  if (!errcodeOk || String(data.status) !== '1') {
    throw new Error(`高德接口错误: ${data.errmsg || data.info || '未知错误'}`);
  }
}

/**
 * 解析位置偏好锚点坐标。
 * downtown 直接使用城市坐标；station/airport/scenic 走地理编码。
 * 解析失败返回 null（调用方回退城市范围搜索）。
 */
function resolveAnchor(cityInfo, location, amapKey) {
  if (location === 'downtown' && cityInfo) {
    return { lng: cityInfo.lng, lat: cityInfo.lat };
  }
  if (location === 'station' && cityInfo) {
    const station = cityInfo.stations && cityInfo.stations[0];
    if (station) return geocode(`${station}站`, cityInfo.name, amapKey);
    return null;
  }
  if (location === 'airport' && cityInfo) {
    const airport = cityInfo.airports && cityInfo.airports[0];
    if (airport) return geocode(`${cityInfo.name}${airport.name}`, cityInfo.name, amapKey);
    return null;
  }
  if (location === 'scenic' && cityInfo) {
    const sights = getSightsByCity(cityInfo.name);
    if (sights.length > 0) return geocode(sights[0].name, cityInfo.name, amapKey);
    return null;
  }
  return null;
}

/** v3 地理编码：地址 → 坐标（失败返回 null，不抛错） */
async function geocode(address, cityName, amapKey) {
  const params = new URLSearchParams({ key: amapKey, address, city: cityName });
  try {
    const res = await fetchWithTimeout(`${AMAP_GEOCODE_URL}?${params}`);
    if (!res.ok) return null;
    const data = await res.json();
    if (String(data.status) !== '1' || !Array.isArray(data.geocodes) || data.geocodes.length === 0) {
      return null;
    }
    return parseLocation(data.geocodes[0].location);
  } catch {
    return null;
  }
}

/** POI → 标准酒店对象 */
function normalizePoi(p) {
  const cost = parseCost(p.biz_ext);
  return {
    name: String(p.name || '').trim(),
    rating: parseRating(p.biz_ext),
    popularity: null, // 高德不提供热度，由统一排序按位置序号补全
    tier: tierFromPrice(cost),
    price: cost,
    address: String(p.address || '').trim() || '地址待补全',
    desc: String((p.biz_ext && p.biz_ext.tag) || '').trim(),
    tags: [],
    recommended: false,
    photo: pickPhoto(p.photos),
    location: parseLocation(p.location),
  };
}

/**
 * 搜索酒店。
 * @param {string} cityName 城市名（规范中文）
 * @param {{tier?: string, location?: string}} prefs 偏好（见 lib/hotelPrefs）
 * @returns {Promise<Array>} 标准酒店列表（未排序）
 */
async function searchHotels(cityName, prefs = {}) {
  const amapKey = getAmapKey();
  if (!amapKey) {
    throw new Error('未配置高德 Key（AMAP_KEY），请在设置页面填写后重试');
  }

  const tier = prefs.tier || 'any';
  const location = prefs.location || 'any';
  const cityInfo = findCity(cityName);
  const region = cityInfo ? cityInfo.name : cityName;

  const base = { key: amapKey, types: HOTEL_TYPES, show_fields: 'business,photos', page_size: 25, page_num: 1 };
  let url;

  // 位置偏好：优先锚点周边搜索，解析失败回退城市范围搜索
  const anchor = location === 'any' ? null : await resolveAnchor(cityInfo, location, amapKey);
  if (anchor) {
    url = `${AMAP_AROUND_URL}?${new URLSearchParams({
      ...base,
      location: `${anchor.lng},${anchor.lat}`,
      radius: String(RADIUS[location] || 5000),
      keywords: '酒店',
    })}`;
  } else {
    url = `${AMAP_TEXT_URL}?${new URLSearchParams({
      ...base,
      keywords: '酒店',
      region,
      city_limit: 'true',
    })}`;
  }

  const res = await fetchWithTimeout(url);
  if (!res.ok) {
    throw new Error(`高德接口 HTTP ${res.status}`);
  }
  const data = await res.json();
  assertOk(data);

  let hotels = (Array.isArray(data.pois) ? data.pois : [])
    .filter((p) => p && String(p.name || '').trim())
    .map(normalizePoi);

  if (hotels.length === 0) {
    throw new Error(`高德未返回「${region}」的酒店数据`);
  }

  // 价格档位过滤（价格未知的条目视为不匹配）
  if (tier !== 'any') {
    hotels = hotels.filter((h) => priceInTier(h.price, tier));
    if (hotels.length === 0) {
      throw new Error(`高德未返回「${region}」${TIERS[tier].label}区间的酒店，请调整价格档位`);
    }
  }

  return hotels;
}

module.exports = { meta, isConfigured, searchHotels };
