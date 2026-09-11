'use strict';

/**
 * 机票实时数据源：Amadeus Self-Service Flight Offers Search API v2
 *
 * 数据链路：
 *   1. OAuth2 client_credentials 换 access_token（缓存至过期前 2 分钟）
 *   2. GET /v2/shopping/flight-offers 查询直飞航班（城市码粒度，含税总价 CNY）
 *   3. 归一化为与本地 flightProvider 完全相同的数据结构
 *
 * 未配置或查询失败时，由 routes/ticket.js 降级到本地模拟数据并透出原因。
 * 测试环境默认 host：https://test.api.amadeus.com（可用环境变量 AMADEUS_HOST 覆盖）。
 */

const { getEffective } = require('../lib/settings');

const HOST = (process.env.AMADEUS_HOST || 'https://test.api.amadeus.com').replace(/\/+$/, '');
const TOKEN_URL = `${HOST}/v1/security/oauth2/token`;
const OFFERS_URL = `${HOST}/v2/shopping/flight-offers`;

const CACHE_TTL = 10 * 60 * 1000; // 查询结果缓存 10 分钟
const queryCache = new Map(); // key -> { ts, value }
const inflight = new Map(); // key -> Promise（在途去重）
let tokenCache = null; // { clientId, token, expiresAt }

/** 城市 -> IATA 城市码（城市码可覆盖同城多机场，如北京 BJS = 首都+大兴） */
const CITY_IATA = {
  北京: 'BJS', 上海: 'SHA', 广州: 'CAN', 深圳: 'SZX', 成都: 'CTU', 杭州: 'HGH', 西安: 'SIA',
  重庆: 'CKG', 武汉: 'WUH', 长沙: 'CSX', 南京: 'NKG', 厦门: 'XMN', 昆明: 'KMG', 青岛: 'TAO',
  天津: 'TSN', 郑州: 'CGO', 哈尔滨: 'HRB', 大连: 'DLC', 三亚: 'SYX', 乌鲁木齐: 'URC',
  兰州: 'LHW', 贵阳: 'KWE', 南宁: 'NNG', 福州: 'FOC', 济南: 'TNA',
};

/** 常见承运航司中文名（Amadeus dictionaries 只给英文名，优先本地映射） */
const AIRLINE_CN = {
  CA: '中国国际航空', MU: '中国东方航空', CZ: '中国南方航空', HU: '海南航空', '3U': '四川航空',
  MF: '厦门航空', ZH: '深圳航空', HO: '吉祥航空', '9C': '春秋航空', GS: '天津航空',
  SC: '山东航空', FM: '上海航空', KN: '中国联合航空', EU: '成都航空', GJ: '长龙航空',
  TV: '西藏航空', KY: '昆明航空', PN: '西部航空', DZ: '东海航空', UQ: '乌鲁木齐航空',
  AQ: '九元航空', NS: '河北航空', GX: '北部湾航空', CN: '大新华航空',
};

/** "PT2H35M" / "PT8H35M" / "P1DT2H" -> 分钟 */
function parseIsoDuration(str) {
  const m = /^P(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?$/.exec(String(str || ''));
  if (!m) return null;
  return (Number(m[1]) || 0) * 1440 + (Number(m[2]) || 0) * 60 + (Number(m[3]) || 0);
}

/** "2026-09-15T08:30:00+08:00" -> { date: '2026-09-15', time: '08:30' } */
function isoToDateTime(iso) {
  const s = String(iso || '');
  const m = /T(\d{2}:\d{2})/.exec(s);
  return { date: s.slice(0, 10), time: m ? m[1] : null };
}

/** 机场代码 -> 「PEK 首都机场」展示标签（仅查两端城市的机场表，查不到就只显示代码） */
function airportLabel(code, from, to) {
  const pool = [...(from.airports || []), ...(to.airports || [])];
  const hit = pool.find((a) => a && a.code === code);
  return hit && hit.name ? `${code} ${hit.name}` : String(code || '');
}

/** 将一条 flight-offer 归一化为应用统一的航班结构；无效数据返回 null */
function normalizeOffer(offer, from, to, dictionaries) {
  if (!offer || typeof offer !== 'object') return null;
  const itinerary = offer.itineraries && offer.itineraries[0];
  if (!itinerary || !Array.isArray(itinerary.segments) || itinerary.segments.length === 0) return null;
  const seg = itinerary.segments[0];

  const dep = isoToDateTime(seg.departure && seg.departure.at);
  const arr = isoToDateTime(seg.arrival && seg.arrival.at);
  if (!dep.time || !arr.time) return null;

  const durationMin = parseIsoDuration(itinerary.duration) || parseIsoDuration(seg.duration) || null;

  let arrDayOffset = 0;
  if (dep.date && arr.date) {
    const diff = (new Date(`${arr.date}T00:00:00Z`) - new Date(`${dep.date}T00:00:00Z`)) / 86400000;
    if (Number.isFinite(diff)) arrDayOffset = Math.max(0, Math.round(diff));
  }

  const totalRaw = offer.price && (offer.price.grandTotal || offer.price.total);
  const price = Math.round(Number(totalRaw));
  if (!Number.isFinite(price) || price <= 0 || price > 50000) return null; // 防御异常报价

  const carrier = String(seg.carrierCode || '').toUpperCase();
  const number = String(seg.number || '').replace(/^0+/, '');
  if (!carrier || !number) return null;

  const dictName = dictionaries && dictionaries.carriers && dictionaries.carriers[carrier];
  return {
    type: 'flight',
    flightNo: `${carrier}${number}`,
    airline: AIRLINE_CN[carrier] || dictName || carrier,
    depTime: dep.time,
    arrTime: arr.time,
    arrDayOffset,
    depAirport: airportLabel(seg.departure.iataCode, from, to),
    arrAirport: airportLabel(seg.arrival.iataCode, from, to),
    durationMin,
    price,
    discountLabel: '实时价',
    punctuality: null, // Amadeus 报价接口不含准点率，前端缺省不展示
  };
}

// ---------------------------------------------------------------- OAuth2

async function fetchToken(clientId, clientSecret) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 15000);
  try {
    const res = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }).toString(),
      signal: controller.signal,
    });
    if (!res.ok) {
      if (res.status === 400 || res.status === 401) {
        throw new Error('Client ID / Client Secret 无效，请核对后重试');
      }
      throw new Error(`认证接口返回 HTTP ${res.status}`);
    }
    const d = await res.json().catch(() => null);
    if (!d || !d.access_token) throw new Error('认证响应缺少 access_token');
    tokenCache = {
      clientId,
      token: d.access_token,
      expiresAt: Date.now() + (Number(d.expires_in) || 1799) * 1000 - 120000,
    };
    return d.access_token;
  } finally {
    clearTimeout(timer);
  }
}

