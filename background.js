/**
 * OpenClaw Hub - Background Service Worker
 * 管理 WebSocket 連線、訊息轉發、定時任務
 */

// WebSocket 連線池 { gatewayId: WebSocket }
const wsConnections = new Map();
// 等待回應的 Promise { runId: { resolve, reject, tabId } }
const pendingRequests = new Map();

// ── 初始化 ──────────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    await chrome.storage.local.set({
      gateways: [],
      activeGatewayId: null,
      chatSessions: [],
      activeChatId: null,
      settings: { defaultModel: 'claude-sonnet-4-6', theme: 'dark' },
      usageMetrics: {}
    });
    console.log('[OpenClaw Hub] 已安裝，初始化完成');
  }
  // 設定右鍵選單
  chrome.contextMenus.create({
    id: 'sendToOpenClaw',
    title: '傳送至 OpenClaw',
    contexts: ['selection']
  });
});

// ── Side Panel：點擊 toolbar icon 開啟 ───────────────────────────────────────

chrome.action.onClicked.addListener(async (tab) => {
  await chrome.sidePanel.open({ tabId: tab.id });
});

// ── 右鍵選單 ─────────────────────────────────────────────────────────────────

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (info.menuItemId === 'sendToOpenClaw' && info.selectionText) {
    await chrome.sidePanel.open({ tabId: tab.id });
    // 延遲確保 side panel 已載入
    setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'INJECT_TEXT',
        text: info.selectionText
      }).catch(() => {});
    }, 500);
  }
});

// ── 訊息處理中心 ──────────────────────────────────────────────────────────────

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch(err => sendResponse({ success: false, error: err.message }));
  return true; // 保持非同步
});

async function handleMessage(message, sender) {
  const { type } = message;

  switch (type) {
    case 'WS_CONNECT':
      return wsConnect(message.gatewayId, message.url);

    case 'WS_DISCONNECT':
      return wsDisconnect(message.gatewayId);

    case 'WS_STATUS':
      return wsStatus(message.gatewayId);

    case 'CHAT_SEND':
      return chatSend(message);

    case 'GET_TAB_CONTENT':
      return getTabContent(sender.tab?.id || message.tabId);

    case 'FETCH_SKILLS':
      return fetchSkills(message.gatewayId);

    case 'INSTALL_SKILL':
      return installSkill(message.gatewayId, message.skillId);

    case 'UNINSTALL_SKILL':
      return uninstallSkill(message.gatewayId, message.skillId);

    case 'WS_TEST':
      return wsTest(message.wsUrl);

    case 'GATEWAY_HEALTH':
      return checkGatewayHealth(message.gatewayId);

    case 'GET_USAGE':
      return getUsage();

    case 'SAVE_USAGE':
      return saveUsage(message.data);

    default:
      return { success: false, error: `Unknown message type: ${type}` };
  }
}

// ── WebSocket 管理 ───────────────────────────────────────────────────────────

async function wsConnect(gatewayId, url) {
  if (wsConnections.has(gatewayId)) {
    const existing = wsConnections.get(gatewayId);
    if (existing.readyState === WebSocket.OPEN) {
      return { success: true, status: 'already_connected' };
    }
    existing.close();
    wsConnections.delete(gatewayId);
  }

  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      resolve({ success: false, error: e.message });
      return;
    }

    const timeout = setTimeout(() => {
      ws.close();
      resolve({ success: false, error: '連線逾時（10s）' });
    }, 10000);

    ws.onopen = () => {
      clearTimeout(timeout);
      wsConnections.set(gatewayId, ws);
      updateGatewayStatus(gatewayId, 'connected');
      setupWsAlarm(gatewayId);
      resolve({ success: true, status: 'connected' });
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        handleWsMessage(gatewayId, data);
      } catch (e) {
        handleWsMessage(gatewayId, { type: 'raw', data: event.data });
      }
    };

    ws.onerror = (event) => {
      clearTimeout(timeout);
      updateGatewayStatus(gatewayId, 'error');
    };

    ws.onclose = () => {
      wsConnections.delete(gatewayId);
      updateGatewayStatus(gatewayId, 'disconnected');
      scheduleReconnect(gatewayId);
    };
  });
}

