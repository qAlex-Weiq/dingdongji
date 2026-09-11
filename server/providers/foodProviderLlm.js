'use strict';

/**
 * LLM Agent 美食数据源（可选）。
 * 兼容 OpenAI Chat Completions 协议，默认对接智谱 GLM（glm-4-flash 免费模型）。
 * 通过提示词让模型输出结构化 JSON，归一化为与本地数据源相同的字段结构。
 *
 * 三个能力（与 foodProvider 本地实现同构）：
 *   - searchSpecialties(cityName, category) 特色菜品列表
 *   - searchRestaurants(cityName, filters)  餐厅筛选列表
 *   - personalize(cityName, query)          个性化推荐
 *
 * 配置来源（优先级从高到低）：
 *   1. 设置页面保存的 .settings.json
 *   2. 环境变量 .env：LLM_API_KEY / LLM_BASE_URL / LLM_MODEL
 */

const { findCity } = require('../data/cities');
const settings = require('../lib/settings');

// ---- 时间工具（与 foodProvider._internal 同构，独立实现避免循环依赖）----
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

function isOpenAt(hours, atMin) {
  const open = hhmmToMin(hours.open);
  const close = hhmmToMin(hours.close);
  if (open === null || close === null) return false;
  if (open < close) return atMin >= open && atMin <= close;
  return atMin >= open || atMin <= close;
}

const meta = {
  name: 'llm',
  label: 'AI 智能生成',
  requiresKey: 'LLM_API_KEY',
};

/** 获取生效配置（设置页优先，环境变量兜底） */
function getConfig() {
  const eff = settings.getEffective();
  return {
    baseUrl: (eff.llmBaseUrl || '').replace(/\/+$/, ''),
    apiKey: (eff.llmApiKey || '').trim(),
    model: eff.llmModel || 'glm-4-flash',
  };
}

function isConfigured() {
  return Boolean(getConfig().apiKey);
}

