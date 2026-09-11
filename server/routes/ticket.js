'use strict';

const express = require('express');
const { findCity } = require('../data/cities');
const flightProvider = require('../providers/flightProvider');
const trainProvider = require('../providers/trainProvider');

const router = express.Router();

/**
 * GET /api/ticket/search?from=北京&to=上海&date=2026-09-12
 * 车票模块：并行返回航班与火车班次。
 */
router.get('/search', async (req, res, next) => {
  try {
    const { from, to, date } = req.query;

    if (!from || !to || !date) {
      return res.status(400).json({ error: '缺少参数：from / to / date 均为必填' });
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) {
      return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' });
    }

    const fromCity = findCity(from);
    const toCity = findCity(to);
    if (!fromCity) {
      return res.status(404).json({ error: `暂不支持出发城市「${from}」，请从支持的城市中选择` });
    }
    if (!toCity) {
      return res.status(404).json({ error: `暂不支持到达城市「${to}」，请从支持的城市中选择` });
    }
    if (fromCity.name === toCity.name) {
      return res.status(400).json({ error: '出发城市与到达城市不能相同' });
    }

    const query = { from: fromCity.name, to: toCity.name, date: String(date) };
    const [flights, trains] = await Promise.all([
      flightProvider.search({ from: fromCity, to: toCity, date: query.date }),
      trainProvider.search({ from: fromCity, to: toCity, date: query.date }),
    ]);

    res.json({ query, flights, trains });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
