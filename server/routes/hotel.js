'use strict';

const express = require('express');
const { findCity } = require('../data/cities');
const { isValidTier, isValidLocation, priceInTier } = require('../lib/hotelPrefs');
const hotelProvider = require('../providers/hotelProvider');
const { isBusinessError } = require('../lib/apiError');

const router = express.Router();

/**
 * GET /api/hotel/search?city=北京&tier=comfort&location=downtown&source=auto
 * 酒店模块：返回该城市按热度与评分综合排序的酒店列表（支持价格档位 + 位置偏好筛选）。
 *   tier     可选：any（默认）/ budget / comfort / upscale / luxury
 *            档位按 price 数值严格过滤（不看档位名称）：
 *            budget: price <= 200；comfort: 200 < price <= 450；
 *            upscale: 450 < price <= 800；luxury: price > 800
 *   location 可选：any（默认）/ downtown / station / airport / scenic
 *   source   可选：auto（默认，自动降级 高德→LLM→内置）/ local / llm / amap
 * 显式指定单一数据源时不降级，失败返回明确错误。
 */
router.get('/search', async (req, res, next) => {
  try {
    const { city, tier, location, source } = req.query;
    if (!city || !String(city).trim()) {
      return res.status(400).json({ error: '缺少参数：city 为必填' });
    }

    const cityInfo = findCity(String(city).trim());
    if (!cityInfo) {
      return res.status(404).json({ error: `暂不支持城市「${city}」，请从支持的城市中选择` });
    }

    // 校验 tier 参数（价格档位）
    const tierVal = String(tier || 'any').trim().toLowerCase();
    if (!isValidTier(tierVal)) {
      return res.status(400).json({ error: `无效的价格档位「${tier}」，可选：any / budget / comfort / upscale / luxury` });
    }

    // 校验 location 参数（位置偏好）
    const locVal = String(location || 'any').trim().toLowerCase();
    if (!isValidLocation(locVal)) {
      return res.status(400).json({ error: `无效的位置偏好「${location}」，可选：any / downtown / station / airport / scenic` });
    }

    // 校验 source 参数
    const src = String(source || 'auto').trim().toLowerCase();
    if (!['auto', 'local', 'llm', 'amap'].includes(src)) {
      return res.status(400).json({ error: `无效的数据源「${source}」，可选：auto / local / llm / amap` });
    }

    const result = await hotelProvider.searchHotels(cityInfo.name, {
      tier: tierVal,
      location: locVal,
      source: src,
    });

    // 严格价格过滤（路由层最后防线）：档位非 any 时剔除任何价格越界/未知的酒店，
    // 确保 API 契约：返回的每一家酒店都 100% 落在所选价格区间内
    const resultTier = result.tier || tierVal;
    const hotels = resultTier === 'any'
      ? result.hotels
      : (result.hotels || []).filter((h) => priceInTier(h.price, resultTier));

    res.json({
      query: { city: cityInfo.name, tier: result.tier, location: result.location, source: src },
      ...result,
      count: hotels.length,
      hotels,
    });
  } catch (err) {
    // 数据源未配置 / 档位未收录 / LLM 与高德接口失败属于业务错误，返回 400 并透出原因
    if (isBusinessError(err.message)) {
      return res.status(400).json({ error: err.message });
    }
    next(err);
  }
});

/**
 * GET /api/hotel/sources
 * 返回各数据源配置状态（用于前端提示当前数据来源）。
 */
router.get('/sources', (req, res) => {
  res.json({ sources: hotelProvider.getSourceStatus() });
});

module.exports = router;
