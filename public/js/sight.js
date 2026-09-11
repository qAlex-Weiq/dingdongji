'use strict';

/* ============================================================
 * 叮咚机 · 旅行规划 —— 景点模块前端逻辑
 * 职责：城市自动补全 / 景点搜索 / 结果渲染 / 排序 / 交互状态
 * ============================================================ */

(() => {
  const $ = (sel) => document.querySelector(sel);

  const els = {
    form: $('#sight-form'),
    city: $('#city-input'),
    source: $('#source-select'),
    hint: $('#source-hint'),
    searchBtn: $('#search-btn'),
    resultSection: $('#result-section'),
    summary: $('#sight-summary'),
    list: $('#sight-list'),
    sort: $('#sort-select'),
    cityList: $('#city-list'),
    toast: $('#toast'),
  };

  const state = {
    sort: 'score',  // 'score' | 'rating' | 'popularity' | 'free'
    source: 'auto', // 'auto' | 'local' | 'llm'
    data: null,     // { city, source, sourceLabel, count, sights }
    loading: false,
  };

  const SEARCH_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';

  const STAR_SVG =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2l-6.1 3.4 1.4-6.8L2.2 9.1l6.9-.8L12 2z"/></svg>';

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
      const params = new URLSearchParams({ city, source: state.source });
      const res = await fetch(`/api/sight/search?${params.toString()}`);
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
    } else if (state.data) {
      renderList();
    }
  }

  // ---------- 渲染 ----------

  function renderSummary() {
    const { city, count, sourceLabel, cached } = state.data;
    els.summary.innerHTML =
      `<b>${esc(city)}</b> · 共 ${count} 个景点` +
      ` <span class="source-badge" title="当前数据来源">${esc(sourceLabel)}${cached ? ' · 缓存' : ''}</span>`;
  }

  function renderList() {
    if (!state.data || state.loading) return;
    const list = sorted(state.data.sights);
    els.list.innerHTML =
      list.length === 0 ? emptyHtml() : list.map(sightCard).join('');
  }

  function sorted(list) {
    const arr = [...list];
    if (state.sort === 'rating') {
      arr.sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0) || b.score - a.score);
    } else if (state.sort === 'popularity') {
      arr.sort((a, b) => (b.popularity ?? 0) - (a.popularity ?? 0) || b.score - a.score);
    } else if (state.sort === 'free') {
      arr.sort((a, b) => Number(isFree(a)) - Number(isFree(b)) || b.score - a.score);
    } else {
      arr.sort((a, b) => b.score - a.score);
    }
    return arr;
  }

  function isFree(s) {
    return /免费|0元/.test(s.ticket || '');
  }

  function sightCard(s, i) {
    const rating = s.rating != null
      ? `<span class="sight-rating">${STAR_SVG}${s.rating.toFixed(1)}</span>`
      : '';
    const recommended = s.recommended ? '<span class="tag-rec">热门推荐</span>' : '';
    const tags = (s.tags || [])
      .slice(0, 4)
      .map((t) => `<span class="tag-soft">${esc(t)}</span>`)
      .join('');
    const meta = [
      ['门票', s.ticket],
      ['开放', s.openTime],
      ['建议游览', s.visitHours],
      ['地址', s.address],
    ]
      .filter(([, v]) => v)
      .map(
        ([k, v]) =>
          `<span class="sight-meta-item"><i>${k}</i>${esc(v)}</span>`
      )
      .join('');

    return `
      <article class="card sight-card">
        <div class="sight-rank ${i < 3 ? 'rank-top' : ''}">${i + 1}</div>
        <div class="card-main">
          <div class="card-top">
            <span class="carrier">${esc(s.name)}</span>
            <span class="tag-soft">${esc(s.type)}</span>
            ${rating}
            ${recommended}
          </div>
          <p class="sight-desc">${esc(s.desc)}</p>
          <div class="sight-meta">${meta}</div>
          ${tags ? `<div class="sight-tags">${tags}</div>` : ''}
        </div>
        <div class="card-side sight-side">
          <div class="sight-score">
            <em>${s.score}</em>
            <span>综合指数</span>
          </div>
          ${isFree(s) ? '<span class="tag-free">免费</span>' : ''}
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
        <p>没有找到该城市的景点，换个城市试试</p>
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

  document.addEventListener('DOMContentLoaded', init);
})();
