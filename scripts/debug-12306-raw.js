'use strict';

/**
 * 调试脚本：直接请求 12306 票价/余票接口，dump 原始行，
 * 用于分析「同一车次多行（不同到达站/出发站）」的数据结构。
 * 用法：node scripts/debug-12306-raw.js <from> <to> <date>
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BASE = 'https://kyfw.12306.cn';
let cookie = null;
let leftTicketPath = 'queryG';

async function fetchWithTimeout(url, options = {}, timeoutMs = 12000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function ensureSession() {
  const res = await fetchWithTimeout(`${BASE}/otn/leftTicket/init?linktypeid=dc`, {
    headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
  });
  try { await res.text(); } catch { /* ignore */ }
  const parts = (typeof res.headers.getSetCookie === 'function')
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  const pairs = parts.map((l) => l.split(';')[0].trim()).filter(Boolean);
  if (pairs.length === 0) throw new Error('no cookie');
  cookie = pairs.join('; ');
}

async function getJson(path, retried = false) {
  if (!cookie) await ensureSession();
  const res = await fetchWithTimeout(`${BASE}${path}`, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      Referer: `${BASE}/otn/leftTicket/init`,
      Cookie: cookie,
    },
  });
  if (res.status === 302 || res.status === 401) {
    if (retried) throw new Error('session loop');
    cookie = null;
    return getJson(path, true);
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return JSON.parse(await res.text());
}

async function loadStationMap() {
  const res = await fetchWithTimeout(`${BASE}/otn/resources/js/framework/station_name.js`, {
    headers: { 'User-Agent': UA, Accept: '*/*' },
  }, 15000);
  const text = await res.text();
  const byName = new Map();
  const byCode = new Map();
  const byCity = new Map();
  for (const m of text.matchAll(/@([a-z]+)\|([^|]+)\|([A-Z]+)\|[^|]*\|[^|]*\|\d+\|[0-9A-Z]+\|([^|]*)\|/g)) {
    const [, , name, code, city] = m;
    if (name && code) { byName.set(name, code); byCode.set(code, { name, city }); }
    if (city && code && !byCity.has(city)) byCity.set(city, code);
  }
  return { byName, byCode, byCity };
}

async function main() {
  const [from, to, date] = process.argv.slice(2);
  if (!from || !to || !date) {
    console.error('用法：node scripts/debug-12306-raw.js <from> <to> <YYYY-MM-DD>');
    process.exit(1);
  }

  const { byName, byCity, byCode } = await loadStationMap();
  const fromCode = byCity.get(from) || byName.get(from);
  const toCode = byCity.get(to) || byName.get(to);
  console.log(`城市电报码：${from}=${fromCode} ${to}=${toCode}`);

  const qs = `leftTicketDTO.train_date=${date}&leftTicketDTO.from_station=${fromCode}&leftTicketDTO.to_station=${toCode}&purpose_codes=ADULT`;

  const priceData = await getJson(`/otn/leftTicketPrice/queryAllPublicPrice?${qs}`);
  const priceRows = (priceData && priceData.data) || [];
  console.log(`\n== queryAllPublicPrice 返回 ${priceRows.length} 行 ==`);

  // 按车次号分组统计
  const groups = new Map();
  for (const row of priceRows) {
    const dto = row.queryLeftNewDTO;
    if (!dto) continue;
    const no = dto.station_train_code;
    if (!groups.has(no)) groups.set(no, []);
    groups.get(no).push(dto);
  }
  for (const [no, dtos] of groups) {
    if (dtos.length === 1) continue;
    console.log(`\n### 车次 ${no} 有 ${dtos.length} 行：`);
    for (const dto of dtos) {
      console.log(JSON.stringify({
        train_no: dto.train_no,
        code: dto.station_train_code,
        from: dto.from_station_name, fromTele: dto.from_station_telecode,
        to: dto.to_station_name, toTele: dto.to_station_telecode,
        start_time: dto.start_time, arrive_time: dto.arrive_time,
        lishi: dto.lishi, day_difference: dto.day_difference,
        ze: dto.ze_price, zy: dto.zy_price, swz: dto.swz_price,
        rw: dto.rw_price, yw: dto.yw_price, yz: dto.yz_price,
      }));
    }
  }
  const multiCount = [...groups.values()].filter((v) => v.length > 1).length;
  console.log(`\n多行车次组数：${multiCount} / 总车次 ${groups.size}`);

  // 余票接口对照
  let avail = await getJson(`/otn/leftTicket/${leftTicketPath}?${qs}`);
  if (avail && avail.c_url) {
    leftTicketPath = String(avail.c_url).replace(/^leftTicket\//, '');
    avail = await getJson(`/otn/leftTicket/${leftTicketPath}?${qs}`);
  }
  const availRows = (avail && avail.data && avail.data.result) || [];
  console.log(`\n== leftTicket 余票接口返回 ${availRows.length} 行 ==`);
  const availGroups = new Map();
  for (const row of availRows) {
    const f = String(row).split('|');
    availGroups.set(f[3], (availGroups.get(f[3]) || 0) + 1);
  }
  const availMulti = [...availGroups.entries()].filter(([, n]) => n > 1);
  console.log('余票接口多行车次：', availMulti.map(([k, n]) => `${k}×${n}`).join(', ') || '无');

  // dump 多行车次的完整余票行（含两段的余票/yp_info 对照）
  for (const [no] of availMulti) {
    console.log(`\n### 余票 ${no} 各行关键字段：`);
    for (const row of availRows) {
      const f = String(row).split('|');
      if (f[3] !== no) continue;
      console.log(JSON.stringify({
        idx2_train_no: f[2], code: f[3],
        idx6: f[6], idx7: f[7],
        from: f[8] !== undefined ? f[8] : '', // 占位，具体下标以输出为准
        f4: f[4], f5: f[5], f6: f[6], f7: f[7], f8: f[8], f9: f[9], f10: f[10], f11: f[11], f12: f[12],
        swz32: f[32], zy31: f[31], ze30: f[30], rw23: f[23], yw28: f[28], yz29: f[29],
        yp39: f[39],
      }));
    }
    console.log(`\n### 余票 ${no} 完整原始行（可直接作测试夹具）：`);
    for (const row of availRows) {
      if (String(row).split('|')[3] === no) console.log(JSON.stringify(String(row)));
    }
  }

  // 打印票价接口有但余票接口没有的（或反之）
  const priceNos = new Set([...groups.keys()]);
  const availNos = new Set(availGroups.keys());
  const onlyPrice = [...priceNos].filter((n) => !availNos.has(n));
  const onlyAvail = [...availNos].filter((n) => !priceNos.has(n));
  console.log('\n仅票价接口有的车次：', onlyPrice.join(', ') || '无');
  console.log('仅余票接口有的车次：', onlyAvail.join(', ') || '无');
}

main().catch((err) => {
  console.error('失败：', err.message);
  process.exit(1);
});
