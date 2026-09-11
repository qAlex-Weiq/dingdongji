'use strict';

/**
 * 离线单测：12306 同车次多到发站（同城多段）解析
 * 回归「同一班次到达不同地点没有全部显示 / 目的地与价格错乱」bug。
 *
 * 夹具为 2026-09-12 从 12306 官方接口抓取的真实原始行：
 *   - G811 北京南→杭州东(HGH)/杭州南(XHH)：同车次同出发时间、不同到达站
 *     （旧去重键 车次|出发时间 会吞掉第二段；旧余票键 train_no|from 使两段互相覆盖、价格错配）
 *   - G5 北京(BJP)/北京南(VNP)→上海：同车次不同出发站
 * 运行：node scripts/test-train-multistation.js
 */

const { _internal } = require('../server/providers/trainProvider12306');
const { buildTrains, buildAvailMap } = _internal;

// ---- queryAllPublicPrice 票价行（真实抓取，节选解析涉及字段） ----
const PRICE_ROWS = [
  // G811 两段：出发时间相同 09:34，到达杭州南 15:53 / 杭州东 15:39
  { queryLeftNewDTO: { train_no: '240000G81105', station_train_code: 'G811', from_station_name: '北京南', from_station_telecode: 'VNP', to_station_name: '杭州南', to_station_telecode: 'XHH', start_time: '09:34', arrive_time: '15:53', lishi: '06:19', day_difference: '0', swz_price: '27690', zy_price: '12660', ze_price: '07910' } },
  { queryLeftNewDTO: { train_no: '240000G81105', station_train_code: 'G811', from_station_name: '北京南', from_station_telecode: 'VNP', to_station_name: '杭州东', to_station_telecode: 'HGH', start_time: '09:34', arrive_time: '15:39', lishi: '06:05', day_difference: '0', swz_price: '27300', zy_price: '12480', ze_price: '07800' } },
  // G5 两段：出发北京 07:40 / 北京南 07:59
  { queryLeftNewDTO: { train_no: '24000000G520', station_train_code: 'G5', from_station_name: '北京', from_station_telecode: 'BJP', to_station_name: '上海', to_station_telecode: 'SHH', start_time: '07:40', arrive_time: '12:32', lishi: '04:52', day_difference: '0', swz_price: '28170', zy_price: '12880', ze_price: '08050' } },
  { queryLeftNewDTO: { train_no: '24000000G520', station_train_code: 'G5', from_station_name: '北京南', from_station_telecode: 'VNP', to_station_name: '上海', to_station_telecode: 'SHH', start_time: '07:59', arrive_time: '12:32', lishi: '04:33', day_difference: '0', swz_price: '28010', zy_price: '12810', ze_price: '08000' } },
];

