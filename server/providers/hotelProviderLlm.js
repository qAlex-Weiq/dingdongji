'use strict';

/**
 * LLM Agent 酒店数据源（可选）。
 * 兼容 OpenAI Chat Completions 协议，默认对接智谱 GLM（glm-4-flash 免费模型）。
 * 通过提示词让模型结合「价格档位 + 位置偏好」输出结构化 JSON 酒店列表。
 *
 * 配置来源（优先级从高到低）：
 *   1. 设置页面保存的 .settings.json
 *   2. 环境变量 .env：LLM_API_KEY / LLM_BASE_URL / LLM_MODEL
 */

const settings = require('../lib/settings');
const { TIERS, tierRangeText, locationText, tierFromPrice } = require('../lib/hotelPrefs');

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
    webSearch: process.env.LLM_WEB_SEARCH === '1',
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
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error(`LLM 请求超时（${Math.round(timeoutMs / 1000)} 秒），请稍后重试或检查接口地址`);
    }
    throw new Error(`LLM 请求失败：${err.message}（请检查 API 地址与网络连通性）`);
  } finally {
    clearTimeout(timer);
  }
}

/** 构造提示词：结合价格档位与位置偏好，要求输出严格 JSON */
function buildPrompt(cityName, prefs) {
  const tier = prefs.tier || 'any';
  const location = prefs.location || 'any';
  return `你是一位专业的中国旅行酒店顾问。请为「${cityName}」推荐酒店，要求：

1. 数量 8-10 家，按热门程度从高到低排列；
2. 价格档位：${tierRangeText(tier)}，推荐的酒店 price 需落在该区间；
3. 位置偏好：${locationText(location)}，优先推荐符合位置偏好的酒店，不足时可用交通便利的替代；
4. tier 字段取值只能是：经济型 / 舒适型 / 高档型 / 豪华型；
5. price 为每晚参考均价（元，整数），须符合该档位在国内的真实行情，不确定时给保守估值，禁止编造极端价格（如 1 元或 99999 元）；rating 为 0-5 一位小数；popularity 为 0-100 整数；
6. tags 包含位置标签（市中心 / 近地铁 / 近火车站 / 近机场 / 景点周边，按实际情况选取）与特色标签；
7. address 尽量给到区级或地标级位置；desc 为 40 字以内的推荐理由；
8. 只推荐真实存在、知名度较高的酒店，不要虚构名称。

只输出 JSON，不要输出任何其他文字，格式：
{"hotels":[{"name":"酒店名","rating":4.7,"popularity":85,"tier":"舒适型","price":450,"address":"xx区xx路","desc":"推荐理由","tags":["市中心","近地铁"]}]}`;
}

/** 从模型输出中提取 JSON 数组（容忍 ```json 包裹） */
function extractJsonArray(text) {
  const content = String(text || '').trim();
  const fenceMatch = content.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const raw = fenceMatch ? fenceMatch[1] : content;
  const start = raw.indexOf('{');
  const objStart = start >= 0 ? start : raw.indexOf('[');
  if (objStart < 0) return null;
  const objEnd = Math.max(raw.lastIndexOf('}'), raw.lastIndexOf(']'));
  if (objEnd <= objStart) return null;
  try {
    const parsed = JSON.parse(raw.slice(objStart, objEnd + 1));
    if (Array.isArray(parsed)) return parsed;
    if (Array.isArray(parsed.hotels)) return parsed.hotels;
    return null;
  } catch {
    return null;
  }
}

/** 从对象中按候选键名取第一个存在的值 */
function pick(obj, keys) {
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
  }
  return undefined;
}

