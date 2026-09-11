'use strict';

/* ============================================================
 * 叮咚机 · 旅行规划 —— 车票模块前端逻辑
 * 职责：城市自动补全 / 查询 / 结果渲染（机票、火车票）/ 排序 / 交互状态
 * ============================================================ */

(() => {
  const $ = (sel) => document.querySelector(sel);

  const els = {
    form: $('#search-form'),
    from: $('#from-input'),
    to: $('#to-input'),
    date: $('#date-input'),
    swap: $('#swap-btn'),
    searchBtn: $('#search-btn'),
    resultSection: $('#result-section'),
    routeSummary: $('#route-summary'),
    tabs: { flights: $('#tab-flights'), trains: $('#tab-trains') },
    counts: { flights: $('#flight-count'), trains: $('#train-count') },
    panels: { flights: $('#flights-panel'), trains: $('#trains-panel') },
    sort: $('#sort-select'),
    cityList: $('#city-list'),
    toast: $('#toast'),
  };

  const state = {
    activeTab: 'flights', // 'flights' | 'trains'
    sort: 'dep',          // 'dep' | 'price' | 'duration'
    data: null,           // { query, flights, trains }
    loading: false,
  };

  const PLANE_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<path d="m22 2-7 20-4-9-9-4Z"/><path d="M22 2 11 13"/></svg>';

  const TRAIN_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<rect x="5" y="3" width="14" height="14" rx="3"/><path d="M5 11h14"/>' +
    '<path d="M9 14h.01M15 14h.01"/><path d="m8.5 21 1.5-4M15.5 21 14 17"/></svg>';

  const SEARCH_SVG =
    '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" ' +
    'stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
    '<circle cx="11" cy="11" r="7"/><path d="m21 21-4.3-4.3"/></svg>';

  // ---------- 初始化 ----------

  function init() {
    setDefaultDate();
    loadCities();
    els.form.addEventListener('submit', onSubmit);
    els.swap.addEventListener('click', swapCities);
    els.tabs.flights.addEventListener('click', () => switchTab('flights'));
    els.tabs.trains.addEventListener('click', () => switchTab('trains'));
    els.sort.addEventListener('change', () => {
      state.sort = els.sort.value;
      renderActivePanel();
    });
    // 事件委托：卡片上的“选择”按钮
    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-action="select"]')) {
        showToast('演示环境：预订功能尚未接入真实渠道');
      }
    });
  }

  function setDefaultDate() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    const today = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    els.date.value = today;
    els.date.min = today;
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
      /* 城市列表加载失败不阻塞主流程，输入框仍可手动填写 */
    }
  }

  // ---------- 查询 ----------

  async function onSubmit(e) {
    e.preventDefault();
    if (state.loading) return;

    const from = els.from.value.trim();
    const to = els.to.value.trim();
    const date = els.date.value;

    if (!from || !to || !date) {
      showToast('请填写出发城市、到达城市和出发日期', 'error');
      return;
    }
    if (from === to) {
      showToast('出发城市与到达城市不能相同', 'error');
      return;
    }

    setLoading(true);
    try {
      const params = new URLSearchParams({ from, to, date });
      const res = await fetch(`/api/ticket/search?${params.toString()}`);
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `查询失败（${res.status}）`);
      state.data = body;
      els.resultSection.hidden = false;
      renderResult();
      els.resultSection.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (err) {
      if (!state.data) els.resultSection.hidden = true;
      showToast(err.message || '网络异常，请稍后重试', 'error');
    } finally {
      setLoading(false);
    }
  }

  function setLoading(loading) {
    state.loading = loading;
    els.searchBtn.disabled = loading;
    els.searchBtn.textContent = loading ? '查询中…' : '查 询';
    if (loading) {
      els.resultSection.hidden = false;
      renderSkeleton(els.panels[state.activeTab]);
    } else if (state.data) {
      // 加载结束：用真实数据替换骨架屏（onSubmit 中渲染时 loading 尚未清除，此处兜底）
      renderActivePanel();
    }
  }

  function swapCities() {
    const t = els.from.value;
    els.from.value = els.to.value;
    els.to.value = t;
    els.swap.classList.remove('is-spin');
    void els.swap.offsetWidth; // 强制 reflow，重置动画
    els.swap.classList.add('is-spin');
  }

  // ---------- 渲染 ----------

  function switchTab(tab) {
    state.activeTab = tab;
    els.tabs.flights.classList.toggle('is-active', tab === 'flights');
    els.tabs.trains.classList.toggle('is-active', tab === 'trains');
    els.tabs.flights.setAttribute('aria-selected', String(tab === 'flights'));
    els.tabs.trains.setAttribute('aria-selected', String(tab === 'trains'));
    els.panels.flights.hidden = tab !== 'flights';
    els.panels.trains.hidden = tab !== 'trains';
    renderActivePanel();
  }

  function renderResult() {
    const { query, flights, trains } = state.data;
    els.counts.flights.textContent = flights.length;
    els.counts.trains.textContent = trains.length;
    els.routeSummary.innerHTML =
      `<b>${esc(query.from)}</b> → <b>${esc(query.to)}</b> · ${formatDateCn(query.date)}` +
      ` · 共 ${flights.length} 个航班 / ${trains.length} 个车次`;
    renderActivePanel();
  }

  function renderActivePanel() {
    if (!state.data || state.loading) return;
    const tab = state.activeTab;
    const list = sorted(state.data[tab]);
    els.panels[tab].innerHTML =
      list.length === 0 ? emptyHtml() : list.map(tab === 'flights' ? flightCard : trainCard).join('');
  }

  function sorted(list) {
    const arr = [...list];
    if (state.sort === 'price') arr.sort((a, b) => priceOf(a) - priceOf(b));
    else if (state.sort === 'duration') arr.sort((a, b) => a.durationMin - b.durationMin);
    else arr.sort((a, b) => a.depTime.localeCompare(b.depTime));
    return arr;
  }

  function priceOf(item) {
    return item.type === 'flight'
      ? item.price
      : Math.min(...item.seats.map((s) => s.price));
  }

  function flightCard(f) {
    return `
      <article class="card">
        <div class="card-main">
          <div class="card-top">
            <span class="carrier">${esc(f.airline)}</span>
            <span class="code">${esc(f.flightNo)}</span>
            <span class="tag-soft">准点率 ${f.punctuality}%</span>
          </div>
          <div class="timeline">
            <div class="node">
              <div class="node-time">${esc(f.depTime)}</div>
              <div class="node-place">${esc(f.depAirport)}</div>
            </div>
            <div class="mid">
              <span>${fmtDuration(f.durationMin)}</span>
              <span class="mid-line">${PLANE_SVG}</span>
            </div>
            <div class="node node-right">
              <div class="node-time">${esc(f.arrTime)}${dayBadge(f.arrDayOffset)}</div>
              <div class="node-place">${esc(f.arrAirport)}</div>
            </div>
          </div>
        </div>
        <div class="card-side">
          <div class="price"><em>¥</em>${f.price}</div>
          <div class="price-meta">经济舱 · ${esc(f.discountLabel)}</div>
          <button class="select-btn" type="button" data-action="select">选 择</button>
        </div>
      </article>`;
  }

  function trainCard(t) {
    const minPrice = Math.min(...t.seats.map((s) => s.price));
    const seats = t.seats
      .map(
        (s) => `
      <span class="seat">
        <span class="seat-class">${esc(s.class)}</span>
        <b>¥${s.price}</b>
        <i class="seat-status st-${statusKey(s.status)}">${esc(s.status)}</i>
      </span>`
      )
      .join('');
    return `
      <article class="card">
        <div class="card-main">
          <div class="card-top">
            <span class="carrier">${esc(t.trainNo)}</span>
            <span class="tag-soft">${esc(t.trainType)}</span>
            ${t.overnight ? '<span class="tag-soft">过夜</span>' : ''}
            <span class="stops">途经 ${t.stops} 站</span>
          </div>
          <div class="timeline">
            <div class="node">
              <div class="node-time">${esc(t.depTime)}</div>
              <div class="node-place">${esc(t.depStation)}</div>
            </div>
            <div class="mid">
              <span>${fmtDuration(t.durationMin)}</span>
              <span class="mid-line">${TRAIN_SVG}</span>
            </div>
            <div class="node node-right">
              <div class="node-time">${esc(t.arrTime)}${dayBadge(t.arrDayOffset)}</div>
              <div class="node-place">${esc(t.arrStation)}</div>
            </div>
          </div>
          <div class="seats">${seats}</div>
        </div>
        <div class="card-side">
          <div class="price"><em>¥</em>${minPrice}<span class="price-from">起</span></div>
          <button class="select-btn" type="button" data-action="select">选 择</button>
        </div>
      </article>`;
  }

  function renderSkeleton(panel) {
    const skeleton = `
      <div class="card skeleton">
        <div>
          <div class="sk-row"><span class="sk sk-tag"></span><span class="sk sk-text"></span></div>
          <div class="sk-row"><span class="sk sk-time"></span><span class="sk sk-mid"></span><span class="sk sk-time"></span></div>
          <div class="sk-row"><span class="sk sk-place"></span><span class="sk sk-place"></span></div>
        </div>
        <div class="card-side"><span class="sk sk-price"></span></div>
      </div>`;
    panel.innerHTML = skeleton.repeat(4);
  }

  function emptyHtml() {
    return `
      <div class="empty">
        ${SEARCH_SVG}
        <p>没有找到符合条件的班次，换个日期或城市试试</p>
      </div>`;
  }

  // ---------- 工具函数 ----------

  function esc(str) {
    return String(str ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
    })[ch]);
  }

  function fmtDuration(min) {
    const h = Math.floor(min / 60);
    const m = min % 60;
    if (h === 0) return `${m}分`;
    return m === 0 ? `${h}小时` : `${h}小时${m}分`;
  }

  function dayBadge(offset) {
    return offset > 0 ? `<sup class="day-badge">+${offset}天</sup>` : '';
  }

  function statusKey(status) {
    return { 有票: 'ok', 少量: 'few', 候补: 'wait' }[status] || 'wait';
  }

  function formatDateCn(dateStr) {
    const d = new Date(`${dateStr}T00:00:00`);
    if (Number.isNaN(d.getTime())) return dateStr;
    const wd = ['日', '一', '二', '三', '四', '五', '六'][d.getDay()];
    return `${d.getMonth() + 1}月${d.getDate()}日（周${wd}）`;
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