// ---- leftTicket 余票原始行（真实抓取；f[0] 为加密串，G5 以 BLOB 占位，不影响解析） ----
const AVAIL_ROWS = [
  '21CCVmY23NK08R8xmC0rkIJXjZ6RjHjDp%2BoiV%2FUgVZIiEHQQE9z%2Bc7No%2BCKNyyRM7FsqystFIwCb%0Abu0ZONt6B1DnfoKvUCqq1xWOLnifPYa2CVY1YAOIkOd%2B%2B8XIKIuBlAwUcIs6knaqFpp4ySahTEiI%0AUqYFGcAtS3uZxfz6P%2BYZYq96t2K%2B58M1DhcDWEVFloiLqDenKNLxlk0T4UbIE4myhxRAq8gn9uAP%0AA5ncLjdl1b9md0%2FnDdDmDngQtmKprF1JT9Ii9TdzNoSNJ8EqWIv%2BjNM%2BAAyyqtWd41v03avLlR29%0AqR8T%2BjV%2FdM7YYEj0%2FuB9q%2FKi%2FLug6PWqK1AT5EQ5sR0jdZyoIa0MWPc%2FHmE%3D|预订|240000G81105|G811|VNP|NXG|VNP|HGH|09:34|15:39|06:05|Y|yzN12Iq6tGc%2Fj2Q06o%2FQAiQeUdkJX1m8pPGjr6elWrFObdnZfH01O0MM1Vw%3D|20260912|3|P2|01|12|1|0|||||||有||||有|有|17||90M0O0W0|9MOO|0|0||9231000017M102000021O067300021O067303054|0|||||1|0#0#Q05#0#z#0#z#z|O067300006|7|CHN,CHN|||N#N#||90085M0082O0087W0087|202608291245|Y|',
  'JMwlSnm91eeK121erGi%2BkbVNtV4CL%2Ft5Ci3jsGFdUaWxOJzsv%2Bt7aHNj4L9SXdIDAV%2Bo9SOqZVub%0AOjD7ezihIsddvEcKrxXXkdi2hqdcav%2FgxJFpuuDosH%2FGqBvbpU1Zy%2FtSNF32mN%2Fa6so%2Btll8S7VH%0Adgk%2BGTMas46FbDw1OyO3%2B1wqCO6Z8PVsjfiMk%2F4v0MuGV7%2F0R93ny56shPPBtlQxqAci3CUz6UVo%0Asd6unFHDDvoCBgRfyCBJ3sq3hAIHcFFks%2FWPsUls3ZHd0%2B2WDPY4pPUE2pyTxkeKxvgB1ydwL7KT%0A9oO3Z9AqV6QI%2Bo6dGxi3t1CCdClYcK6dR44GNlWRaTlLAqzk4QlPjpAjh9o%3D|预订|240000G81105|G811|VNP|NXG|VNP|XHH|09:34|15:53|06:19|Y|elPGgDzenYzn7T5uyAwF%2FxGinmetNlsPmDYuXqW%2F1lLBCOBx0tyRi8OougU%3D|20260912|3|P2|01|13|1|0|||||||有||||有|有|17||90M0O0W0|9MOO|0|0||9233900017M103600021O068200021O068203054|0|||||1|0#0#Q05#0#z#0#z#z|O068200006|7|CHN,CHN|||N#N#||90085M0082O0087W0087|202608291245|Y|',
  'BLOB|预订|24000000G520|G5|BJP|SHH|BJP|SHH|07:40|12:32|04:52|Y|TZ5OOH6FB6GrRTeZpVdnWd05UHD3bJzAzbx3JcAYbbb3Es5YBuOT6sC98fM%3D|20260912|3|P4|01|05|1|0|||||||有||||有|有|6||90M0O0W0|9MOO|0|0||9235000006M107500021O067200021O067203066|0|||||1|0#1#Q0304#0#z#0#z#z|O067200009|7|CHN,CHN|||N#N#||90084M0084O0084W0084|202608291000|Y|',
  'BLOB|预订|24000000G520|G5|BJP|SHH|VNP|SHH|07:59|12:32|04:33|Y|wDB3djHL7VAhfTQNa%2B1zrKHQOV%2BVbV2FhlJEv0kOZK5Rn5t4dRYGRtXeLOY%3D|20260912|3|P4|02|05|1|0|||||||有||||有|有|6||90M0O0W0|9MOO|0|0||9233700006M106900021O066700021O066703066|0|||||1|0#1#Q0304#0#z#0#z#z||7|CHN,CHN|||N#N#||90084M0084O0084W0084|202608291245|Y|',
];

