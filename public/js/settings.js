'use strict';

/* ============================================================
 * 订懂机 · 旅行规划 —— 设置页前端逻辑
 * 职责：加载/保存数据源配置、测试 LLM 连通性、状态展示
 * 密钥安全：后端只返回脱敏值；输入框留空 = 不修改已保存的 Key
 * ============================================================ */

(() => {
  const $ = (sel) => document.querySelector(sel);

  const els = {
    form: $('#settings-form'),
    url: $('#llm-url'),
    key: $('#llm-key'),
    model: $('#llm-model'),
    amapKey: $('#amap-key'),
    amadeusId: $('#amadeus-id'),
    amadeusSecret: $('#amadeus-secret'),
    keyNote: $('#llm-key-note'),
    amapKeyNote: $('#amap-key-note'),
    amadeusIdNote: $('#amadeus-id-note'),
    amadeusSecretNote: $('#amadeus-secret-note'),
    saveBtn: $('#save-btn'),
    testBtn: $('#test-btn'),
    status: $('#settings-status'),
    toast: $('#toast'),
  };

  // ---------- 初始化 ----------

  function init() {
    load();
    els.form.addEventListener('submit', onSave);
    els.testBtn.addEventListener('click', onTest);
  }

  // ---------- 加载当前配置 ----------

  async function load() {
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) throw new Error(`加载失败（${res.status}）`);
      const d = await res.json();

      // 文本字段显示当前生效值（用户保存后两者一致）
      els.url.value = d.effective.llmBaseUrl || '';
      els.model.value = d.effective.llmModel || '';

      // 密钥只显示状态，不回显明文
      els.key.value = '';
      els.key.placeholder = d.user.llmApiKeyConfigured
        ? `已配置（${d.user.llmApiKeyMasked}），留空表示不修改`
        : '未配置，请输入 API Key';
      els.keyNote.textContent = d.user.llmApiKeyConfigured
        ? `已保存：${d.user.llmApiKeyMasked}（来源：设置页）`
        : (d.effective.llmReady ? '当前使用 .env 环境变量中的 Key' : '');

      els.amapKey.value = '';
      els.amapKey.placeholder = d.user.amapKeyConfigured
        ? `已配置（${d.user.amapKeyMasked}），留空表示不修改`
        : '未配置（可选）';
      els.amapKeyNote.textContent = d.user.amapKeyConfigured
        ? `已保存：${d.user.amapKeyMasked}`
        : (d.effective.amapReady ? '当前使用 .env 环境变量中的 Key' : '');

      els.amadeusId.value = d.user.amadeusClientId || '';
      els.amadeusSecret.value = '';
      els.amadeusSecret.placeholder = d.user.amadeusSecretConfigured
        ? `已配置（${d.user.amadeusSecretMasked}），留空表示不修改`
        : '未配置（可选）';
      els.amadeusSecretNote.textContent = d.user.amadeusSecretConfigured
        ? `已保存：${d.user.amadeusSecretMasked}`
        : (d.effective.amadeusReady ? '当前使用 .env 环境变量中的凭据' : '');

      renderStatus(d);
    } catch (err) {
      els.status.innerHTML = `<p class="status-line st-err">配置加载失败：${esc(err.message)}</p>`;
    }
  }

  function renderStatus(d) {
    const llm = d.effective.llmReady
      ? `<span class="badge badge-ok">AI 联网搜索 · 已就绪</span><span class="status-meta">${esc(d.effective.llmBaseUrl)} · ${esc(d.effective.llmModel)}</span>`
      : `<span class="badge badge-off">AI 联网搜索 · 未配置</span><span class="status-meta">填写 API Key 后即可在景点页使用</span>`;
    const amap = d.effective.amapReady
      ? `<span class="badge badge-ok">高德地图 · 已就绪</span>`
      : `<span class="badge badge-off">高德地图 · 未配置（可选）</span>`;
    const amadeus = d.effective.amadeusReady
      ? `<span class="badge badge-ok">机票实时数据 · 已就绪</span>`
      : `<span class="badge badge-off">机票实时数据 · 未配置（可选）</span>`;
    els.status.innerHTML = `<p class="status-line">${llm}</p><p class="status-line">${amap}</p><p class="status-line">${amadeus}</p>`;
  }

  // ---------- 保存 ----------

  async function onSave(e) {
    e.preventDefault();
    const body = {
      llmBaseUrl: els.url.value.trim(),
      llmModel: els.model.value.trim(),
    };
    // 密钥留空 = 不修改已保存的 Key
    const key = els.key.value.trim();
    if (key) body.llmApiKey = key;
    const amapKey = els.amapKey.value.trim();
    if (amapKey) body.amapKey = amapKey;
    body.amadeusClientId = els.amadeusId.value.trim(); // 非密钥，直接回填
    const amadeusSecret = els.amadeusSecret.value.trim();
    if (amadeusSecret) body.amadeusSecret = amadeusSecret;

    els.saveBtn.disabled = true;
    els.saveBtn.textContent = '保存中…';
    try {
      const res = await fetch('/api/settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `保存失败（${res.status}）`);
      showToast('配置已保存，各模块缓存已刷新');
      await load();
    } catch (err) {
      showToast(err.message || '保存失败，请稍后重试', 'error');
    } finally {
      els.saveBtn.disabled = false;
      els.saveBtn.textContent = '保存配置';
    }
  }

  // ---------- 测试连接 ----------

  async function onTest() {
    const body = { llmBaseUrl: els.url.value.trim() };
    const key = els.key.value.trim();
    if (key) body.llmApiKey = key; // 未输入时用已保存/环境变量的 Key
    body.amadeusClientId = els.amadeusId.value.trim();
    const amadeusSecret = els.amadeusSecret.value.trim();
    if (amadeusSecret) body.amadeusSecret = amadeusSecret;

    els.testBtn.disabled = true;
    els.testBtn.textContent = '测试中…';
    try {
      const res = await fetch('/api/settings/test', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const d = await res.json();
      if (!res.ok) throw new Error(d.error || `测试失败（${res.status}）`);
      // 汇总各数据源的测试结果（LLM 校验模型名；Amadeus 校验凭据）
      const parts = [];
      let hasError = false;
      if (d.llmTested) {
        const models = d.models || [];
        const cur = els.model.value.trim();
        if (d.llmError) {
          parts.push(d.llmError);
          hasError = true;
        } else if (!models.length) {
          parts.push('LLM 连接成功 ✓（接口未返回模型列表，无法校验模型名）');
        } else if (!cur) {
          els.model.value = models[0];
          parts.push(`LLM 连接成功 ✓ 已填入默认模型：${models[0]}`);
        } else if (!models.includes(cur)) {
          parts.push(`模型「${cur}」不在可用列表：${models.slice(0, 6).join('、')}，请修改后再保存`);
          hasError = true;
        } else {
          parts.push(`LLM 连接成功 ✓ 模型「${cur}」可用（共 ${models.length} 个）`);
        }
      }
      if (d.amadeusTested) {
        if (d.amadeusOk) {
          parts.push('Amadeus 连接成功 ✓（机票实时数据已就绪）');
        } else {
          parts.push(d.amadeusError || 'Amadeus 连接失败');
          hasError = true;
        }
      }
      showToast(parts.join('；'), hasError ? 'error' : 'info');
    } catch (err) {
      showToast(err.message || '测试失败，请检查地址与密钥', 'error');
    } finally {
      els.testBtn.disabled = false;
      els.testBtn.textContent = '测试连接';
    }
  }

  // ---------- 工具 ----------

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
    }, kind === 'error' ? 4000 : 3000);
  }

  document.addEventListener('DOMContentLoaded', init);
})();
