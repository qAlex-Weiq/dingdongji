'use strict';

/**
 * 行程规划器：调度编排引擎 + 并行 LLM 写文案。
 *
 * 职责分工：
 *   - itinerary.js  确定性算法：景点聚类、时段编排、就近配餐、首尾锚定
 *   - planner.js    LLM 层：为每天撰写 summary；输入是编排结果，不是原始行程篮
 *
 * 这个分工意味着：LLM 不能增删或移动任何条目，只能写「今天你会去…」的导览文案。
 * 结构完全可审计，Agent 只负责语言表达。
 */

const { buildItinerary } = require('./itinerary');
const { getEffective } = require('./settings');

// ---------------------------------------------------------------------------
// LLM 单次调用（带 thinking:disabled，与 sightProviderLlm.js 保持一致）
// ---------------------------------------------------------------------------

async function llmCall(messages, maxTokens = 300) {
  const { llmBaseUrl, llmApiKey, llmModel } = getEffective();
  if (!llmApiKey) throw new Error('AI 数据源未配置 API Key');

  const res = await fetch(`${llmBaseUrl.replace(/\/+$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${llmApiKey}` },
    body: JSON.stringify({
      model: llmModel,
      messages,
      max_tokens: maxTokens,
      temperature: 0.6,
      thinking: { type: 'disabled' },
    }),
    signal: AbortSignal.timeout(15000),
  });

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`LLM 接口 HTTP ${res.status}: ${t.slice(0, 120)}`);
  }
  const data = await res.json();
  const content = data?.choices?.[0]?.message?.content;
  if (!content) throw new Error('LLM 未返回内容');
  return content.trim();
}

// ---------------------------------------------------------------------------
// 每日 summary 提示词
// ---------------------------------------------------------------------------

function buildDayPrompt(day, city) {
  const sightNames = day.slots
    .filter((s) => s.type === 'sight')
    .map((s) => s.item?.name)
    .filter(Boolean);
  const foodNames = day.slots
    .filter((s) => s.type === 'food')
    .map((s) => s.item?.name)
    .filter(Boolean);
  const district = day.district || city;

  const parts = [];
  if (sightNames.length) parts.push(`游览：${sightNames.join('、')}`);
  if (foodNames.length) parts.push(`用餐：${foodNames.join('、')}`);
  if (day.slots.find((s) => s.slot === '抵达')) parts.push('（抵达当天，节奏轻松）');
  if (day.slots.find((s) => s.slot === '返程')) parts.push('（返程日，留出赶车时间）');

  return [
    {
      role: 'user',
      content:
        `你是一名资深${city}旅行向导，用轻松自然的中文（2-3句话）写 Day ${day.day} 导览简介。` +
        `今天在${district}，${parts.join('，')}。` +
        `语气亲切，突出亮点与节奏，不要用「首先/其次/最后」等程式化词语，不要重复景点列表。`,
    },
  ];
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------

/**
 * 生成完整行程（结构 + 文案）并返回含 agent.steps 的响应对象。
 *
 * @param {{city:string, days:number, startDate?:string, items:Array, autoFill?:boolean}} input
 * @returns {Promise<object>} 与 /api/plan 直接序列化为响应的对象
 */
async function plan(input) {
  const { city, days, startDate, items, autoFill = true } = input;
  const steps = [];
  const t0 = Date.now();

  const tick = (name, detail) => {
    steps.push({ name, detail, ms: Date.now() - t0 });
  };

  // ── Step 1: 解析行程篮 ──────────────────────────────────────────────────
  tick('解析行程篮', `共 ${items.length} 项`);

  // ── Step 2: 确定性算法编排 ──────────────────────────────────────────────
  const { itinerary, warnings, stats } = buildItinerary({ city, days, startDate, items, autoFill });

  const districtList = [...new Set(itinerary.flatMap((d) => d.district.split(' / ')))].join(' · ');
  const dishBit = stats.dishes ? ` / ${stats.dishes} 特色菜→餐厅` : '';
  tick(
    '按行政区聚类',
    `${districtList}；${stats.sights} 景点 / ${stats.foods} 餐厅${dishBit} / ${stats.hotels} 酒店 / ${stats.tickets} 车次`
  );

  if (stats.suggested > 0) {
    tick('行程补全建议', `景点偏少，补充 ${stats.suggested} 个高分推荐（可逐条采纳/移除）`);
  }

  const slotSummary = itinerary
    .map((d) => `Day${d.day} ${d.slots.length} 时段·${d.hours}h`)
    .join(' / ');
  tick('编排时段与配餐', slotSummary);

  // ── Step 3: 并行 LLM 文案 ──────────────────────────────────────────────
  tick('Agent 生成每日说明', `${days} 天并行调用`);

  const summaries = await Promise.all(
    itinerary.map((day) =>
      llmCall(buildDayPrompt(day, city))
        .then((text) => text)
        .catch(() => `${city} Day ${day.day}，${day.district}片区，期待精彩旅程。`)
    )
  );

  itinerary.forEach((day, i) => {
    day.summary = summaries[i];
  });

  tick('完成', `总耗时 ${Date.now() - t0}ms`);

  const { llmModel } = getEffective();
  return {
    city,
    days,
    startDate: startDate || null,
    generatedAt: new Date().toISOString(),
    agent: {
      model: llmModel,
      steps,
    },
    warnings,
    stats,
    itinerary,
  };
}

module.exports = { plan };