let failed = 0;
function check(name, cond, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${extra ? '  ' + extra : ''}`);
  if (!cond) failed++;
}

const seatOf = (t, cls) => (t.seats || []).find((s) => s.class === cls);

// ---- 1) 余票表：同车次两段都必须保留（旧键 train_no|from 会使后一段覆盖前一段） ----
const avail = buildAvailMap(AVAIL_ROWS);
check('余票表保留 G811 杭州东段', avail.has('240000G81105|VNP|HGH'));
check('余票表保留 G811 杭州南段', avail.has('240000G81105|VNP|XHH'));
check('余票表保留 G5 北京段与北京南段', avail.has('24000000G520|BJP|SHH') && avail.has('24000000G520|VNP|SHH'));
check('余票表共 4 条', avail.size === 4, `实际 ${avail.size}`);

// ---- 2) 车次列表：同车次多段全部显示（旧逻辑只显示 2 行） ----
const trains = buildTrains(PRICE_ROWS, avail);
check('4 个可售区间全部显示', trains.length === 4, `实际 ${trains.length} 行`);

const g811Hdh = trains.find((t) => t.trainNo === 'G811' && t.arrStation === '杭州东');
const g811Hnh = trains.find((t) => t.trainNo === 'G811' && t.arrStation === '杭州南');
const g5Bj = trains.find((t) => t.trainNo === 'G5' && t.depStation === '北京');
const g5Bjn = trains.find((t) => t.trainNo === 'G5' && t.depStation === '北京南');
check('G811 杭州东段存在且到发正确', !!g811Hdh && g811Hdh.depTime === '09:34' && g811Hdh.arrTime === '15:39' && g811Hdh.durationMin === 365);
check('G811 杭州南段存在且到发正确', !!g811Hnh && g811Hnh.arrTime === '15:53' && g811Hnh.durationMin === 379);
check('G5 北京段存在且到发正确', !!g5Bj && g5Bj.depTime === '07:40' && g5Bj.arrTime === '12:32');
check('G5 北京南段存在且到发正确', !!g5Bjn && g5Bjn.depTime === '07:59' && g5Bjn.arrTime === '12:32');

// ---- 3) 各段价格正确（实际执行价取自本段 yp_info，不得串段） ----
// 杭州东：商务 2310 / 一等 1020 / 二等 673；杭州南：商务 2339 / 一等 1036 / 二等 682
check('G811 杭州东段价格正确', g811Hdh && seatOf(g811Hdh, '商务座').price === 2310 && seatOf(g811Hdh, '一等座').price === 1020 && seatOf(g811Hdh, '二等座').price === 673,
  `商务 ${seatOf(g811Hdh, '商务座').price} / 一等 ${seatOf(g811Hdh, '一等座').price} / 二等 ${seatOf(g811Hdh, '二等座').price}`);
check('G811 杭州南段价格正确', g811Hnh && seatOf(g811Hnh, '商务座').price === 2339 && seatOf(g811Hnh, '一等座').price === 1036 && seatOf(g811Hnh, '二等座').price === 682,
  `商务 ${seatOf(g811Hnh, '商务座').price} / 一等 ${seatOf(g811Hnh, '一等座').price} / 二等 ${seatOf(g811Hnh, '二等座').price}`);
// 北京：商务 2350 / 一等 1075 / 二等 672；北京南：商务 2337 / 一等 1069 / 二等 667
check('G5 北京段价格正确', g5Bj && seatOf(g5Bj, '商务座').price === 2350 && seatOf(g5Bj, '一等座').price === 1075 && seatOf(g5Bj, '二等座').price === 672);
check('G5 北京南段价格正确', g5Bjn && seatOf(g5Bjn, '商务座').price === 2337 && seatOf(g5Bjn, '一等座').price === 1069 && seatOf(g5Bjn, '二等座').price === 667);

// ---- 4) 余票状态与折扣标签 ----
check('G811 商务座余票状态为少量(17张)', g811Hdh && seatOf(g811Hdh, '商务座').status === '少量');
check('G811 二等座余票状态为有票', g811Hdh && seatOf(g811Hdh, '二等座').status === '有票');
check('G811 杭州东二等座折扣 8.6折(673/780)', g811Hdh && seatOf(g811Hdh, '二等座').discount === '8.6折');
check('G811 杭州东商务座折扣 8.5折(2310/2730)', g811Hdh && seatOf(g811Hdh, '商务座').discount === '8.5折');

// ---- 5) 确定性：输入行序打乱，输出完全一致（12306 两次请求行序不稳定） ----
const trainsReversed = buildTrains([...PRICE_ROWS].reverse(), buildAvailMap([...AVAIL_ROWS].reverse()));
check('输入行序打乱输出不变', JSON.stringify(trainsReversed) === JSON.stringify(trains));
check('输出按出发时间确定性排序', trains.map((t) => t.depTime).join(',') === '07:40,07:59,09:34,09:34');
check('同车次同出发时间按到达时间排序(杭州东在前)', trains[2].arrStation === '杭州东' && trains[3].arrStation === '杭州南');

// ---- 6) 真实重复行（同三元组）仍被合并 ----
const trainsDup = buildTrains([...PRICE_ROWS, PRICE_ROWS[1]], avail);
check('同区间重复行仍被去重', trainsDup.length === 4, `实际 ${trainsDup.length}`);

// ---- 7) 余票接口整体失败时降级为公布价 + 状态「—」 ----
const trainsNoAvail = buildTrains(PRICE_ROWS, new Map());
const g811HdhNa = trainsNoAvail.find((t) => t.trainNo === 'G811' && t.arrStation === '杭州东');
check('无余票时降级公布价', g811HdhNa && seatOf(g811HdhNa, '二等座').price === 780 && seatOf(g811HdhNa, '二等座').status === '—');

console.log(failed ? `\n${failed} 项失败` : '\n全部通过');
process.exit(failed ? 1 : 0);
