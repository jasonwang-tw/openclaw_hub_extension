/**
 * OpenClaw Hub - Options Page Script
 */

// ── 導覽切換 ─────────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-item').forEach(item => {
  item.addEventListener('click', () => {
    const tab = item.dataset.tab;
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    item.classList.add('active');
    document.getElementById(`tab-${tab}`).classList.add('active');

    if (tab === 'usage') renderUsage();
    if (tab === 'skills') loadSkills();
    if (tab === 'settings') loadSettings();
    if (tab === 'gateway') loadGateways();
  });
});

document.addEventListener('DOMContentLoaded', () => {
  loadGateways();
  bindGatewayEvents();
  bindSettingsEvents();
  bindSkillsEvents();
});

// ── GATEWAY ──────────────────────────────────────────────────────────────────

let editingGatewayId = null;

async function loadGateways() {
  const { gateways = [], activeGatewayId } = await chrome.storage.local.get(['gateways', 'activeGatewayId']);
  const list = document.getElementById('gatewayList');

  if (gateways.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon"><i data-lucide="link"></i></div>
        <p>尚無 Gateway，點擊「新增 Gateway」開始連線</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  list.innerHTML = gateways.map(gw => `
    <div class="gateway-card ${gw.id === activeGatewayId ? 'default' : ''}" data-id="${gw.id}">
      <div class="gw-status-dot ${gw.status || ''}"></div>
      <div class="gw-info">
        <div class="gw-name">
          ${escHtml(gw.name)}
          ${gw.id === activeGatewayId ? '<span class="gw-badge">預設</span>' : ''}
        </div>
        <div class="gw-url">${escHtml(gw.wsUrl)}</div>
      </div>
      <div class="gw-actions">
        <button class="gw-btn" data-action="health" data-id="${gw.id}" title="健康檢查"><i data-lucide="zap"></i></button>
        ${gw.id !== activeGatewayId ? `<button class="gw-btn" data-action="setDefault" data-id="${gw.id}">設為預設</button>` : ''}
        <button class="gw-btn" data-action="edit" data-id="${gw.id}">編輯</button>
        <button class="gw-btn danger" data-action="delete" data-id="${gw.id}">刪除</button>
      </div>
    </div>
  `).join('');
  lucide.createIcons();

  // 事件委派
  list.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id } = btn.dataset;

    if (action === 'health') await checkHealth(id);
    if (action === 'setDefault') await setDefaultGateway(id);
    if (action === 'edit') openEditGateway(id);
    if (action === 'delete') await deleteGateway(id);
  });
}

function bindGatewayEvents() {
  document.getElementById('btnAddGateway').addEventListener('click', () => {
    editingGatewayId = null;
    document.getElementById('modalTitle').textContent = '新增 Gateway';
    document.getElementById('gwName').value = '';
    document.getElementById('gwWsUrl').value = 'ws://127.0.0.1:18789';
    document.getElementById('gwHttpUrl').value = 'http://127.0.0.1:18789';
    document.getElementById('gwApiKey').value = '';
    document.getElementById('gatewayModal').style.display = 'flex';
  });

  document.getElementById('btnCancelGateway').addEventListener('click', () => {
    document.getElementById('gatewayModal').style.display = 'none';
  });

  document.getElementById('btnSaveGateway').addEventListener('click', saveGateway);

  document.getElementById('btnTestConn').addEventListener('click', testConnection);
}

async function testConnection() {
  const wsUrl = document.getElementById('gwWsUrl').value.trim();
  const resultEl = document.getElementById('testConnResult');

  if (!wsUrl) {
    resultEl.textContent = '請先填寫 WebSocket URL';
    resultEl.className = 'test-conn-result fail';
    return;
  }

  resultEl.textContent = '連線測試中…';
  resultEl.className = 'test-conn-result ing';

  // 透過 background service worker 發起 WS 測試，避免 extension page CSP 限制
  const res = await bgMsg({ type: 'WS_TEST', wsUrl });

  if (res.success) {
    resultEl.textContent = `✓ 連線成功（${res.latency}ms）`;
    resultEl.className = 'test-conn-result ok';
  } else {
    resultEl.textContent = `✕ ${res.error}`;
    resultEl.className = 'test-conn-result fail';
  }
}

