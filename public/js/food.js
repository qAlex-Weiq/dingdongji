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

  const STAR_SVG =
    '<svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">' +
    '<path d="M12 2l2.9 6.3 6.9.8-5.1 4.7 1.4 6.8L12 17.2l-6.1 3.4 1.4-6.8L2.2 9.1l6.9-.8L12 2z"/></svg>';

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function showError(msg) {
    LLMProgress.stop();
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

  /** LLM 慢速查询：显示分阶段进度横幅；其余数据源显示原加载文案 */
  function llmLoading(text) {
    if (sourceSelect.value === 'llm') {
      emptyTip.hidden = true;
      LLMProgress.start(emptyTip.parentElement, emptyTip);
    } else {
      emptyTip.hidden = false;
      emptyTip.textContent = text;
      emptyTip.className = 'empty-tip';
    }
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
    llmLoading('加载中…');

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
      LLMProgress.stop();
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
    list.forEach((d, i) => {
      const card = document.createElement('article');
      card.className = 'card sight-card menu-card';
      const tags = (d.tags || [])
        .slice(0, 4)
        .map((t) => `<span class="tag-soft">${escapeHtml(t)}</span>`)
        .join('');
      const meta = [
        ['最佳', d.season || '四季'],
        ['可尝', `市内约 ${d.availableRestaurants} 家`],
      ]
        .filter(([, v]) => v)
        .map(([k, v]) => `<span class="sight-meta-item"><i>${k}</i>${escapeHtml(v)}</span>`)
        .join('');
      card.innerHTML = `
        <div class="sight-rank ${i < 3 ? 'rank-top' : ''}">${i + 1}</div>
        <div class="card-main">
          <div class="card-top">
            <span class="carrier">${escapeHtml(d.name)}</span>
            <span class="tag-soft">${escapeHtml(d.category)}</span>
          </div>
          <p class="sight-desc">${escapeHtml(d.intro)}</p>
          <div class="sight-meta">${meta}</div>
          ${tags ? `<div class="sight-tags">${tags}</div>` : ''}
        </div>
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
    llmLoading('加载中…');

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
      LLMProgress.stop();
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
    list.forEach((r, i) => {
      const card = document.createElement('article');
      card.className = 'card sight-card';
      card.innerHTML = restaurantCard(r, i);
      root.appendChild(card);
    });
  }

  /** 餐厅卡（与景点/酒店卡片同构）：编号 + 名称/菜系/评分/营业 + 招牌菜 + 营业/地址 + 人均参考价 */
  function restaurantCard(r, i) {
    const openBadge = r.hours.isOpenNow
      ? '<span class="open-badge open">营业中</span>'
      : '<span class="open-badge closed">未营业</span>';
    const signature = (r.signatureDishes || []).length
      ? `<p class="sight-desc">招牌：${(r.signatureDishes || []).slice(0, 3).map((d) => escapeHtml(d)).join('、')}</p>`
      : '';
    const addr = [
      [r.location.district, r.location.address].filter(Boolean).map(escapeHtml).join(' '),
      r.location.nearLandmark ? escapeHtml(r.location.nearLandmark) : '',
    ].filter(Boolean).join(' · ');
    const meta = [
      ['营业', `${escapeHtml(r.hours.open)}–${escapeHtml(r.hours.close)}`],
      ['地址', addr],
    ]
      .filter(([, v]) => v)
      .map(([k, v]) => `<span class="sight-meta-item"><i>${k}</i>${v}</span>`)
      .join('');
    const tags = (r.tags || [])
      .slice(0, 4)
      .map((t) => `<span class="tag-soft">${escapeHtml(t)}</span>`)
      .join('');
    const price = r.avgPrice == null
      ? '<div class="sight-score"><em>—</em><span>人均以门店为准</span></div>'
      : `<div class="sight-score"><em>¥${r.avgPrice}</em><span>人均参考</span></div>`;
    return `
      <article class="card sight-card restaurant-card">
        <div class="sight-rank ${i < 3 ? 'rank-top' : ''}">${i + 1}</div>
        <div class="card-main">
          <div class="card-top">
            <span class="carrier">${escapeHtml(r.name)}</span>
            <span class="tag-soft">${escapeHtml((r.cuisines || [])[0] || '美食')}</span>
            <span class="sight-rating">${STAR_SVG}${r.rating.toFixed(1)}</span>
            ${openBadge}
          </div>
          ${signature}
          <div class="sight-meta">${meta}</div>
          ${tags ? `<div class="sight-tags">${tags}</div>` : ''}
        </div>
        <div class="card-side sight-side">
          ${price}
        </div>
      </article>`;
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
    llmLoading('分析中…');

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
      LLMProgress.stop();
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
      const card = document.createElement('article');
      card.className = 'card sight-card restaurant-card recommendation-card';
      // 复用餐厅卡结构；推荐理由替换招牌菜行（无招牌菜则插到营业信息前），侧边加匹配指数
      let html = restaurantCard(r, idx);
      if (html.includes('<p class="sight-desc">')) {
        html = html.replace(/<p class="sight-desc">[\s\S]*?<\/p>/, `<p class="sight-desc">${escapeHtml(rec.reason)}</p>`);
      } else {
        html = html.replace('<div class="sight-meta">', `<p class="sight-desc">${escapeHtml(rec.reason)}</p><div class="sight-meta">`);
      }
      card.innerHTML = html.replace(
        '<div class="card-side sight-side">',
        `<div class="card-side sight-side"><div class="sight-score"><em>${rec.score}</em><span>匹配指数</span></div>`
      );
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

  // 快捷城市芯片：填入城市并按当前 tab 自动查询（个性化 tab 需先补需求描述）
  function bindQuickChips() {
    const wrap = document.querySelector('.quick-chips');
    if (!wrap) return;
    wrap.addEventListener('click', (e) => {
      const btn = e.target.closest('.chip');
      if (!btn) return;
      cityInput.value = btn.dataset.city || '';
      if (currentTab === 'personalize') {
        const q = document.getElementById('query-input');
        if (q && !q.value.trim()) { q.focus(); return; }
      }
      const forms = { specialty: formSpecialty, restaurant: formRestaurant, personalize: formPersonalize };
      forms[currentTab].requestSubmit();
    });
  }
  bindQuickChips();

  loadCities();
  loadCuisines();
  setTab('specialty');
})();