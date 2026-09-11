'use strict';

/**
 * 高德地图 POI 景点数据源（推荐）。
 * 使用高德 Web 服务 API v5 place/text 搜索城市景点：
 *   https://restapi.amap.com/v5/place/text
 *
 * 配置来源（优先级从高到低）：
 *   1. 设置页面保存的 .settings.json（amapKey 字段）
 *   2. 环境变量 .env：AMAP_KEY（Web 服务类型 Key，免费额度充足）
 *
 * v5 特性：
 *   - show_fields=business 可返回评分 rating 与人均消费 cost
 *   - show_fields=photos 可返回照片
 *   - city_limit=true 限定在指定城市内搜索
 */

const { findCity } = require('../data/cities');
const settings = require('../lib/settings');

const AMAP_V5_URL = 'https://restapi.amap.com/v5/place/text';

/** 景点相关 POI 分类码（高德 POI 分类）：风景名胜 + 部分文旅相关类目 */
const SIGHT_TYPES = [
  '110000', // 风景名胜
  '110100', // 风景名胜相关
  '140300', // 博物馆
  '140200', // 展览馆
  '140400', // 动植物园
  '060100', // 广场
  '060200', // 休闲广场
].join('|');

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

/** 简易 fetch 带超时（Node 18+ 全局 fetch） */
async function fetchWithTimeout(url, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 数组字段容错：高德在无数据时可能返回空数组而非字符串 */
function asString(v) {
  if (Array.isArray(v)) return '';
  if (v == null) return '';
  return String(v);
}

/** 解析高德 photos 字段，取第一张图片 URL */
function pickPhoto(poi) {
  const photos = poi.photos;
  if (Array.isArray(photos) && photos.length > 0) {
    const url = asString(photos[0].url);
    if (url) return url;
  }
  return null;
}

/** 解析经纬度字符串 "lng,lat" */
function parseLocation(poi) {
  const loc = asString(poi.location);
  if (!loc || !loc.includes(',')) return null;
  const [lng, lat] = loc.split(',').map(Number);
  if (Number.isNaN(lng) || Number.isNaN(lat)) return null;
  return { lng, lat };
}

/** 将高德 POI 转换为统一的景点对象 */
function normalizePoi(poi) {
  const business = poi.business || {};
  const rating = parseFloat(asString(business.rating));
  const cost = parseFloat(asString(business.cost));
  return {
    name: asString(poi.name) || '未知景点',
    rating: Number.isFinite(rating) ? Math.min(5, Math.max(0, rating)) : null,
    popularity: null, // 高德不直接提供热度，由 sightProvider 综合计算
    type: asString(poi.type) || '景点',
    ticket: Number.isFinite(cost) ? `人均约${Math.round(cost)}元` : '以现场公示为准',
    openTime: asString(business.opentime) || asString(business.opentime2) || '以现场公示为准',
    visitHours: null,
    address: asString(poi.address) || asString(poi.pname) + asString(poi.cityname),
    desc: asString(poi.biz_ext && poi.biz_ext.tag) || `${asString(poi.type)} · ${asString(poi.address)}`,
    tags: [],
    recommended: false,
    photo: pickPhoto(poi),
    location: parseLocation(poi),
  };
}

/**
 * 搜索指定城市的景点。
 * @param {string} cityName 城市名（中文）
 * @returns {Promise<Array>} 景点数组（已按综合热度排序，由上层处理）
 */
async function searchSights(cityName) {
  const amapKey = getAmapKey();
  if (!amapKey) {
    throw new Error('高德数据源未配置 Key，请先在「设置」页面配置');
  }
  const city = findCity(cityName);
  const region = city ? city.name : cityName;

  const params = new URLSearchParams({
    key: amapKey,
    keywords: '景点',
    types: SIGHT_TYPES,
    region: region,
    city_limit: 'true',
    show_fields: 'business,photos',
    page_size: '25',
    page_num: '1',
  });

  const res = await fetchWithTimeout(`${AMAP_V5_URL}?${params.toString()}`);
  if (!res.ok) {
    throw new Error(`高德接口 HTTP ${res.status}`);
  }
  const data = await res.json();

  // v5 返回 errcode=0 / status="1" 表示成功
  if (data.errcode !== 0 || String(data.status) !== '1') {
    throw new Error(`高德接口错误: ${data.errmsg || data.info || '未知错误'}`);
  }
  const pois = Array.isArray(data.pois) ? data.pois : [];
  if (pois.length === 0) {
    throw new Error(`高德未返回「${region}」的景点数据`);
  }

  // 过滤无名称的脏数据并归一化
  return pois
    .filter((p) => p && asString(p.name))
    .map(normalizePoi);
}

module.exports = { meta, isConfigured, searchSights };