async function saveGateway() {
  const name = document.getElementById('gwName').value.trim();
  const wsUrl = document.getElementById('gwWsUrl').value.trim();
  const httpUrl = document.getElementById('gwHttpUrl').value.trim();
  const apiKey = document.getElementById('gwApiKey').value.trim();

  if (!name || !wsUrl) {
    alert('請填寫名稱和 WebSocket URL');
    return;
  }

  const { gateways = [], activeGatewayId } = await chrome.storage.local.get(['gateways', 'activeGatewayId']);

  if (editingGatewayId) {
    const idx = gateways.findIndex(g => g.id === editingGatewayId);
    if (idx >= 0) {
      gateways[idx] = { ...gateways[idx], name, wsUrl, httpUrl, apiKey };
    }
  } else {
    const newGw = {
      id: crypto.randomUUID(),
      name, wsUrl, httpUrl, apiKey,
      createdAt: new Date().toISOString(),
      status: 'unknown'
    };
    gateways.push(newGw);
    // 若為第一個，自動設為預設
    if (gateways.length === 1) {
      await chrome.storage.local.set({ activeGatewayId: newGw.id });
    }
  }

  await chrome.storage.local.set({ gateways });
  document.getElementById('gatewayModal').style.display = 'none';
  loadGateways();
}

async function openEditGateway(id) {
  const { gateways = [] } = await chrome.storage.local.get('gateways');
  const gw = gateways.find(g => g.id === id);
  if (!gw) return;

  editingGatewayId = id;
  document.getElementById('modalTitle').textContent = '編輯 Gateway';
  document.getElementById('gwName').value = gw.name;
  document.getElementById('gwWsUrl').value = gw.wsUrl;
  document.getElementById('gwHttpUrl').value = gw.httpUrl || '';
  document.getElementById('gwApiKey').value = gw.apiKey || '';
  document.getElementById('gatewayModal').style.display = 'flex';
}

async function setDefaultGateway(id) {
  await chrome.storage.local.set({ activeGatewayId: id });
  // 嘗試連線
  bgMsg({ type: 'WS_CONNECT', gatewayId: id });
  loadGateways();
}

async function deleteGateway(id) {
  if (!confirm('確定要刪除此 Gateway？')) return;
  const { gateways = [], activeGatewayId } = await chrome.storage.local.get(['gateways', 'activeGatewayId']);
  const newGateways = gateways.filter(g => g.id !== id);

  const updates = { gateways: newGateways };
  if (activeGatewayId === id) {
    updates.activeGatewayId = newGateways[0]?.id || null;
  }

  await bgMsg({ type: 'WS_DISCONNECT', gatewayId: id });
  await chrome.storage.local.set(updates);
  loadGateways();
}

async function checkHealth(id) {
  const result = await bgMsg({ type: 'GATEWAY_HEALTH', gatewayId: id });
  const msg = result.success && result.healthy
    ? `✓ 連線正常（延遲 ${result.latency}ms）`
    : `✕ 連線失敗：${result.error || '無回應'}`;
  alert(msg);
  loadGateways();
}

// ── SKILLS ───────────────────────────────────────────────────────────────────

let currentSkillsTab = 'installed';

function bindSkillsEvents() {
  document.getElementById('btnRefreshSkills').addEventListener('click', loadSkills);

  document.querySelectorAll('.skills-tab').forEach(btn => {
    btn.addEventListener('click', () => {
      currentSkillsTab = btn.dataset.st;
      document.querySelectorAll('.skills-tab').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById('skillsInstalled').style.display = currentSkillsTab === 'installed' ? 'grid' : 'none';
      document.getElementById('skillsMarketplace').style.display = currentSkillsTab === 'marketplace' ? 'grid' : 'none';
    });
  });
}

