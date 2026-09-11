'use strict';

/**
 * LLM Agent 景点数据源（可选）。
 * 兼容 OpenAI Chat Completions 协议，默认对接智谱 GLM（glm-4-flash 免费模型）。
 * 通过提示词让模型输出结构化 JSON 景点列表。
 *
 * 配置来源（优先级从高到低）：
 *   1. 设置页面保存的 .settings.json
 *   2. 环境变量 .env：LLM_API_KEY / LLM_BASE_URL / LLM_MODEL
 */

const { findCity } = require('../data/cities');
const settings = require('../lib/settings');

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

/** 构造提示词：要求模型输出严格 JSON */
function buildPrompt(cityName) {
  const city = findCity(cityName);
  const region = city ? city.name : cityName;
  return `你是一位专业的中国旅行规划师。请列出「${region}」最值得游览的景点，要求：

1. 数量 25-30 个，按热门程度从高到低排列，严禁少于 20 个；
2. 覆盖该城市最具代表性的地标、历史古迹、自然风光、博物馆、主题乐园等类型；
3. 评分 rating 为 0-5 的数字（参考大众点评/携程等平台的大致水平）；
4. 热度 popularity 为 0-100 的整数，表示游客关注程度；
5. 门票 ticket、开放时间 openTime、建议游览时长 visitHours 尽量准确，不确定时写"以现场公示为准"；
6. 简介 desc 控制在 40 字以内，突出亮点。

只输出一个 JSON 对象（json 模式），不要任何解释文字，格式如下：
{
  "sights": [
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
  ]
}
其中 sights 数组必须包含 8-10 个景点对象，禁止只输出单个景点。`;
}

/**
 * 从模型输出中提取 JSON 数组。
 * 兼容多种输出形态：
 *   1. 裸数组 [...]（理想情况）
 *   2. markdown 代码块包裹 ```json [...] ```
 *   3. 对象包裹（json_object 模式下模型必须输出对象）：
 *      {"name": "json_object", "data": [...]} / {"sights": [...]} 等
 *      → 取第一个「元素为对象且含 name 类字段」的数组
 *   4. 兜底：截取第一个 [ 到最后一个 ] 之间再解析
 */
function extractJsonArray(text) {
  if (!text) return null;
  const stripped = text.replace(/```(?:json)?/gi, '').trim();

  // 整体作为 JSON 解析
  try {
    const parsed = JSON.parse(stripped);
    if (Array.isArray(parsed)) return parsed;
    if (parsed && typeof parsed === 'object') {
      const arrays = Object.values(parsed).filter((v) => Array.isArray(v) && v.length > 0);
      // 优先取元素为对象且含 name 类字段的数组（跳过 tags 等字符串数组）
      const good = arrays.find(
        (a) => a[0] && typeof a[0] === 'object' && (a[0].name || a[0].名称 || a[0].景点名称)
      );
      if (good) return good;
      if (arrays.length > 0) return arrays[0];
      // 模型偶发只输出单个景点对象（无包裹数组）：包成数组返回
      if (pick(parsed, 'name', '名称', '景点名称')) return [parsed];
    }
  } catch {
    /* 整体解析失败，走兜底截取 */
  }

  // 兜底：第一个 [ 到最后一个 ]
  const start = stripped.indexOf('[');
  const end = stripped.lastIndexOf(']');
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

/** 校验并归一化单条景点数据 */
function normalizeItem(item) {
  if (!item || typeof item !== 'object') return null;
  const name = pick(item, 'name', '名称', '景点名称');
  if (!name) return null;
  const rating = Number(pick(item, 'rating', '评分'));
  const popularity = Number(pick(item, 'popularity', '热度'));
  const tags = pick(item, 'tags', '标签');
  return {
    name: String(name),
    rating: Number.isFinite(rating) ? Math.min(5, Math.max(0, rating)) : null,
    popularity: Number.isFinite(popularity) ? Math.min(100, Math.max(0, Math.round(popularity))) : null,
    type: String(pick(item, 'type', '类型') || '景点'),
    ticket: String(pick(item, 'ticket', '门票') || '以现场公示为准'),
    openTime: String(pick(item, 'openTime', '开放时间') || '以现场公示为准'),
    visitHours: pick(item, 'visitHours', '建议时长', '游览时长') ? String(pick(item, 'visitHours', '建议时长', '游览时长')) : null,
    address: String(pick(item, 'address', '地址') || ''),
    desc: String(pick(item, 'desc', '简介', '描述') || ''),
    tags: Array.isArray(tags) ? tags.map(String).slice(0, 5) : [],
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
  const { baseUrl, apiKey, model } = getConfig();
  if (!apiKey) {
    throw new Error('AI 数据源未配置 API Key，请先在「设置」页面配置');
  }
  const city = findCity(cityName);
  const region = city ? city.name : cityName;

  const body = {
    model,
    messages: [
      {
        role: 'user',
        content: buildPrompt(region),
      },
    ],
    temperature: 0.3,
    // 预留充足输出空间：25-30 个景点 JSON 较大，8192 常被截断（finish_reason=length），
    // 16384 已实测被接口接受且输出完整；过低会导致景点数量不足或 JSON 解析失败
    max_tokens: 16384,
    // 关闭思考模式：deepseek 系推理模型会把 token 预算耗在 reasoning_content 上，
    // 导致最终 content 被截断甚至为空；关闭后全部预算用于生成景点 JSON
    thinking: { type: 'disabled' },
    // 智谱 GLM 支持 response_format（部分模型）；不支持时服务端会忽略
    response_format: { type: 'json_object' },
  };

  const res = await fetchWithTimeout(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
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
    throw new Error(`LLM 输出无法解析为景点列表（原始输出前 200 字：${String(content).slice(0, 200)}）`);
  }

  const sights = arr.map(normalizeItem).filter(Boolean);
  if (sights.length === 0) {
    const first = arr[0];
    const shape = first && typeof first === 'object' ? `对象，键：${Object.keys(first).join('/')}` : typeof first;
    throw new Error(`LLM 输出的景点数据无效（共 ${arr.length} 条，首条为${shape}；原始输出前 200 字：${String(content).slice(0, 200)}）`);
  }
  return sights;
}

module.exports = { meta, isConfigured, searchSights };
