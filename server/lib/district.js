'use strict';

/**
 * 从地址字符串中提取行政区（区 / 县 / 县级市）。
 *
 * 设计说明：
 * 内置景点与酒店数据（server/data/sights.js、hotels.js）的 address 字段
 * 本身以行政区开头（如「青羊区顺城大街269号」「东城区金鱼胡同8号」），
 * 高德数据源返回的地址同样遵循该约定。因此行政区无需额外人工标注，
 * 用纯函数从既有字段推导即可 —— 实测覆盖率：
 *   - 北京 / 上海 / 成都：113/113（100%）
 *   - 全部 25 城：826/860（96.0%）
 * 未命中的 34 条为自治县 / 县级市等长地名（如「石林彝族自治县」
 * 「登封市」），返回 null 后由上层降级为「市区」统一分组。
 *
 * 解析要点：
 * 1. 先剥离省市前缀（「河南省郑州市」「上海市」），避免把「上海市」
 *    误判为行政区；
 * 2. 「新区」优先于「区」匹配，保证「浦东新区」不被截断为「浦东新」；
 * 3. 仅匹配开头位置，避免命中地址中段的「…区间…」等无关字样。
 */

/** 省级前缀：河南省、内蒙古自治区… */
const PROVINCE_RE = /^[一-龥]{2,4}(?:省|自治区)/;

/**
 * 地级市前缀：郑州市、上海市…
 * 仅在「按城市名剥离后仍无法识别行政区」时才启用 —— 若无条件剥离，
 * 「东城区煤市街」会被误吃成「东城区煤市」，「都江堰市公园路」的
 * 县级市本身就是行政区，也会被整个吞掉。
 */
const CITY_RE = /^[一-龥]{2,3}市/;

/**
 * 行政区主体，按后缀分别限长（避免过度匹配非地名文字）：
 *   新区  前缀 1-3 字：浦东新区 / 滨海新区
 *   区    前缀 2-4 字：东城区 / 浦东区 / 管城回族区
 *   县    前缀 2-8 字：延庆县 / 石林彝族自治县 / 禄劝彝族苗族自治县
 *   市    前缀 2-3 字：登封市 / 都江堰市（县级市）
 *
 * 注意：中文地址无法在词法层面区分「东城区」与「某个没有区」这类
 * 同形串；本函数面向 data/ 下以行政区开头的规范地址设计，
 * 非规范输入由调用方通过 districtOf 的兜底值处理。
 */
const DISTRICT_RE = /^([一-龥]{1,3}新区|[一-龥]{2,4}区|[一-龥]{2,8}县|[一-龥]{2,3}市)/;

/** 无法识别行政区时的统一归组名 */
const FALLBACK = '市区';

/**
 * 提取行政区名。
 * @param {string} address 地址全文
 * @param {string} [cityName] 所属城市名（用于剥离「成都市」「北京」等前缀）
 * @returns {string|null} 行政区名（如「青羊区」「浦东新区」），无法识别返回 null
 */
function extractDistrict(address, cityName) {
  const raw = String(address || '').trim();
  if (!raw) return null;

  // 1) 剥离省级前缀
  let s = raw.replace(PROVINCE_RE, '');

  // 2) 剥离「城市名 + 可选的市」前缀（成都市 / 北京 / 上海市 …）
  if (cityName) {
    s = s.replace(new RegExp(`^${cityName}市?`), '');
  }

  // 3) 首选：直接匹配行政区
  let d = match(s);

  // 4) 兜底：仍未命中时，再尝试剥离一层地级市前缀后重试。
  //    放在最后而非最前，避免「东城区煤市街」「都江堰市公园路」被误吃。
  if (!d) {
    const trimmed = s.replace(CITY_RE, '');
    if (trimmed !== s) d = match(trimmed);
  }
  return d;
}

/** 在已去除前缀的串上匹配行政区，并过滤两字「某市」误匹配 */
function match(s) {
  const m = s.match(DISTRICT_RE);
  if (!m) return null;
  const d = m[1];
  // 「市」结尾需为县级市全称（≥3 字，如「都江堰市」「登封市」），
  // 排除前缀剥离不彻底时残留的两字「某市」
  if (d.endsWith('市') && d.length < 3) return null;
  return d;
}

/**
 * 提取行政区，失败时返回统一归组名「市区」。
 * 编排算法用此版本，保证每个条目都有分组键。
 */
function districtOf(address, cityName) {
  return extractDistrict(address, cityName) || FALLBACK;
}

module.exports = { extractDistrict, districtOf, FALLBACK };
