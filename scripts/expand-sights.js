'use strict';

/**
 * 扩充本地景点数据源：
 *  - 对全部 25 个城市调用 LLM 数据源生成 25-30 个景点
 *  - 与现有 server/data/sights.js 合并（按名称去重，保留原条目）
 *  - 每城按热度降序取前 MAX_PER_CITY 个
 *  - 输出：
 *      1. server/data/sights.expanded.json —— 每城新增清单（供审阅）
 *      2. server/data/sights.js —— 合并后的最终数据文件
 *
 * 用法：node scripts/expand-sights.js
 */

const fs = require('fs');
const path = require('path');
const { CITIES } = require('../server/data/cities');
const { getSightsByCity } = require('../server/data/sights');
const llm = require('../server/providers/sightProviderLlm');

const MAX_PER_CITY = 28; // 目标：每城最多 28 个
const MIN_TARGET = 20; // 每城至少希望达到的数量（不足则告警）
const MAX_ATTEMPTS = 3; // 每城最多尝试次数（LLM 输出偶发截断/为空，重试可显著提高成功率）

/** 标准景点对象 -> 紧凑行数组（与 sights.js 现有格式一致） */
function toRow(item) {
  const tags = Array.isArray(item.tags) && item.tags.length > 0
    ? item.tags.slice(0, 3).join(' ')
    : tagFromType(item.type);
  return [
    String(item.name),
    item.rating != null ? Number(item.rating) : 4.5,
    item.popularity != null ? Number(item.popularity) : 80,
    String(item.type || '景点'),
    String(item.ticket || '以现场公示为准'),
    String(item.openTime || '以现场公示为准'),
    String(item.visitHours || ''),
    String(item.address || ''),
    String(item.desc || ''),
    tags,
  ];
}

function tagFromType(type) {
  const map = {
    '历史古迹': '古迹',
    '自然风光': '自然',
    '博物馆': '博物馆',
    '主题乐园': '乐园',
    '城市地标': '地标',
    '宗教场所': '寺庙',
    '古镇水乡': '古镇',
    '历史街区': '街区',
    '皇家园林': '园林',
    '古典园林': '园林',
    '文创街区': '文创',
    '艺术园区': '艺术',
    '城市公园': '公园',
    '滨海公园': '海滨',
  };
  return map[type] || '景点';
}

function rowKey(row) {
  return String(row[0]).trim();
}

