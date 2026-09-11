'use strict';

const { haversineKm, minutesToHHMM } = require('../lib/geo');
const { createRng } = require('../lib/random');

const AIRLINES = [
  { code: 'CA', name: '中国国际航空' },
  { code: 'MU', name: '中国东方航空' },
  { code: 'CZ', name: '中国南方航空' },
  { code: 'HU', name: '海南航空' },
  { code: '3U', name: '四川航空' },
  { code: 'MF', name: '厦门航空' },
  { code: 'ZH', name: '深圳航空' },
  { code: 'HO', name: '吉祥航空' },
];

/**
 * 机票数据源（当前为确定性模拟数据：同一查询条件永远返回同一结果）。
 *
 * 接入真实数据源（航司直销 / OTA / 聚合 API）时：
 * 实现相同签名的 async search({ from, to, date }) 并返回同结构的数据，
 * 在 routes/search.js 中替换本模块即可，上层无需改动。
 *
 * 返回字段：
 *   flightNo / airline / depTime / arrTime / arrDayOffset
 *   depAirport / arrAirport / durationMin / price / discountLabel / punctuality
 */
async function search({ from, to, date }) {
  const distanceKm = Math.round(haversineKm(from.lat, from.lng, to.lat, to.lng));
  const count = 6 + Math.floor(createRng(`${from.name}|${to.name}|${date}|flight-count`)() * 5); // 6-10 班

  const flights = [];
  for (let i = 0; i < count; i += 1) {
    const rng = createRng(`${from.name}|${to.name}|${date}|flight|${i}`);
    const airline = AIRLINES[Math.floor(rng() * AIRLINES.length)];
    const flightNo = `${airline.code}${1000 + Math.floor(rng() * 8000)}`;

    // 出发时间在 06:20–21:40 间均匀分布，并加入少量抖动
    const firstDep = 6 * 60 + 20;
    const lastDep = 21 * 60 + 40;
    const step = (lastDep - firstDep) / Math.max(count - 1, 1);
    const depMin = Math.round(firstDep + step * i + (rng() - 0.5) * 36);

    // 飞行时长：按 760km/h 巡航 + 起降滑行余量
    const durationMin = Math.round((distanceKm / 760) * 60) + 35 + Math.floor(rng() * 3) * 5;

    const depAirport = from.airports[Math.floor(rng() * from.airports.length)];
    const arrAirport = to.airports[Math.floor(rng() * to.airports.length)];

    // 参考票价：里程基础价 × 时段系数 × 折扣
    const base = 380 + distanceKm * 0.5;
    const hour = depMin / 60;
    let timeFactor = 1;
    if ((hour >= 7 && hour < 9.5) || (hour >= 17 && hour < 19.5)) timeFactor = 1.28; // 高峰
    else if (hour >= 11 && hour < 14) timeFactor = 1.05;
    else if (hour < 7 || hour >= 21) timeFactor = 0.82; // 早班/晚班
    const discount = 0.45 + rng() * 0.5;
    const price = Math.max(190, Math.round((base * timeFactor * discount) / 10) * 10);
    const discountLabel =
      discount >= 0.95 ? '全价' : `${(discount * 10).toFixed(1).replace(/\.0$/, '')}折`;

    const arrTotal = depMin + durationMin;
    flights.push({
      type: 'flight',
      flightNo,
      airline: airline.name,
      depTime: minutesToHHMM(depMin),
      arrTime: minutesToHHMM(arrTotal),
      arrDayOffset: Math.floor(arrTotal / 1440),
      depAirport: `${depAirport.code} ${depAirport.name}`,
      arrAirport: `${arrAirport.code} ${arrAirport.name}`,
      durationMin,
      price,
      discountLabel,
      punctuality: 82 + Math.floor(rng() * 17),
    });
  }

  flights.sort((a, b) => a.depTime.localeCompare(b.depTime));
  return flights;
}

module.exports = { search };
