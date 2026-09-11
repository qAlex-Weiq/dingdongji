'use strict';

/**
 * 12306 实时火车票数据源（真实票价 + 真实余票）
 *
 * 数据来源：中国铁路 12306 官方公开查询接口
 *   - 车次/余票：/otn/leftTicket/queryG（端点名会轮换，响应含 c_url 时自动切换并重试）
 *   - 真实票价：/otn/leftTicketPrice/queryAllPublicPrice（余票接口的 yp_info 已加密，票价必须单独取）
 *   - 站点电报码：/otn/resources/js/framework/station_name.js
 *
 * 已实测的关键结论（2026-09）：
 *   - 查询时传任一站码即按"城市"扩展返回同城所有车站的车次（北京北 VAP → 返回北京南/北京/丰台共 55 班）
 *   - 票价格式为 5 位字符串，末位是十分位："07950" = 795.0 元
 *   - 余票为管道分隔字段：[23]软卧 [26]无座 [28]硬卧 [29]硬座 [30]二等 [31]一等 [32]商务 [33]动卧
 *   - 需先 GET /otn/leftTicket/init 拿 JSESSIONID，否则查询接口拒绝
 *
 * 降级策略：任何失败都向上抛错（「12306」前缀），由路由层降级到本地模拟数据。
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';
const BASE = 'https://kyfw.12306.cn';
const CACHE_TTL = 10 * 60 * 1000; // 查询结果缓存 10 分钟
const STATION_TTL = 24 * 60 * 60 * 1000; // 站点表缓存 24 小时
const TIMEOUT = 12000;

// ---- 模块级状态 ----
let cookie = null; // 'JSESSIONID=xxx; ...'
let leftTicketPath = 'queryG'; // 余票端点名（会轮换，不带 leftTicket/ 前缀）
const queryCache = new Map(); // key -> { ts, value }
const inflight = new Map(); // key -> Promise（在途去重）
let stationMapPromise = null; // { byName: Map, byCity: Map }
let stationMapTs = 0;

// ---- 席别定义：票价字段名 -> 展示名（价格接口） ----
const PRICE_FIELDS = [
  ['swz_price', '商务座'],
  ['zy_price', '一等座'],
  ['ze_price', '二等座'],
  ['rw_price', '软卧'],
  ['yw_price', '硬卧'],
  ['yz_price', '硬座'],
];

// ---- 余票管道字段的列下标（queryG result，已交叉验证） ----
const AVAIL_COLS = { 商务座: 32, 一等座: 31, 二等座: 30, 软卧: 23, 硬卧: 28, 硬座: 29 };

// ---- 明文 yp_info：余票行里同时携带的「实际执行价（含折扣）+ 余量」 ----
// 格式为 10 字符一组：席别代码(1) + 价格(5，前 4 位元 + 末位角) + 余量(4)。
// 代码与席别对应（2026-09 实测验证）：9 商务 / M 一等 / O 二等 / 4 软卧 / 3 硬卧 / 1 硬座。
// 同一代码出现第二条（余量数千）为无座额度，价格与基础席别相同，展示时跳过。
const YP_SEAT_CODES = { 商务座: '9', 一等座: 'M', 二等座: 'O', 软卧: '4', 硬卧: '3', 硬座: '1' };
const YP_FIELD_RE = /^(?:[0-9A-Z]\d{9}){2,}$/;

/** 从余票管道字段数组中定位明文 yp_info（固定在 [39]，异常时向后扫描兜底） */
function findYpField(fields) {
  if (Array.isArray(fields)) {
    const preferred = fields[39];
    if (typeof preferred === 'string' && YP_FIELD_RE.test(preferred)) return preferred;
    for (let i = 34; i < fields.length; i += 1) {
      const v = fields[i];
      if (typeof v === 'string' && YP_FIELD_RE.test(v)) return v;
    }
  }
  return '';
}

/**
 * 解析明文 yp_info -> { 席别代码: 实际执行价(元) }。
 * 任一条目格式异常则整体放弃（上层回退公布价），保证不产出错误价格。
 */
