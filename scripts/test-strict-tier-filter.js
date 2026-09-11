'use strict';

/**
 * 严格价格过滤验证：模拟 LLM 返回（含越界价/幻觉价/缺失价），
 * 验证 hotelProviderLlm 的后置严格过滤与 hotelProvider 的统一防线。
 */

const path = require('path');
const { priceInTier, tierPriceRule, tierRangeText } = require(path.join(__dirname, '../server/lib/hotelPrefs'));
const llmInternal = require(path.join(__dirname, '../server/providers/hotelProviderLlm'))._internal;

let pass = 0;
let fail = 0;
function test(name, fn) {
  try { fn(); console.log(`  ok - ${name}`); pass++; }
  catch (e) { console.log(`  FAIL - ${name}: ${e.message}`); fail++; }
}

console.log('档位数值约束表达式（tierPriceRule）:');
test('budget -> "price <= 200"', () => { if (tierPriceRule('budget') !== 'price <= 200') throw new Error(tierPriceRule('budget')); });
test('comfort -> "200 < price <= 450"', () => { if (tierPriceRule('comfort') !== '200 < price <= 450') throw new Error(tierPriceRule('comfort')); });
test('upscale -> "450 < price <= 800"', () => { if (tierPriceRule('upscale') !== '450 < price <= 800') throw new Error(tierPriceRule('upscale')); });
test('luxury -> "price > 800"', () => { if (tierPriceRule('luxury') !== 'price > 800') throw new Error(tierPriceRule('luxury')); });
test('any -> "价格不限"', () => { if (tierPriceRule('any') !== '价格不限') throw new Error(tierPriceRule('any')); });

console.log('统一防线（priceInTier）对模拟 LLM 越界价的剔除:');
// 模拟 LLM 输出（含典型越界：¥260/¥280 —— 正是线上 bug 场景）
const mockLlmPrices = [98, 128, 158, 165, 185, 192, 260, 280, 99999, 45, 201];
// LLM 数据源真实流水线：normalizeTierPrice 先做幻觉守卫（≤50/>50000 -> null，
// 指定档位时不改价），再由 priceInTier 做严格数值区间校验
const pipeline = (price, tier) => {
  const cleaned = llmInternal.normalizeTierPrice(price, '经济型', tier === 'any');
  return cleaned !== null && priceInTier(cleaned, tier);
};
test('budget 流水线：保留全部 ≤200 真实价，剔除 ¥260/¥280/¥201/幻觉价(45/99999)', () => {
  const kept = mockLlmPrices.filter((p) => pipeline(p, 'budget'));
  if (kept.join() !== '98,128,158,165,185,192') throw new Error(`kept=${kept}`);
});
test('comfort 流水线：只保留 200 < price <= 450（¥201/¥260/¥280）', () => {
  const kept = mockLlmPrices.filter((p) => pipeline(p, 'comfort'));
  if (kept.join() !== '260,280,201') throw new Error(`kept=${kept}`);
});
test('luxury 流水线：只保留 >800（幻觉价 99999 已被守卫拦截）', () => {
  const kept = mockLlmPrices.filter((p) => pipeline(p, 'luxury'));
  if (kept.join() !== '') throw new Error(`kept=${kept}`);
});

console.log('LLM 提示词含硬性价格约束:');
const llmSrc = require(path.join(__dirname, '../server/providers/hotelProviderLlm'));
const prompt = llmSrc._internal && typeof llmSrc._internal.buildPrompt === 'function'
  ? llmSrc._internal.buildPrompt('北京', { tier: 'budget' })
  : null;
test('buildPrompt 含「硬性约束」与 "price <= 200"（若未导出则跳过）', () => {
  if (!prompt) return; // 未导出 buildPrompt 时跳过（不视为失败）
  if (!prompt.includes('硬性约束')) throw new Error('缺少硬性约束字样');
  if (!prompt.includes('price <= 200')) throw new Error('缺少数值约束 price <= 200');
  if (!prompt.includes('严格')) throw new Error('缺少「严格」措辞');
});

console.log('normalizeTierPrice 指定档位时不改价（交给严格校验）:');
test('450 标经济型 + clamp=false -> 450 原样（不会被改价凑区间）', () => {
  if (llmInternal.normalizeTierPrice(450, '经济型', false) !== 450) throw new Error('bad');
});
test('幻觉价 99999 -> null（任何模式下）', () => {
  if (llmInternal.normalizeTierPrice(99999, '经济型', false) !== null) throw new Error('bad');
});

console.log(fail === 0 ? `\n✅ 严格过滤验证: ${pass} 通过 / ${fail} 失败` : `\n❌ 严格过滤验证: ${pass} 通过 / ${fail} 失败`);
process.exit(fail === 0 ? 0 : 1);
