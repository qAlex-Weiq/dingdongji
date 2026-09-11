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
const { clearCache: clearFlightCache, testConnection: testAmadeusConnection } = require('../providers/flightProviderAmadeus');

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
      amadeusClientId: user.amadeusClientId,
      amadeusSecretConfigured: Boolean(user.amadeusSecret),
      amadeusSecretMasked: settings.mask(user.amadeusSecret),
    },
    effective: {
      llmBaseUrl: eff.llmBaseUrl,
      llmModel: eff.llmModel,
      llmReady: Boolean(eff.llmApiKey),
      amapReady: Boolean(eff.amapKey),
      amadeusReady: Boolean(eff.amadeusClientId && eff.amadeusSecret),
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
    clearFlightCache(); // 同时清空机票缓存（数据源配置可能变化）
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

// POST /api/settings/test — 测试接口连通性（LLM / Amadeus）
// body: { llmBaseUrl?, llmApiKey?, amadeusClientId?, amadeusSecret? }，缺省时使用已保存/环境变量配置
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
    const amadeusClientId =
      typeof body.amadeusClientId === 'string' && body.amadeusClientId.trim()
        ? body.amadeusClientId.trim()
        : eff.amadeusClientId;
    const amadeusSecret =
      typeof body.amadeusSecret === 'string' && body.amadeusSecret.trim()
        ? body.amadeusSecret.trim()
        : eff.amadeusSecret;

    const testLlm = Boolean(apiKey);
    const testAmadeus = Boolean(amadeusClientId && amadeusSecret);
    if (!testLlm && !testAmadeus) {
      return res.status(400).json({ error: '未填写任何待测试的密钥，且当前无已保存配置' });
    }

    const out = { ok: true, models: [], llmTested: testLlm, amadeusTested: testAmadeus };

    // --- LLM 连通性（仅测试 LLM 时保持原有 400 语义） ---
    if (testLlm) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 15000);
      try {
        const r = await fetch(`${baseUrl}/models`, {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: controller.signal,
        });
        if (!r.ok) {
          const msg = `LLM 接口返回 HTTP ${r.status}，请检查地址与密钥`;
          if (testAmadeus) { out.ok = false; out.llmError = msg; } else { return res.status(400).json({ error: msg }); }
        } else {
          const d = await r.json().catch(() => ({}));
          out.models = Array.isArray(d.data) ? d.data.map((m) => m.id).filter(Boolean).slice(0, 20) : [];
        }
      } catch (err) {
        const msg = err.name === 'AbortError'
          ? 'LLM 连接超时（15 秒），请检查接口地址是否可达'
          : `LLM 连接失败：${err.message}`;
        if (testAmadeus) { out.ok = false; out.llmError = msg; } else { return res.status(400).json({ error: msg }); }
      } finally {
        clearTimeout(timer);
      }
    }

    // --- Amadeus 连通性（凭据可换取 token 即通过） ---
    if (testAmadeus) {
      try {
        await testAmadeusConnection(amadeusClientId, amadeusSecret);
        out.amadeusOk = true;
      } catch (err) {
        out.ok = false;
        out.amadeusOk = false;
        out.amadeusError = `Amadeus 连接失败：${err.message}`;
      }
    }

    res.json(out);
  } catch (err) {
    next(err);
  }
});

module.exports = router;
