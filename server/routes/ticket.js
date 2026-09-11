'use strict';

const express = require('express');
const { findCity } = require('../data/cities');
const flightProvider = require('../providers/flightProvider');
const trainProvider = require('../providers/trainProvider');
const trainProvider12306 = require('../providers/trainProvider12306');
const flightProviderAmadeus = require('../providers/flightProviderAmadeus');
const settings = require('../lib/settings');

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

    // 火车：优先 12306 实时数据（真实票价 + 真实余票），失败降级本地模拟并透出原因
    let trains;
    let trainsSource = '12306';
    let trainsNote = null;
    try {
      trains = await trainProvider12306.search({ from: fromCity, to: toCity, date: query.date });
    } catch (err) {
      trainsSource = 'local';
      trainsNote = `12306 实时查询不可用（${err.message}），以下为模拟数据`;
      console.warn(`[ticket] 降级到本地模拟：${err.message}`);
      trains = await trainProvider.search({ from: fromCity, to: toCity, date: query.date });
    }

    // 机票：配置了 Amadeus 时用实时报价（班次/时刻/含税总价），失败或未配置降级本地模拟并透出原因
    let flights;
    let flightsSource = 'local';
    let flightsNote = null;
    const eff = settings.getEffective();
    if (eff.amadeusClientId && eff.amadeusSecret) {
      try {
        flights = await flightProviderAmadeus.search({ from: fromCity, to: toCity, date: query.date });
        flightsSource = 'amadeus';
      } catch (err) {
        flightsNote = `Amadeus 实时查询不可用（${err.message}），以下为模拟数据`;
        console.warn(`[ticket] 机票降级到本地模拟：${err.message}`);
        flights = await flightProvider.search({ from: fromCity, to: toCity, date: query.date });
      }
    } else {
      flightsNote = '机票为模拟数据（可在设置页配置 Amadeus 获取实时票价）';
      flights = await flightProvider.search({ from: fromCity, to: toCity, date: query.date });
    }

    res.json({ query, flights, trains, trainsSource, trainsNote, flightsSource, flightsNote });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
