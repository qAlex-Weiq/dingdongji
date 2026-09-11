'use strict';

/**
 * 字符串哈希 → 32 位无符号整数（FNV-1a）。
 * 用于把查询条件映射成稳定的随机种子，保证同一查询每次返回一致的结果。
 */
function hashString(str) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i += 1) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/**
 * mulberry32：轻量、可复现的伪随机数生成器。
 * 返回函数每次调用产生 [0, 1) 之间的数。
 */
function createRng(seedStr) {
  let a = hashString(String(seedStr));
  return function rng() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

module.exports = { hashString, createRng };
