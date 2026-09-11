'use strict';

/**
 * 支持的城市清单。
 * - lat/lng：城市坐标，用于估算里程，进而推算时长与参考票价
 * - airports：机场（IATA 代码 + 名称）
 * - stations：火车站，顺序为 [高铁/动车主要车站, ..., 传统车站]
 */
const CITIES = [
  { name: '北京', pinyin: 'beijing', lat: 39.90, lng: 116.41,
    airports: [{ code: 'PEK', name: '首都国际机场' }, { code: 'PKX', name: '大兴国际机场' }],
    stations: ['北京南', '北京西', '北京朝阳', '北京站'] },
  { name: '上海', pinyin: 'shanghai', lat: 31.23, lng: 121.47,
    airports: [{ code: 'SHA', name: '虹桥国际机场' }, { code: 'PVG', name: '浦东国际机场' }],
    stations: ['上海虹桥', '上海', '上海南'] },
  { name: '广州', pinyin: 'guangzhou', lat: 23.13, lng: 113.26,
    airports: [{ code: 'CAN', name: '白云国际机场' }],
    stations: ['广州南', '广州', '广州东'] },
  { name: '深圳', pinyin: 'shenzhen', lat: 22.54, lng: 114.06,
    airports: [{ code: 'SZX', name: '宝安国际机场' }],
    stations: ['深圳北', '深圳', '福田'] },
  { name: '成都', pinyin: 'chengdu', lat: 30.57, lng: 104.07,
    airports: [{ code: 'CTU', name: '双流国际机场' }, { code: 'TFU', name: '天府国际机场' }],
    stations: ['成都东', '成都南', '成都'] },
  { name: '杭州', pinyin: 'hangzhou', lat: 30.27, lng: 120.16,
    airports: [{ code: 'HGH', name: '萧山国际机场' }],
    stations: ['杭州东', '杭州', '杭州南'] },
  { name: '西安', pinyin: 'xian', lat: 34.34, lng: 108.94,
    airports: [{ code: 'XIY', name: '咸阳国际机场' }],
    stations: ['西安北', '西安'] },
  { name: '重庆', pinyin: 'chongqing', lat: 29.56, lng: 106.55,
    airports: [{ code: 'CKG', name: '江北国际机场' }],
    stations: ['重庆北', '重庆西', '重庆'] },
  { name: '武汉', pinyin: 'wuhan', lat: 30.59, lng: 114.31,
    airports: [{ code: 'WUH', name: '天河国际机场' }],
    stations: ['武汉', '汉口', '武昌'] },
  { name: '长沙', pinyin: 'changsha', lat: 28.23, lng: 112.94,
    airports: [{ code: 'CSX', name: '黄花国际机场' }],
    stations: ['长沙南', '长沙'] },
  { name: '南京', pinyin: 'nanjing', lat: 32.16, lng: 118.78,
    airports: [{ code: 'NKG', name: '禄口国际机场' }],
    stations: ['南京南', '南京'] },
  { name: '厦门', pinyin: 'xiamen', lat: 24.48, lng: 118.09,
    airports: [{ code: 'XMN', name: '高崎国际机场' }],
    stations: ['厦门北', '厦门'] },
  { name: '昆明', pinyin: 'kunming', lat: 25.04, lng: 102.71,
    airports: [{ code: 'KMG', name: '长水国际机场' }],
    stations: ['昆明南', '昆明'] },
  { name: '青岛', pinyin: 'qingdao', lat: 36.07, lng: 120.38,
    airports: [{ code: 'TAO', name: '胶东国际机场' }],
    stations: ['青岛北', '青岛'] },
  { name: '天津', pinyin: 'tianjin', lat: 39.13, lng: 117.20,
    airports: [{ code: 'TSN', name: '滨海国际机场' }],
    stations: ['天津西', '天津'] },
  { name: '郑州', pinyin: 'zhengzhou', lat: 34.75, lng: 113.63,
    airports: [{ code: 'CGO', name: '新郑国际机场' }],
    stations: ['郑州东', '郑州'] },
  { name: '哈尔滨', pinyin: 'haerbin', lat: 45.80, lng: 126.53,
    airports: [{ code: 'HRB', name: '太平国际机场' }],
    stations: ['哈尔滨西', '哈尔滨'] },
  { name: '大连', pinyin: 'dalian', lat: 38.91, lng: 121.61,
    airports: [{ code: 'DLC', name: '周水子国际机场' }],
    stations: ['大连北', '大连'] },
  { name: '三亚', pinyin: 'sanya', lat: 18.25, lng: 109.51,
    airports: [{ code: 'SYX', name: '凤凰国际机场' }],
    stations: ['三亚'] },
  { name: '乌鲁木齐', pinyin: 'wulumuqi', lat: 43.83, lng: 87.62,
    airports: [{ code: 'URC', name: '地窝堡国际机场' }],
    stations: ['乌鲁木齐'] },
  { name: '兰州', pinyin: 'lanzhou', lat: 36.06, lng: 103.83,
    airports: [{ code: 'LHW', name: '中川国际机场' }],
    stations: ['兰州西', '兰州'] },
  { name: '贵阳', pinyin: 'guiyang', lat: 26.65, lng: 106.63,
    airports: [{ code: 'KWE', name: '龙洞堡国际机场' }],
    stations: ['贵阳北', '贵阳'] },
  { name: '南宁', pinyin: 'nanning', lat: 22.82, lng: 108.37,
    airports: [{ code: 'NNG', name: '吴圩国际机场' }],
    stations: ['南宁东', '南宁'] },
  { name: '福州', pinyin: 'fuzhou', lat: 26.07, lng: 119.30,
    airports: [{ code: 'FOC', name: '长乐国际机场' }],
    stations: ['福州南', '福州'] },
  { name: '济南', pinyin: 'jinan', lat: 36.65, lng: 117.12,
    airports: [{ code: 'TNA', name: '遥墙国际机场' }],
    stations: ['济南西', '济南'] },
];

const byName = new Map(CITIES.map((c) => [c.name, c]));

/** 按城市名或拼音（精确/前缀）查找城市，找不到返回 null */
function findCity(input) {
  const q = String(input || '').trim().toLowerCase();
  if (!q) return null;
  if (byName.has(q)) return byName.get(q);
  return CITIES.find((c) => c.pinyin === q || c.pinyin.startsWith(q)) || null;
}

module.exports = { CITIES, findCity };
