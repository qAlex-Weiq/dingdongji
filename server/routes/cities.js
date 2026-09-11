'use strict';

const express = require('express');
const { CITIES } = require('../data/cities');

const router = express.Router();

/**
 * GET /api/cities
 * 返回支持的城市列表（各模块共用的自动补全数据）。
 */
router.get('/cities', (req, res) => {
  res.json(CITIES.map((c) => ({ name: c.name, pinyin: c.pinyin })));
});

module.exports = router;
