'use strict';

(function () {
  const cityInput = document.getElementById('city-input');
  const cityList = document.getElementById('city-list');
  const cityClear = document.getElementById('city-clear');
  const sourceSelect = document.getElementById('source-select');
  const sourceHint = document.getElementById('source-hint');
  const tabs = Array.from(document.querySelectorAll('.tab'));
  const panels = {
    specialty: document.getElementById('panel-specialty'),
    restaurant: document.getElementById('panel-restaurant'),
    personalize: document.getElementById('panel-personalize'),
  };
  const resultSection = document.getElementById('result-section');
  const resultSummary = document.getElementById('result-summary');
  const emptyTip = document.getElementById('empty-tip');

  const formSpecialty = document.getElementById('form-specialty');
  const formRestaurant = document.getElementById('form-restaurant');
  const formPersonalize = document.getElementById('form-personalize');

  const resultPanels = {
    specialty: document.getElementById('specialty-panel'),
    restaurant: document.getElementById('restaurant-panel'),
    personalize: document.getElementById('personalize-panel'),
  };
  const parsedChips = document.getElementById('parsed-chips');
  const personalizeHint = document.getElementById('personalize-hint');
  const personalizeList = document.getElementById('personalize-list');

  const cuisineChips = document.getElementById('cuisine-chips');

  let currentTab = 'specialty';
  let cuisineCode = new Map(); // code -> {code, name}

  // ---------- 工具 ----------

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showError(msg) {
    emptyTip.hidden = false;
    emptyTip.textContent = msg;
    emptyTip.className = 'empty-tip error';
    resultSection.hidden = true;
  }

  function clearError() {
    emptyTip.hidden = true;
    emptyTip.textContent = '';
    emptyTip.className = 'empty-tip';
  }

  function setSummary(text, sourceInfo) {
    let html = escapeHtml(text || '');
    if (sourceInfo && sourceInfo.sourceLabel) {
      html += ` <span class="source-badge" title="当前数据来源">${escapeHtml(sourceInfo.sourceLabel)}${sourceInfo.cached ? ' · 缓存' : ''}</span>`;
    }
    resultSummary.innerHTML = html;
  }

  function updateSourceHint() {
    if (sourceHint && sourceSelect) sourceHint.hidden = sourceSelect.value !== 'llm';
  }
  // 高德数据源仅支持餐厅筛选：其他标签页下禁用该选项并说明原因
  function updateSourceOptions() {
    if (!sourceSelect) return;
    const amapOpt = sourceSelect.querySelector('option[value="amap"]');
    if (!amapOpt) return;
    const usable = currentTab === 'restaurant';
    amapOpt.disabled = !usable;
    amapOpt.textContent = usable ? '高德地图（真实数据）' : '高德地图（仅餐厅筛选）';
    if (!usable && sourceSelect.value === 'amap') {
      sourceSelect.value = 'auto';
      updateSourceHint();
    }
  }
  function loadingText(fallback) {
    return sourceSelect && sourceSelect.value === 'llm' ? 'AI 生成中…' : fallback;
  }

  function setTab(tab) {
    currentTab = tab;
    tabs.forEach((t) => {
      const active = t.dataset.tab === tab;
      t.classList.toggle('is-active', active);
      t.setAttribute('aria-selected', active ? 'true' : 'false');
    });
    Object.entries(panels).forEach(([k, el]) => {
      el.hidden = k !== tab;
    });
    Object.entries(resultPanels).forEach(([k, el]) => {
      el.hidden = k !== tab;
    });
    updateSourceOptions();
  }

  function requireCity() {
    const v = cityInput.value.trim();
    if (!v) {
      cityInput.focus();
      throw new Error('请先输入目的地城市');
    }
    return v;
  }

  // ---------- 城市自动补全 ----------

  async function loadCities() {
    try {
      const res = await fetch('/api/cities');
      const data = await res.json();
      cityList.innerHTML = '';
      const cities = Array.isArray(data) ? data : (data.cities || []);
      cities.forEach((c) => {
        const opt = document.createElement('option');
        opt.value = c.name;
        opt.textContent = `${c.name}（${c.pinyin}）`;
        cityList.appendChild(opt);
      });
    } catch (e) {
      console.warn('[food] load cities failed', e);
    }
  }

  // ---------- 菜系 chips ----------

  async function loadCuisines() {
    try {
      const res = await fetch('/api/food/cuisines');
      const data = await res.json();
      cuisineCode = new Map(data.map((c) => [c.code, c]));
      cuisineChips.innerHTML = '';
      data.forEach((c) => {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'chip';
        btn.dataset.code = c.code;
        btn.dataset.name = c.name;
        btn.textContent = c.name;
        btn.setAttribute('aria-pressed', 'false');
        btn.addEventListener('click', () => {
          btn.classList.toggle('is-on');
          btn.setAttribute('aria-pressed', btn.classList.contains('is-on') ? 'true' : 'false');
        });
        cuisineChips.appendChild(btn);
      });
    } catch (e) {
      console.warn('[food] load cuisines failed', e);
    }
  }

  function selectedCuisineNames() {
    return Array.from(cuisineChips.querySelectorAll('.chip.is-on')).map((b) => b.dataset.name);
  }

  // ---------- Tab 1: 特色菜品 ----------

  async function submitSpecialty(evt) {
    evt.preventDefault();
    clearError();
    let city;
    try { city = requireCity(); } catch (e) { return showError(e.message); }
    const category = document.getElementById('specialty-category').value;

    setTab('specialty');
    resultSection.hidden = true;
    emptyTip.hidden = false;
    emptyTip.textContent = loadingText('加载中…');
    emptyTip.className = 'empty-tip';

    try {
      const url = new URL('/api/food/specialties', location.origin);
      url.searchParams.set('city', city);
      if (category) url.searchParams.set('category', category);
      url.searchParams.set('source', sourceSelect.value);
      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');

      setSummary(`「${data.query.city}」的${data.query.category === '全部' ? '' : data.query.category + '类'}特色菜，共 ${data.specialties.length} 道`, data);
      renderSpecialties(data.specialties);
      resultSection.hidden = false;
      emptyTip.hidden = true;
    } catch (e) {
      showError(e.message);
    }
  }

  function renderSpecialties(list) {
    const root = resultPanels.specialty;
    root.innerHTML = '';
    if (!list.length) {
      root.innerHTML = '<p class="empty-tip">暂无该分类的特色菜品，试试其他分类。</p>';
      return;
    }
    list.forEach((d) => {
      const card = document.createElement('article');
      card.className = 'card dish-card';
      card.innerHTML = `
        <header class="card-head">
          <h3 class="dish-name">${escapeHtml(d.name)}</h3>
          <span class="dish-cat">${escapeHtml(d.category)}</span>
        </header>
        <p class="dish-intro">${escapeHtml(d.intro)}</p>
        ${d.culture ? `<p class="dish-culture">${escapeHtml(d.culture)}</p>` : ''}
        <ul class="dish-tags">${(d.tags || []).map((t) => `<li class="chip tag-chip">${escapeHtml(t)}</li>`).join('')}</ul>
        <footer class="dish-foot">
          <span class="dish-season">最佳：${escapeHtml(d.season || '四季')}</span>
          <span class="dish-availability">市内 <strong>${d.availableRestaurants}</strong> 家可尝</span>
        </footer>
      `;
      root.appendChild(card);
    });
  }

  // ---------- Tab 2: 餐厅 ----------

  async function submitRestaurant(evt) {
    evt.preventDefault();
    clearError();
    let city;
    try { city = requireCity(); } catch (e) { return showError(e.message); }
    const priceMin = Number(document.getElementById('price-min').value || 0);
    const priceMax = Number(document.getElementById('price-max').value || 1000);
    if (priceMin < 0 || priceMax < 0 || priceMin > priceMax) {
      return showError('请填写有效的人均区间（最低 ≤ 最高，且均为非负数）');
    }
    const slot = document.getElementById('slot-select').value;
    const openNow = document.getElementById('open-now').checked;
    const sort = document.getElementById('restaurant-sort').value;
    const cuisines = selectedCuisineNames();

    setTab('restaurant');
    resultSection.hidden = true;
    emptyTip.hidden = false;
    emptyTip.textContent = loadingText('加载中…');
    emptyTip.className = 'empty-tip';

    try {
      const url = new URL('/api/food/restaurants', location.origin);
      url.searchParams.set('city', city);
      cuisines.forEach((c) => url.searchParams.append('cuisines', c));
      url.searchParams.set('priceMin', String(priceMin));
      url.searchParams.set('priceMax', String(priceMax));
      if (slot) url.searchParams.set('slot', slot);
      url.searchParams.set('openNow', String(openNow));
      url.searchParams.set('sort', sort);
      url.searchParams.set('source', sourceSelect.value);

      const res = await fetch(url);
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');

      const cuisineText = cuisines.length ? cuisines.join(' / ') : '不限';
      const slotText = slot ? `· ${slot}` : '';
      const openText = openNow ? '· 营业中' : '';
      setSummary(`「${data.query.city}」共 ${data.restaurants.length} 家 · 菜系：${cuisineText} · 人均 ¥${data.query.priceMin}–${data.query.priceMax} ${slotText}${openText}`, data);
      renderRestaurants(data.restaurants);
      resultSection.hidden = false;
      emptyTip.hidden = true;
    } catch (e) {
      showError(e.message);
    }
  }

  function renderRestaurants(list) {
    const root = resultPanels.restaurant;
    root.innerHTML = '';
    if (!list.length) {
      root.innerHTML = '<p class="empty-tip">暂无符合条件的餐厅，试试放宽筛选条件。</p>';
      return;
    }
    list.forEach((r) => {
      const card = document.createElement('article');
      card.className = 'card rest-card';
      const stars = renderStars(r.rating);
      const openBadge = r.hours.isOpenNow
        ? '<span class="open-badge open">营业中</span>'
        : '<span class="open-badge closed">未营业</span>';
      card.innerHTML = `
        <header class="card-head">
          <h3 class="rest-name">${escapeHtml(r.name)}</h3>
          ${openBadge}
        </header>
        <div class="rest-meta">
          <span class="cuisines">${r.cuisines.map((c) => `<span class="chip cuisine-chip">${escapeHtml(c)}</span>`).join('')}</span>
          <span class="price">人均 ${r.avgPrice == null ? '<strong>以现场为准</strong>' : `<strong>¥${r.avgPrice}</strong> · ${escapeHtml(r.priceRange)}`}</span>
        </div>
        <div class="rest-info">
          <p class="line"><span class="ico">📍</span>${escapeHtml(r.location.district)} ${escapeHtml(r.location.address)}${r.location.nearLandmark ? ' · <em>' + escapeHtml(r.location.nearLandmark) + '</em>' : ''}</p>
          <p class="line"><span class="ico">🕒</span>${escapeHtml(r.hours.open)}–${escapeHtml(r.hours.close)} · 时段：${r.hours.slots.join(' / ')}</p>
          <p class="line"><span class="ico">⭐</span>${stars} <span class="rating-num">${r.rating.toFixed(1)}</span> · ${r.reviewCount ? r.reviewCount.toLocaleString('zh-CN') + ' 条评价' : '评价数暂无'}</p>
          <p class="line tags-line"><span class="ico">🏷️</span>${(r.tags || []).map((t) => `<span class="chip tag-chip">${escapeHtml(t)}</span>`).join('')}</p>
          ${(r.signatureDishes || []).length ? `<p class="line sig-line"><span class="ico">🍴</span>招牌：${(r.signatureDishes || []).map((d) => `<span class="sig-dish">${escapeHtml(d)}</span>`).join('、')}</p>` : ''}
          ${r.reservation ? `<p class="line"><span class="ico">📅</span>${escapeHtml(r.reservation)}</p>` : ''}
        </div>
      `;
      root.appendChild(card);
    });
  }

  function renderStars(rating) {
    const full = Math.floor(rating);
    const half = (rating - full) >= 0.5 ? 1 : 0;
    const empty = 5 - full - half;
    return '★'.repeat(full) + (half ? '½' : '') + '☆'.repeat(empty);
  }

  // ---------- Tab 3: 个性化 ----------

  async function submitPersonalize(evt) {
    evt.preventDefault();
    clearError();
    let city;
    try { city = requireCity(); } catch (e) { return showError(e.message); }
    const query = document.getElementById('query-input').value.trim();
    if (query.length < 4) {
      return showError('需求描述太短（至少 4 个字），补充一些偏好让我们更懂你');
    }

    setTab('personalize');
    resultSection.hidden = true;
    emptyTip.hidden = false;
    emptyTip.textContent = loadingText('分析中…');
    emptyTip.className = 'empty-tip';

    try {
      const res = await fetch('/api/food/personalize', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ city, query, source: sourceSelect.value }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '请求失败');

      setSummary(`「${data.query.city}」· 你的描述：「${data.query.raw}」`, data);
      renderPersonalize(data);
      resultSection.hidden = false;
      emptyTip.hidden = true;
    } catch (e) {
      showError(e.message);
    }
  }

  function renderPersonalize(data) {
    // 解析出的关键词
    parsedChips.innerHTML = '';
    const items = data.parsed || [];
    if (items.length) {
      items.forEach((p) => {
        const c = document.createElement('span');
        c.className = 'chip parsed-chip';
        c.innerHTML = `<strong>${escapeHtml(p.key)}</strong><span class="hint">${escapeHtml(p.hint || '')}</span>`;
        parsedChips.appendChild(c);
      });
      parsedChips.hidden = false;
    } else {
      parsedChips.hidden = true;
    }

    if (data.hint) {
      personalizeHint.textContent = data.hint;
      personalizeHint.hidden = false;
    } else {
      personalizeHint.hidden = true;
    }

    const list = data.recommendations || [];
    personalizeList.innerHTML = '';
    if (!list.length) {
      personalizeList.innerHTML = '<p class="empty-tip">当前没找到匹配的餐厅，试着补充更多偏好。</p>';
      return;
    }
    list.forEach((rec, idx) => {
      const r = rec.restaurant;
      const stars = renderStars(r.rating);
      const openBadge = r.hours.isOpenNow
        ? '<span class="open-badge open">营业中</span>'
        : '<span class="open-badge closed">未营业</span>';
      const card = document.createElement('article');
      card.className = 'card rest-card';
      card.innerHTML = `
        <header class="card-head">
          <span class="rank">${idx + 1}</span>
          <h3 class="rest-name">${escapeHtml(r.name)}</h3>
          ${openBadge}
          <span class="match-score" title="匹配度">${(rec.score * 100).toFixed(0)} 分</span>
        </header>
        <div class="reason-tag">${escapeHtml(rec.reason)}</div>
        <div class="rest-meta">
          <span class="cuisines">${r.cuisines.map((c) => `<span class="chip cuisine-chip">${escapeHtml(c)}</span>`).join('')}</span>
          <span class="price">人均 ${r.avgPrice == null ? '<strong>以现场为准</strong>' : `<strong>¥${r.avgPrice}</strong> · ${escapeHtml(r.priceRange)}`}</span>
        </div>
        <div class="rest-info">
          <p class="line"><span class="ico">📍</span>${escapeHtml(r.location.district)} ${escapeHtml(r.location.address)}${r.location.nearLandmark ? ' · <em>' + escapeHtml(r.location.nearLandmark) + '</em>' : ''}</p>
          <p class="line"><span class="ico">🕒</span>${escapeHtml(r.hours.open)}–${escapeHtml(r.hours.close)} · 时段：${r.hours.slots.join(' / ')}</p>
          <p class="line"><span class="ico">⭐</span>${stars} <span class="rating-num">${r.rating.toFixed(1)}</span> · ${r.reviewCount ? r.reviewCount.toLocaleString('zh-CN') + ' 条评价' : '评价数暂无'}</p>
          <p class="line tags-line"><span class="ico">🏷️</span>${(r.tags || []).map((t) => `<span class="chip tag-chip">${escapeHtml(t)}</span>`).join('')}</p>
          ${(r.signatureDishes || []).length ? `<p class="line sig-line"><span class="ico">🍴</span>招牌：${(r.signatureDishes || []).map((d) => `<span class="sig-dish">${escapeHtml(d)}</span>`).join('、')}</p>` : ''}
        </div>
      `;
      personalizeList.appendChild(card);
    });
  }

  // ---------- 事件绑定 ----------

  tabs.forEach((t) => {
    t.addEventListener('click', () => setTab(t.dataset.tab));
  });

  cityClear.addEventListener('click', () => {
    cityInput.value = '';
    updateCityClear();
    cityInput.focus();
    clearError();
  });

  cityInput.addEventListener('input', updateCityClear);

  if (sourceSelect) {
    sourceSelect.addEventListener('change', updateSourceHint);
    updateSourceHint();
    updateSourceOptions();
  }

  function updateCityClear() {
    if (!cityClear) return;
    if (cityInput.value.trim()) {
      cityClear.hidden = false;
    } else {
      cityClear.hidden = true;
    }
  }

  formSpecialty.addEventListener('submit', submitSpecialty);
  formRestaurant.addEventListener('submit', submitRestaurant);
  formPersonalize.addEventListener('submit', submitPersonalize);

  // ---------- 初始化 ----------

  loadCities();
  loadCuisines();
  setTab('specialty');
})();