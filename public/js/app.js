'use strict';

/* ============================================================
 * 订懂机 · 旅行规划 —— 车票模块前端逻辑
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
    filterBar: $('#filter-bar'),
    filterType: $('#filter-type'),
    filterDep: $('#filter-dep'),
    cityList: $('#city-list'),
    toast: $('#toast'),
  };

  const state = {
    activeTab: 'flights', // 'flights' | 'trains'
    sort: 'dep',          // 'dep' | 'price' | 'duration'
    data: null,           // { query, flights, trains }
    loading: false,
    filters: { type: 'all', dep: 'all' }, // 车型 'all'|'hsr'|'normal'；时段 'all'|'dawn'|'morning'|'afternoon'|'night'
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
    bindFilterGroups();
    bindQuickChips();

    // 事件委托：卡片上的”选择”按钮 / 空态清除筛选
    document.addEventListener('click', (e) => {
      if (e.target.closest('[data-action=”clear-filters”]')) {
        resetFilters();
        return;
      }
      const selectBtn = e.target.closest('[data-action=”select”]');
      if (selectBtn) {
        handleSelectTicket(selectBtn);
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
    els.searchBtn.textContent = loading ? '查询中…' : '查询';
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
    updateCounts();
    els.filterBar.hidden = false;
    els.routeSummary.innerHTML =
      `<b>${esc(query.from)}</b> → <b>${esc(query.to)}</b> · ${formatDateCn(query.date)}` +
      ` · 共 ${flights.length} 个航班 / ${trains.length} 个车次`;
    renderActivePanel();
  }

  function renderActivePanel() {
    if (!state.data || state.loading) return;
    const tab = state.activeTab;
    const all = state.data[tab];
    const list = sorted(applyFilters(all, tab));
    const note = tab === 'trains' ? trainsSourceNote() : flightsSourceNote();
    const filtered = list.length !== all.length;
    updateFilterVisibility();
    updateCounts();
    els.panels[tab].innerHTML =
      note + (list.length === 0 ? emptyHtml(filtered) : list.map(tab === 'flights' ? flightCard : trainCard).join(''));
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
      <article class="card ticket-card flight-ticket">
        <div class="card-main">
          <div class="card-top">
            <span class="carrier">${esc(f.airline)}</span>
            <span class="code">${esc(f.flightNo)}</span>
            ${punctualityTag(f.punctuality)}
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
          ${selectBtnHtml(f)}
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
        ${s.discount ? `<i class="seat-discount">${esc(s.discount)}</i>` : ''}
        <i class="seat-status st-${statusKey(s.status)}">${esc(s.status)}</i>
      </span>`
      )
      .join('');
    return `
      <article class="card ticket-card train-ticket">
        <div class="card-main">
          <div class="card-top">
            <span class="carrier">${esc(t.trainNo)}</span>
            <span class="tag-soft">${esc(t.trainType)}</span>
            ${t.overnight ? '<span class="tag-soft">过夜</span>' : ''}
            ${t.stops != null ? `<span class="stops">途经 ${t.stops} 站</span>` : ''}
          </div>
          <div class="timeline">
            <div class="node">
              <div class="node-time">${esc(t.depTime)}</div>
              <div class="node-place">${esc(t.depStation)}</div>
            </div>
            <div class="mid">
              <span>${t.durationMin != null ? fmtDuration(t.durationMin) : '时刻以车站为准'}</span>
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
          ${selectBtnHtml(t)}
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

  function emptyHtml(filtered) {
    return `
      <div class="empty">
        ${SEARCH_SVG}
        <p>${filtered ? '当前筛选条件下没有班次，试试放宽条件' : '没有找到符合条件的班次，换个日期或城市试试'}</p>
        ${filtered ? '<button type="button" class="btn-ghost" data-action="clear-filters">清除筛选</button>' : ''}
      </div>`;
  }

  // ---------- 筛选与快捷示例（纯前端，数据已在内存） ----------

  /** 车型/时段组合筛选；时段口径与 12306 一致：凌晨 00-06 / 上午 06-12 / 下午 12-18 / 晚上 18-24 */
  function applyFilters(list, tab) {
    const DEP_RANGE = { dawn: [0, 6], morning: [6, 12], afternoon: [12, 18], night: [18, 24] };
    return list.filter((it) => {
      if (tab === 'trains' && state.filters.type !== 'all') {
        const wantHsr = state.filters.type === 'hsr';
        const isHsr = /^[GDC]/.test(it.trainNo);
        if (wantHsr !== isHsr) return false;
      }
      if (state.filters.dep !== 'all') {
        const [lo, hi] = DEP_RANGE[state.filters.dep];
        const h = Number(it.depTime.slice(0, 2));
        if (!(h >= lo && h < hi)) return false;
      }
      return true;
    });
  }

  /** tab 计数：筛选激活时显示 "N/M"（过滤后/全部） */
  function updateCounts() {
    ['flights', 'trains'].forEach((tab) => {
      const all = state.data[tab];
      const n = applyFilters(all, tab).length;
      els.counts[tab].textContent = n === all.length ? String(all.length) : `${n}/${all.length}`;
    });
  }

  /** 车型筛选仅对火车票 tab 有意义 */
  function updateFilterVisibility() {
    els.filterType.hidden = state.activeTab !== 'trains';
  }

  function bindFilterGroups() {
    [['type', els.filterType], ['dep', els.filterDep]].forEach(([key, group]) => {
      group.addEventListener('click', (e) => {
        const btn = e.target.closest('.pill');
        if (!btn || btn.classList.contains('is-active')) return;
        state.filters[key] = btn.dataset.v;
        group.querySelectorAll('.pill').forEach((p) => p.classList.toggle('is-active', p === btn));
        renderActivePanel();
      });
    });
  }

  function resetFilters() {
    state.filters = { type: 'all', dep: 'all' };
    [els.filterType, els.filterDep].forEach((group) => {
      group.querySelectorAll('.pill').forEach((p, i) => p.classList.toggle('is-active', i === 0));
    });
    renderActivePanel();
  }

  /** 快捷路线芯片：一键填充起终点并查询 */
  function bindQuickChips() {
    const wrap = document.querySelector('.quick-chips');
    if (!wrap) return;
    wrap.addEventListener('click', (e) => {
      const btn = e.target.closest('.chip');
      if (!btn) return;
      els.from.value = btn.dataset.from || '';
      els.to.value = btn.dataset.to || '';
      els.form.requestSubmit();
    });
  }

  /** 机票历史准点率徽标：≥90 绿（很准点）/ 80-89 琥珀（较为准点）/ <80 橙（易延误） */
  function punctualityTag(p) {
    if (p == null) return '';
    const level = p >= 90 ? 'hi' : p >= 80 ? 'mid' : 'lo';
    const label = p >= 90 ? '很准点' : p >= 80 ? '较为准点' : '易延误';
    return `<span class="tag-punctual pk-${level}" title="该航班历史准点率 ${p}%">准点率 ${p}% · ${label}</span>`;
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

  function flightsSourceNote() {
    const d = state.data;
    if (!d || !d.flightsSource) return '';
    if (d.flightsSource === 'amadeus') {
      return `<div class="source-note ok"><span class="dot"></span>机票班次 · 含税票价来自 Amadeus 实时数据</div>`;
    }
    return `<div class="source-note warn"><span class="dot"></span>${esc(d.flightsNote || '机票为模拟数据')}</div>`;
  }

  function trainsSourceNote() {
    const d = state.data;
    if (!d || !d.trainsSource) return '';
    if (d.trainsSource === '12306') {
      return `<div class="source-note ok"><span class="dot"></span>火车班次 · 折扣票价 · 余票来自 12306 实时数据</div>`;
    }
    return `<div class="source-note warn"><span class="dot"></span>${esc(d.trainsNote || '火车票为模拟数据')}</div>`;
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

  // ---------- 车票选择 → 行程绑定 ----------

  const TRANSPORT_KEY = 'ddj.selectedTransport.v1';

  function handleSelectTicket(btn) {
    const card = btn.closest('.ticket-card');
    if (!card) return;

    // 解析选中班次数据
    const isFlight = card.classList.contains('flight-ticket');
    let transport;

    if (isFlight) {
      const carrier = card.querySelector('.carrier')?.textContent.trim() || '';
      const code    = card.querySelector('.code')?.textContent.trim() || '';
      const times   = card.querySelectorAll('.node-time');
      const places  = card.querySelectorAll('.node-place');
      const depTime = times[0]?.textContent.replace(/\+\d天/, '').trim() || '';
      const arrTime = times[1]?.textContent.replace(/\+\d天/, '').trim() || '';
      const depCity = places[0]?.textContent.trim() || '';
      const arrCity = places[1]?.textContent.trim() || '';
      const priceRaw = card.querySelector('.price')?.textContent.replace(/[^0-9]/g, '') || '0';
      const cabin   = card.querySelector('.price-meta')?.textContent.split('·')[0].trim() || '经济舱';
      transport = {
        type: 'flight',
        carrier,
        flightNo: code,
        depCity,
        arrCity,
        depTime,
        arrTime,
        price: Number(priceRaw),
        cabin,
      };
    } else {
      // 火车票
      const trainNo   = card.querySelector('.carrier')?.textContent.trim() || '';
      const times     = card.querySelectorAll('.node-time');
      const places    = card.querySelectorAll('.node-place');
      const depTime   = times[0]?.textContent.replace(/\+\d天/, '').trim() || '';
      const arrTime   = times[1]?.textContent.replace(/\+\d天/, '').trim() || '';
      const depCity   = places[0]?.textContent.trim() || '';
      const arrCity   = places[1]?.textContent.trim() || '';
      const priceRaw  = card.querySelector('.price')?.textContent.replace(/[^0-9]/g, '') || '0';
      transport = {
        type: 'train',
        carrier: trainNo,
        flightNo: null,
        depCity,
        arrCity,
        depTime,
        arrTime,
        price: Number(priceRaw),
        cabin: null,
      };
    }

    // 取消其他已选状态
    document.querySelectorAll('.select-btn.is-selected').forEach((b) => {
      b.classList.remove('is-selected');
      b.textContent = '选择';
      b.removeAttribute('aria-pressed');
    });

    // 切换当前按钮
    const alreadySelected = btn.classList.contains('is-selected');
    if (alreadySelected) {
      btn.classList.remove('is-selected');
      btn.textContent = '选择';
      btn.removeAttribute('aria-pressed');
      try { localStorage.removeItem(TRANSPORT_KEY); } catch { /* ignore */ }
      showToast('已取消选定班次');
    } else {
      btn.classList.add('is-selected');
      btn.textContent = '✓ 已选定';
      btn.setAttribute('aria-pressed', 'true');
      try { localStorage.setItem(TRANSPORT_KEY, JSON.stringify(transport)); } catch { /* ignore */ }
      showToast('✓ 已选定该班次，已自动同步至「行程规划」！');
    }
  }

  /** 读取已选定的班次（跨页面共享，plan.html 会消费） */
  function readSelectedTransport() {
    try {
      const raw = localStorage.getItem(TRANSPORT_KEY);
      if (!raw) return null;
      const d = JSON.parse(raw);
      return d && typeof d === 'object' ? d : null;
    } catch {
      return null;
    }
  }

  /**
   * 当前卡片是否为已选定班次。
   * 用车次/航班号 + 出发时刻做匹配 —— 同一车次同一时刻在一次查询里唯一。
   */
  function isSelectedTicket(item) {
    const sel = readSelectedTransport();
    if (!sel) return false;
    const code = item.flightNo || item.trainNo || '';
    const selCode = sel.flightNo || sel.carrier || '';
    return String(code) === String(selCode) && String(item.depTime || '') === String(sel.depTime || '');
  }

  /** 选择按钮 HTML（保持重渲染后的选定态） */
  function selectBtnHtml(item) {
    const on = isSelectedTicket(item);
    return `<button class="select-btn${on ? ' is-selected' : ''}" type="button" data-action="select"` +
      `${on ? ' aria-pressed="true"' : ''}>${on ? '✓ 已选定' : '选择'}</button>`;
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
