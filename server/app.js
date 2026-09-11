'use strict';

const path = require('path');
const express = require('express');
require('./lib/env'); // 加载根目录 .env（必须在读取环境变量的模块之前）
const citiesRouter = require('./routes/cities');
const ticketRouter = require('./routes/ticket');
const sightRouter = require('./routes/sight');
const hotelRouter = require('./routes/hotel');
const settingsRouter = require('./routes/settings');
const foodRouter = require('./routes/food');
const planRouter = require('./routes/plan');

function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json());

  // ---- API ----
  // 共享：GET /api/cities（城市自动补全，各模块通用）
  app.use('/api', citiesRouter);
  // 车票模块：GET /api/ticket/search（机票 + 火车票）
  app.use('/api/ticket', ticketRouter);
  // 景点模块：GET /api/sight/search（联网搜索 + 综合排序）
  app.use('/api/sight', sightRouter);
  // 酒店模块：GET /api/hotel/search（联网搜索 + 偏好筛选 + 综合排序）
  app.use('/api/hotel', hotelRouter);
  // 设置：GET/PUT /api/settings、POST /api/settings/test
  app.use('/api/settings', settingsRouter);
  // 美食模块：GET /api/food/cuisines|specialties|restaurants + POST /api/food/personalize
  app.use('/api/food', foodRouter);
  // 行程规划：POST /api/plan（行程篮 → 确定性编排 + Agent 文案）
  app.use('/api/plan', planRouter);

  app.use('/api', (req, res) => res.status(404).json({ error: '接口不存在' }));

  // API 统一错误处理
  // eslint-disable-next-line no-unused-vars
  app.use('/api', (err, req, res, next) => {
    console.error('[api] error:', err);
    res.status(500).json({ error: '服务器内部错误，请稍后重试' });
  });

  // ---- 前端静态资源 ----
  app.use(express.static(path.join(__dirname, '..', 'public')));

  return app;
}

module.exports = { createApp };