async function fetchWithTimeout(url, options, timeoutMs = 90000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

function regionName(cityName) {
  const city = findCity(cityName);
  return city ? city.name : cityName;
}

function buildSpecialtiesPrompt(cityName, category) {
  const cat = category && category !== '全部' ? `，限定分类为「${category}」` : '';
  return `你是一位专业的中国美食向导。请列出「${regionName(cityName)}」最具代表性的特色菜品${cat}，要求：

1. 数量 8-12 道，按知名程度从高到低排列；
2. category 为分类：主食 / 小吃 / 汤羹 / 凉菜 / 甜品 / 饮品 之一；
3. intro 一句话介绍风味特点（40 字以内）；culture 说明来历典故（40 字以内）；
4. season 为最佳品尝季节，如「四季皆宜」「秋冬最佳」；
5. tags 为 2-4 个标签，如 甜辣 / 老字号 / 街头小吃；
6. availableRestaurants 为该城市可吃到这道菜的大致餐厅数量（整数，10-80 之间）。

只输出一个 JSON 对象（json 模式），不要任何解释文字，格式如下：
{
  "specialties": [
    {
      "name": "菜品名",
      "category": "小吃",
      "intro": "一句话介绍",
      "culture": "来历典故",
      "season": "四季皆宜",
      "tags": ["标签1", "标签2"],
      "availableRestaurants": 35
    }
  ]
}
其中 specialties 数组必须包含 8-12 个菜品对象，禁止只输出单个菜品。`;
}

function buildRestaurantsPrompt(cityName, filters) {
  const cond = [];
  if (filters.cuisines && filters.cuisines.length) cond.push(`菜系限定：${filters.cuisines.join('、')}`);
  if (filters.priceMin > 0 || filters.priceMax < Number.MAX_SAFE_INTEGER) {
    cond.push(`人均消费区间：${filters.priceMin || 0}-${filters.priceMax === Number.MAX_SAFE_INTEGER ? '不限' : filters.priceMax} 元`);
  }
  if (filters.slot) cond.push(`用餐时段须供应：${filters.slot}`);
  if (filters.openNow) cond.push('当前正在营业');
  const condText = cond.length ? `\n筛选条件（必须全部满足）：\n${cond.map((c) => `- ${c}`).join('\n')}` : '';

  return `你是一位专业的中国美食向导。请列出「${regionName(cityName)}」值得去的餐厅${condText}，要求：

1. 数量 8-10 家，按评分从高到低排列；均为该城市真实存在、口碑较好的餐厅（可带分店名）；
2. cuisines 为菜系数组（如 川菜 / 火锅 / 小吃）；avgPrice 为人均消费（整数元）；priceMin/priceMax 为大致区间；
3. open/close 为营业时间（HH:MM 格式，跨夜门店 close 可小于 open）；slots 为供应时段数组（早餐/午餐/下午茶/晚餐/夜宵）；
4. rating 为 0-5 评分（参考大众点评水平，保留 1 位小数）；reviewCount 为评价数量（整数）；
5. address 为大致地址；district 为所在区；nearLandmark 为相对市中心/地标的位置描述（如「距春熙路约 1 km」）；
6. tags 为 2-4 个特色标签；signatureDishes 为 2-4 道招牌菜；reservation 为是否支持预订（true/false）。

只输出一个 JSON 对象（json 模式），不要任何解释文字，格式如下：
{
  "restaurants": [
    {
      "name": "餐厅名（含分店）",
      "cuisines": ["川菜", "火锅"],
      "avgPrice": 120,
      "priceMin": 80,
      "priceMax": 200,
      "open": "11:00",
      "close": "02:00",
      "slots": ["午餐", "晚餐", "夜宵"],
      "rating": 4.6,
      "reviewCount": 22000,
      "address": "大致地址",
      "district": "所在区",
      "nearLandmark": "距春熙路约 1 km",
      "tags": ["老字号", "排队"],
      "signatureDishes": ["招牌菜1", "招牌菜2"],
      "reservation": true
    }
  ]
}
其中 restaurants 数组必须包含 8-10 个餐厅对象，禁止只输出单个餐厅。`;
}

function buildPersonalizePrompt(cityName, query) {
  return `你是一位专业的中国美食向导。游客将在「${regionName(cityName)}」用餐，需求描述如下：

「${query}」

请分两步输出：

第一步 parsed：从需求中识别关键偏好，每项 {key, hint, type}，type ∈ taste(口味)/companion(同行人)/slot(时段)/facility(设施)/price(价位)；
第二步 recommendations：推荐 5-6 家符合需求的餐厅（该城市真实存在、口碑较好，可带分店名），restaurant 字段结构完整（与大众点评信息一致），score 为 0-100 的匹配度整数，reason 为一句推荐理由（20 字以内，需点明匹配的需求点，如「人均符合预算；适合朋友聚餐」）。

只输出一个 JSON 对象（json 模式），不要任何解释文字，格式如下：
{
  "parsed": [
    { "key": "辣", "hint": "麻辣口味", "type": "taste" }
  ],
  "recommendations": [
    {
      "restaurant": {
        "name": "餐厅名（含分店）",
        "cuisines": ["川菜", "火锅"],
        "avgPrice": 120,
        "priceMin": 80,
        "priceMax": 200,
        "open": "11:00",
        "close": "02:00",
        "slots": ["午餐", "晚餐", "夜宵"],
        "rating": 4.6,
        "reviewCount": 22000,
        "address": "大致地址",
        "district": "所在区",
        "nearLandmark": "距春熙路约 1 km",
        "tags": ["深夜聚餐", "辣"],
        "signatureDishes": ["招牌菜1", "招牌菜2"],
        "reservation": true
      },
      "score": 95,
      "reason": "人均符合预算；适合朋友聚餐"
    }
  ]
}
recommendations 必须包含 5-6 个推荐对象。`;
}

// ---------------------------------------------------------------------------
// 输出解析与归一化
// ---------------------------------------------------------------------------

/** 从模型输出中提取 JSON 对象（或数组） */
function extractJson(text) {
  if (!text) return null;
  const stripped = text.replace(/```(?:json)?/gi, '').trim();

  try {
    const parsed = JSON.parse(stripped);
    if (parsed && typeof parsed === 'object') return parsed;
  } catch {
    /* 走兜底 */
  }

  // 兜底：第一个 { 到最后一个 }
  const start = stripped.indexOf('{');
  const end = stripped.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 从条目中按别名取字段（兼容模型偶发使用中文键名） */
function pick(item, ...keys) {
  for (const k of keys) {
    const v = item[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return undefined;
}

function normalizeNumber(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function normalizeTags(v, max = 5) {
  if (Array.isArray(v)) return v.map(String).filter(Boolean).slice(0, max);
  if (typeof v === 'string' && v) return v.split(/[、,，\s]+/).filter(Boolean).slice(0, max);
  return [];
}

function normalizeHours(v) {
  const open = String(pick(v, 'open', '营业开始', '开始营业') || '10:00');
  const close = String(pick(v, 'close', '营业结束', '结束营业') || '22:00');
  const openMin = hhmmToMin(open);
  const closeMin = hhmmToMin(close);
  const at = nowMin();
  const slots = normalizeTags(pick(v, 'slots', '时段', '供应时段'), 5);
  return {
    open: hhmmToMin(open) === null ? '10:00' : open,
    close: hhmmToMin(close) === null ? '22:00' : close,
    isOpenNow: openMin !== null && closeMin !== null ? isOpenAt({ open, close }, at) : false,
    slots: slots.length ? slots : ['午餐', '晚餐'],
  };
}

function normalizeRestaurant(item) {
  if (!item || typeof item !== 'object') return null;
  const name = pick(item, 'name', '名称', '餐厅名称');
  if (!name) return null;
  const avgPrice = normalizeNumber(pick(item, 'avgPrice', '人均', '人均消费'), 80);
  const priceMin = normalizeNumber(pick(item, 'priceMin', '人均下限'), Math.max(0, Math.round(avgPrice * 0.6)));
  const priceMax = normalizeNumber(pick(item, 'priceMax', '人均上限'), Math.round(avgPrice * 1.5));
  const rating = normalizeNumber(pick(item, 'rating', '评分'), 4.5);
  return {
    id: `llm-${String(name).replace(/\s+/g, '').slice(0, 20)}-${Math.abs(String(name).length * 31 + Math.round(avgPrice))}`,
    name: String(name),
    cuisines: normalizeTags(pick(item, 'cuisines', '菜系'), 4),
    avgPrice: Math.max(0, Math.round(avgPrice)),
    priceRange: `¥${Math.round(priceMin)}–${Math.round(priceMax)}`,
    location: {
      address: String(pick(item, 'address', '地址') || '以门店公示为准'),
      district: String(pick(item, 'district', '区域', '所在区') || ''),
      nearLandmark: String(pick(item, 'nearLandmark', '地标', '位置') || ''),
    },
    hours: normalizeHours(item),
    rating: Math.min(5, Math.max(0, Math.round(rating * 10) / 10)),
    reviewCount: Math.max(0, Math.round(normalizeNumber(pick(item, 'reviewCount', '评价数', '评论数'), 1000))),
    tags: normalizeTags(pick(item, 'tags', '标签'), 4),
    signatureDishes: normalizeTags(pick(item, 'signatureDishes', '招牌菜', '推荐菜'), 4),
    reservation: Boolean(pick(item, 'reservation', '预订', '支持预订')),
  };
}

function normalizeSpecialty(item) {
  if (!item || typeof item !== 'object') return null;
  const name = pick(item, 'name', '名称', '菜品名称');
  if (!name) return null;
  return {
    id: `llm-${String(name).slice(0, 20)}`,
    name: String(name),
    category: String(pick(item, 'category', '分类') || '小吃'),
    intro: String(pick(item, 'intro', '介绍', '简介') || ''),
    culture: String(pick(item, 'culture', '典故', '来历') || ''),
    season: String(pick(item, 'season', '季节', '最佳季节') || '四季皆宜'),
    tags: normalizeTags(pick(item, 'tags', '标签'), 4),
    availableRestaurants: Math.min(80, Math.max(10, Math.round(normalizeNumber(pick(item, 'availableRestaurants', '可尝店铺'), 30)))),
  };
}

// ---------------------------------------------------------------------------
// 调用 LLM
// ---------------------------------------------------------------------------

async function callLlm(prompt) {
  const { baseUrl, apiKey, model } = getConfig();
  if (!apiKey) {
    throw new Error('AI 数据源未配置 API Key，请先在「设置」页面配置');
  }

  const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      messages: [
        { role: 'system', content: '你是严谨的美食数据助手，只输出符合要求的 JSON，不输出任何解释。' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.7,
    }),
  });

  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`LLM 接口请求失败（HTTP ${res.status}）：${body.slice(0, 200)}`);
  }

  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error('LLM 返回内容为空');
  }
  return content;
}

// ---------------------------------------------------------------------------
// 对外接口
// ---------------------------------------------------------------------------

async function searchSpecialties(cityName, category) {
  const content = await callLlm(buildSpecialtiesPrompt(cityName, category));
  const parsed = extractJson(content);
  const arr = parsed && Array.isArray(parsed.specialties) ? parsed.specialties : (Array.isArray(parsed) ? parsed : null);
  if (!arr || !Array.isArray(arr) || arr.length === 0) {
    throw new Error(`LLM 输出无法解析为菜品列表（原始输出前 200 字：${String(content).slice(0, 200)}）`);
  }
  const items = arr.map(normalizeSpecialty).filter(Boolean);
  if (items.length === 0) {
    throw new Error(`LLM 输出的菜品数据无效（共 ${arr.length} 条）`);
  }
  items.sort((a, b) => (b.availableRestaurants - a.availableRestaurants) || a.id.localeCompare(b.id));
  return items;
}

async function searchRestaurants(cityName, filters = {}) {
  const content = await callLlm(buildRestaurantsPrompt(cityName, filters));
  const parsed = extractJson(content);
  const arr = parsed && Array.isArray(parsed.restaurants) ? parsed.restaurants : (Array.isArray(parsed) ? parsed : null);
  if (!arr || !Array.isArray(arr) || arr.length === 0) {
    throw new Error(`LLM 输出无法解析为餐厅列表（原始输出前 200 字：${String(content).slice(0, 200)}）`);
  }
  const items = arr.map(normalizeRestaurant).filter(Boolean);
  if (items.length === 0) {
    throw new Error(`LLM 输出的餐厅数据无效（共 ${arr.length} 条）`);
  }
  const sort = filters.sort || 'rating';
  if (sort === 'priceAsc') items.sort((a, b) => a.avgPrice - b.avgPrice);
  else if (sort === 'priceDesc') items.sort((a, b) => b.avgPrice - a.avgPrice);
  else if (sort === 'openFirst') items.sort((a, b) => {
    if (a.hours.isOpenNow !== b.hours.isOpenNow) return a.hours.isOpenNow ? -1 : 1;
    return b.rating - a.rating;
  });
  else items.sort((a, b) => (b.rating - a.rating) || (b.reviewCount - a.reviewCount));
  return items;
}

async function personalize(cityName, query) {
  const content = await callLlm(buildPersonalizePrompt(cityName, query));
  const parsed = extractJson(content);
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`LLM 输出无法解析为推荐结果（原始输出前 200 字：${String(content).slice(0, 200)}）`);
  }

  const rawParsed = Array.isArray(parsed.parsed) ? parsed.parsed : [];
  const parsedItems = rawParsed
    .filter((p) => p && typeof p === 'object')
    .map((p) => ({
      key: String(pick(p, 'key', '关键词') || ''),
      matched: true,
      hint: String(pick(p, 'hint', '说明') || ''),
      type: String(pick(p, 'type', '类型') || 'other'),
    }))
    .filter((p) => p.key);

  const rawRecs = Array.isArray(parsed.recommendations) ? parsed.recommendations : [];
  const recommendations = rawRecs
    .map((r) => {
      const restaurant = normalizeRestaurant(pick(r, 'restaurant', '餐厅') || r);
      if (!restaurant) return null;
      const score = Math.min(100, Math.max(0, Math.round(normalizeNumber(pick(r, 'score', '匹配度', '分数'), 80))));
      const reason = String(pick(r, 'reason', '推荐理由', '理由') || `评分 ${restaurant.rating}，口碑不错`);
      return { restaurant, score, reason };
    })
    .filter(Boolean);

  if (recommendations.length === 0) {
    throw new Error(`LLM 输出的推荐数据无效（共 ${rawRecs.length} 条）`);
  }
  recommendations.sort((a, b) => b.score - a.score);

  return { parsed: parsedItems, recommendations, hint: null };
}

module.exports = { meta, isConfigured, searchSpecialties, searchRestaurants, personalize };
