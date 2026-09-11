'use strict';

/**
 * 业务错误判定：数据源配置 / 外部接口 / 参数类问题。
 * 命中时路由层返回 400 并透出真实原因（引导用户改配置或换条件），
 * 未命中视为服务端内部缺陷，走 500 兜底。
 *
 * 覆盖的错误前缀：
 *   - LLM 接口 / LLM 未返回 / LLM 输出 / LLM 请求失败 / LLM 请求超时（三个 LLM provider）
 *   - AI 数据源未配置…
 *   - 高德接口 / 高德未返回 / 高德接口错误（三个高德 provider）
 *   - 未配置 / 未收录 / 数据源（通用业务提示）
 */
const PREFIX_RE = /^(AI 数据源|LLM|高德)/;
const KEYWORD_RE = /未配置|未收录|数据源/;

function isBusinessError(message) {
  const msg = String(message || '');
  return PREFIX_RE.test(msg) || KEYWORD_RE.test(msg);
}

module.exports = { isBusinessError };