async function loadSkills() {
  const { activeGatewayId } = await chrome.storage.local.get('activeGatewayId');
  if (!activeGatewayId) {
    document.getElementById('skillsInstalled').innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon"><i data-lucide="link"></i></div>
        <p>請先設定 Gateway</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  const result = await bgMsg({ type: 'FETCH_SKILLS', gatewayId: activeGatewayId });

  if (!result.success) {
    document.getElementById('skillsInstalled').innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon"><i data-lucide="triangle-alert"></i></div>
        <p>無法載入 Skills：${result.error}</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  renderSkills(result.skills || [], activeGatewayId);
  await loadMarketplaceSkills();
}

function renderSkills(skills, gatewayId) {
  const container = document.getElementById('skillsInstalled');
  if (skills.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon"><i data-lucide="puzzle"></i></div>
        <p>尚未安裝任何 Skill</p>
      </div>
    `;
    lucide.createIcons();
    return;
  }

  container.innerHTML = skills.map(skill => `
    <div class="skill-card">
      <div class="skill-header">
        <div>
          <div class="skill-name">${escHtml(skill.name)}</div>
          <div class="skill-version">${escHtml(skill.version || '')}</div>
        </div>
      </div>
      <div class="skill-desc">${escHtml(skill.description || '')}</div>
      <div class="skill-footer">
        <span class="skill-status ${skill.enabled ? 'enabled' : ''}">
          ${skill.enabled ? '● 已啟用' : '○ 已停用'}
        </span>
        <button class="btn-danger" data-action="uninstall" data-id="${skill.id}" data-gw="${gatewayId}">
          移除
        </button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('[data-action="uninstall"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      if (!confirm('確定移除此 Skill？')) return;
      const result = await bgMsg({ type: 'UNINSTALL_SKILL', gatewayId: btn.dataset.gw, skillId: btn.dataset.id });
      if (result.success) loadSkills();
      else alert('移除失敗：' + result.error);
    });
  });
  lucide.createIcons();
}

