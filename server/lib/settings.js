'use strict';

/**
 * 运行时设置（用户在「设置」页面配置，持久化到根目录 .settings.json）。
 *
 * 配置优先级：.settings.json（用户界面配置） > 环境变量（.env）
 * .settings.json 已被 .gitignore 忽略，其中的 API Key 不会进入代码仓库。
 */

const fs = require('fs');
const path = require('path');

const SETTINGS_FILE = path.join(__dirname, '..', '..', '.settings.json');

/** 可配置字段白名单 */
const FIELDS = ['llmBaseUrl', 'llmApiKey', 'llmModel', 'amapKey', 'amadeusClientId', 'amadeusSecret'];

/** 内存缓存（避免每次请求读文件） */
let memory = null;

function load() {
  if (memory) return memory;
  let data = {};
  try {
    data = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));
  } catch {
    /* 文件不存在或损坏时视为空配置，回退环境变量 */
  }
  memory = {};
  for (const k of FIELDS) {
    memory[k] = typeof data[k] === 'string' ? data[k] : '';
  }
  return memory;
}

function persist(settings) {
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(settings, null, 2), 'utf8');
  memory = { ...settings };
}

/** 用户在设置页保存的原始配置（仅服务端内部使用，勿直接下发前端） */
function getUserSettings() {
  return { ...load() };
}

/**
 * 生效配置：用户配置优先，环境变量兜底。
 * 数据源 provider 统一从这里读取。
 */
function getEffective() {
  const s = load();
  return {
    llmBaseUrl: s.llmBaseUrl || process.env.LLM_BASE_URL || 'https://open.bigmodel.cn/api/paas/v4',
    llmApiKey: s.llmApiKey || process.env.LLM_API_KEY || '',
    llmModel: s.llmModel || process.env.LLM_MODEL || 'glm-4-flash',
    amapKey: s.amapKey || process.env.AMAP_KEY || '',
    amadeusClientId: s.amadeusClientId || process.env.AMADEUS_CLIENT_ID || '',
    amadeusSecret: s.amadeusSecret || process.env.AMADEUS_CLIENT_SECRET || '',
  };
}

/**
 * 更新配置（增量合并）。
 * patch 中仅接受白名单内的字符串字段；空字符串表示清除该项（回退环境变量）。
 */
function update(patch) {
  const next = { ...load() };
  for (const k of FIELDS) {
    if (typeof patch[k] === 'string') {
      next[k] = patch[k].trim();
    }
  }
  persist(next);
  return { ...next };
}

/** 密钥脱敏显示：保留首 5 位与末 4 位 */
function mask(secret) {
  if (!secret) return '';
  if (secret.length <= 10) return '***';
  return `${secret.slice(0, 5)}***${secret.slice(-4)}`;
}

module.exports = { getUserSettings, getEffective, update, mask, FIELDS };