function parseYpInfo(raw) {
  const out = {};
  const s = String(raw || '');
  if (s.length === 0 || s.length % 10 !== 0) return out;
  for (let i = 0; i < s.length; i += 10) {
    const entry = s.slice(i, i + 10);
    if (!/^[0-9A-Z]\d{9}$/.test(entry)) return {};
    const code = entry[0];
    if (out[code] !== undefined) continue; // 无座额度等重复条目
    const price = Number(entry.slice(1, 5)) + Number(entry.slice(5, 6)) / 10;
    if (price > 0) out[code] = price;
  }
  return out;
}

/** 折扣标签：实际价低于公布价时给出「7.2折」，视为全价（≥9.95折）时不展示 */
function discountLabelOf(actual, published) {
  if (!(published > 0) || !(actual > 0) || actual >= published - 0.5) return undefined;
  const zhe = Math.round((actual / published) * 100) / 10;
  if (zhe >= 9.95) return undefined;
  return `${Number.isInteger(zhe) ? zhe : zhe.toFixed(1)}折`;
}

// ---------------------------------------------------------------- 基础请求

async function fetchWithTimeout(url, options = {}, timeoutMs = TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** 携带会话 cookie 请求 12306 JSON 接口 */
async function getJson(path, tryCount = 0) {
  if (!cookie) await ensureSession();
  const res = await fetchWithTimeout(`${BASE}${path}`, {
    headers: {
      'User-Agent': UA,
      Accept: 'application/json, text/plain, */*',
      Referer: `${BASE}/otn/leftTicket/init`,
      Cookie: cookie,
    },
  });
  // 会话过期：重建后重试一次
  if (res.status === 302 || res.status === 401) {
    if (tryCount >= 1) throw new Error('12306 会话无法建立（重定向循环）');
    cookie = null;
    return getJson(path, tryCount + 1);
  }
  if (!res.ok) throw new Error(`12306 接口返回 HTTP ${res.status}`);
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch (err) {
    throw new Error(`12306 接口返回了无法解析的内容（可能触发风控）`);
  }
}

/** GET /otn/leftTicket/init 采集 set-cookie 建立会话 */
async function ensureSession() {
  const res = await fetchWithTimeout(`${BASE}/otn/leftTicket/init?linktypeid=dc`, {
    headers: { 'User-Agent': UA, Accept: 'text/html,*/*' },
  });
  if (!res.ok && res.status !== 302) throw new Error(`12306 会话初始化失败（HTTP ${res.status}）`);
  // 先读空 body 释放连接，再取 set-cookie
  try { await res.text(); } catch (err) { /* body 读取失败不影响 cookie 采集 */ }
  const parts = (typeof res.headers.getSetCookie === 'function')
    ? res.headers.getSetCookie()
    : (res.headers.get('set-cookie') ? [res.headers.get('set-cookie')] : []);
  const pairs = parts
    .map((line) => line.split(';')[0].trim())
    .filter(Boolean);
  if (pairs.length === 0) throw new Error('12306 会话初始化未返回 cookie');
  cookie = pairs.join('; ');
}

// ---------------------------------------------------------------- 站点电报码

async function loadStationMap() {
  if (stationMapPromise && Date.now() - stationMapTs < STATION_TTL) return stationMapPromise;
  stationMapTs = Date.now();
  stationMapPromise = (async () => {
    const res = await fetchWithTimeout(`${BASE}/otn/resources/js/framework/station_name.js`, {
      headers: { 'User-Agent': UA, Accept: '*/*' },
    }, 15000);
    if (!res.ok) throw new Error(`12306 站点表下载失败（HTTP ${res.status}）`);
    const text = await res.text();
    const byName = new Map(); // 站名 -> 电报码
    const byCity = new Map(); // 城市名 -> 电报码（同城任一站码均可触发城市级查询）
    for (const m of text.matchAll(/@([a-z]+)\|([^|]+)\|([A-Z]+)\|[^|]*\|[^|]*\|\d+\|[0-9A-Z]+\|([^|]*)\|/g)) {
      const [, , name, code, city] = m;
      if (name && code) byName.set(name, code);
      if (city && code && !byCity.has(city)) byCity.set(city, code);
    }
    if (byName.size < 100) throw new Error('12306 站点表解析异常');
    return { byName, byCity };
  })().catch((err) => {
    stationMapPromise = null; // 失败允许下次重试
    throw err;
  });
  return stationMapPromise;
}

/** 城市 -> 查询用电报码（城市里任一已知站均可，12306 会做同城扩展） */
async function cityTelecode(city) {
  const { byName, byCity } = await loadStationMap();
  for (const st of city.stations || []) {
    const code = byName.get(st);
    if (code) return code;
  }
  return byCity.get(city.name) || null;
}

// ---------------------------------------------------------------- 票价解析

/** "07950" -> 795，"01775" -> 177.5（末位是十分位） */
function parsePrice(raw) {
  if (!raw || typeof raw !== 'string' || !/^\d{5}$/.test(raw)) return null;
  const yuan = Number(raw.slice(0, 4)) + Number(raw.slice(4)) / 10;
  return yuan > 0 ? Math.round(yuan * 10) / 10 : null;
}

/** 余票原始值 -> 状态（有 / 数字 / 无 / 空） */
function availToStatus(raw) {
  if (raw === '有') return '有票';
  if (/^\d+$/.test(raw)) return Number(raw) <= 20 ? '少量' : '有票';
  if (raw === '无') return '候补';
  return null; // 空 = 该席别不存在
}

// ---------------------------------------------------------------- 查询

/**
 * 查询两城市间某日期的全部火车班次（真实票价 + 真实余票）。
 * @param {{ from: object, to: object, date: string }} opts from/to 为 cities.js 城市对象
 * @returns {Promise<Array>} 与本地 trainProvider 相同结构的数组
 */
async function search({ from, to, date }) {
  const key = `${from.name}|${to.name}|${date}`;
  const hit = queryCache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.value;
  const pending = inflight.get(key);
  if (pending) return pending;

  const task = (async () => {
    // 预售期预检查（12306 约 15 天，留 1 天余量给"含当天"口径）
    const beijingToday = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
    const maxDate = new Date(`${beijingToday}T00:00:00+08:00`).getTime() + 14 * 86400 * 1000;
    if (new Date(`${date}T00:00:00+08:00`).getTime() > maxDate) {
      throw new Error(`12306 仅可查询预售期内（约 15 天，截至 ${new Date(maxDate).toISOString().slice(0, 10)}）的车次`);
    }
    if (date < beijingToday) {
      throw new Error('12306 不能查询已过去日期的车次');
    }

    const [fromCode, toCode] = await Promise.all([cityTelecode(from), cityTelecode(to)]);
    if (!fromCode) throw new Error(`12306 站点表中找不到「${from.name}」的车站电报码`);
    if (!toCode) throw new Error(`12306 站点表中找不到「${to.name}」的车站电报码`);

    const qs = `leftTicketDTO.train_date=${date}&leftTicketDTO.from_station=${fromCode}&leftTicketDTO.to_station=${toCode}&purpose_codes=ADULT`;

    // 票价（主数据：车次、时刻、历时的权威来源）
    const priceData = await getJson(`/otn/leftTicketPrice/queryAllPublicPrice?${qs}`);
    if (!priceData || priceData.status !== true || !Array.isArray(priceData.data)) {
      throw new Error('12306 票价接口返回异常');
    }
    if (priceData.data.length === 0) {
      throw new Error(`12306 未返回 ${from.name} → ${to.name} 的直达车次`);
    }

    // 余票（尽力而为：失败不影响票价返回，状态显示为「—」）
    const availMap = await loadAvailMap(qs);

    const trains = [];
    const seen = new Set();
    for (const row of priceData.data) {
      const dto = row && row.queryLeftNewDTO;
      if (!dto || !dto.station_train_code) continue;
      const trainNo = String(dto.station_train_code).trim();
      if (!/^[GDCZTKY]\d+/.test(trainNo)) continue; // 过滤"列车运行图调整"等占位行
      const dedupeKey = `${trainNo}|${dto.start_time}`;
      if (seen.has(dedupeKey)) continue;

      const seats = [];
      const avail = availMap.get(`${dto.train_no}|${dto.from_station_telecode}`);
      // 明文 yp_info 的实际执行价（含 12306 折扣），余票行可用时优先于公布价
      const ypPrices = avail ? parseYpInfo(findYpField(avail)) : {};
      for (const [field, className] of PRICE_FIELDS) {
        const published = parsePrice(dto[field]);
        if (published == null) continue;
        const raw = avail ? avail[AVAIL_COLS[className]] : '';
        const actual = ypPrices[YP_SEAT_CODES[className]];
        const price = actual > 0 ? actual : published;
        seats.push({
          class: className,
          price,
          discount: discountLabelOf(price, published),
          status: availToStatus(raw) || '—',
        });
      }
      if (seats.length === 0) continue; // 无任何可售席别的行（如停运/调图）

      const durationMin = parseLishi(dto.lishi);
      const dayDiff = Number(dto.day_difference) || 0;
      seen.add(dedupeKey);
      trains.push({
        type: 'train',
        trainNo,
        trainType: trainTypeOf(trainNo),
        overnight: dayDiff >= 1,
        depTime: String(dto.start_time || '').trim(),
        arrTime: String(dto.arrive_time || '').trim(),
        arrDayOffset: dayDiff,
        depStation: String(dto.from_station_name || '').trim(),
        arrStation: String(dto.to_station_name || '').trim(),
        durationMin,
        stops: null, // 12306 查询接口不含途经站数，前端对 null 不展示
        seats,
      });
    }

    if (trains.length === 0) {
      throw new Error(`12306 未返回 ${from.name} → ${to.name} 的可售车次`);
    }
    trains.sort((a, b) => a.depTime.localeCompare(b.depTime));
    return trains;
  })();

  inflight.set(key, task);
  try {
    const value = await task;
    queryCache.set(key, { ts: Date.now(), value });
    return value;
  } catch (err) {
    // 票价/网络类失败时清掉会话，下次重建
    cookie = null;
    err.message = err.message.startsWith('12306') ? err.message : `12306 查询失败：${err.message}`;
    throw err;
  } finally {
    inflight.delete(key);
  }
}

/** 余票表：train_no|from_telecode -> 管道字段数组 */
async function loadAvailMap(qs) {
  try {
    const first = await getJson(`/otn/leftTicket/${leftTicketPath}?${qs}`);
    const data = (first && first.c_url) // 端点名轮换：按提示切换后重试一次
      ? await getJson(`/otn/leftTicket/${first.c_url}?${qs}`)
      : first;
    if (first && first.c_url) leftTicketPath = String(first.c_url).replace(/^leftTicket\//, '');
    const rows = data && data.data && Array.isArray(data.data.result) ? data.data.result : [];
    const map = new Map();
    for (const row of rows) {
      const f = String(row).split('|');
      if (f.length > 33) map.set(`${f[2]}|${f[6]}`, f);
    }
    return map;
  } catch (err) {
    return new Map(); // 余票拿不到时票价照常返回
  }
}

/** "05:56" -> 356 分钟 */
function parseLishi(str) {
  const m = /^(\d+):(\d+)$/.exec(String(str || '').trim());
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

function trainTypeOf(trainNo) {
  if (/^[GC]/.test(trainNo)) return '高铁';
  if (/^D/.test(trainNo)) return '动车';
  return '普速';
}

/** 清空缓存（设置保存后由路由调用） */
function clearCache() {
  queryCache.clear();
  cookie = null;
}

module.exports = { search, clearCache, _internal: { parsePrice, availToStatus, parseLishi, trainTypeOf, findYpField, parseYpInfo, discountLabelOf } };
