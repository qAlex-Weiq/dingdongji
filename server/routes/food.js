'use strict';

const express = require('express');
const { findCity } = require('../data/cities');
const foodProvider = require('../providers/foodProvider');
const { CUISINES, VALID_SLOTS } = require('../data/food');

const router = express.Router();

const VALID_SOURCES = ['auto', 'local', 'llm'];

/** 校验 source 参数；返回小写规范值或抛 400 响应 */
function parseSource(raw) {
  const src = String(raw || 'auto').trim().toLowerCase();
  if (!VALID_SOURCES.includes(src)) {
    return { invalid: true, src };
  }
  return { invalid: false, src };
}

/**
 * GET /api/food/cuisines
 * 返回菜系目录，前端用于填充筛选下拉。
 */
router.get('/cuisines', (_req, res) => {
  res.json(CUISINES.map(({ code, name, aliases }) => ({ code, name, aliases })));
});

/**
 * GET /api/food/sources
 * 返回各数据源配置状态（用于前端提示当前数据来源）。
 */
router.get('/sources', (_req, res) => {
  res.json({ sources: foodProvider.getSourceStatus() });
});

/**
 * GET /api/food/specialties?city=成都&category=小吃&source=auto
 * 特色菜品：按推荐店铺数倒序返回。
 * source 可选：auto（默认，LLM→本地降级）/ local / llm；显式指定时不降级。
 */
router.get('/specialties', async (req, res, next) => {
  try {
    const { city, category } = req.query;
    if (!city) {
      return res.status(400).json({ error: '缺少参数：city 必填' });
    }
    const c = findCity(city);
    if (!c) {
      return res.status(404).json({ error: `暂不支持城市「${city}」，请从支持的城市中选择` });
    }
    const { invalid, src } = parseSource(req.query.source);
    if (invalid) {
      return res.status(400).json({ error: `无效的数据源「${req.query.source}」，可选：${VALID_SOURCES.join(' / ')}` });
    }

    const result = await foodProvider.getSpecialties({ city: c.name, category, source: src });
    res.json({
      query: { city: c.name, category: category || '全部', source: src },
      ...result,
    });
  } catch (err) {
    if (/未配置|未收录|数据源/.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

/**
 * GET /api/food/restaurants
 *   ?city=成都&cuisines=川菜,火锅&priceMin=50&priceMax=200&slot=晚餐&openNow=true&sort=rating&source=auto
 * 餐厅筛选：菜系 / 人均 / 时段 / 营业中 / 排序。
 */
router.get('/restaurants', async (req, res, next) => {
  try {
    const { city, cuisines, priceMin, priceMax, slot, openNow, sort } = req.query;
    if (!city) {
      return res.status(400).json({ error: '缺少参数：city 必填' });
    }
    if (slot && !VALID_SLOTS.includes(slot)) {
      return res.status(400).json({ error: `slot 取值应为 ${VALID_SLOTS.join('/')} 之一` });
    }
    const c = findCity(city);
    if (!c) {
      return res.status(404).json({ error: `暂不支持城市「${city}」，请从支持的城市中选择` });
    }
    const { invalid, src } = parseSource(req.query.source);
    if (invalid) {
      return res.status(400).json({ error: `无效的数据源「${req.query.source}」，可选：${VALID_SOURCES.join(' / ')}` });
    }

    const cuisineList = cuisines
      ? String(cuisines).split(',').map((s) => s.trim()).filter(Boolean)
      : [];
    const pm = priceMin !== undefined ? Number(priceMin) : 0;
    const px = priceMax !== undefined ? Number(priceMax) : 1000;
    if (Number.isNaN(pm) || pm < 0 || Number.isNaN(px) || px < 0) {
      return res.status(400).json({ error: 'priceMin / priceMax 必须为非负数字' });
    }
    if (pm > px) {
      return res.status(400).json({ error: 'priceMin 不能大于 priceMax' });
    }

    const result = await foodProvider.searchRestaurants({
      city: c.name,
      cuisines: cuisineList,
      priceMin: pm,
      priceMax: px,
      slot: slot || null,
      openNow: openNow === 'true',
      sort: sort || 'rating',
      source: src,
    });

    res.json({
      query: {
        city: c.name,
        cuisines: cuisineList,
        priceMin: pm,
        priceMax: px,
        slot: slot || null,
        openNow: openNow === 'true',
        sort: sort || 'rating',
        source: src,
      },
      ...result,
    });
  } catch (err) {
    if (/未配置|未收录|数据源/.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

/**
 * POST /api/food/personalize
 *   body: { city, query, source }
 * 个性化推荐：本地词典打分或 LLM 智能解析。
 */
router.post('/personalize', async (req, res, next) => {
  try {
    const { city, query, source } = req.body || {};
    if (!city || !query) {
      return res.status(400).json({ error: '缺少参数：city / query 均为必填' });
    }
    if (String(query).trim().length < 4) {
      return res.status(400).json({ error: '需求描述过短，请补充更多信息' });
    }
    const c = findCity(city);
    if (!c) {
      return res.status(404).json({ error: `暂不支持城市「${city}」，请从支持的城市中选择` });
    }
    const { invalid, src } = parseSource(source);
    if (invalid) {
      return res.status(400).json({ error: `无效的数据源「${source}」，可选：${VALID_SOURCES.join(' / ')}` });
    }

    const result = await foodProvider.personalize({ city: c.name, query: String(query), source: src });
    res.json({ query: { city: c.name, raw: String(query), source: src }, ...result });
  } catch (err) {
    if (/未配置|未收录|数据源/.test(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

module.exports = router;
