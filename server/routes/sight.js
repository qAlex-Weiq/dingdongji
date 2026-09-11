'use strict';

const express = require('express');
const { findCity } = require('../data/cities');
const sightProvider = require('../providers/sightProvider');

const router = express.Router();

/**
 * GET /api/sight/search?city=北京
 * 景点模块：返回该城市按热门程度与评分综合排序的景点列表。
 * 数据源自动降级：高德地图 → LLM → 内置数据。
 */
router.get('/search', async (req, res, next) => {
  try {
    const { city } = req.query;
    if (!city || !String(city).trim()) {
      return res.status(400).json({ error: '缺少参数：city 为必填' });
    }

    const cityInfo = findCity(String(city).trim());
    if (!cityInfo) {
      return res.status(404).json({ error: `暂不支持城市「${city}」，请从支持的城市中选择` });
    }

    const result = await sightProvider.searchSights(cityInfo.name);
    res.json({
      query: { city: cityInfo.name },
      ...result,
    });
  } catch (err) {
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
