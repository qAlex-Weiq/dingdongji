'use strict';

const express = require('express');
const { findCity } = require('../data/cities');
const foodProvider = require('../providers/foodProvider');
const { CUISINES, VALID_SLOTS } = require('../data/food');

const router = express.Router();

/**
 * GET /api/food/cuisines
 * 返回菜系目录，前端用于填充筛选下拉。
 */
router.get('/cuisines', (_req, res) => {
  res.json(CUISINES.map(({ code, name, aliases }) => ({ code, name, aliases })));
});

/**
 * GET /api/food/specialties?city=成都&category=小吃
 * 特色菜品：按推荐店铺数倒序返回。
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
    const specialties = await foodProvider.getSpecialties({ city: c.name, category });
    res.json({
      query: { city: c.name, category: category || '全部' },
      specialties,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * GET /api/food/restaurants
 *   ?city=成都&cuisines=川菜,火锅&priceMin=50&priceMax=200&slot=晚餐&openNow=true&sort=rating
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

    const restaurants = await foodProvider.searchRestaurants({
      city: c.name,
      cuisines: cuisineList,
      priceMin: pm,
      priceMax: px,
      slot: slot || null,
      openNow: openNow === 'true',
      sort: sort || 'rating',
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
      },
      restaurants,
    });
  } catch (err) {
    next(err);
  }
});

/**
 * POST /api/food/personalize
 *   body: { city, query }
 * 个性化推荐：关键词词典打分 + 预算区间 + 评分软加成。
 */
router.post('/personalize', async (req, res, next) => {
  try {
    const { city, query } = req.body || {};
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

    const result = await foodProvider.personalize({ city: c.name, query: String(query) });
    res.json({ query: { city: c.name, raw: String(query) }, ...result });
  } catch (err) {
    next(err);
  }
});

module.exports = router;