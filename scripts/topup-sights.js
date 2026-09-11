'use strict';

/** 定向补足：对指定城市用更强的提示词生成 30-35 个景点并合并进 sights.js */
const fs = require('fs');
const path = require('path');
const settings = require('../server/lib/settings');

const TARGETS = ['重庆', '南宁'];
const MAX_ATTEMPTS = 3;
const CAP = 28;

const eff = settings.getEffective();
const baseUrl = (eff.llmBaseUrl || '').replace(/\/+$/, '');
const apiKey = eff.llmApiKey.trim();
const model = eff.llmModel || 'glm-4-flash';

function buildPrompt(city) {
  return `你是一位专业的中国旅行规划师。请列出「${city}」最值得游览的景点，要求：

1. 数量 30-35 个，按热门程度从高到低排列，严禁少于 25 个；
2. 请覆盖尽可能多样的类型：城市地标、历史古迹、博物馆、自然风光、主题乐园、宗教场所、古镇老街、美食街区、城市公园、滨江/观景平台等，避免大量重复同质景点；
3. 评分 rating 为 0-5 的数字；热度 popularity 为 0-100 的整数；
4. 门票 ticket、开放时间 openTime、建议时长 visitHours、地址 address、40字内简介 desc 尽量准确，不确定写"以现场公示为准"。

只输出一个 JSON 对象（json 模式），不要任何解释文字，格式：
{"sights":[{"name":"景点名称","rating":4.8,"popularity":95,"type":"分类","ticket":"门票信息","openTime":"开放时间","visitHours":"建议时长","address":"大致地址","desc":"40字以内简介"}]}`;
}

async function fetchSights(city) {
  let lastErr;
  for (let i = 1; i <= MAX_ATTEMPTS; i++) {
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
      if (!arr || arr.length === 0) throw new Error('no sights array');
      return arr.map((it) => [
        String(it.name || ''),
        Number.isFinite(Number(it.rating)) ? Number(it.rating) : 4.5,
        Number.isFinite(Number(it.popularity)) ? Number(it.popularity) : 80,
        String(it.type || '景点'),
        String(it.ticket || '以现场公示为准'),
        String(it.openTime || '以现场公示为准'),
        String(it.visitHours || ''),
        String(it.address || ''),
        String(it.desc || ''),
        String(it.tags && it.tags[0] || '景点'),
      ]);
    } catch (err) {
      lastErr = err.message;
      await new Promise((r) => setTimeout(r, 1500));
    }
  }
  throw new Error(lastErr);
}

async function main() {
  const src = fs.readFileSync(path.join(__dirname, '../server/data/sights.js'), 'utf8');
  // 读取现有 SIGHTS 对象（直接 require，但需要拿到数据）：
  const data = require('../server/data/sights');
  for (const city of TARGETS) {
    const existing = data.getSightsByCity(city);
    const have = new Set(existing.map((s) => s.name.trim()));
    const rows = existing.map((s) => [
      s.name, s.rating, s.popularity, s.type, s.ticket, s.openTime,
      s.visitHours || '', s.address || '', s.desc || '', (s.tags || []).join(' '),
    ]);
    console.log(`[${city}] 现有 ${rows.length} 个`);
    const gen = await fetchSights(city);
    let added = 0;
    for (const row of gen) {
      if (!row[0] || have.has(String(row[0]).trim())) continue;
      have.add(String(row[0]).trim());
      rows.push(row);
      added++;
    }
    rows.sort((a, b) => (Number(b[2]) || 0) - (Number(a[2]) || 0));
    const finalRows = rows.slice(0, CAP);
    console.log(`[${city}] 生成 ${gen.length} 个，新增 ${added}，最终 ${finalRows.length} 个`);

    // 替换 sights.js 中该城市条目
    const re = new RegExp(`(  "${city}": \\[)([\\s\\S]*?)(\\],)`);
    const block = finalRows.map((r) => `    ${JSON.stringify(r)},`).join('\n');
    const out = src.replace(re, `  "${city}": [\n${block}\n  ],`);
    fs.writeFileSync(path.join(__dirname, '../server/data/sights.js'), out, 'utf8');
    console.log(`[${city}] 已写入 sights.js`);
  }
  console.log('done');
}

main().catch((e) => { console.error('FATAL:', e); process.exit(1); });
