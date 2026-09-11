'use strict';

/**
 * 设置 API：
 *   GET  /api/settings       - 读取当前配置（密钥脱敏，绝不返回明文）
 *   PUT  /api/settings       - 保存配置（增量合并，保存后清空景点缓存）
 *   POST /api/settings/test  - 测试 LLM 接口连通性（可用表单待存值或已保存值）
 */

const express = require('express');
const settings = require('../lib/settings');
const { clearCache } = require('../providers/sightProvider');
const { clearCache: clearHotelCache } = require('../providers/hotelProvider');
const { clearCache: clearFoodCache } = require('../providers/foodProvider');

const router = express.Router();

// GET /api/settings — 脱敏返回
router.get('/', (req, res) => {
  const user = settings.getUserSettings();
  const eff = settings.getEffective();
  res.json({
    user: {
      llmBaseUrl: user.llmBaseUrl,
      llmModel: user.llmModel,
      llmApiKeyConfigured: Boolean(user.llmApiKey),
      llmApiKeyMasked: settings.mask(user.llmApiKey),
      amapKeyConfigured: Boolean(user.amapKey),
      amapKeyMasked: settings.mask(user.amapKey),
    },
    effective: {
      llmBaseUrl: eff.llmBaseUrl,
      llmModel: eff.llmModel,
      llmReady: Boolean(eff.llmApiKey),
      amapReady: Boolean(eff.amapKey),
    },
  });
});

// PUT /api/settings — 保存（body 中出现的字符串字段才更新；密钥留空/缺省 = 不修改）
router.put('/', (req, res, next) => {
  try {
    const body = req.body || {};
    const patch = {};
    for (const k of settings.FIELDS) {
      if (typeof body[k] === 'string') {
        patch[k] = body[k];
      }
    }
    if (Object.keys(patch).length === 0) {
      return res.status(400).json({ error: '没有可保存的配置字段' });
    }
    settings.update(patch);
    clearCache(); // 数据源配置已变化，清空景点缓存
    clearHotelCache(); // 同时清空酒店缓存
    clearFoodCache(); // 同时清空美食缓存
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/settings/test — 测试 LLM 接口连通性
// body: { llmBaseUrl?, llmApiKey?, } 缺省时使用已保存/环境变量配置
router.post('/test', async (req, res, next) => {
  try {
    const body = req.body || {};
    const eff = settings.getEffective();
    const baseUrl = (
      typeof body.llmBaseUrl === 'string' && body.llmBaseUrl.trim()
        ? body.llmBaseUrl
        : eff.llmBaseUrl
    ).replace(/\/+$/, '');
    const apiKey =
      typeof body.llmApiKey === 'string' && body.llmApiKey.trim()
        ? body.llmApiKey.trim()
        : eff.llmApiKey;

    if (!apiKey) {
      return res.status(400).json({ error: '未填写 API Key，且当前无已保存配置' });
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const r = await fetch(`${baseUrl}/models`, {
        headers: { Authorization: `Bearer ${apiKey}` },
        signal: controller.signal,
      });
      if (!r.ok) {
        return res.status(400).json({ error: `接口返回 HTTP ${r.status}，请检查地址与密钥` });
      }
      const d = await r.json().catch(() => ({}));
      const models = Array.isArray(d.data) ? d.data.map((m) => m.id).filter(Boolean) : [];
      res.json({ ok: true, models: models.slice(0, 20) });
    } finally {
      clearTimeout(timer);
    }
  } catch (err) {
    if (err.name === 'AbortError') {
      return res.status(400).json({ error: '连接超时（15 秒），请检查接口地址是否可达' });
    }
    next(err);
  }
});

module.exports = router;
