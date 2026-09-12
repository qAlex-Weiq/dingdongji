'use strict';

/* ============================================================
 * 订懂机 · 旅行规划 —— 酒店模块前端逻辑
 * 职责：城市自动补全 / 偏好选项（价格档位 + 位置偏好）/
 *       酒店搜索 / 结果渲染 / 排序 / 交互状态
 * ============================================================ */

(() => {
  const $ = (sel) => document.querySelector(sel);

  const els = {
    form: $('#hotel-form'),
    city: $('#city-input'),
    source: $('#source-select'),
    hint: $('#source-hint'),
    searchBtn: $('#search-btn'),
    resultSection: $('#result-section'),
    summary: $('#hotel-summary'),
    list: $('#hotel-list'),
    sort: $('#sort-select'),
    cityList: $('#city-list'),
    toast: $('#toast'),
  };

  const state = {
    sort: 'score',  // 'score' | 'rating' | 'popularity' | 'priceAsc' | 'priceDesc'
    source: 'local', // 'local' | 'llm'
    tier: 'any',    // 'any' | 'budget' | 'comfort' | 'upscale' | 'luxury'
    location: 'any', // 'any' | 'downtown' | 'station' | 'airport' | 'scenic'
    data: null,     // { city, source, sourceLabel, count, hotels }
    loading: false,
  };

  const SEARCH_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';

  const STAR_SVG =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2l-6.1 3.4 1.4-6.8L2.2 9.1l6.9-.8L12 2z"/></svg>';

  /** 档位中文 → 标签样式类（与 CSS .tier-* 对应） */
  const TIER_CLASS = {
    '经济型': 'tier-budget',
    '舒适型': 'tier-comfort',
    '高档型': 'tier-upscale',
    '豪华型': 'tier-luxury',
  };

  /** 档位 key → 价格区间标签（用于筛选条件回显，与页面药丸文案一致） */
  const TIER_LABEL = {
    any: '不限',
    budget: '¥200以下',
    comfort: '¥200 - ¥450',
    upscale: '¥450 - ¥800',
    luxury: '¥800以上',
  };
  /**
   * 档位 key → 严格数值区间（与后端 lib/hotelPrefs 的 TIERS 一致）：
   * budget: price <= 200；comfort: 200 < price <= 450；
   * upscale: 450 < price <= 800；luxury: price > 800
   */
  const PRICE_RANGES = {
    budget: { max: 200 },
    comfort: { min: 200, max: 450 },
    upscale: { min: 450, max: 800 },
    luxury: { min: 800 },
  };

  /** 严格价格过滤（前端防线）：指定档位时剔除任何价格越界或未知的酒店 */
  function inPriceRange(price, tier) {
    if (tier === 'any' || !PRICE_RANGES[tier]) return true;
    if (!Number.isFinite(price)) return false;
    const r = PRICE_RANGES[tier];
    if (r.min !== undefined && !(price > r.min)) return false;
    if (r.max !== undefined && !(price <= r.max)) return false;
    return true;
  }

  const LOCATION_LABEL = {
    any: '位置不限',
    downtown: '市中心',
    station: '火车站周边',
    airport: '机场周边',
    scenic: '景点周边',
  };

  // ---------- 初始化 ----------

  function init() {
    loadCities();
    els.form.addEventListener('submit', onSubmit);
    els.sort.addEventListener('change', () => {
      state.sort = els.sort.value;
      renderList();
    });
    els.source.addEventListener('change', () => {
      state.source = els.source.value;
      updateHint();
    });
    // 偏好 chip：选中即记住（无需点搜索也能看到选中态）
    document.querySelectorAll('input[name="tier"]').forEach((r) => {
      r.addEventListener('change', () => { state.tier = r.value; });
    });
    document.querySelectorAll('input[name="location"]').forEach((r) => {
      r.addEventListener('change', () => { state.location = r.value; });
    });
    updateHint();
  }

  /** AI 联网搜索较慢，切换到该选项时显示提示 */
  function updateHint() {
    els.hint.hidden = state.source !== 'llm';
  }

  async function loadCities() {
    try {
      const res = await fetch('/api/cities');
      if (!res.ok) return;
      const cities = await res.json();
      const frag = document.createDocumentFragment();
      cities.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c.name;
        frag.appendChild(opt);
      });
      els.cityList.appendChild(frag);
    } catch {
      /* 城市列表加载失败不阻塞主流程 */
    }
  }

  // ---------- 查询 ----------

  async function onSubmit(e) {
    e.preventDefault();
    if (state.loading) return;

    const city = els.city.value.trim();
    if (!city) {
      showToast('请填写目的地城市', 'error');
      return;
    }

    setLoading(true);
    try {
      const params = new URLSearchParams({
        city,
        tier: state.tier,
        location: state.location,
        source: state.source,
      });
      const res = await fetch(`/api/hotel/search?${params.toString()}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `查询失败（${res.status}）`);
      state.data = body;
      els.resultSection.hidden = false;
      renderSummary();
      renderList();
      els.resultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      if (!state.data) els.resultSection.hidden = true;
      // 数据源未配置时引导用户去设置页
      const msg = /未配置/.test(err.message || '')
        ? `${err.message}（点右上角「设置」填写后即可使用）`
        : err.message || '网络异常，请稍后重试';
      showToast(msg, 'error');
    } finally {
      setLoading(false);
    }
  }

  function setLoading(loading) {
    state.loading = loading;
    els.searchBtn.disabled = loading;
    // AI 联网搜索耗时较长，按钮文案区分提示
    els.searchBtn.textContent = loading
      ? (state.source === 'llm' ? 'AI 生成中…' : '搜索中…')
      : '搜 索';
    if (loading) {
      els.resultSection.hidden = false;
      renderSkeleton();
      // AI 联网搜索耗时 10~40s，在骨架屏之上叠加分阶段进度横幅
      if (state.source === 'llm') LLMProgress.start(els.list);
    } else {
      LLMProgress.stop();
      if (state.data) renderList();
    }
  }

  // ---------- 渲染 ----------

  function renderSummary() {
    const { city, tier, location, count, sourceLabel, cached } = state.data;
    const cond = [];
    if (tier && tier !== 'any') cond.push(TIER_LABEL[tier] || tier);
    if (location && location !== 'any') cond.push(LOCATION_LABEL[location] || location);
    const condText = cond.length > 0 ? cond.join(' · ') : '全部酒店';
    els.summary.innerHTML =
      `<b>${esc(city)}</b> · ${esc(condText)} · 共 ${count} 家` +
      ` <span class="source-badge" title="当前数据来源">${esc(sourceLabel)}${cached ? ' · 缓存' : ''}</span>`;
  }

  function renderList() {
    if (!state.data || state.loading) return;
    // 按本次查询的档位做严格价格过滤（前端防线，与后端同一套数值区间）
    const list = sorted(state.data.hotels.filter((h) => inPriceRange(h.price, state.data.tier)));
    // 暴露给 cart.js 反查完整条目（按名称）
    window.__ddjRendered = { ...(window.__ddjRendered || {}), hotel: list };
    els.list.innerHTML =
      list.length === 0 ? emptyHtml() : list.map(hotelCard).join('');
  }

  function sorted(list) {
    const arr = [...list];
    if (state.sort === 'rating') {
      arr.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.score - a.score);
    } else if (state.sort === 'popularity') {
      arr.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0) || b.score - a.score);
    } else if (state.sort === 'priceAsc') {
      arr.sort((a, b) => (a.price ?? Infinity) - (b.price ?? Infinity) || b.score - a.score);
    } else if (state.sort === 'priceDesc') {
      arr.sort((a, b) => (b.price ?? -1) - (a.price ?? -1) || b.score - a.score);
    } else {
      arr.sort((a, b) => b.score - a.score);
    }
    return arr;
  }

  function hotelCard(h, i) {
    const rating = h.rating != null
      ? `<span class="sight-rating">${STAR_SVG}${h.rating.toFixed(1)}</span>`
      : '';
    const recommended = h.recommended ? '<span class="tag-rec">热门推荐</span>' : '';
    const tierTag = h.tier
      ? `<span class="tier-tag ${TIER_CLASS[h.tier] || 'tier-comfort'}">${esc(h.tier)}</span>`
      : '';
    const tags = (h.tags || [])
      .slice(0, 4)
      .map((t) => `<span class="tag-soft">${esc(t)}</span>`)
      .join('');
    const meta = h.address
      ? `<span class="sight-meta-item"><i>地址</i>${esc(h.address)}</span>`
      : '';

    const price = h.price != null
      ? `<div class="hotel-price"><em><small>¥</small>${h.price}</em><span>每晚参考价</span></div>`
      : '<div class="hotel-price tba"><em>价格待询</em><span>以预订平台为准</span></div>';

    return `
      <article class="card sight-card hotel-card stay-card">
        <div class="sight-rank ${i < 3 ? 'rank-top' : ''}">${i + 1}</div>
        <div class="card-main">
          <div class="card-top">
            <span class="carrier">${esc(h.name)}</span>
            ${tierTag}
            ${rating}
            ${recommended}
          </div>
          ${h.desc ? `<p class="sight-desc">${esc(h.desc)}</p>` : ''}
          ${meta ? `<div class="sight-meta">${meta}</div>` : ''}
          ${tags ? `<div class="sight-tags">${tags}</div>` : ''}
        </div>
        <div class="card-side sight-side hotel-side">
          ${price}
          <div class="sight-score">
            <em>${h.score}</em>
            <span>综合指数</span>
          </div>
          ${window.Cart && state.data ? Cart.addButton('hotel', state.data.city, h) : ''}
        </div>
      </article>`;
  }

  function renderSkeleton() {
    const skeleton = `
      <div class="card skeleton sight-card">
        <span class="sk sk-rank"></span>
        <div>
          <div class="sk-row"><span class="sk sk-tag"></span><span class="sk sk-text"></span></div>
          <div class="sk-row"><span class="sk sk-line"></span></div>
          <div class="sk-row"><span class="sk sk-line short"></span></div>
        </div>
        <div class="card-side"><span class="sk sk-price"></span></div>
      </div>`;
    els.list.innerHTML = skeleton.repeat(5);
  }

  function emptyHtml() {
    return `
      <div class="empty">
        ${SEARCH_SVG}
        <p>没有找到符合条件的酒店，换个城市或调整偏好试试</p>
      </div>`;
  }

  // ---------- 工具函数 ----------

  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
  }

  let toastTimer = null;
  function showToast(msg, kind = 'info') {
    els.toast.textContent = msg;
    els.toast.className = `toast${kind === 'error' ? ' toast-error' : ''} is-visible`;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      els.toast.classList.remove('is-visible');
    }, 2400);
  }

  // 快捷城市芯片：点击填入城市并自动查询
  function bindQuickChips() {
    const wrap = document.querySelector('.quick-chips');
    if (!wrap) return;
    wrap.addEventListener('click', (e) => {
      const btn = e.target.closest('.chip');
      if (!btn) return;
      els.city.value = btn.dataset.city || '';
      els.form.requestSubmit();
    });
  }
  bindQuickChips();

  // 全局目的地上下文：自动预填城市并跑一次默认查询（Task 3）
  function bindTripContext() {
    if (!window.Cart) return;

    let lastCity = els.city.value.trim();
    els.city.addEventListener('change', () => {
      const next = els.city.value.trim();
      if (!next || next === lastCity) return;
      if (!Cart.guardCitySwitch(next)) {
        els.city.value = lastCity; // 用户取消：回滚输入框
        return;
      }
      lastCity = next;
    });

    Cart.prefillCity('city-input', () => {
      lastCity = els.city.value.trim();
      els.form.requestSubmit();
    });
  }

  document.addEventListener('DOMContentLoaded', () => {
    init();
    bindTripContext();
  });
})();