/** LLM 输出条目 → 标准酒店对象（档位非法时按价格反推） */
function normalizeItem(item) {
  if (!item || typeof item !== 'object') return null;
  const name = String(pick(item, ['name', '名称', '酒店名']) || '').trim();
  if (!name) return null;

  const rating = Number(pick(item, ['rating', '评分']));
  const popularity = Number(pick(item, ['popularity', '热度']));
  const price = Number(pick(item, ['price', '价格', '均价']));

  let tier = String(pick(item, ['tier', '档位', '类型']) || '').trim();
  if (!['经济型', '舒适型', '高档型', '豪华型'].includes(tier)) {
    tier = tierFromPrice(price) || '舒适型';
  }

  const tags = Array.isArray(item.tags)
    ? item.tags.map((t) => String(t).trim()).filter(Boolean)
    : [];

  return {
    name,
    rating: Number.isFinite(rating) ? Math.min(5, Math.max(0, Number(rating.toFixed(1)))) : null,
    popularity: Number.isFinite(popularity) ? Math.min(100, Math.max(0, Math.round(popularity))) : null,
    tier,
    // 价格真实性防线：<=50 或 >50000 视为模型幻觉置 null；
    // 其余按档位区间放宽 20% 裁剪（与 priceInTierLoose 口径一致）
    price: normalizeTierPrice(price, tier),
    address: String(pick(item, ['address', '地址']) || '地址待补全').trim(),
    desc: String(pick(item, ['desc', '简介', '推荐理由']) || '').trim(),
    tags,
    recommended: false,
    photo: null,
    location: null,
  };
}

/**
 * 生成酒店列表。
 * @param {string} cityName 城市名（规范中文）
 * @param {{tier?: string, location?: string}} prefs 偏好（见 lib/hotelPrefs）
 * @returns {Promise<Array>} 标准酒店列表（未排序）
 */
async function searchHotels(cityName, prefs = {}) {
  const cfg = getConfig();
  if (!cfg.apiKey) {
    throw new Error('未配置 LLM API Key（LLM_API_KEY），请在设置页面填写后重试');
  }

  const body = {
    model: cfg.model,
    messages: [
      { role: 'user', content: buildPrompt(cityName, prefs) },
    ],
    temperature: 0.6,
  };
  // 智谱等支持 web_search 工具的模型可开启联网检索（更准但更慢）
  if (cfg.webSearch) {
    body.tools = [{ type: 'web_search', web_search: { enable: true, searchResult: false } }];
  }

  const res = await fetchWithTimeout(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.apiKey}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`LLM 接口 HTTP ${res.status}${detail ? `：${detail.slice(0, 120)}` : ''}`);
  }
  const data = await res.json();
  const content =
    (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';

  const arr = extractJsonArray(content);
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error(`LLM 输出无法解析为酒店列表（原始输出前 200 字：${String(content).slice(0, 200)}）`);
  }

  const hotels = arr.map(normalizeItem).filter(Boolean);
  if (hotels.length === 0) {
    throw new Error(`LLM 输出的酒店数据无效（共 ${arr.length} 条）`);
  }

  // 档位二次校验：价格明显偏离档位区间的条目剔除（宽松策略，仅剔除价格已知且不符的）
  const tier = prefs.tier || 'any';
  if (tier !== 'any') {
    const filtered = hotels.filter((h) => h.price === null || priceInTierLoose(h.price, tier));
    return filtered.length >= 3 ? filtered : hotels;
  }
  return hotels;
}

/** 中文档位标签 -> 英文 key（TIERS 以英文 key 存档位区间） */
const TIER_KEY_BY_LABEL = Object.fromEntries(Object.entries(TIERS).map(([k, t]) => [t.label, k]));

/** 价格真实性防线：极端值置 null，其余按档位区间（放宽 20%）裁剪 */
function normalizeTierPrice(price, tierLabel) {
  if (!Number.isFinite(price) || price <= 50 || price > 50000) return null;
  const t = TIERS[TIER_KEY_BY_LABEL[tierLabel]] || TIERS.any;
  let min = 0;
  let max = Infinity;
  if (t.min > 0) min = Math.round(t.min * 0.8);
  if (Number.isFinite(t.max)) max = Math.round(t.max * 1.2);
  return Math.round(Math.min(max, Math.max(min, price)));
}

/** 宽松档位匹配：允许 20% 越界（LLM 价格为估算值，避免过度剔除） */
function priceInTierLoose(price, tier) {
  const t = TIERS[tier];
  const margin = Math.max(t.min, t.max === Infinity ? 1e9 : t.max) * 0.2;
  const min = t.min === 0 ? 0 : t.min - margin;
  const max = t.max === Infinity ? Infinity : t.max + margin;
  return price >= min && price < max;
}

module.exports = { meta, isConfigured, searchHotels, _internal: { normalizeTierPrice } };
