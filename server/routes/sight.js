'use strict';

const express = require('express');
const { findCity } = require('../data/cities');
const sightProvider = require('../providers/sightProvider');

const router = express.Router();

/**
 * GET /api/sight/search?city=北京&source=auto
 * 景点模块：返回该城市按热门程度与评分综合排序的景点列表。
 * source 可选：auto（默认，自动降级 高德→LLM→内置）/ local / llm / amap。
 * 显式指定单一数据源时不降级，失败返回明确错误。
 */
router.get('/search', async (req, res, next) => {
  try {
    const { city, source } = req.query;
    if (!city || !String(city).trim()) {
      return res.status(400).json({ error: '缺少参数：city 为必填' });
    }

    const cityInfo = findCity(String(city).trim());
    if (!cityInfo) {
      return res.status(404).json({ error: `暂不支持城市「${city}」，请从支持的城市中选择` });
    }

    // 校验 source 参数
    const src = String(source || 'auto').trim().toLowerCase();
    if (!['auto', 'local', 'llm', 'amap'].includes(src)) {
      return res.status(400).json({ error: `无效的数据源「${source}」，可选：auto / local / llm / amap` });
    }

    const result = await sightProvider.searchSights(cityInfo.name, { source: src });
    res.json({
      query: { city: cityInfo.name, source: src },
      ...result,
    });
  } catch (err) {
    // 数据源未配置 / 查询失败属于业务错误，返回 400 并透出原因（引导用户去设置页）
    if (/未配置|未收录/.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

/**
 * GET /api/sight/sources
 * 返回各数据源配置状态（用于前端提示当前数据来源）。
 */
router.get('/sources', (req, res) => {
  res.json({ sources: sightProvider.getSourceStatus() });
});

module.exports = router;
