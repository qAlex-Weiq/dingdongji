'use strict';

/**
 * LLM Agent 景点数据源（可选）。
 * 兼容 OpenAI Chat Completions 协议，默认对接智谱 GLM（glm-4-flash 免费模型）。
 * 通过提示词让模型输出结构化 JSON 景点列表。
 *
 * 需要在 .env 中配置：
 *   LLM_API_KEY   - API Key（必填）
 *   LLM_BASE_URL  - 接口地址（默认智谱 https://open.bigmodel.cn/api/paas/v4）
 *   LLM_MODEL     - 模型名（默认 glm-4-flash）
 */

const { findCity } = require('../data/cities');

const meta = {
  name: 'llm',
  label: 'AI 智能生成',
  requiresKey: 'LLM_API_KEY',
};

function isConfigured() {
  return Boolean(process.env.LLM_API_KEY && process.env.LLM_API_KEY.trim());
}

function getBaseUrl() {
  return (process.env.LLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4').replace(/\/+$/, '');
}

function getModel() {
  return process.env.LLM_MODEL || 'glm-4-flash';
}

async function fetchWithTimeout(url, options, timeoutMs = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 构造提示词：要求模型输出严格 JSON */
function buildPrompt(cityName) {
  const city = findCity(cityName);
  const region = city ? city.name : cityName;
  return `你是一位专业的中国旅行规划师。请列出「${region}」最值得游览的景点，要求：

1. 数量 8-10 个，按热门程度从高到低排列；
2. 覆盖该城市最具代表性的地标、历史古迹、自然风光、博物馆、主题乐园等类型；
3. 评分 rating 为 0-5 的数字（参考大众点评/携程等平台的大致水平）；
4. 热度 popularity 为 0-100 的整数，表示游客关注程度；
5. 门票 ticket、开放时间 openTime、建议游览时长 visitHours 尽量准确，不确定时写"以现场公示为准"；
6. 简介 desc 控制在 40 字以内，突出亮点。

只输出 JSON，不要任何解释文字，格式如下：
[
  {
    "name": "景点名称",
    "rating": 4.8,
    "popularity": 95,
    "type": "分类（如 历史古迹/自然风光/博物馆/主题乐园/城市地标）",
    "ticket": "门票信息",
    "openTime": "开放时间",
    "visitHours": "建议时长",
    "address": "大致地址",
    "desc": "一句话简介",
    "tags": ["标签1", "标签2"]
  }
]`;
}

/** 从模型输出中提取 JSON 数组（容忍 markdown 代码块包裹） */
function extractJsonArray(text) {
  if (!text) return null;
  // 去掉 ```json ... ``` 包裹
  const stripped = text.replace(/```(?:json)?/gi, '').trim();
  // 找到第一个 [ 到最后一个 ] 之间的内容
  const start = stripped.indexOf('[');
  const end = stripped.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) return null;
  try {
    return JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
}

/** 校验并归一化单条景点数据 */
function normalizeItem(item) {
  if (!item || typeof item !== 'object' || !item.name) return null;
  const rating = Number(item.rating);
  const popularity = Number(item.popularity);
  return {
    name: String(item.name),
    rating: Number.isFinite(rating) ? Math.min(5, Math.max(0, rating)) : null,
    popularity: Number.isFinite(popularity) ? Math.min(100, Math.max(0, Math.round(popularity))) : null,
    type: item.type ? String(item.type) : '景点',
    ticket: item.ticket ? String(item.ticket) : '以现场公示为准',
    openTime: item.openTime ? String(item.openTime) : '以现场公示为准',
    visitHours: item.visitHours ? String(item.visitHours) : null,
    address: item.address ? String(item.address) : '',
    desc: item.desc ? String(item.desc) : '',
    tags: Array.isArray(item.tags) ? item.tags.map(String).slice(0, 5) : [],
    recommended: false,
    photo: null,
    location: null,
  };
}

/**
 * 调用 LLM 生成指定城市的景点列表。
 * @param {string} cityName 城市名
 * @returns {Promise<Array>} 景点数组
 */
async function searchSights(cityName) {
  if (!isConfigured()) {
    throw new Error('未配置 LLM_API_KEY');
  }
  const city = findCity(cityName);
  const region = city ? city.name : cityName;

  const body = {
    model: getModel(),
    messages: [
      {
        role: 'user',
        content: buildPrompt(region),
      },
    ],
    temperature: 0.3,
    // 智谱 GLM 支持 response_format（部分模型）；不支持时服务端会忽略
    response_format: { type: 'json_object' },
  };

  const res = await fetchWithTimeout(`${getBaseUrl()}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.LLM_API_KEY.trim()}`,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const errText = await res.text().catch(() => '');
    throw new Error(`LLM 接口 HTTP ${res.status}: ${errText.slice(0, 200)}`);
  }
  const data = await res.json();
  const content =
    data.choices &&
    data.choices[0] &&
    data.choices[0].message &&
    data.choices[0].message.content;
  if (!content) {
    throw new Error('LLM 未返回内容');
  }

  const arr = extractJsonArray(content);
  if (!Array.isArray(arr) || arr.length === 0) {
    throw new Error('LLM 输出无法解析为景点列表');
  }

  const sights = arr.map(normalizeItem).filter(Boolean);
  if (sights.length === 0) {
    throw new Error('LLM 输出的景点数据无效');
  }
  return sights;
}

module.exports = { meta, isConfigured, searchSights };
