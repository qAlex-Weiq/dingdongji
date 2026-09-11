/**
 * cart.js — 行程篮（跨页面共享购物车）
 *
 * 使用方式：在各模块页面的 <script> 中引入本文件（在模块脚本之前），
 * 然后在卡片渲染函数中调用 Cart.toggle / Cart.has 即可。
 *
 * 存储格式（localStorage key: 'ddj.cart.v1'）：
 * { city: string, items: [ { type, key, payload, mustGo } ] }
 *
 * 条目类型（type）：
 *   ticket / hotel / sight / food（餐厅）/ dish（特色菜）
 *   dish 是「想吃什么」而非「去哪吃」—— 服务端 /api/plan 会把它
 *   自动解析成同区的高分餐厅（见 server/lib/itinerary.js 的 resolveDishes）。
 *
 * key 格式：`${type}|${city}|${name}`，由本模块生成，用于去重和移除。
 *
 * 全局城市上下文（localStorage key: 'ddj.ctx.v1'）：
 * { city: string, travelDate: string }
 * 第一次加入条目时自动写入；各模块页面读取后自动预填城市输入框。
 */
(function () {
  'use strict';

  const STORAGE_KEY = 'ddj.cart.v1';
  const CTX_KEY = 'ddj.ctx.v1';
  const MAX_ITEMS = 40;

  // ── 持久化 ──────────────────────────────────────────────────────────────

  function load() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return { city: null, items: [] };
      const d = JSON.parse(raw);
      return {
        city: typeof d.city === 'string' ? d.city : null,
        items: Array.isArray(d.items) ? d.items : [],
      };
    } catch {
      return { city: null, items: [] };
    }
  }

  function save(data) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      /* quota exceeded — silent */
    }
  }

  // ── 全局行程上下文（目的地 + 出发日期）────────────────────────────────────

  /**
   * 读取全局上下文。
   * 与行程篮分开存储：即使用户清空了行程篮，仍记得他这趟想去哪，
   * 避免在各模块页面之间跳转时反复输入城市。
   */
  function loadCtx() {
    try {
      const raw = localStorage.getItem(CTX_KEY);
      if (!raw) return { city: null, travelDate: null };
      const d = JSON.parse(raw);
      return {
        city: typeof d.city === 'string' && d.city ? d.city : null,
        travelDate: typeof d.travelDate === 'string' && d.travelDate ? d.travelDate : null,
      };
    } catch {
      return { city: null, travelDate: null };
    }
  }

  function saveCtx(ctx) {
    try {
      localStorage.setItem(CTX_KEY, JSON.stringify(ctx));
    } catch {
      /* quota exceeded — silent */
    }
  }

  /** 合并写入上下文（只覆盖传入的字段） */
  function patchCtx(patch) {
    const next = { ...loadCtx(), ...patch };
    saveCtx(next);
    renderCityIndicator();
    return next;
  }

  // ── 生成唯一键 ──────────────────────────────────────────────────────────

  /**
   * 条目显示名。
   * 车票没有 name 字段，用「车次号 出发站→到达站」合成，
   * 与服务端 itinerary.js 的 ticketLabel 保持一致。
   */
  function displayName(type, payload) {
    if (!payload) return '';
    if (payload.name) return String(payload.name);
    if (payload.trainNo) return `${payload.trainNo} ${payload.depStation || ''}→${payload.arrStation || ''}`.trim();
    if (payload.flightNo) return `${payload.flightNo} ${payload.depAirport || ''}→${payload.arrAirport || ''}`.trim();
    return '';
  }

  function makeKey(type, city, payload) {
    return `${type}|${city}|${displayName(type, payload)}`;
  }

  // ── 目的地指示器 ──────────────────────────────────────────────────────────

  /**
   * 在导航栏右侧渲染「📍 当前目的地: 北京」小标签。
   * 首次调用时注入样式和 DOM；后续只更新文本。
   */
  function renderCityIndicator() {
    const ctx = loadCtx();
    const city = ctx.city;

    // 注入样式（只需一次）
    if (!document.getElementById('ddj-city-ind-style')) {
      const s = document.createElement('style');
      s.id = 'ddj-city-ind-style';
      s.textContent = `
        #ddj-city-indicator {
          display: inline-flex; align-items: center; gap: 4px;
          padding: 3px 10px; border-radius: 9999px;
          background: var(--primary-soft, rgba(29,79,145,.1));
          color: var(--primary, #1d4f91);
          font-size: 12px; font-weight: 600;
          border: 1.5px solid var(--primary-soft, rgba(29,79,145,.18));
          white-space: nowrap; user-select: none;
        }
        #ddj-city-indicator:empty { display: none; }
      `;
      document.head.appendChild(s);
    }

    let el = document.getElementById('ddj-city-indicator');
    if (!el) {
      el = document.createElement('span');
      el.id = 'ddj-city-indicator';
      el.setAttribute('aria-label', '当前行程目的地');
      // 尝试插入到导航栏；如果拿不到，就放到 topbar 末尾
      const nav = document.querySelector('.module-nav') || document.querySelector('.topbar-inner');
      if (nav) nav.appendChild(el);
    }

    el.textContent = city ? `📍 ${city}` : '';
  }

  // ── 模块页面自动预填城市 ───────────────────────────────────────────────────

  /**
   * 若存在城市输入框且尚未有内容，用全局上下文自动预填，
   * 预填成功后调用 onReady 让模块页自行触发默认搜索。
   *
   * 调用约定（各模块页）：
   *   Cart.prefillCity('city-input', () => submitSearch());
   *
   * onReady 仅在「确实预填了城市」时调用一次 —— 用户自己填了城市、
   * 或没有全局上下文时都不会触发，避免打断用户正在进行的输入。
   *
   * @param {string} inputId 城市输入框的 DOM id
   * @param {function} [onReady] 预填完成后的回调（通常是触发默认搜索）
   * @returns {string|null} 实际预填的城市名，未预填返回 null
   */
  function prefillCity(inputId, onReady) {
    const inp = document.getElementById(inputId);
    if (!inp) return null;

    const ctx = loadCtx();
    if (!ctx.city || inp.value.trim()) return null;

    inp.value = ctx.city;
    // 触发 input 事件，让城市自动补全等控件感知这次程序化赋值
    inp.dispatchEvent(new Event('input', { bubbles: true }));

    if (typeof onReady === 'function') onReady(ctx.city);
    return ctx.city;
  }



  const subscribers = [];

  function notify() {
    const count = load().items.length;
    subscribers.forEach((fn) => fn(count));
    updateBadge(count);
  }

  // ── 浮动行程篮按钮 ───────────────────────────────────────────────────────

  function updateBadge(count) {
    const badge = document.getElementById('cart-badge');
    const btn = document.getElementById('cart-fab');
    if (!badge || !btn) return;
    badge.textContent = count;
    btn.hidden = count === 0;
    btn.setAttribute('aria-label', `行程篮，共 ${count} 项`);
  }

  function mountFab() {
    if (document.getElementById('cart-fab')) return; // 已挂载

    const btn = document.createElement('a');
    btn.id = 'cart-fab';
    btn.href = '/plan.html';
    btn.setAttribute('role', 'link');
    btn.setAttribute('aria-live', 'polite');
    btn.innerHTML =
      '<span class="cart-fab-icon" aria-hidden="true">' +
      '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" ' +
      'stroke-linecap="round" stroke-linejoin="round" width="20" height="20">' +
      '<path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>' +
      '<rect x="9" y="3" width="6" height="4" rx="1"/>' +
      '<path d="m9 12 2 2 4-4"/>' +
      '</svg></span>' +
      '<span class="cart-fab-label">行程篮</span>' +
      '<span id="cart-badge" class="cart-badge" aria-hidden="true">0</span>';

    // 样式（注入一次，与 style.css 的设计令牌对齐）
    if (!document.getElementById('cart-fab-style')) {
      const style = document.createElement('style');
      style.id = 'cart-fab-style';
      style.textContent = `
        #cart-fab {
          position: fixed; bottom: 28px; right: 24px; z-index: 200;
          display: flex; align-items: center; gap: 6px;
          padding: 10px 18px 10px 14px;
          background: var(--primary, #1d4f91); color: #fff;
          border-radius: 9999px;
          box-shadow: 0 4px 16px rgba(29,79,145,.35);
          text-decoration: none; font-size: 14px; font-weight: 600;
          transition: transform 140ms ease, box-shadow 140ms ease;
        }
        #cart-fab:hover { transform: translateY(-2px); box-shadow: 0 6px 20px rgba(29,79,145,.45); }
        #cart-fab:active { transform: translateY(0); }
        #cart-fab[hidden] { display: none !important; }
        .cart-badge {
          display: inline-flex; align-items: center; justify-content: center;
          min-width: 20px; height: 20px; padding: 0 5px;
          background: #fff; color: var(--primary, #1d4f91);
          border-radius: 9999px; font-size: 12px; font-weight: 700;
        }
        .cart-fab-icon { display: flex; align-items: center; }
        /* 「加入行程」按钮 */
        .cart-add-btn {
          display: inline-flex; align-items: center; gap: 4px;
          padding: 5px 12px; border-radius: 8px;
          background: var(--primary-soft, rgba(29,79,145,.1));
          color: var(--primary, #1d4f91);
          border: 1.5px solid var(--primary-soft, rgba(29,79,145,.18));
          font-size: 13px; font-weight: 600; cursor: pointer;
          transition: background 120ms, border-color 120ms;
          white-space: nowrap;
        }
        .cart-add-btn:hover { background: rgba(29,79,145,.16); border-color: rgba(29,79,145,.3); }
        .cart-add-btn.is-in-cart {
          background: var(--primary, #1d4f91); color: #fff;
          border-color: var(--primary, #1d4f91);
        }
        .cart-add-btn.is-in-cart:hover { background: var(--primary-strong, #163d73); border-color: var(--primary-strong, #163d73); }
        .cart-add-btn.is-must-go {
          background: var(--accent, #e8590c); color: #fff;
          border-color: var(--accent, #e8590c);
        }
        .cart-add-btn.is-must-go:hover { background: #c44a08; border-color: #c44a08; }
      `;
      document.head.appendChild(style);
    }

    document.body.appendChild(btn);
    updateBadge(load().items.length);
  }

  // ── 公开 API ────────────────────────────────────────────────────────────

  window.Cart = {
    /**
     * 加入或移出行程篮。
     * @param {'sight'|'hotel'|'food'|'ticket'} type
     * @param {string} city 城市名
     * @param {object} payload 完整的卡片数据对象
     * @param {boolean} [mustGo] 是否为必去
     * @returns {boolean} 操作后是否在篮中
     */
    toggle(type, city, payload, mustGo = false) {
      const data = load();
      const key = makeKey(type, city, payload);
      const idx = data.items.findIndex((it) => it.key === key);

      if (idx !== -1) {
        // 已在篮中：移除
        data.items.splice(idx, 1);
        if (data.items.length === 0) data.city = null;
        save(data);
        notify();
        return false;
      }

      // 不在篮中：加入
      if (data.items.length >= MAX_ITEMS) {
        alert(`行程篮最多 ${MAX_ITEMS} 项，请先移除一些条目`);
        return false;
      }

      // 城市互斥：不同城市时弹出确认对话框，措辞符合 Task 3 规范
      if (data.city && data.city !== city) {
        const ok = confirm(
          `当前行程篮中已有【${data.city}】的项目，切换城市将清空行程篮重新开始，是否继续？`
        );
        if (!ok) return false;
        data.items = [];
      }

      data.city = city;
      data.items.push({ type, key, payload, mustGo: Boolean(mustGo) });
      save(data);

      // 首次加入条目时写入全局城市上下文（此后跨页面自动预填）
      patchCtx({ city });

      notify();
      return true;
    },

    /** 切换必去状态（仅对已在篮中的条目有效） */
    toggleMustGo(type, city, payload) {
      const data = load();
      const key = makeKey(type, city, payload);
      const item = data.items.find((it) => it.key === key);
      if (!item) return false;
      item.mustGo = !item.mustGo;
      save(data);
      notify();
      return item.mustGo;
    },

    /** 是否在篮中 */
    has(type, city, payload) {
      return load().items.some((it) => it.key === makeKey(type, city, payload));
    },

    /** 是否为必去 */
    isMustGo(type, city, payload) {
      const item = load().items.find((it) => it.key === makeKey(type, city, payload));
      return item ? item.mustGo : false;
    },

    /** 当前篮内数量 */
    count() {
      return load().items.length;
    },

    /** 读取完整数据（plan.html 用） */
    read() {
      return load();
    },

    /**
     * 批量加入条目（一键规划用）。
     *
     * 与逐个 toggle 的区别：只写一次 localStorage、只通知一次订阅者，
     * 且不会对每个条目重复弹出城市确认框 —— 城市冲突在这里统一处理一次。
     *
     * @param {string} city 目的地城市
     * @param {Array<{type:string,payload:object,mustGo?:boolean}>} entries
     * @param {object} [opts]
     * @param {boolean} [opts.replace] 为 true 时先清空同城条目再写入
     * @returns {{added:number, skipped:number}} 实际写入与跳过（重复/超限）的数量
     */
    addMany(city, entries, opts = {}) {
      const data = load();

      // 城市冲突：统一确认一次
      if (data.city && data.city !== city) {
        const ok = confirm(
          `当前行程篮中已有【${data.city}】的项目，切换城市将清空行程篮重新开始，是否继续？`
        );
        if (!ok) return { added: 0, skipped: (entries || []).length };
        data.items = [];
      }

      if (opts.replace) data.items = [];

      let added = 0;
      let skipped = 0;

      for (const e of entries || []) {
        if (!e || !e.type || !e.payload) { skipped++; continue; }
        const key = makeKey(e.type, city, e.payload);
        if (data.items.some((it) => it.key === key)) { skipped++; continue; }
        if (data.items.length >= MAX_ITEMS) { skipped++; continue; }
        data.items.push({
          type: e.type,
          key,
          payload: e.payload,
          mustGo: Boolean(e.mustGo),
        });
        added++;
      }

      data.city = city;
      save(data);
      patchCtx({ city });
      notify();
      return { added, skipped };
    },

    /**
     * 城市切换守卫（供各模块页在用户手动改城市时调用）。
     *
     * 篮中存在其他城市的条目时弹出确认；用户确认则清空行程篮并返回 true，
     * 取消则原样保留并返回 false。篮空或同城时直接返回 true（无需打扰）。
     *
     * @param {string} nextCity 用户想切换到的城市
     * @returns {boolean} 是否允许继续切换
     */
    guardCitySwitch(nextCity) {
      const data = load();
      if (!nextCity) return true;
      if (!data.city || data.city === nextCity || data.items.length === 0) {
        patchCtx({ city: nextCity });
        return true;
      }
      const ok = confirm(
        `当前行程篮中已有【${data.city}】的项目，切换城市将清空行程篮重新开始，是否继续？`
      );
      if (!ok) return false;
      save({ city: nextCity, items: [] });
      patchCtx({ city: nextCity });
      notify();
      return true;
    },

    /** 读取全局上下文 { city, travelDate } */
    ctx() {
      return loadCtx();
    },

    /** 写入全局上下文（合并式，只覆盖传入字段） */
    setCtx(patch) {
      return patchCtx(patch || {});
    },

    /** 自动预填城市输入框（详见 prefillCity 文档） */
    prefillCity,

    /** 重新渲染目的地指示器 */
    renderCityIndicator,

    /** 清空行程篮（保留全局城市上下文，方便用户重新挑选同城条目） */
    clear() {
      save({ city: null, items: [] });
      notify();
    },

    /**
     * 订阅数量变化（count: number）
     * @param {function} fn
     */
    subscribe(fn) {
      subscribers.push(fn);
    },

    /** 生成条目的 HTML 按钮（供各模块 render 函数调用） */
    addButton(type, city, payload) {
      const inCart = this.has(type, city, payload);
      const mustGo = this.isMustGo(type, city, payload);
      const cls = mustGo ? 'cart-add-btn is-must-go' : inCart ? 'cart-add-btn is-in-cart' : 'cart-add-btn';
      const label = mustGo ? '📌 必去' : inCart ? '✓ 已加入' : '＋ 加入行程';
      const escapedName = String(displayName(type, payload)).replace(/'/g, "\\'");
      // data-* 属性由事件委托读取；onclick 是备用的内联处理（不依赖 JS 模块化）
      return `<button type="button" class="${cls}" aria-label="${inCart ? '从行程篮移除' : '加入行程篮'} ${escapedName}"` +
        ` data-cart-type="${type}" data-cart-city="${city}" data-cart-name="${escapedName}">${label}</button>`;
    },

    /** 挂载浮动按钮（页面加载后调用） */
    mountFab,

    /** 生成唯一键（供调试） */
    makeKey,
  };

  // ── 自动挂载 ────────────────────────────────────────────────────────────

  /**
   * 全局事件委托：处理「加入行程」按钮。
   *
   * 各模块页面的卡片由 innerHTML 整体重渲染，逐个绑定监听器会失效，
   * 因此统一在 document 层委托。按钮通过 data-cart-* 属性携带身份信息，
   * 真正的 payload 从页面的渲染数据中按 name 反查（见 resolvePayload）。
   *
   * 景点页在自己的列表监听器中调用了 stopPropagation，事件不会冒泡到
   * document，因此这里天然不会重复处理。
   */
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('.cart-add-btn');
    if (!btn || e.defaultPrevented) return;

    const { cartType, cartCity, cartName } = btn.dataset;
    if (!cartType || !cartCity || !cartName) return;

    const payload = resolvePayload(cartType, cartName);
    if (!payload) return;

    e.preventDefault();
    const nowIn = window.Cart.toggle(cartType, cartCity, payload);

    // 就地更新按钮态（避免整页重渲染）
    btn.classList.toggle('is-in-cart', nowIn);
    btn.textContent = nowIn ? '✓ 已加入' : '＋ 加入行程';
    btn.setAttribute('aria-label', `${nowIn ? '从行程篮移除' : '加入行程篮'} ${cartName}`);
  });

  /**
   * 按名称从当前页面的渲染数据中反查完整条目。
   * 各模块把渲染结果挂在 window.__ddjRendered 上供此处读取。
   */
  function resolvePayload(type, name) {
    const pools = window.__ddjRendered || {};
    const pool = pools[type];
    if (!Array.isArray(pool)) return null;
    return pool.find((x) => String(displayName(type, x)) === String(name)) || null;
  }

  /** 页面加载后挂载浮动按钮 + 目的地指示器 */
  function mountAll() {
    mountFab();
    renderCityIndicator();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mountAll);
  } else {
    mountAll();
  }
})();
