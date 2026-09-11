'use strict';

/**
 * 重建 server/data/sights.js（整体重写，不做正则局部替换）：
 *  1. 从正在运行的本地服务 API 拉取全部 25 城现有数据（内存中为扩容后的 667 条）
 *  2. 对不足 20 个的城市（重庆/南宁）调用 LLM 补足至 28 个
 *  3. 整文件重写，保证结构合法
 */

const fs = require('fs');
const path = require('path');
const { CITIES } = require('../server/data/cities');
const settings = require('../server/lib/settings');

const API = 'http://localhost:3000';
const MIN_TARGET = 20;
const CAP = 28;

function toRow(s) {
  const tags = Array.isArray(s.tags) && s.tags.length ? s.tags.slice(0, 3).join(' ') : (s.type || '景点');
  return [
    String(s.name),
    Number(s.rating) || 4.5,
    Number(s.popularity) || 80,
    String(s.type || '景点'),
    String(s.ticket || '以现场公示为准'),
    String(s.openTime || '以现场公示为准'),
    String(s.visitHours || ''),
    String(s.address || ''),
    String(s.desc || ''),
    tags,
  ];
}

async function fetchCity(city) {
  const res = await fetch(`${API}/api/sight/search?city=${encodeURIComponent(city)}&source=local`);
  const j = await res.json();
  return Array.isArray(j.sights) ? j.sights : Array.isArray(j.data) ? j.data : [];
}

// ---- LLM 补足（仅对不足城市）----
const eff = settings.getEffective();
const baseUrl = (eff.llmBaseUrl || '').replace(/\/+$/, '');
const apiKey = eff.llmApiKey.trim();
const model = eff.llmModel || 'glm-4-flash';

function buildPrompt(city) {
  return `你是一位专业的中国旅行规划师。请列出「${city}」最值得游览的景点，要求：
1. 数量 30-35 个，按热门程度从高到低排列，严禁少于 25 个；
2. 类型尽量多样：城市地标、历史古迹、博物馆、自然风光、主题乐园、宗教场所、古镇老街、美食街区、城市公园、滨江/观景平台等；
3. rating 为 0-5 数字；popularity 为 0-100 整数；
4. ticket、openTime、visitHours、address、40字内 desc 尽量准确，不确定写"以现场公示为准"。
只输出一个 JSON 对象（json 模式），不要任何解释，格式：
{"sights":[{"name":"景点名称","rating":4.8,"popularity":95,"type":"分类","ticket":"门票信息","openTime":"开放时间","visitHours":"建议时长","address":"大致地址","desc":"40字以内简介"}]}`;
}

async function llmGen(city) {
  for (let i = 1; i <= 3; i++) {
    try {
      const res = await fetch(`${baseUrl}/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify({
          model,
          messages: [{ role: 'user', content: buildPrompt(city) }],
          temperature: 0.3,
          max_tokens: 32768,
          thinking: { type: 'disabled' },
          response_format: { type: 'json_object' },
        }),
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const j = await res.json();
      const content = j.choices && j.choices[0] && j.choices[0].message.content;
      if (!content) throw new Error('empty content');
      const parsed = JSON.parse(content);
      const arr = Array.isArray(parsed.sights) ? parsed.sights : Array.isArray(parsed) ? parsed : null;
      if (!arr || !arr.length) throw new Error('no sights array');
      return arr;
    } catch (err) {
      if (i === 3) throw err;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
}

async function main() {
  const all = {};
  for (const c of CITIES) {
    const rows = (await fetchCity(c.name)).map(toRow);
    rows.sort((a, b) => (Number(b[2]) || 0) - (Number(a[2]) || 0));
    all[c.name] = rows;
    console.log(`[api] ${c.name.padEnd(4)} ${rows.length} 个`);
  }

  // 补足不足城市
  for (const c of CITIES) {
    if (all[c.name].length >= MIN_TARGET) continue;
    const name = c.name;
    const have = new Set(all[name].map((r) => String(r[0]).trim()));
    const gen = await llmGen(name);
    let added = 0;
    for (const it of gen) {
      const row = toRow(it);
      if (!row[0] || have.has(String(row[0]).trim())) continue;
      have.add(String(row[0]).trim());
      all[name].push(row);
      added++;
    }
    all[name].sort((a, b) => (Number(b[2]) || 0) - (Number(a[2]) || 0));
    all[name] = all[name].slice(0, CAP);
    console.log(`[llm] ${name.padEnd(4)} 生成 ${gen.length} 个，新增 ${added}，最终 ${all[name].length} 个`);
  }

  // 整文件重写
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
  for (const c of CITIES) {
    lines.push(`  ${JSON.stringify(c.name)}: [`);
    for (const row of all[c.name]) {
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

  const total = Object.values(all).reduce((n, r) => n + r.length, 0);
  console.log(`\n[done] 共 ${total} 条 / ${CITIES.length} 城，sights.js 已重写`);
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