/** 取 token：同 Client ID 且未过期时复用缓存；force=true 用于设置页「测试连接」 */
async function getToken(clientId, clientSecret, force = false) {
  if (!force && tokenCache && tokenCache.clientId === clientId && Date.now() < tokenCache.expiresAt) {
    return tokenCache.token;
  }
  return fetchToken(clientId, clientSecret);
}

/** 测试凭据有效性（设置页调用，成功后 token 直接留作缓存） */
async function testConnection(clientId, clientSecret) {
  await getToken(clientId, clientSecret, true);
  return true;
}

// ---------------------------------------------------------------- 查询

async function fetchOffers(token, origin, dest, date) {
  const params = new URLSearchParams({
    originLocationCode: origin,
    destinationLocationCode: dest,
    departureDate: date,
    adults: '1',
    currencyCode: 'CNY',
    nonStop: 'true', // 仅直飞（界面不支持中转展示）
    max: '20',
  });
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const res = await fetch(`${OFFERS_URL}?${params.toString()}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const d = await res.json().catch(() => null);
    if (!res.ok) {
      const detail = d && d.errors && d.errors[0] && (d.errors[0].detail || d.errors[0].title);
      throw new Error(detail ? String(detail).slice(0, 120) : `航班接口返回 HTTP ${res.status}`);
    }
    return d || {};
  } finally {
    clearTimeout(timer);
  }
}

async function queryOffers(token, from, to, date) {
  const cityO = CITY_IATA[from.name];
  const cityD = CITY_IATA[to.name];
  const airportO = from.airports && from.airports[0] && from.airports[0].code;
  const airportD = to.airports && to.airports[0] && to.airports[0].code;
  const origin = cityO || airportO;
  const dest = cityD || airportD;
  if (!origin || !dest) {
    throw new Error(`缺少 ${from.name} / ${to.name} 的机场代码映射`);
  }
  try {
    return await fetchOffers(token, origin, dest, date);
  } catch (err) {
    // 个别城市码不被接口接受时，回退到具体机场码重试一次
    if ((airportO && airportO !== origin) || (airportD && airportD !== dest)) {
      return fetchOffers(token, airportO || origin, airportD || dest, date);
    }
    throw err;
  }
}

/**
 * 查询两城市间某日期的航班（含税总价 CNY）。
 * @param {{ from: object, to: object, date: string }} opts from/to 为 cities.js 城市对象
 * @returns {Promise<Array>} 与本地 flightProvider 相同结构的数组
 */
async function search({ from, to, date }) {
  const eff = getEffective();
  if (!eff.amadeusClientId || !eff.amadeusSecret) {
    throw new Error('未配置 Amadeus（可在设置页填写 Client ID / Client Secret）');
  }

  const key = `${from.name}|${to.name}|${date}`;
  const hit = queryCache.get(key);
  if (hit && Date.now() - hit.ts < CACHE_TTL) return hit.value;
  const pending = inflight.get(key);
  if (pending) return pending;

  const task = (async () => {
    const token = await getToken(eff.amadeusClientId, eff.amadeusSecret);
    const d = await queryOffers(token, from, to, date);
    const dictionaries = d.dictionaries || {};
    const flights = (Array.isArray(d.data) ? d.data : [])
      .map((offer) => normalizeOffer(offer, from, to, dictionaries))
      .filter(Boolean);
    if (flights.length === 0) {
      throw new Error(`Amadeus 未返回 ${from.name} → ${to.name} 当日可售直飞航班`);
    }
    flights.sort((a, b) => a.depTime.localeCompare(b.depTime));
    queryCache.set(key, { ts: Date.now(), value: flights });
    return flights;
  })().finally(() => {
    inflight.delete(key);
  });

  inflight.set(key, task);
  return task;
}

/** 清空缓存（设置保存后由路由调用） */
function clearCache() {
  queryCache.clear();
  tokenCache = null;
}

module.exports = {
  search,
  clearCache,
  testConnection,
  _internal: { parseIsoDuration, isoToDateTime, normalizeOffer, CITY_IATA, AIRLINE_CN },
};