function handleWsMessage(gatewayId, data) {
  const runId = data.runId || data.id;

  // 轉發串流訊息給所有擴充功能頁面
  chrome.runtime.sendMessage({
    type: 'WS_MESSAGE',
    gatewayId,
    data
  }).catch(() => {});

  // 解析等待中的 request
  if (runId && pendingRequests.has(runId)) {
    if (data.type === 'done' || data.event === 'run_finished') {
      const { resolve } = pendingRequests.get(runId);
      pendingRequests.delete(runId);
      resolve({ success: true });
    }
  }
}

async function wsDisconnect(gatewayId) {
  const ws = wsConnections.get(gatewayId);
  if (ws) {
    ws.close();
    wsConnections.delete(gatewayId);
  }
  return { success: true };
}

function wsStatus(gatewayId) {
  if (!gatewayId) {
    const statuses = {};
    for (const [id, ws] of wsConnections) {
      statuses[id] = ws.readyState;
    }
    return { success: true, statuses };
  }
  const ws = wsConnections.get(gatewayId);
  return {
    success: true,
    connected: ws ? ws.readyState === WebSocket.OPEN : false,
    readyState: ws ? ws.readyState : -1
  };
}

// ── 聊天發送 ──────────────────────────────────────────────────────────────────

async function chatSend({ gatewayId, message, model, runId, tabContext }) {
  const ws = wsConnections.get(gatewayId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    // 嘗試重新連線
    const { gateways } = await chrome.storage.local.get('gateways');
    const gw = gateways?.find(g => g.id === gatewayId);
    if (gw) {
      const result = await wsConnect(gatewayId, gw.wsUrl);
      if (!result.success) return { success: false, error: '無法連線至 Gateway' };
    } else {
      return { success: false, error: 'Gateway 不存在' };
    }
  }

  const payload = {
    type: 'run',
    runId,
    message,
    model,
    tabContext: tabContext || null
  };

  try {
    wsConnections.get(gatewayId).send(JSON.stringify(payload));
    return { success: true };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Tab 內容擷取 ──────────────────────────────────────────────────────────────

async function getTabContent(tabId) {
  if (!tabId) return { success: false, error: 'No active tab' };
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      func: () => ({
        url: location.href,
        title: document.title,
        text: document.body?.innerText?.slice(0, 3000) || ''
      })
    });
    return { success: true, content: results[0]?.result };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── Skills API ───────────────────────────────────────────────────────────────

async function fetchSkills(gatewayId) {
  const gw = await getGateway(gatewayId);
  if (!gw) return { success: false, error: 'Gateway 不存在' };

  try {
    const res = await fetch(`${gw.httpUrl}/api/skills`, {
      headers: buildHeaders(gw)
    });
    const data = await res.json();
    return { success: true, skills: data.skills || data };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function installSkill(gatewayId, skillId) {
  const gw = await getGateway(gatewayId);
  if (!gw) return { success: false, error: 'Gateway 不存在' };

  try {
    const res = await fetch(`${gw.httpUrl}/api/skills/install`, {
      method: 'POST',
      headers: { ...buildHeaders(gw), 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillId })
    });
    const data = await res.json();
    return { success: res.ok, data };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

async function uninstallSkill(gatewayId, skillId) {
  const gw = await getGateway(gatewayId);
  if (!gw) return { success: false, error: 'Gateway 不存在' };

  try {
    const res = await fetch(`${gw.httpUrl}/api/skills/uninstall`, {
      method: 'POST',
      headers: { ...buildHeaders(gw), 'Content-Type': 'application/json' },
      body: JSON.stringify({ skillId })
    });
    const data = await res.json();
    return { success: res.ok, data };
  } catch (e) {
    return { success: false, error: e.message };
  }
}

// ── WS 臨時測試（不存入連線池）────────────────────────────────────────────────

function wsTest(wsUrl) {
  return new Promise((resolve) => {
    if (!wsUrl) {
      resolve({ success: false, error: '請填寫 WebSocket URL' });
      return;
    }
    let ws;
    try {
      ws = new WebSocket(wsUrl);
    } catch (e) {
      resolve({ success: false, error: e.message });
      return;
    }
    const start = Date.now();
    const timer = setTimeout(() => {
      ws.close();
      resolve({ success: false, error: '連線逾時（10s）' });
    }, 10000);

    ws.onopen = () => {
      clearTimeout(timer);
      const latency = Date.now() - start;
      ws.close();
      resolve({ success: true, latency });
    };
    ws.onerror = (e) => {
      clearTimeout(timer);
      resolve({ success: false, error: e.message || '連線失敗' });
    };
  });
}

// ── Gateway 健康檢查 ──────────────────────────────────────────────────────────

async function checkGatewayHealth(gatewayId) {
  const gw = await getGateway(gatewayId);
  if (!gw) return { success: false, error: 'Gateway 不存在' };

  try {
    const start = Date.now();
    const res = await fetch(`${gw.httpUrl}/api/health`, {
      headers: buildHeaders(gw),
      signal: AbortSignal.timeout(5000)
    });
    const latency = Date.now() - start;
    const data = await res.json().catch(() => ({}));
    return { success: true, healthy: res.ok, latency, data };
  } catch (e) {
    return { success: false, healthy: false, error: e.message };
  }
}

// ── 用量統計 ──────────────────────────────────────────────────────────────────

async function getUsage() {
  const { usageMetrics } = await chrome.storage.local.get('usageMetrics');
  return { success: true, metrics: usageMetrics || {} };
}

async function saveUsage({ model, inputTokens, outputTokens, costUSD }) {
  const today = new Date().toISOString().split('T')[0];
  const { usageMetrics = {} } = await chrome.storage.local.get('usageMetrics');

  if (!usageMetrics[today]) usageMetrics[today] = {};
  if (!usageMetrics[today][model]) {
    usageMetrics[today][model] = { inputTokens: 0, outputTokens: 0, costUSD: 0 };
  }

  usageMetrics[today][model].inputTokens += inputTokens || 0;
  usageMetrics[today][model].outputTokens += outputTokens || 0;
  usageMetrics[today][model].costUSD += costUSD || 0;

  await chrome.storage.local.set({ usageMetrics });
  return { success: true };
}

// ── 輔助工具 ──────────────────────────────────────────────────────────────────

async function getGateway(gatewayId) {
  const { gateways = [] } = await chrome.storage.local.get('gateways');
  return gateways.find(g => g.id === gatewayId) || null;
}

function buildHeaders(gw) {
  const headers = { 'Content-Type': 'application/json' };
  if (gw.apiKey) headers['Authorization'] = `Bearer ${gw.apiKey}`;
  return headers;
}

async function updateGatewayStatus(gatewayId, status) {
  const { gateways = [] } = await chrome.storage.local.get('gateways');
  const idx = gateways.findIndex(g => g.id === gatewayId);
  if (idx >= 0) {
    gateways[idx].status = status;
    gateways[idx].lastChecked = new Date().toISOString();
    await chrome.storage.local.set({ gateways });
  }
  // 通知 UI 更新
  chrome.runtime.sendMessage({ type: 'GATEWAY_STATUS_CHANGED', gatewayId, status }).catch(() => {});
}

// ── WS Keepalive (Alarm) ──────────────────────────────────────────────────────

function setupWsAlarm(gatewayId) {
  chrome.alarms.create(`ws_ping_${gatewayId}`, { periodInMinutes: 0.4 }); // ~25s
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name.startsWith('ws_ping_')) {
    const gatewayId = alarm.name.replace('ws_ping_', '');
    const ws = wsConnections.get(gatewayId);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'ping' }));
    } else {
      chrome.alarms.clear(alarm.name);
    }
  }
});

// ── 斷線重連 ──────────────────────────────────────────────────────────────────

const reconnectAttempts = new Map();

async function scheduleReconnect(gatewayId) {
  const attempts = reconnectAttempts.get(gatewayId) || 0;
  if (attempts >= 5) {
    reconnectAttempts.delete(gatewayId);
    return;
  }

  const delay = Math.min(1000 * 2 ** attempts, 30000); // exponential backoff, max 30s
  reconnectAttempts.set(gatewayId, attempts + 1);

  setTimeout(async () => {
    const gw = await getGateway(gatewayId);
    if (gw) {
      const result = await wsConnect(gatewayId, gw.wsUrl);
      if (result.success) reconnectAttempts.delete(gatewayId);
    }
  }, delay);
}