async function loadMarketplaceSkills() {
  // 從 GitHub openclaw/clawhub 取得
  try {
    const res = await fetch('https://api.github.com/repos/openclaw/clawhub/contents/skills');
    if (!res.ok) throw new Error('GitHub API error');
    const items = await res.json();
    renderMarketplace(items);
  } catch (e) {
    document.getElementById('skillsMarketplace').innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon"><i data-lucide="globe"></i></div>
        <p>無法連線至 Skills 市場：${e.message}</p>
      </div>
    `;
    lucide.createIcons();
  }
}

function renderMarketplace(items) {
  const container = document.getElementById('skillsMarketplace');
  const dirs = items.filter(i => i.type === 'dir');

  if (dirs.length === 0) {
    container.innerHTML = `<div class="empty-state"><p>市場暫無可用 Skills</p></div>`;
    return;
  }

  container.innerHTML = dirs.map(dir => `
    <div class="skill-card">
      <div class="skill-header">
        <div>
          <div class="skill-name">${escHtml(dir.name)}</div>
        </div>
      </div>
      <div class="skill-desc">來自 openclaw/clawhub</div>
      <div class="skill-footer">
        <a href="${dir.html_url}" target="_blank" style="font-size:12px;color:var(--text3)">查看原始碼</a>
        <button class="btn-primary" style="font-size:12px;padding:5px 12px"
          data-action="install" data-id="${dir.name}">安裝</button>
      </div>
    </div>
  `).join('');

  container.querySelectorAll('[data-action="install"]').forEach(btn => {
    btn.addEventListener('click', async () => {
      const { activeGatewayId } = await chrome.storage.local.get('activeGatewayId');
      if (!activeGatewayId) { alert('請先選擇 Gateway'); return; }
      btn.textContent = '安裝中…';
      btn.disabled = true;
      const result = await bgMsg({ type: 'INSTALL_SKILL', gatewayId: activeGatewayId, skillId: btn.dataset.id });
      btn.textContent = result.success ? '✓ 已安裝' : '失敗';
      if (result.success) setTimeout(loadSkills, 500);
    });
  });
  lucide.createIcons();
}

// ── USAGE ────────────────────────────────────────────────────────────────────

async function renderUsage() {
  const days = parseInt(document.getElementById('usagePeriod').value || '7');
  const { usageMetrics = {} } = await chrome.storage.local.get('usageMetrics');

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - days);

  const filteredDates = Object.keys(usageMetrics)
    .filter(d => new Date(d) >= cutoff)
    .sort();

  // 彙總
  let totalInput = 0, totalOutput = 0, totalCost = 0;
  const byModel = {};
  const byDay = {};

  filteredDates.forEach(date => {
    const dayData = usageMetrics[date];
    byDay[date] = { input: 0, output: 0 };
    Object.entries(dayData).forEach(([model, stats]) => {
      totalInput += stats.inputTokens;
      totalOutput += stats.outputTokens;
      totalCost += stats.costUSD;
      byDay[date].input += stats.inputTokens;
      byDay[date].output += stats.outputTokens;
      if (!byModel[model]) byModel[model] = { inputTokens: 0, outputTokens: 0, costUSD: 0 };
      byModel[model].inputTokens += stats.inputTokens;
      byModel[model].outputTokens += stats.outputTokens;
      byModel[model].costUSD += stats.costUSD;
    });
  });

  document.getElementById('totalTokens').textContent = formatNum(totalInput + totalOutput);
  document.getElementById('totalCost').textContent = '$' + totalCost.toFixed(4);
  document.getElementById('activeDays').textContent = filteredDates.length;

  renderChart(byDay);
  renderUsageTable(byModel);
}

function renderChart(byDay) {
  const svg = document.getElementById('usageChart');
  const dates = Object.keys(byDay).sort();
  if (dates.length === 0) {
    svg.innerHTML = '<text x="50%" y="50%" text-anchor="middle" fill="#6666aa" font-size="13">尚無資料</text>';
    return;
  }

  const maxVal = Math.max(...dates.map(d => byDay[d].input + byDay[d].output), 1);
  const W = 560, H = 150, pad = { l: 40, r: 10, t: 10, b: 30 };
  const chartW = W - pad.l - pad.r;
  const chartH = H - pad.t - pad.b;
  const barW = Math.min(40, (chartW / dates.length) - 4);

  const bars = dates.map((date, i) => {
    const val = byDay[date].input + byDay[date].output;
    const h = (val / maxVal) * chartH;
    const x = pad.l + (i / dates.length) * chartW + (chartW / dates.length - barW) / 2;
    const y = pad.t + chartH - h;
    const label = date.slice(5); // MM-DD
    return `
      <rect x="${x}" y="${y}" width="${barW}" height="${h}" fill="#ff6b35" rx="3" opacity="0.85"/>
      <text x="${x + barW/2}" y="${H - 8}" text-anchor="middle" font-size="10" fill="#6666aa">${label}</text>
    `;
  }).join('');

  svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
  svg.innerHTML = bars;
}

function renderUsageTable(byModel) {
  const tbody = document.getElementById('usageTableBody');
  const rows = Object.entries(byModel)
    .sort((a, b) => b[1].costUSD - a[1].costUSD);

  if (rows.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text3);padding:20px">尚無資料</td></tr>';
    return;
  }

  tbody.innerHTML = rows.map(([model, stats]) => `
    <tr>
      <td><code style="font-size:12px">${escHtml(model)}</code></td>
      <td>${formatNum(stats.inputTokens)}</td>
      <td>${formatNum(stats.outputTokens)}</td>
      <td>$${stats.costUSD.toFixed(4)}</td>
    </tr>
  `).join('');
}

document.getElementById('usagePeriod').addEventListener('change', renderUsage);

// ── SETTINGS ─────────────────────────────────────────────────────────────────

async function loadSettings() {
  const { settings = {} } = await chrome.storage.local.get('settings');
  document.getElementById('themeToggle').checked = settings.theme === 'light';
  if (settings.defaultModel) {
    document.getElementById('defaultModel').value = settings.defaultModel;
  }
}

function bindSettingsEvents() {
  document.getElementById('themeToggle').addEventListener('change', async (e) => {
    const theme = e.target.checked ? 'light' : 'dark';
    document.body.classList.toggle('light', e.target.checked);
    document.body.classList.toggle('dark', !e.target.checked);
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, theme } });
  });

  document.getElementById('defaultModel').addEventListener('change', async (e) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    await chrome.storage.local.set({ settings: { ...settings, defaultModel: e.target.value } });
  });

  document.getElementById('btnClearChats').addEventListener('click', async () => {
    if (!confirm('確定清除所有對話紀錄？')) return;
    await chrome.storage.local.set({ chatSessions: [], activeChatId: null });
    alert('對話紀錄已清除');
  });

  document.getElementById('btnClearUsage').addEventListener('click', async () => {
    if (!confirm('確定清除用量統計？')) return;
    await chrome.storage.local.set({ usageMetrics: {} });
    renderUsage();
    alert('用量統計已清除');
  });

  document.getElementById('btnResetAll').addEventListener('click', async () => {
    if (!confirm('確定重置所有設定？此操作不可還原。')) return;
    await chrome.storage.local.clear();
    await chrome.storage.local.set({
      gateways: [],
      activeGatewayId: null,
      chatSessions: [],
      activeChatId: null,
      settings: { defaultModel: 'claude-sonnet-4-6', theme: 'dark' },
      usageMetrics: {}
    });
    alert('已重置完成');
    loadGateways();
    loadSettings();
  });
}

// ── 工具 ─────────────────────────────────────────────────────────────────────

function bgMsg(message) {
  return chrome.runtime.sendMessage(message).catch(err => ({ success: false, error: err.message }));
}

function escHtml(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatNum(n) {
  return Number(n || 0).toLocaleString('zh-TW');
}
