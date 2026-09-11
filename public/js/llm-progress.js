'use strict';

/* ============================================================
 * 订懂机 · LLM 慢速查询分阶段进度横幅
 * AI 联网搜索需 10~40 秒，骨架屏只能表达"在加载"，
 * 本组件在加载区顶部叠加一条会"分阶段推进"的提示：
 *   0s  正在联网检索最新资讯…
 *   8s  正在筛选与核实信息…
 *   18s 正在生成与整理内容…
 *   32s 内容较多，即将完成…
 * 用法（各模块页引入本文件后）：
 *   LLMProgress.start(listEl);            // prepend 到容器顶部
 *   LLMProgress.start(parent, refEl);     // 插入到 refEl 之前
 *   LLMProgress.stop();                   // 移除横幅并清定时器（幂等）
 * ============================================================ */

(() => {
  const PHASES = [
    { at: 0, text: '正在联网检索最新资讯…' },
    { at: 8, text: '正在筛选与核实信息…' },
    { at: 18, text: '正在生成与整理内容…' },
    { at: 32, text: '内容较多，即将完成…' },
  ];

  let banner = null;
  let timer = null;
  let t0 = 0;

  function stop() {
    if (timer) { clearInterval(timer); timer = null; }
    if (banner && banner.parentNode) banner.parentNode.removeChild(banner);
    banner = null;
  }

  function tick() {
    if (!banner) return;
    const elapsed = Date.now() - t0;
    let text = PHASES[PHASES.length - 1].text;
    for (const p of PHASES) {
      if (elapsed >= p.at * 1000) text = p.text;
    }
    banner.querySelector('.llm-progress-text').textContent = text;
  }

  /**
   * @param {HTMLElement} container 横幅插入的父容器
   * @param {HTMLElement} [refEl]   指定时插入到该元素之前，否则 prepend 到容器顶部
   */
  function start(container, refEl) {
    stop();
    if (!container) return;
    banner = document.createElement('div');
    banner.className = 'llm-progress';
    banner.setAttribute('role', 'status');
    banner.setAttribute('aria-live', 'polite');
    banner.innerHTML =
      '<span class="llm-progress-track" aria-hidden="true"><i></i></span>' +
      '<span class="llm-progress-text"></span>';
    if (refEl && refEl.parentNode === container) {
      container.insertBefore(banner, refEl);
    } else {
      container.prepend(banner);
    }
    t0 = Date.now();
    tick();
    timer = setInterval(tick, 1000);
  }

  window.LLMProgress = { start, stop };
})();
