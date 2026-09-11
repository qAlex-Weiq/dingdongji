'use strict';

/**
 * 景点数据源统一入口。
 *
 * 三级降级链（自动选择第一个可用的数据源）：
 *   1. amap  - 高德地图 POI 联网搜索（需 AMAP_KEY，推荐，数据真实）
 *   2. llm   - LLM Agent 生成（需 LLM_API_KEY，可选联网模型）
 *   3. local - 内置 25 城数据集（离线兜底，无需任何 Key）
 *
 * 可通过环境变量 SIGHT_SOURCE 强制指定：amap / llm / local
 *
 * 其他特性：
 *   - 内存缓存（TTL 30 分钟，避免重复请求外部接口）
 *   - 熔断：某数据源连续失败 3 次后暂停使用 10 分钟，直接降级
 *   - 综合排序：score = 热度(60%) + 评分(40%)，热门程度与口碑兼顾
 */

const amap = require('./sightProviderAmap');
const llm = require('./sightProviderLlm');
const { getSightsByCity } = require('../data/sights');
const { findCity } = require('../data/cities');

/** 数据源注册表（顺序即降级优先级） */
const SOURCES = [amap, llm];

/** 内置数据源（本地，永不失败） */
const localSource = {
  meta: { name: 'local', label: '内置数据', requiresKey: null },
  isConfigured: () => true,
  async searchSights(cityName) {
    const city = findCity(cityName);
    const sights = getSightsByCity(city ? city.name : cityName);
    if (sights.length === 0) {
      throw new Error(`内置数据暂未收录「${cityName}」`);
    }
    return sights;
  },
};

// ---------------------------------------------------------------------------
// 缓存
// ---------------------------------------------------------------------------

const CACHE_TTL_MS = 30 * 60 * 1000; // 30 分钟
const cache = new Map(); // key: city名 -> { sights, expireAt }

function cacheGet(key) {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expireAt) {
    cache.delete(key);
    return null;
  }
  return entry.sights;
}

function cacheSet(key, sights) {
  cache.set(key, { sights, expireAt: Date.now() + CACHE_TTL_MS });
}

// ---------------------------------------------------------------------------
// 熔断器
// ---------------------------------------------------------------------------

const BREAK_THRESHOLD = 3;      // 连续失败次数阈值
const BREAK_COOLDOWN_MS = 10 * 60 * 1000; // 熔断冷却时间

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
    b.fails = 0; // 冷却结束后重新计数
  }
  breakers.set(sourceName, b);
}

function recordSuccess(sourceName) {
  breakers.delete(sourceName);
}

// ---------------------------------------------------------------------------
// 综合排序：热度 + 评分
// ---------------------------------------------------------------------------

/**
 * 计算综合得分（0-100）。
 * 热度占 60%，评分占 40%；缺失的字段用中性值兜底。
 */
function computeScore(sight, index, total) {
  // 热度：直接用 popularity；缺失时按列表位置线性递减（越靠前越热门）
  let popularity = sight.popularity;
  if (!Number.isFinite(popularity) || popularity == null) {
    popularity = total > 1 ? Math.round(95 - (index / (total - 1)) * 45) : 70; // 95 -> 50
  }
  // 评分：缺失时用 4.0 中性值
  let rating = sight.rating;
  if (!Number.isFinite(rating) || rating == null) {
    rating = 4.0;
  }
  const score = popularity * 0.6 + (rating / 5) * 100 * 0.4;
  return Math.round(score * 10) / 10;
}

/** 排序并补充综合得分与推荐标记 */
function rankSights(sights) {
  return sights
    .map((s, i) => ({ ...s, score: computeScore(s, i, sights.length) }))
    .sort((a, b) => b.score - a.score)
    .map((s, i) => ({
      ...s,
      rank: i + 1,
      recommended: s.recommended || s.score >= 80,
    }));
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/** 解析强制指定的数据源 */
function getForcedSource() {
  const forced = (process.env.SIGHT_SOURCE || '').trim().toLowerCase();
  if (!forced) return null;
  if (forced === 'local') return localSource;
  return SOURCES.find((s) => s.meta.name === forced) || null;
}

/** 列出各数据源可用性（供前端展示与诊断） */
function getSourceStatus() {
  const list = SOURCES.map((s) => ({
    name: s.meta.name,
    label: s.meta.label,
    configured: s.isConfigured(),
    broken: isBroken(s.meta.name),
  }));
  list.push({
    name: localSource.meta.name,
    label: localSource.meta.label,
    configured: true,
    broken: false,
  });
  return list;
}

/**
 * 搜索城市景点（带缓存 + 降级链）。
 * @param {string} cityName 城市名（支持中文或拼音，内部会归一化）
 * @returns {Promise<{city: string, source: string, sourceLabel: string, count: number, sights: Array}>}
 */
async function searchSights(cityName) {
  const city = findCity(cityName);
  const canonicalName = city ? city.name : cityName;

  // 命中缓存直接返回
  const cached = cacheGet(canonicalName);
  if (cached) {
    return { ...cached, cached: true };
  }

  // 组装尝试顺序：强制指定 > 降级链
  const forced = getForcedSource();
  const chain = [];
  if (forced) {
    chain.push(forced);
  } else {
    for (const s of SOURCES) {
      if (s.isConfigured() && !isBroken(s.meta.name)) chain.push(s);
    }
    chain.push(localSource); // 兜底永远在最后
  }

  const errors = [];
  for (const source of chain) {
    try {
      const raw = await source.searchSights(canonicalName);
      const sights = rankSights(raw);
      const result = {
        city: canonicalName,
        source: source.meta.name,
        sourceLabel: source.meta.label,
        count: sights.length,
        sights,
        cached: false,
      };
      recordSuccess(source.meta.name);
      cacheSet(canonicalName, result);
      return result;
    } catch (err) {
      recordFailure(source.meta.name);
      errors.push(`[${source.meta.name}] ${err.message}`);
    }
  }

  throw new Error(`所有景点数据源均失败: ${errors.join(' | ')}`);
}

module.exports = { searchSights, getSourceStatus };
