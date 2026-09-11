'use strict';

const { haversineKm, minutesToHHMM } = require('../lib/geo');
const { createRng } = require('../lib/random');

/**
 * 火车票数据源（当前为确定性模拟数据：同一查询条件永远返回同一结果）。
 *
 * 接入真实数据源（如 12306 查询接口）时：
 * 实现相同签名的 async search({ from, to, date }) 并返回同结构的数据，
 * 在 routes/search.js 中替换本模块即可，上层无需改动。
 *
 * 返回字段：
 *   trainNo / trainType / overnight / depTime / arrTime / arrDayOffset
 *   depStation / arrStation / durationMin / stops / seats[{ class, price, status }]
 */
async function search({ from, to, date }) {
  // 铁路绕行系数：直线距离 × 1.22 近似线路里程
  const railKm = Math.round(haversineKm(from.lat, from.lng, to.lat, to.lng) * 1.22);
  const rng0 = createRng(`${from.name}|${to.name}|${date}|train-count`);
  const trains = [];

  const pickHsrStation = (city, rng) =>
    city.stations[Math.floor(rng() * Math.min(city.stations.length, 2))];
  const pickClassicStation = (city) => city.stations[city.stations.length - 1];

  // ---- 高铁 G：4-8 班，06:10–18:40 间分布 ----
  const gCount = 4 + Math.floor(rng0() * 5);
  for (let i = 0; i < gCount; i += 1) {
    const rng = createRng(`${from.name}|${to.name}|${date}|g|${i}`);
    const firstDep = 6 * 60 + 10;
    const lastDep = 18 * 60 + 40;
    const step = (lastDep - firstDep) / Math.max(gCount - 1, 1);
    const depMin = Math.round(firstDep + step * i + (rng() - 0.5) * 30);
    const stops = 2 + Math.floor(rng() * 8);
    const durationMin = Math.round((railKm / 275) * 60) + stops * 6;
    const arrTotal = depMin + durationMin;

    trains.push({
      type: 'train',
      trainNo: `G${101 + i * 7 + Math.floor(rng() * 5)}`,
      trainType: '高铁',
      overnight: false,
      depTime: minutesToHHMM(depMin),
      arrTime: minutesToHHMM(arrTotal),
      arrDayOffset: Math.floor(arrTotal / 1440),
      depStation: pickHsrStation(from, rng),
      arrStation: pickHsrStation(to, rng),
      durationMin,
      stops,
      seats: buildSeats(rng, [
        ['二等座', Math.round(railKm * 0.46)],
        ['一等座', Math.round(railKm * 0.78)],
        ['商务座', Math.round(railKm * 1.52)],
      ]),
    });
  }

  // ---- 动车 D：中短途线路 1-2 班 ----
  if (railKm < 1500) {
    const dCount = 1 + Math.floor(rng0() * 2);
    for (let i = 0; i < dCount; i += 1) {
      const rng = createRng(`${from.name}|${to.name}|${date}|d|${i}`);
      const depMin = 7 * 60 + 30 + Math.floor(rng() * 11 * 60);
      const stops = 3 + Math.floor(rng() * 9);
      const durationMin = Math.round((railKm / 195) * 60) + stops * 5;
      const arrTotal = depMin + durationMin;

      trains.push({
        type: 'train',
        trainNo: `D${2201 + i * 13 + Math.floor(rng() * 9)}`,
        trainType: '动车',
        overnight: false,
        depTime: minutesToHHMM(depMin),
        arrTime: minutesToHHMM(arrTotal),
        arrDayOffset: Math.floor(arrTotal / 1440),
        depStation: pickHsrStation(from, rng),
        arrStation: pickHsrStation(to, rng),
        durationMin,
        stops,
        seats: buildSeats(rng, [
          ['二等座', Math.round(railKm * 0.31)],
          ['一等座', Math.round(railKm * 0.52)],
        ]),
      });
    }
  }

  // ---- 普速 K/Z：较长线路 1-2 班，多在夜间出发 ----
  if (railKm > 700) {
    const kCount = 1 + Math.floor(rng0() * 2);
    for (let i = 0; i < kCount; i += 1) {
      const rng = createRng(`${from.name}|${to.name}|${date}|k|${i}`);
      const depMin = 19 * 60 + Math.floor(rng() * 4 * 60 + 30);
      const durationMin = Math.round((railKm / 100) * 60) + 45;
      const arrTotal = depMin + durationMin;

      trains.push({
        type: 'train',
        trainNo: `${rng() > 0.5 ? 'Z' : 'K'}${101 + i * 37 + Math.floor(rng() * 20)}`,
        trainType: '普速',
        overnight: true,
        depTime: minutesToHHMM(depMin),
        arrTime: minutesToHHMM(arrTotal),
        arrDayOffset: Math.floor(arrTotal / 1440),
        depStation: pickClassicStation(from),
        arrStation: pickClassicStation(to),
        durationMin,
        stops: 8 + Math.floor(rng() * 12),
        seats: buildSeats(rng, [
          ['硬座', Math.round(railKm * 0.16)],
          ['硬卧', Math.round(railKm * 0.3)],
          ['软卧', Math.round(railKm * 0.47)],
        ]),
      });
    }
  }

  trains.sort((a, b) => a.depTime.localeCompare(b.depTime));
  return trains;
}

/** 生成席别与余票状态：有票 / 少量 / 候补 */
function buildSeats(rng, defs) {
  return defs.map(([className, price]) => {
    const r = rng();
    const status = r < 0.62 ? '有票' : r < 0.86 ? '少量' : '候补';
    return { class: className, price, status };
  });
}

module.exports = { search };
