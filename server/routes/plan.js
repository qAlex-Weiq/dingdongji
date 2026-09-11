'use strict';

/**
 * 行程规划 API：
 *   POST /api/plan  - 由行程篮生成日程（确定性编排 + Agent 文案）
 *
 * 入参（body）：
 *   { city: '成都', days: 3, startDate?: '2026-09-20',
 *     items: [ { type, key, payload, mustGo } ... ] }
 *
 * 校验规则（与前端 cart.js 的可生成条件保持一致）：
 *   - city 必填且需为支持的城市
 *   - days 为 1-7 的整数
 *   - items 至少包含 2 个景点（车票 / 酒店 / 餐厅均为可选）
 */

const express = require('express');
const { findCity } = require('../data/cities');
const { plan } = require('../lib/planner');
const { isBusinessError } = require('../lib/apiError');

const router = express.Router();

/** 行程篮单项结构校验 */
const VALID_TYPES = ['ticket', 'hotel', 'sight', 'food', 'dish'];

function validateItems(items) {
  if (!Array.isArray(items) || items.length === 0) {
    return '行程篮为空，请先在各模块中添加条目';
  }
  if (items.length > 40) {
    return '行程篮条目过多（上限 40 项），请精简后重试';
  }
  for (const it of items) {
    if (!it || typeof it !== 'object') return '行程篮存在无效条目';
    if (!VALID_TYPES.includes(it.type)) return `未知的条目类型「${it.type}」`;
    if (!it.payload || typeof it.payload !== 'object') return '行程篮条目缺少数据';
    // 车票条目没有 name 字段（由 trainNo / flightNo 标识），其余模块必须有 name
    if (it.type === 'ticket') {
      if (!it.payload.trainNo && !it.payload.flightNo && !it.payload.name) {
        return '车票条目缺少车次号或航班号';
      }
    } else if (!it.payload.name) {
      return '行程篮条目缺少名称';
    }
  }
  // 景点不足时由服务端自动补全（见 itinerary.suggestSights），
  // 因此这里只要求至少有 1 个景点作为行程锚点。
  const sightCount = items.filter((i) => i.type === 'sight').length;
  if (sightCount < 1) {
    return '生成行程至少需要 1 个景点作为锚点';
  }
  return null;
}

/**
 * POST /api/plan
 * 由行程篮生成日程。结构由确定性算法决定，Agent 仅撰写每日说明。
 */
router.post('/', async (req, res, next) => {
  try {
    const body = req.body || {};
    const { city, days, startDate, items, autoFill } = body;

    if (!city || !String(city).trim()) {
      return res.status(400).json({ error: '缺少参数：city 为必填' });
    }
    const cityInfo = findCity(String(city).trim());
    if (!cityInfo) {
      return res.status(404).json({ error: `暂不支持城市「${city}」，请从支持的城市中选择` });
    }

    const d = Number(days);
    if (!Number.isInteger(d) || d < 1 || d > 7) {
      return res.status(400).json({ error: '天数应为 1-7 的整数' });
    }

    if (startDate !== undefined && startDate !== null && startDate !== '') {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(String(startDate))) {
        return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' });
      }
    }

    const itemError = validateItems(items);
    if (itemError) {
      return res.status(400).json({ error: itemError });
    }

    const result = await plan({
      city: cityInfo.name,
      days: d,
      startDate: startDate || null,
      items,
      // 默认开启行程补全；前端「移除所有 AI 建议」时传 false
      autoFill: autoFill !== false,
    });

    res.json(result);
  } catch (err) {
    // LLM 未配置 / 接口失败等属于业务错误，返回 400 并透出真实原因
    if (isBusinessError(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

module.exports = router;
