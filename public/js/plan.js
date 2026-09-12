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
    tipsTraps: $('#tips-traps'),
    tipsTrapsList: $('#tips-traps-list'),
    tipsGear: $('#tips-gear'),
    tipsGearList: $('#tips-gear-list'),
    aiAdjustments: $('#ai-adjustments'),
    aiAdjustmentsCount: $('#ai-adjustments-count'),
    timelineSection: $('#timeline-section'),
    timelineTitle: $('#timeline-title'),
    timeline: $('#timeline'),
    regenBtn: $('#regen-btn'),
    copyWechatBtn: $('#btn-copy-wechat'),
    toast: $('#toast'),
    // 一键智能规划
    apFrom: $('#ap-from'),
    apTo: $('#ap-to'),
    apDate: $('#ap-date'),
    apDays: $('#ap-days'),
    apCityList: $('#ap-city-list'),
    apTierPills: document.querySelectorAll('#auto-plan .auto-plan-tier .pill'),
    apCompanionPills: document.querySelectorAll('#auto-plan .auto-plan-companion .pill'),
    apHint: $('#ap-hint'),
    apGenerate: $('#ap-generate'),
  };

  const state = {
    days: 3,
    loading: false,      // 一键规划进行中
    generating: false,   // /api/plan 调用中
    lastPlan: null,
    tier: 'comfort',
    companion: 'solo',
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
    applySelectedTransport();   // ← 车票绑定

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
    els.copyWechatBtn && els.copyWechatBtn.addEventListener('click', copyWechatNote);

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

  // ── 城市避坑与贴士知识库 ────────────────────────────────────────────────

  const CITY_TIPS = {
    广州: {
      traps: [
        '广东省博物馆、广州博物馆均需提前在微信小程序实名预约，现场无法购票',
        '广州塔建议 18:00 后登塔，可同时欣赏日落与珠江夜景，日间人流较大',
        '陈家祠旺季需在官方公众号提前预约，闭馆日为周一',
      ],
      gear: [
        '广州全年湿热多雨，建议随身携带折叠晴雨伞与防滑平底鞋',
        '地铁覆盖全面，景区间建议优先乘坐地铁，避开早晚高峰（7-9点 / 17-19点）',
      ],
    },
    成都: {
      traps: [
        '成都大熊猫繁育研究基地须提前在官方 App 或微信预约，旺季建议提前 3 天购票',
        '宽窄巷子无需门票，但内部餐饮消费较高；建议提前锁定心仪餐厅排号',
        '都江堰 + 青城山可联票购买，仅售线上，现场票价更高',
      ],
      gear: [
        '成都盆地气候多云潮湿，防晒需求低但需备轻薄雨衣或折叠伞',
        '火锅与串串偏油辣，肠胃敏感建议自备肠胃药',
      ],
    },
    北京: {
      traps: [
        '故宫须至少提前 7 天在"故宫博物院"官方小程序实名预约，旺季常常秒空',
        '颐和园、天坛等热门景点建议工作日前往，周末人流可达 5 万+',
        '长城（慕田峪 / 八达岭）建议优先慕田峪，人少且景色更原始；缆车需单独购票',
      ],
      gear: [
        '北京四季分明，春秋风大，建议备一件防风外套',
        '地铁高峰期极拥挤，景区间推荐打车或包车，节省体力',
      ],
    },
    上海: {
      traps: [
        '外滩夜景最佳观赏时间为 19:30-21:00，无需门票，但防范扒手',
        '豫园门票需线上预购，旺季周边商城人流极大，建议安排工作日游览',
        '迪士尼须提前在 App 购票并抢"灵境优先体验券"，热门项目候场 90 分钟以上',
      ],
      gear: [
        '上海梅雨季（6-7 月）潮湿多雨，建议携带防水外套',
        '出行以地铁为主，打车高峰期等待较久，可提前 15 分钟叫车',
      ],
    },
    杭州: {
      traps: [
        '西湖景区免费，但断桥、雷峰塔等核心景点旺季人流大，建议 7:00 前入园',
        '灵隐寺需单独购票（飞来峰与寺院分开计费），善男信女多，建议非高香期前往',
        '西溪湿地船票须在园区内购买，建议上午抵达提前排队',
      ],
      gear: [
        '杭州春季（3-4 月）踏青旺季，气温多变，早晚需备一件薄外套',
        '共享单车骑行西湖一圈约 2 小时，强烈推荐，优于打车',
      ],
    },
    深圳: {
      traps: [
        '深圳博物馆、科技馆等国有场馆免费但需预约，周末名额通常周四放出即抢空',
        '华强北电子市场建议工作日前往，周末人多且商户态度欠佳',
        '大小梅沙泳滩旺季须实名预约限流，泳衣入场，无缘由禁止携带自带食物',
      ],
      gear: [
        '深圳全年气温偏高，防晒霜与遮阳帽是必备装备',
        '地铁便捷且覆盖全市，建议办一张深圳通卡享受九折优惠',
      ],
    },
    西安: {
      traps: [
        '兵马俑须在官方小程序提前预约，旺季（五一/国庆）须提前 7 天；建议选工作日',
        '城墙骑自行车需另付租车费，旺季下午 16 点后人流明显减少',
        '回民街饮食价格偏高，建议避开正餐时间前往，夜市更热闹',
      ],
      gear: [
        '西安冬季寒冷干燥，建议备好护唇膏与保湿霜；夏季酷热，防晒必备',
        '景区间距离较远，建议租车或包车游览，公交换乘耗时',
      ],
    },
    重庆: {
      traps: [
        '洪崖洞夜景最佳拍摄点在千厮门大桥上，无需门票；景区内消费较高',
        '磁器口古镇建议工作日上午前往，旺季下午人流极为拥挤',
        '长江索道须提前在"重庆轨道交通"App 购票，现场排队候场 1 小时以上',
      ],
      gear: [
        '重庆多山多坡，建议穿低跟防滑鞋，避免高跟鞋与人字拖',
        '重庆夏季气温高达 40°C，建议备好防暑药与冰凉贴',
      ],
    },
  };

  const CITY_TIPS_FALLBACK = (city) => ({
    traps: [
      `${city}热门景区建议提前通过官方公众号或小程序实名预约，现场排队时间较长`,
      `参观博物馆、古迹类景点请提前确认开闭馆日期（通常周一闭馆）及入场规则`,
      `旺季（五一/暑期/国庆）建议工作日前往，景区人流可能是周末的 3 倍以上`,
    ],
    gear: [
      `出发前查询目的地近期天气，备好折叠雨伞与适合步行的舒适鞋`,
      `优先使用地铁/公共交通，高峰时段提前叫车避免候车过久`,
    ],
  });

  function getCityTips(city) {
    if (!city) return CITY_TIPS_FALLBACK('目的地');
    // 模糊匹配：城市名可能含「市」字
    const key = Object.keys(CITY_TIPS).find(
      (k) => city.includes(k) || k.includes(city.replace(/市$/, ''))
    );
    return key ? CITY_TIPS[key] : CITY_TIPS_FALLBACK(city);
  }

  const COMPANION_LABEL = {
    solo: '🚶 独自出发',
    couple: '👫 情侣出游',
    family: '👨‍👩‍👧 亲子带娃',
    parents: '👵 孝敬父母',
  };

  // ── 已选班次绑定（车票 → 行程）────────────────────────────────────────────

  /**
   * 车票页「选择」写入的班次，在本页消费。
   *
   * 与行程篮分开存储：行程篮是「想去哪些地方」，班次是「怎么到」——
   * 班次决定 Day 1 的起始时刻，因此需要在渲染时对 Day 1 做二次编排。
   * state.lastPlan 始终保持服务端原样，班次相关的裁剪只在渲染时套用，
   * 这样「清除班次」可以直接用原始 plan 重绘，不会污染其它天。
   */
  const TRANSPORT_KEY = 'ddj.selectedTransport.v1';

  /** 抵达时刻分界：11:30 / 17:30 */
  const ARR_EARLY_MIN = 11 * 60 + 30;
  const ARR_LATE_MIN = 17 * 60 + 30;

  function readTransport() {
    try {
      const raw = localStorage.getItem(TRANSPORT_KEY);
      if (!raw) return null;
      const t = JSON.parse(raw);
      if (!t || typeof t !== 'object') return null;
      if (!t.arrTime && !t.depTime) return null;   // 结构不完整视为无效
      return t;
    } catch {
      return null;
    }
  }

  function clearTransport() {
    try { localStorage.removeItem(TRANSPORT_KEY); } catch { /* ignore */ }
  }

  /** 'HH:mm' → 分钟；非法输入返回 null（调用方据此退回默认编排） */
  function toMinutes(hhmm) {
    const m = /^(\d{1,2}):(\d{2})$/.exec(String(hhmm || '').trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (!Number.isFinite(h) || !Number.isFinite(min) || h > 23 || min > 59) return null;
    return h * 60 + min;
  }

  /**
   * 从站点/机场名提取城市名。
   * 「SHA 虹桥」→ 虹桥 →（去方位与站场后缀）→ 空 → 回退原值；
   * 「北京西」→ 北京；「PEK 首都国际机场」→ 首都。
   * 提取失败时返回原始文本 —— 预填错了用户能改，填不上才是断链。
   */
  function cityFromPlace(place) {
    const raw = String(place || '').trim();
    if (!raw) return '';
    // 去掉三字码前缀（SHA / PEK）与括号备注
    const zh = raw.replace(/\([^)]*\)/g, '').replace(/\b[A-Z]{3}\b/g, '').trim();
    const base = zh
      .replace(/(国际)?机场.*$/, '')
      .replace(/(火车|高铁|动车)?站$/, '')
      .replace(/[东西南北]$/, '')
      .replace(/T\d$/, '')
      .trim();
    return base || zh || raw;
  }

  /** 班次简称：CA1781 / G321 */
  function transportCode(t) {
    return String(t.flightNo || t.carrier || '班次').trim();
  }

  function transportIcon(t) {
    return t.type === 'train' ? '🚄' : '✈️';
  }

  /** 把已选班次套用到页面：预填城市 + 渲染绑定横幅 */
  function applySelectedTransport() {
    const t = readTransport();
    renderTransportBanner(t);
    if (!t) return;

    // 预填出发/目的地（不覆盖用户已填内容）
    const from = cityFromPlace(t.depCity);
    const to = cityFromPlace(t.arrCity);
    if (els.apFrom && !els.apFrom.value && from) els.apFrom.value = from;
    if (els.apTo && !els.apTo.value && to) {
      els.apTo.value = to;
      Cart.setCtx({ city: to });
    }
  }

  /** 绑定横幅：位于行程篮与时间轴之上，始终可见 */
  function renderTransportBanner(t) {
    const host = document.getElementById('basket-section');
    let bar = document.getElementById('transport-bind');

    if (!t) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = document.createElement('div');
      bar.id = 'transport-bind';
      bar.className = 'transport-bind';
      if (host && host.parentNode) host.parentNode.insertBefore(bar, host);
      else return;

      // 事件只绑一次（元素复用，内容由下方 innerHTML 更新）
      bar.addEventListener('click', (e) => {
        if (e.target.closest('[data-transport="change"]')) {
          window.location.href = '/ticket.html';
        } else if (e.target.closest('[data-transport="clear"]')) {
          clearTransport();
          renderTransportBanner(null);
          // Day 1 回退到标准全天模板：用未经裁剪的原始 plan 重绘
          if (state.lastPlan) {
            renderTipsCard(state.lastPlan);
            renderTimeline(state.lastPlan);
          }
          toast('已清除绑定班次，Day 1 已恢复完整行程');
        }
      });
    }

    const arrPlace = String(t.arrCity || '').trim();
    bar.innerHTML =
      `<span class="transport-bind-icon" aria-hidden="true">${transportIcon(t)}</span>` +
      `<span class="transport-bind-text">已绑定出发班次：<b>${esc(transportCode(t))}</b>` +
      `<i>（${esc(t.arrTime || '')} 抵达${arrPlace ? ' ' + esc(arrPlace) : ''}）</i></span>` +
      `<span class="transport-bind-actions">` +
      `<button type="button" class="transport-bind-btn" data-transport="change">更换</button>` +
      `<button type="button" class="transport-bind-btn is-clear" data-transport="clear">清除</button>` +
      `</span>`;
  }

  /**
   * 按抵达时刻重排 Day 1。
   *
   * A 早到（< 11:30）：全天保留，仅在最前插入抵达事件
   * B 午后（11:30-17:30）：去掉上午项，抵达后先入住，再安排下午轻量游览与晚餐
   * C 夜间（> 17:30）：只保留 抵达 → 入住 → 夜宵/休息，白天景点整体顺延
   *
   * 返回新对象，不改动入参 —— 保证 state.lastPlan 始终是服务端原样，
   * 「清除班次」时可以无损回退（Case D）。
   */
  function applyTransportToPlan(plan) {
    const t = readTransport();
    if (!plan || !Array.isArray(plan.itinerary) || plan.itinerary.length === 0) return plan;
    if (!t) return plan;

    const arrMin = toMinutes(t.arrTime);
    const days = plan.itinerary.map((d) => ({ ...d, slots: [...(d.slots || [])] }));
    const day1 = days[0];
    const notes = [];

    // 抵达事件：Day 1 的第一项
    const arrPlace = String(t.arrCity || '').trim();
    const arrivalSlot = {
      slot: '抵达',
      time: t.arrTime || '',
      type: 'ticket',
      item: { name: `抵达【${arrPlace || '目的地'}】`, address: arrPlace },
      reason: '出站并前往市区酒店寄存行李',
    };

    let rest = day1.slots.filter((s) => s && s.type !== 'ticket');

    // 抵达时刻无法解析：只插入抵达事件，不做任何裁剪（宁可多排，不可错删）
    if (arrMin !== null) {
      if (arrMin >= ARR_LATE_MIN) {
        // Case C：夜间抵达 —— 只留住宿与晚间轻食
        const hotel = rest.filter((s) => s.type === 'hotel');
        const dinner = rest.filter((s) => s.type === 'food' && (toMinutes(s.time) ?? 0) >= 17 * 60);
        rest = [...hotel, ...dinner.slice(0, 1)];
        if (!dinner.length) {
          rest.push({
            slot: '夜宵',
            time: minutesToHHMM(Math.min(arrMin + 90, 22 * 60 + 30)),
            type: 'food',
            item: { name: '酒店附近夜市 / 清淡夜宵' },
            reason: '夜间抵达，先补充能量再休息，为明天留足体力',
          });
        }
        notes.push(`▸ 班次于 ${t.arrTime} 抵达，Day 1 已为您自动精简白天行程，避免劳累。`);
      } else if (arrMin >= ARR_EARLY_MIN) {
        // Case B：午后抵达 —— 去掉上午项，保留下午与晚餐
        const before = rest.length;
        rest = rest.filter((s) => {
          if (s.type === 'hotel') return true;              // 入住始终保留
          const m = toMinutes(s.time);
          return m === null || m >= 12 * 60;                 // 仅剔除上午安排
        });
        if (rest.length < before) {
          notes.push(`▸ 班次于 ${t.arrTime} 抵达，Day 1 已为您自动精简白天行程，避免劳累。`);
        }
      }
      // Case A：早到，全天保留，无需裁剪

      // 入住紧随抵达之后（B/C 下尤其重要）
      const hotelIdx = rest.findIndex((s) => s.type === 'hotel');
      if (hotelIdx > 0) {
        const [h] = rest.splice(hotelIdx, 1);
        rest.unshift(h);
      }
      // 抵达之后的项不应早于抵达时刻
      const floor = arrMin + 45;
      rest = rest.map((s) => {
        const m = toMinutes(s.time);
        return (m !== null && m < floor) ? { ...s, time: minutesToHHMM(floor) } : s;
      });
    }

    day1.slots = [arrivalSlot, ...rest];
    days[0] = day1;

    return { ...plan, itinerary: days, __transportNotes: notes };
  }

  /** 分钟 → 'HH:mm'（跨日截断到 23:59，避免出现 24:xx） */
  function minutesToHHMM(min) {
    const v = Math.max(0, Math.min(23 * 60 + 59, Math.round(min)));
    return `${String(Math.floor(v / 60)).padStart(2, '0')}:${String(v % 60).padStart(2, '0')}`;
  }

  // ── 一键智能规划（Task 4）──────────────────────────────────────────────

  function bindAutoPlan() {
    if (!els.apGenerate) return;

    // 预算偏好药丸：单选
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

    // 同行人药丸：单选
    els.apCompanionPills.forEach((pill) => {
      pill.addEventListener('click', () => {
        els.apCompanionPills.forEach((p) => {
          const on = p === pill;
          p.classList.toggle('is-active', on);
          p.setAttribute('aria-checked', on ? 'true' : 'false');
        });
        state.companion = pill.dataset.companion || 'couple';
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
          companion: state.companion,
        }),
      });

      const body = await res.json();
      if (!res.ok) throw new Error(body.error || `服务返回 ${res.status}`);

      state.lastPlan = body;
      renderAgentSteps(body.agent);
      const displayPlan = applyTransportToPlan(body);
      renderTipsCard(displayPlan);
      renderTimeline(displayPlan);
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

  // ── 行前小贴士与避坑指南（Task 3）──────────────────────────────────────

  /**
   * 渲染贴士卡片。
   *
   * 卡片主体是城市化的「避坑 / 装备」建议（来自本地知识库，瞬时可用）；
   * 服务端返回的 warnings 属于编排算法日志（如「抵达时间 18:02，Day1 已减少安排」），
   * 对普通用户价值低，因此收进默认折叠的 <details> 里。
   */
  function renderTipsCard(plan) {
    const city = plan?.city || '';
    const tips = getCityTips(city);

    els.tipsTrapsList.innerHTML = tips.traps.map((t) => `<li>${esc(t)}</li>`).join('');
    els.tipsGearList.innerHTML = tips.gear.map((t) => `<li>${esc(t)}</li>`).join('');

    // 技术性编排日志：折叠收纳；班次调整注记优先置顶
    const transportNotes = (plan?.__transportNotes || []).filter(Boolean);
    const warnings = [...transportNotes, ...(plan?.warnings || []).filter(Boolean)];
    if (warnings.length) {
      els.warningsList.innerHTML = warnings.map((w) => `<li>${esc(w)}</li>`).join('');
      els.aiAdjustmentsCount.textContent = `(${warnings.length} 项)`;
      els.aiAdjustments.hidden = false;
      // 有班次调整注记时自动展开，让用户第一眼就看见
      els.aiAdjustments.open = transportNotes.length > 0;
    } else {
      els.warningsList.innerHTML = '';
      els.aiAdjustments.hidden = true;
    }

    els.warnings.hidden = false;
  }

  // ── 微信行程便签导出（Task 2）──────────────────────────────────────────

  /** 汇总当前行程的预估人均花费 */
  function estimateBudget(plan) {
    let total = 0;
    (plan.itinerary || []).forEach((day) => {
      (day.slots || []).forEach((slot) => {
        // 已被用户移除的 AI 建议不计入
        if (slot.suggested && state.dismissed.has(slot.item?.name)) return;
        const item = slot.item || {};
        if (slot.type === 'food' && item.avgPrice) {
          total += Number(item.avgPrice) || 0;
        } else if (slot.type === 'hotel' && item.price) {
          total += Number(item.price) || 0;
        } else if (slot.type === 'sight') {
          // 门票形如「¥60」「免费」
          const m = String(item.ticket || '').match(/(\d+)/);
          if (m) total += Number(m[1]) || 0;
        } else if (slot.type === 'ticket') {
          const p = priceOf(item);
          if (Number.isFinite(p)) total += p;
        }
      });
    });
    return Math.round(total);
  }

  /** 把当前行程格式化成适合微信粘贴的纯文本便签 */
  function buildWechatText(plan) {
    const tier = TIER_CONFIG[state.tier] || TIER_CONFIG.comfort;
    const companion = COMPANION_LABEL[state.companion] || COMPANION_LABEL.couple;
    const tips = getCityTips(plan.city);
    const divider = '=================================';
    const lines = [];

    lines.push(`✈️ 订懂机 · ${plan.city}${plan.days}日定制行程`);
    lines.push(`👥 出行偏好：${companion} · ${tier.label}`);
    const budget = estimateBudget(plan);
    if (budget > 0) lines.push(`💰 预估总花费：¥${budget} / 人均`);
    lines.push(divider);

    (plan.itinerary || []).forEach((day) => {
      const dateStr = day.date ? formatDate(day.date) : '';
      const head = [`📅 Day ${day.day}`];
      if (dateStr) head.push(`(${dateStr})`);
      if (day.district) head.push(day.district);
      lines.push(head.join(' '));

      (day.slots || []).forEach((slot) => {
        if (slot.suggested && state.dismissed.has(slot.item?.name)) return;
        const item = slot.item || {};
        const name = displayName(item);
        if (!name) return;
        const bits = [`• ${slot.time || ''} ${slot.slot || ''}：${name}`.replace(/\s+/g, ' ').trim()];
        // 括号里放最有用的一条信息：门票 / 人均 / 房价
        let tip = '';
        if (slot.type === 'sight' && item.ticket && item.ticket !== '以现场公示为准') tip = item.ticket;
        else if (slot.type === 'food' && item.avgPrice) tip = `人均 ¥${item.avgPrice}`;
        else if (slot.type === 'hotel' && item.price) tip = `¥${item.price}/晚`;
        else if (slot.type === 'ticket' && item.depTime) tip = `${item.depTime} → ${item.arrTime || ''}`.trim();
        if (tip) bits.push(`(${tip})`);
        lines.push(bits.join(' '));
      });
      lines.push('');
    });

    // 去掉最后一个多余空行后再加分隔符
    while (lines[lines.length - 1] === '') lines.pop();
    lines.push(divider);
    lines.push('💡 订懂机 · 行前避坑与实用贴士');
    lines.push('🛡️ 预约与避坑提示：');
    tips.traps.forEach((t) => lines.push(`• ${t}`));
    lines.push('');
    lines.push('🎒 行前装备与备忘：');
    tips.gear.forEach((t) => lines.push(`• ${t}`));

    return lines.join('\n');
  }

  /**
   * 写入剪贴板。
   * navigator.clipboard 在非 HTTPS / 部分 WebView（含微信内置浏览器）下不可用，
   * 因此保留 execCommand('copy') 兜底 —— 演示环境常走 http://localhost。
   */
  async function copyToClipboard(text) {
    try {
      if (navigator.clipboard && window.isSecureContext) {
        await navigator.clipboard.writeText(text);
        return true;
      }
    } catch { /* 落到兜底方案 */ }

    try {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.setAttribute('readonly', '');
      ta.style.position = 'fixed';
      ta.style.top = '-9999px';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      ta.setSelectionRange(0, text.length);   // iOS Safari 需要显式设置选区
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }

  let copyResetTimer = null;
  async function copyWechatNote() {
    const plan = state.lastPlan;
    if (!plan) return toast('请先生成行程');

    const text = buildWechatText(plan);
    const ok = await copyToClipboard(text);
    const btn = els.copyWechatBtn;

    if (!ok) {
      toast('复制失败，请手动选择行程内容复制');
      return;
    }

    btn.textContent = '✓ 已复制！';
    btn.classList.add('is-copied');
    clearTimeout(copyResetTimer);
    copyResetTimer = setTimeout(() => {
      btn.textContent = '📋 复制微信行程便签';
      btn.classList.remove('is-copied');
    }, 2000);

    toast('✓ 行程单及避坑贴士已复制，直接去微信粘贴发给好友！');
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
