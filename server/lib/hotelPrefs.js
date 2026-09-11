'use strict';

/**
 * 酒店模块共享偏好定义（价格档位 & 位置偏好）。
 * 前端选项 → 后端过滤参数 / LLM 提示词 的单一事实来源，
 * 各数据源（高德 / LLM / 内置）统一按这里的区间与标签工作。
 */

/** 价格档位（每晚参考均价区间，元，左闭右开） */
const TIERS = {
  any: { label: '不限', min: 0, max: Infinity },
  budget: { label: '经济型', min: 0, max: 300 },
  comfort: { label: '舒适型', min: 300, max: 600 },
  upscale: { label: '高档型', min: 600, max: 1000 },
  luxury: { label: '豪华型', min: 1000, max: Infinity },
};

/** 位置偏好 → 内置数据的匹配标签（近地铁并入市中心维度） */
const LOCATIONS = {
  any: { label: '不限', tags: [] },
  downtown: { label: '市中心', tags: ['市中心', '近地铁'] },
  station: { label: '火车站周边', tags: ['近火车站'] },
  airport: { label: '机场周边', tags: ['近机场'] },
  scenic: { label: '景点周边', tags: ['景点周边'] },
};

const TIER_KEYS = Object.keys(TIERS);
const LOCATION_KEYS = Object.keys(LOCATIONS);

function isValidTier(v) {
  return TIER_KEYS.includes(v);
}

function isValidLocation(v) {
  return LOCATION_KEYS.includes(v);
}

/** 归一化档位参数（非法值回退 any） */
function normalizeTier(v) {
  return isValidTier(v) ? v : 'any';
}

/** 归一化位置参数（非法值回退 any） */
function normalizeLocation(v) {
  return isValidLocation(v) ? v : 'any';
}

/** 价格是否落在指定档位区间（价格未知视为不匹配） */
function priceInTier(price, tier) {
  if (tier === 'any') return true;
  if (!Number.isFinite(price)) return false;
  const t = TIERS[tier];
  return price >= t.min && price < t.max;
}

/** 由每晚价格反推档位标签（用于高德/LLM 数据补全档位） */
function tierFromPrice(price) {
  if (!Number.isFinite(price)) return null;
  for (const key of TIER_KEYS) {
    if (key === 'any') continue;
    const t = TIERS[key];
    if (price >= t.min && price < t.max) return t.label;
  }
  return null;
}

/** 档位区间的人类可读描述（用于 LLM 提示词与错误提示） */
function tierRangeText(tier) {
  if (tier === 'any') return '不限价格';
  const t = TIERS[tier];
  if (!Number.isFinite(t.max)) return `${t.label}（${t.min} 元以上/晚）`;
  if (t.min === 0) return `${t.label}（${t.max} 元以内/晚）`;
  return `${t.label}（${t.min}-${t.max} 元/晚）`;
}

/** 位置偏好的人类可读描述（用于 LLM 提示词） */
function locationText(location) {
  if (location === 'any') return '位置不限';
  return LOCATIONS[location].label;
}

module.exports = {
  TIERS,
  LOCATIONS,
  isValidTier,
  isValidLocation,
  normalizeTier,
  normalizeLocation,
  priceInTier,
  tierFromPrice,
  tierRangeText,
  locationText,
};