async function main() {
  // 现有数据：通过 getSightsByCity 拿到展开对象，再转回紧凑行
  const existingByCity = {};
  for (const city of CITIES) {
    existingByCity[city.name] = getSightsByCity(city.name).map((obj) => toRow(obj));
  }
  const existingCount = Object.values(existingByCity).reduce((n, arr) => n + arr.length, 0);
  console.log(`[start] 现有本地景点：${existingCount} 条 / ${CITIES.length} 城`);
  console.log('');

  const result = {}; // city -> { rows, added, errors }
  for (const city of CITIES) {
    const name = city.name;
    const existing = existingByCity[name] || [];
    const have = new Set(existing.map(rowKey));
    let added = [];
    let lastErr = null;

    // 已达标城市直接跳过，不再调用 LLM
    if (existing.length >= MAX_PER_CITY) {
      result[name] = { rows: existing, added: [], errors: [], skipped: true };
      console.log(`[skip] ${name.padEnd(4)} 已有 ${existing.length} 个，已达标`);
      continue;
    }

    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const generated = await llm.searchSights(name);
        for (const item of generated) {
          const row = toRow(item);
          if (!row[0] || have.has(rowKey(row))) continue; // 与现有/已加重复则跳过
          have.add(rowKey(row));
          added.push(row);
        }
        // 按热度降序，取足 MAX_PER_CITY（老数据优先保留）
        added.sort((a, b) => (Number(b[2]) || 0) - (Number(a[2]) || 0));
        if (added.length > MAX_PER_CITY - existing.length) {
          added = added.slice(0, Math.max(0, MAX_PER_CITY - existing.length));
        }
        if (added.length > 0) break; // 有新增即算成功
        lastErr = `第 ${attempt} 次未生成新条目（去重后为空）`;
      } catch (err) {
        lastErr = err.message;
      }
      if (attempt < MAX_ATTEMPTS) {
        console.log(`[retry] ${name} 第 ${attempt} 次失败（${lastErr.slice(0, 60)}），重试...`);
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    if (added.length === 0) {
      result[name] = { rows: existing, added: [], errors: [lastErr] };
      console.log(`[fail] ${name}: ${lastErr}`);
      continue;
    }

    const rows = existing.concat(added);
    rows.sort((a, b) => (Number(b[2]) || 0) - (Number(a[2]) || 0));
    result[name] = { rows, added, errors: [] };

    const warn = rows.length < MIN_TARGET ? '  << 不足20个!' : '';
    console.log(
      `[ok]   ${name.padEnd(4)} ${String(existing.length).padStart(2)} -> ${String(rows.length).padStart(2)} 个（新增 ${added.length}）${warn}`
    );
  }

  // 输出新增清单（审阅用）
  const review = {};
  for (const [city, r] of Object.entries(result)) {
    review[city] = r.added.map((row) => row[0]);
  }
  fs.writeFileSync(
    path.join(__dirname, '../server/data/sights.expanded.json'),
    JSON.stringify(review, null, 2),
    'utf8'
  );

  // 生成最终 sights.js（保持与现有导出结构一致）
  const lines = [];
  lines.push("'use strict';");
  lines.push('');
  lines.push('/**');
  lines.push(' * 内置景点数据集（兜底数据源：未配置任何 API Key 时使用，离线可用）。');
  lines.push(' * 覆盖 cities.js 中支持的全部 25 个城市，数据为人工整理的常见公开信息，');
  lines.push(' * 评分/热度为综合各大平台的近似值，仅供演示参考。');
  lines.push(' *');
  lines.push(' * 紧凑行格式：');
  lines.push(' * [名称, 评分(0-5), 热度(0-100), 分类, 门票, 开放时间, 建议时长, 地址, 简介, 标签(空格分隔)]');
  lines.push(' */');
  lines.push('');
  lines.push('const SIGHTS = {');
  for (const city of CITIES) {
    const r = result[city.name];
    if (!r) continue;
    lines.push(`  ${JSON.stringify(city.name)}: [`);
    for (const row of r.rows) {
      lines.push(`    ${JSON.stringify(row)},`);
    }
    lines.push('  ],');
  }
  lines.push('};');
  lines.push('');
  lines.push('/** 将紧凑行展开为标准景点对象 */');
  lines.push('function expandRow(row) {');
  lines.push('  const [name, rating, popularity, type, ticket, openTime, visitHours, address, desc, tagStr] = row;');
  lines.push('  return {');
  lines.push('    name,');
  lines.push('    rating,');
  lines.push('    popularity,');
  lines.push('    type,');
  lines.push('    ticket,');
  lines.push('    openTime,');
  lines.push('    visitHours,');
  lines.push('    address,');
  lines.push('    desc,');
  lines.push('    tags: tagStr ? tagStr.split(/\\s+/).filter(Boolean) : [],');
  lines.push('    recommended: popularity >= 88,');
  lines.push('    photo: null,');
  lines.push('    location: null,');
  lines.push('  };');
  lines.push('}');
  lines.push('');
  lines.push('/** 按城市名取内置景点列表（找不到返回空数组） */');
  lines.push('function getSightsByCity(cityName) {');
  lines.push('  const rows = SIGHTS[cityName] || [];');
  lines.push('  return rows.map(expandRow);');
  lines.push('}');
  lines.push('');
  lines.push('module.exports = { getSightsByCity };');
  lines.push('');
  fs.writeFileSync(path.join(__dirname, '../server/data/sights.js'), lines.join('\n'), 'utf8');

  // 汇总
  console.log('');
  const total = Object.values(result).reduce((n, r) => n + r.rows.length, 0);
  const failed = Object.values(result).filter((r) => r.errors.length > 0).length;
  console.log(`[done] 共 ${total} 条 / ${CITIES.length} 城，失败 ${failed} 城`);
  console.log('审阅文件：server/data/sights.expanded.json');
}

main().catch((err) => {
  console.error('FATAL:', err);
  process.exit(1);
});
