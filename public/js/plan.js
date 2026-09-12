'use strict';

/* ============================================================
 * 订懂机 · 旅行规划 —— 行程规划页前端逻辑
 * 职责：一键智能规划 / 行程篮渲染 / 必去标记 / 天数与日期 /
 *       调用 /api/plan / 时间轴渲染 / AI 建议采纳与移除
 *
 * 关键设计：骨架先行 —— 确定性编排在服务端瞬时完成，Agent 文案随后返回，
 * 因此页面不会出现长时间空白（参见 agent-strip 的分步展示）。
 *
 * 一键规划采用「客户端批量写入行程篮」而非服务端缓存：
 * 选好的条目直接进 localStorage，用户随后去景点/美食页会看到「✓ 已加入」，
 * 可以随时增删后回到本页重新生成 —— 全站共用同一份数据源。
 * ============================================================ */

(() => {
  const $ = (sel) => document.querySelector(sel);

  const els = {
    basketCity: $('#basket-city'),
    basketEmpty: $('#basket-empty'),
    basketGroups: $('#basket-groups'),
    controls: $('#plan-controls'),
    daysInput: $('#days-input'),
    daysMinus: $('#days-minus'),
    daysPlus: $('#days-plus'),
    startDate: $('#start-date'),
    hint: $('#plan-hint'),
    generateBtn: $('#generate-btn'),
    agentStrip: $('#agent-strip'),
    agentSteps: $('#agent-steps'),
    agentModel: $('#agent-model'),
    warnings: $('#plan-warnings'),
    warningsList: $('#warnings-list'),
    timelineSection: $('#timeline-section'),
    timelineTitle: $('#timeline-title'),
    timeline: $('#timeline'),
    regenBtn: $('#regen-btn'),
    toast: $('#toast'),
    // 一键智能规划
    apFrom: $('#ap-from'),
    apTo: $('#ap-to'),
    apDate: $('#ap-date'),
    apDays: $('#ap-days'),
    apCityList: $('#ap-city-list'),
    apTierPills: document.querySelectorAll('#auto-plan .pill'),
    apHint: $('#ap-hint'),
    apGenerate: $('#ap-generate'),
  };

  const state = {
    days: 3,
    loading: false,      // 一键规划进行中
    generating: false,   // /api/plan 调用中
    lastPlan: null,
    tier: 'comfort',
    dismissed: new Set(),   // 用户已移除的 AI 建议（名称集合）
  };

  const GROUP_META = {
    ticket: { label: '车票', order: 1 },
    hotel: { label: '酒店', order: 2 },
    sight: { label: '景点', order: 3 },
    dish: { label: '特色菜', order: 4 },
    food: { label: '餐厅', order: 5 },
  };

  const MIN_SIGHTS = 1;

  /**
   * 三档偏好对应的实际筛选参数。
   *
   * hotelTier 用的是 /api/hotel/search 的 tier 取值
   * （any / budget / comfort / upscale / luxury，非中文档位名）；
   * priceMin/priceMax 对应美食页的人均区间。
   */
  const TIER_CONFIG = {
    budget:  { hotelTier: 'budget',  priceMin: 0,   priceMax: 80,  label: '经济实惠' },
    comfort: { hotelTier: 'comfort', priceMin: 50,  priceMax: 200, label: '舒适均衡' },
    luxury:  { hotelTier: 'luxury',  priceMin: 150, priceMax: 600, label: '品质轻奢' },
  };

  // ── 初始化 ──────────────────────────────────────────────────────────────

  function init() {
    renderBasket();
    bindEvents();
    bindAutoPlan();
    prefillDate();
    Cart.subscribe(() => renderBasket());

    // 一键规划：从全局上下文预填目的地
    const ctx = Cart.ctx();
    if (ctx.city) {
      if (els.apTo && !els.apTo.value) els.apTo.value = ctx.city;
    }
    if (ctx.travelDate) {
      if (els.apDate && !els.apDate.value) els.apDate.value = ctx.travelDate;
    }
    loadCityList();
  }

  /** 拉取城市列表，填入两个 datalist */
  async function loadCityList() {
    try {
      const res = await fetch('/api/cities');
      const data = await res.json();
      const cities = Array.isArray(data) ? data : (data.cities || []);
      if (!els.apCityList) return;
      els.apCityList.innerHTML = cities.map((c) => `<option value="${esc(c.name)}">`).join('');
    } catch {
      // 不阻断流程
    }
  }

  function bindEvents() {
    els.daysMinus.addEventListener('click', () => setDays(state.days - 1));
    els.daysPlus.addEventListener('click', () => setDays(state.days + 1));
    els.generateBtn.addEventListener('click', generate);
    els.regenBtn.addEventListener('click', generate);

    // 事件委托：必去 / 移除 / AI建议采纳 / AI建议移除
    els.basketGroups.addEventListener('click', (e) => {
      const pin = e.target.closest('.pin-btn');
      const remove = e.target.closest('.remove-btn');
      if (!pin && !remove) return;

      const item = e.target.closest('.basket-item');
      if (!item) return;
      const { cartType, cartName } = item.dataset;
      const data = Cart.read();
      const entry = data.items.find((it) => it.type === cartType && it.payload.name === cartName);
      if (!entry) return;

      if (pin) {
        Cart.toggleMustGo(entry.type, data.city, entry.payload);
        toast(entry.mustGo ? `已取消「${cartName}」的必去标记` : `已标记「${cartName}」为必去`);
      } else {
        Cart.toggle(entry.type, data.city, entry.payload);
        toast(`已移出「${cartName}」`);
      }
    });

    // 时间轴上的 AI 建议事件（采纳 / 移除 / 移除所有）
    els.timeline && els.timeline.addEventListener('click', (e) => {
      const accept = e.target.closest('.sugg-btn.is-accept');
      const dismiss = e.target.closest('.sugg-btn.is-dismiss');
      const clearAll = e.target.closest('.day-sugg-clear');

      if (accept || dismiss || clearAll) {
        handleSuggAction(e, { accept, dismiss, clearAll });
      }
    });
  }

  function handleSuggAction(e, { accept, dismiss, clearAll }) {
    const data = Cart.read();
    const city = data.city || els.apTo?.value?.trim() || '';

    if (clearAll) {
      // 移除当天所有 AI 建议
      const dayBlock = e.target.closest('.day-block');
      if (!dayBlock) return;
      const items = dayBlock.querySelectorAll('.slot-item.is-suggested');
      items.forEach((item) => {
        const name = item.dataset.suggName;
        if (name) state.dismissed.add(name);
        item.remove();
      });
      // 如果当天已经没有 AI 建议了，把控制条也移除
      if (!dayBlock.querySelector('.slot-item.is-suggested')) {
        const ctrl = dayBlock.querySelector('.day-sugg-ctrl');
        if (ctrl) ctrl.remove();
      }
      toast('已移除当天所有 AI 建议');
      return;
    }

    const slotItem = e.target.closest('.slot-item.is-suggested');
    if (!slotItem) return;
    const name = slotItem.dataset.suggName;
    const payloadRaw = slotItem.dataset.suggPayload;
    if (!name) return;

    if (accept && payloadRaw && city) {
      try {
        const payload = JSON.parse(payloadRaw);
        Cart.toggle('sight', city, payload);
        toast(`已将「${name}」加入行程篮`);
        // 采纳后把徽标和按钮改成「已加入」样式
        slotItem.classList.remove('is-suggested');
        slotItem.querySelector('.slot-badge-ai')?.remove();
        slotItem.querySelector('.slot-sugg-actions')?.remove();
      } catch { /* ignore */ }
    } else if (dismiss) {
      state.dismissed.add(name);
      slotItem.remove();
      toast(`已移除「${name}」建议`);
      // 如果当天已没有 AI 建议，把控制条移除
      const dayBlock = e.target.closest('.day-block');
      if (dayBlock && !dayBlock.querySelector('.slot-item.is-suggested')) {
        dayBlock.querySelector('.day-sugg-ctrl')?.remove();
      }
    }
  }

  /** 出发日期默认填明天 */
  function prefillDate() {
    const d = new Date();
    d.setDate(d.getDate() + 1);
    const iso = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    els.startDate.value = iso;
    els.startDate.min = iso;
    if (els.apDate && !els.apDate.value) {
      els.apDate.value = iso;
      els.apDate.min = iso;
    }
  }

  // ── 一键智能规划（Task 4）──────────────────────────────────────────────

  function bindAutoPlan() {
    if (!els.apGenerate) return;

    // 偏好药丸：单选
    els.apTierPills.forEach((pill) => {
      pill.addEventListener('click', () => {
        els.apTierPills.forEach((p) => {
          const on = p === pill;
          p.classList.toggle('is-active', on);
          p.setAttribute('aria-checked', on ? 'true' : 'false');
        });
        state.tier = pill.dataset.tier || 'comfort';
      });
    });

    els.apGenerate.addEventListener('click', runAutoPlan);

    // 目的地变化时同步到全局上下文
    els.apTo.addEventListener('change', () => {
      const v = els.apTo.value.trim();
      if (v) Cart.setCtx({ city: v });
    });
    els.apDate.addEventListener('change', () => {
      const v = els.apDate.value;
      if (v) Cart.setCtx({ travelDate: v });
    });
  }

  /**
   * 一键生成：拉取各模块数据 → 选出匹配条目 → 批量写入行程篮 → 调用 /api/plan。
   *
   * 条目数量按天数缩放：
   *   景点  days * 2（与服务端补全阈值一致，生成后不会再触发 AI 建议）
   *   餐厅  min(days, 3) 家 + 特色菜 2 道
   *   酒店  1 家（按偏好档位）
   *   车票  仅在填了出发城市时查询
   */
  async function runAutoPlan() {
    if (state.loading) return;

    const city = els.apTo.value.trim();
    if (!city) {
      els.apTo.focus();
      return apHint('请先填写目的地', true);
    }

    const days = Number(els.apDays.value) || 3;
    const date = els.apDate.value || null;
    const from = els.apFrom.value.trim();
    const tier = TIER_CONFIG[state.tier] || TIER_CONFIG.comfort;

    state.loading = true;
    els.apGenerate.disabled = true;
    els.apGenerate.textContent = '正在挑选…';
    apHint('正在为你挑选酒店 / 景点 / 美食…');

    try {
      // 并行拉取四个模块的候选数据
      const [sights, hotels, restaurants, dishes] = await Promise.all([
        fetchJSON(`/api/sight/search?city=${encodeURIComponent(city)}&source=local`)
          .then((d) => d.sights || []).catch(() => []),
        fetchJSON(`/api/hotel/search?city=${encodeURIComponent(city)}&tier=${encodeURIComponent(tier.hotelTier)}&source=local`)
          .then((d) => d.hotels || []).catch(() => []),
        fetchJSON(`/api/food/restaurants?city=${encodeURIComponent(city)}&priceMin=${tier.priceMin}&priceMax=${tier.priceMax}&source=local`)
          .then((d) => d.restaurants || []).catch(() => []),
        fetchJSON(`/api/food/specialties?city=${encodeURIComponent(city)}&source=local`)
          .then((d) => d.specialties || []).catch(() => []),
      ]);

      if (sights.length === 0) {
        throw new Error(`暂无「${city}」的景点数据，换个城市试试`);
      }

      const entries = [];

      // 景点：days * 2，热度优先（接口已按 score 排序），第一个标为必去
      const sightPick = sights.slice(0, days * 2);
      sightPick.forEach((s, i) => entries.push({ type: 'sight', payload: s, mustGo: i === 0 }));

      // 酒店：按档位取第一家
      if (hotels.length) entries.push({ type: 'hotel', payload: hotels[0] });

      // 餐厅：按天数取 2-3 家
      restaurants.slice(0, Math.min(Math.max(days, 2), 3))
        .forEach((r) => entries.push({ type: 'food', payload: r }));

      // 特色菜：取 2 道（服务端会自动解析成同区餐厅）
      dishes.slice(0, 2).forEach((d) => entries.push({ type: 'dish', payload: d }));

      // 车票：仅在填了出发城市时查询，失败不阻断
      if (from && date) {
        const ticket = await pickTicket(from, city, date, state.tier);
        if (ticket) entries.push({ type: 'ticket', payload: ticket });
      }

      // 批量写入行程篮（替换式：一键规划是「重新开始」的语义）
      const { added } = Cart.addMany(city, entries, { replace: true });
      Cart.setCtx({ city, travelDate: date });

      setDays(days);
      if (date) els.startDate.value = date;
      renderBasket();

      apHint(`已挑选 ${added} 项，正在编排行程…`);
      await generate();
      apHint(`已生成 ${days} 天行程 · ${tier.label}`);
    } catch (err) {
      apHint(err.message || '生成失败，请稍后重试', true);
      toast(err.message || '生成失败');
    } finally {
      state.loading = false;
      els.apGenerate.disabled = false;
      els.apGenerate.textContent = '🚀 一键生成全套行程';
    }
  }

  /**
   * 车票挑选：经济实惠取最便宜的高铁，其余档位取上午出发的车次。
   * 车票接口依赖实时数据源，任何失败都静默跳过 —— 不能因为查不到票
   * 就让整个一键规划失败。
   */
  async function pickTicket(from, to, date, tier) {
    try {
      const url = `/api/ticket/search?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&date=${encodeURIComponent(date)}`;
      const data = await fetchJSON(url);
      // 接口返回 { trains: [...], flights: [...] }；一键规划只取火车
      const list = (data.trains || []).filter(Boolean);
      if (!list.length) return null;

      if (tier === 'budget') {
        // 最便宜：按价格升序
        const sorted = [...list].sort((a, b) => priceOf(a) - priceOf(b));
        return sorted[0];
      }
      // 舒适/轻奢：优先上午 06:00-12:00 出发
      const morning = list.filter((t) => {
        const h = Number(String(t.depTime || '').slice(0, 2));
        return h >= 6 && h < 12;
      });
      return (morning[0] || list[0]);
    } catch {
      return null;
    }
  }

  function priceOf(t) {
    const cands = [t.price, t.minPrice, t.lowestPrice];
    for (const c of cands) {
      const n = Number(c);
      if (Number.isFinite(n) && n > 0) return n;
    }
    // seats: [{name, price}]
    if (Array.isArray(t.seats)) {
      const ps = t.seats.map((s) => Number(s.price)).filter((n) => Number.isFinite(n) && n > 0);
      if (ps.length) return Math.min(...ps);
    }
    return Number.POSITIVE_INFINITY;
  }

  async function fetchJSON(url) {
    const res = await fetch(url);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || `请求失败 ${res.status}`);
    return data;
  }

  function apHint(msg, isError = false) {
    if (!els.apHint) return;
    els.apHint.textContent = msg || '';
    els.apHint.classList.toggle('is-blocked', Boolean(isError));
  }

  // ── 天数控制 ────────────────────────────────────────────────────────────

  function setDays(n) {
    state.days = Math.min(7, Math.max(1, n));
    els.daysInput.value = state.days;
    els.daysMinus.disabled = state.days <= 1;
    els.daysPlus.disabled = state.days >= 7;
    // 天数变化会影响「景点偏少」的判定，同步刷新提示
    updateHint(Cart.read().items || []);
  }

  /**
   * 有车票时按往返日期推导天数（Q6-Y）。
   * 单程票不改变天数，仅在往返都在篮中时生效。
   */
  function deriveDaysFromTickets(items) {
    const tickets = items.filter((i) => i.type === 'ticket');
    if (tickets.length < 2) return null;
    const dates = tickets
      .map((t) => t.payload.date)
      .filter(Boolean)
      .sort();
    if (dates.length < 2) return null;
    const a = new Date(`${dates[0]}T00:00:00+08:00`);
    const b = new Date(`${dates[dates.length - 1]}T00:00:00+08:00`);
    if (Number.isNaN(a.getTime()) || Number.isNaN(b.getTime())) return null;
    const diff = Math.round((b - a) / 86400000) + 1;
    return diff >= 1 && diff <= 7 ? diff : null;
  }

  // ── 行程篮渲染 ──────────────────────────────────────────────────────────

  function renderBasket() {
    const data = Cart.read();
    const items = data.items || [];

    if (items.length === 0) {
      els.basketEmpty.hidden = false;
      els.basketGroups.innerHTML = '';
      els.controls.hidden = true;
      els.basketCity.textContent = '';
      return;
    }

    els.basketEmpty.hidden = true;
    els.controls.hidden = false;
    els.basketCity.textContent = `${data.city} · 共 ${items.length} 项`;

    // 按类型分组
    const groups = {};
    for (const it of items) {
      (groups[it.type] = groups[it.type] || []).push(it);
    }

    const html = Object.keys(groups)
      .sort((a, b) => (GROUP_META[a]?.order || 9) - (GROUP_META[b]?.order || 9))
      .map((type) => {
        const list = groups[type];
        const label = GROUP_META[type]?.label || type;
        const rows = list.map((it) => renderBasketItem(it, type)).join('');
        return `
          <div class="basket-group basket-group-${esc(type)}">
            <div class="basket-group-head">
              ${esc(label)}
              <span class="basket-group-count">${list.length}</span>
            </div>
            <div class="basket-list">${rows}</div>
          </div>`;
      })
      .join('');

    els.basketGroups.innerHTML = html;

    // 天数推导
    const derived = deriveDaysFromTickets(items);
    if (derived) {
      setDays(derived);
    } else {
      setDays(state.days);
    }

    updateHint(items);
  }

  function renderBasketItem(it, type) {
    const p = it.payload || {};
    const name = displayName(p);
    const meta = [];
    if (type === 'sight') {
      if (p.visitHours) meta.push(p.visitHours);
      if (p.ticket && p.ticket !== '以现场公示为准') meta.push(p.ticket);
    } else if (type === 'hotel') {
      if (p.tier) meta.push(p.tier);
      if (p.price) meta.push(`¥${p.price}/晚`);
    } else if (type === 'food') {
      if (p.avgPrice) meta.push(`人均 ¥${p.avgPrice}`);
      if (p.location?.district) meta.push(p.location.district);
    } else if (type === 'dish') {
      if (p.category) meta.push(p.category);
      meta.push('自动匹配餐厅');
    } else if (type === 'ticket') {
      if (p.depTime && p.arrTime) meta.push(`${p.depTime} → ${p.arrTime}`);
    }

    // 仅景点支持必去标记（车票/酒店本身就是固定锚点）
    const pinBtn = type === 'sight'
      ? `<button type="button" class="pin-btn ${it.mustGo ? 'is-active' : ''}" aria-pressed="${it.mustGo}" title="标记为必去，Agent 会优先安排">📌 必去</button>`
      : '';

    return `
      <div class="basket-item ${it.mustGo ? 'is-must-go' : ''}"
           data-cart-type="${esc(type)}" data-cart-name="${esc(name)}">
        <span class="basket-item-name">${esc(name)}</span>
        ${meta.length ? `<span class="basket-item-meta">${esc(meta.join(' · '))}</span>` : ''}
        ${pinBtn}
        <button type="button" class="remove-btn" aria-label="移出行程篮">移除</button>
      </div>`;
  }

  /** 条目显示名（车票无 name 字段，与 cart.js / itinerary.js 保持一致） */
  function displayName(p) {
    if (!p) return '';
    if (p.name) return String(p.name);
    if (p.trainNo) return `${p.trainNo} ${p.depStation || ''}→${p.arrStation || ''}`.trim();
    if (p.flightNo) return `${p.flightNo} ${p.depAirport || ''}→${p.arrAirport || ''}`.trim();
    return '';
  }

  function updateHint(items) {
    const sightCount = items.filter((i) => i.type === 'sight').length;
    if (sightCount < MIN_SIGHTS) {
      els.hint.textContent = '还需添加至少 1 个景点作为行程锚点';
      els.hint.classList.add('is-blocked');
      els.generateBtn.disabled = true;
      return;
    }

    els.hint.classList.remove('is-blocked');
    els.generateBtn.disabled = false;

    // 景点偏少时提前告知会自动补全，避免用户以为漏了条目
    const target = state.days * 2;
    els.hint.textContent = sightCount < target
      ? `${items.length} 项 · ${state.days} 天 · 景点偏少，将补充 ${target - sightCount} 个 AI 建议`
      : `${items.length} 项 · ${state.days} 天`;
  }

  // ── 生成行程 ────────────────────────────────────────────────────────────

  async function generate() {
    if (state.generating) return;
    const data = Cart.read();
    if (!data.items.length) return;

    state.generating = true;
    els.generateBtn.disabled = true;
    els.generateBtn.textContent = '生成中…';
    els.regenBtn.disabled = true;

    // Agent strip 进入运行态
    els.agentStrip.hidden = false;
    els.agentStrip.classList.add('is-running');
    els.agentSteps.innerHTML = '';
    els.agentModel.textContent = '';
    appendStep({ name: '提交行程篮', detail: `${data.items.length} 项 · ${state.days} 天`, ms: 0 }, 0);

    els.warnings.hidden = true;
    els.timelineSection.hidden = true;

    try {
      const res = await fetch('/api/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          city: data.city,
          days: state.days,
          startDate: els.startDate.value || null,
          items: data.items,
        }),
      });

      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `服务返回 ${res.status}`);

      state.lastPlan = body;
      renderAgentSteps(body.agent);
      renderWarnings(body.warnings);
      renderTimeline(body);
      els.timelineSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (err) {
      appendStep({ name: '生成失败', detail: err.message, ms: 0 }, els.agentSteps.children.length);
      toast(err.message);
    } finally {
      state.generating = false;
      els.agentStrip.classList.remove('is-running');
      els.generateBtn.disabled = false;
      els.generateBtn.textContent = '生成行程';
      els.regenBtn.disabled = false;
    }
  }

  // ── Agent 步骤渲染 ──────────────────────────────────────────────────────

  function renderAgentSteps(agent) {
    if (!agent) return;
    els.agentModel.textContent = agent.model || '';
    els.agentSteps.innerHTML = '';
    (agent.steps || []).forEach((s, i) => {
      // 逐条淡入，让编排过程可见（而非黑盒）
      setTimeout(() => appendStep(s, i), i * 90);
    });
  }

  function appendStep(step, idx) {
    const li = document.createElement('li');
    li.className = 'agent-step';
    li.innerHTML =
      `<span class="agent-step-idx">${idx + 1}</span>` +
      `<span class="agent-step-name">${esc(step.name)}</span>` +
      `<span class="agent-step-detail">${esc(step.detail || '')}</span>` +
      `<span class="agent-step-ms">${step.ms}ms</span>`;
    els.agentSteps.appendChild(li);
  }

  // ── 警告渲染 ────────────────────────────────────────────────────────────

  function renderWarnings(warnings) {
    if (!warnings || warnings.length === 0) {
      els.warnings.hidden = true;
      return;
    }
    els.warningsList.innerHTML = warnings.map((w) => `<li>${esc(w)}</li>`).join('');
    els.warnings.hidden = false;
  }

  // ── 时间轴渲染 ──────────────────────────────────────────────────────────

  function renderTimeline(plan) {
    els.timelineTitle.textContent = `${plan.city} · ${plan.days} 天行程`;
    els.timeline.innerHTML = (plan.itinerary || []).map(renderDay).join('');
    els.timelineSection.hidden = false;
  }

  function renderDay(day) {
    const dateStr = day.date ? formatDate(day.date) : '';
    // 过滤掉用户已移除的建议（重新生成时保持移除状态）
    const slots = (day.slots || [])
      .filter((s) => !(s.suggested && state.dismissed.has(s.item?.name)))
      .map(renderSlot)
      .join('');

    const hasSugg = (day.slots || []).some(
      (s) => s.suggested && !state.dismissed.has(s.item?.name)
    );

    // 「移除所有 AI 建议」—— 给想要松弛行程的用户一个一键出口
    const suggCtrl = hasSugg
      ? `<button type="button" class="day-sugg-clear day-sugg-ctrl">移除所有 AI 建议</button>`
      : '';

    return `
      <article class="day-block">
        <header class="day-header">
          <span class="day-badge">Day ${day.day}</span>
          ${dateStr ? `<span class="day-date">${esc(dateStr)}</span>` : ''}
          <span class="day-district">${esc(day.district || '')}</span>
          ${suggCtrl}
        </header>
        ${day.summary ? `<div class="day-summary">${esc(day.summary)}</div>` : ''}
        <ol class="slot-list">${slots}</ol>
      </article>`;
  }

  function renderSlot(slot) {
    const item = slot.item || {};
    const tags = [];

    if (slot.type === 'sight') {
      if (item.ticket && item.ticket !== '以现场公示为准') tags.push({ text: item.ticket, price: true });
      if (item.rating) tags.push({ text: `★ ${item.rating}` });
    } else if (slot.type === 'food') {
      if (item.avgPrice) tags.push({ text: `人均 ¥${item.avgPrice}`, price: true });
      if (item.cuisines?.length) tags.push({ text: item.cuisines[0] });
    } else if (slot.type === 'hotel') {
      if (item.price) tags.push({ text: `¥${item.price}/晚`, price: true });
      if (item.tier) tags.push({ text: item.tier });
    }

    const tagHtml = tags.length
      ? `<div class="slot-tags">${tags.map((t) => `<span class="slot-tag ${t.price ? 'is-price' : ''}">${esc(t.text)}</span>`).join('')}</div>`
      : '';

    // AI 建议项：徽标 + 采纳/移除快捷操作
    const isSugg = Boolean(slot.suggested);
    const badge = isSugg ? '<span class="slot-badge-ai">💡 AI 建议添加</span>' : '';
    const actions = isSugg
      ? `<div class="slot-sugg-actions">
           <button type="button" class="sugg-btn is-accept">✓ 采纳</button>
           <button type="button" class="sugg-btn is-dismiss">✕ 移除</button>
         </div>`
      : '';
    // 采纳时需要完整 payload 写回行程篮，挂在 data 属性上
    const payloadAttr = isSugg
      ? ` data-sugg-name="${esc(item.name || '')}" data-sugg-payload="${esc(JSON.stringify(item))}"`
      : '';

    return `
      <li class="slot-item${isSugg ? ' is-suggested' : ''}" data-type="${esc(slot.type)}"${payloadAttr}>
        <span class="slot-time">${esc(slot.time || '')}</span>
        <span class="slot-label">${esc(slot.slot || '')}</span>
        <div class="slot-body">
          <div class="slot-name">${esc(item.name || '')}${badge}</div>
          ${slot.reason ? `<div class="slot-reason">${esc(slot.reason)}</div>` : ''}
          ${tagHtml}
          ${actions}
        </div>
      </li>`;
  }

  // ── 工具 ────────────────────────────────────────────────────────────────

  function formatDate(iso) {
    const d = new Date(`${iso}T00:00:00+08:00`);
    if (Number.isNaN(d.getTime())) return iso;
    const week = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()];
    return `${d.getMonth() + 1}月${d.getDate()}日 ${week}`;
  }

  let toastTimer = null;
  function toast(msg) {
    els.toast.textContent = msg;
    els.toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { els.toast.hidden = true; }, 2600);
  }

  function esc(str) {
    return String(str == null ? '' : str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  // ── 启动 ────────────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
