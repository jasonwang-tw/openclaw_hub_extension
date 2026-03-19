/**
 * OpenClaw Hub - Background Service Worker
 * 管理 WebSocket 連線、訊息轉發、定時任務
 */

// WebSocket 連線池 { gatewayId: WebSocket }
const wsConnections = new Map();
// 每個 WS 的 pending req/res { gatewayId → Map<id, {res, rej}> }
const wsPending = new Map();
// 已抓取模型的 Gateway { gatewayId: true }
const modelsFetched = new Map();
// Hub JWT tokens { gatewayId: token }
const hubTokens = new Map();
// Hub 模式標記 { gatewayId: true }
const hubMode = new Map();

// ── 初始化 ──────────────────────────────────────────────────────────────────

console.log('[Extension] Origin:', `chrome-extension://${chrome.runtime.id}`);

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
    // 已安裝，初始化完成
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
      return wsConnect(message.gatewayId, message.url, message.apiKey);

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

// ── Hub HTTP 代理模式 ────────────────────────────────────────────────────────

/**
 * Hub 代理模式驗證：確認 proxy 可用
 */
async function hubLogin(gatewayId) {
  const gw = await getGateway(gatewayId);
  if (!gw?.httpUrl) return null;

  try {
    const res = await fetch(`${gw.httpUrl}/health`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) {
      console.log('[Hub] health check failed:', res.status);
      return null;
    }
    const data = await res.json();
    console.log('[Hub] proxy OK:', data.status);
    hubTokens.set(gatewayId, gw.apiKey || 'ok');
    return gw.apiKey || 'ok';
  } catch (e) {
    console.log('[Hub] proxy error:', e.message);
    return null;
  }
}

/**
 * 透過 Chat Proxy 發送聊天訊息（streaming text/plain）
 * 讀取串流文字 → 轉換為 WS_MESSAGE 事件推送至 sidepanel
 */
async function hubChatSend({ gatewayId, message, model, runId, tabContext, sessionId }) {
  const gw = await getGateway(gatewayId);
  if (!gw?.httpUrl) return { success: false, error: 'Proxy URL 未設定' };

  // 組合訊息內容（含 tab context）
  let fullMessage = message;
  if (tabContext) {
    fullMessage = `[頁面上下文]\n標題: ${tabContext.title}\nURL: ${tabContext.url}\n內容: ${tabContext.text}\n\n${message}`;
  }

  try {
    const res = await fetch(`${gw.httpUrl}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        message: fullMessage,
        sessionId: sessionId || 'default',
        token: gw.apiKey || ''
      })
    });

    if (!res.ok) return { success: false, error: `Proxy 錯誤: ${res.status}` };

    // 非同步讀取串流回應
    streamHubResponse(gatewayId, res);
    return { success: true };

  } catch (e) {
    return { success: false, error: `Proxy 請求失敗: ${e.message}` };
  }
}

/**
 * 讀取 Hub 的 text/plain 串流回應，轉為 WS_MESSAGE 事件
 */
async function streamHubResponse(gatewayId, res) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      const text = decoder.decode(value, { stream: true });
      if (text) {
        // 包裝成 sidepanel 已知的事件格式
        chrome.runtime.sendMessage({
          type: 'WS_MESSAGE',
          gatewayId,
          data: {
            type: 'event',
            event: 'agent',
            payload: { stream: 'assistant', data: { delta: text } }
          }
        }).catch(() => {});
      }
    }
  } catch (e) {
    console.log('[Hub] stream error:', e.message);
  }

  // 發送結束信號
  chrome.runtime.sendMessage({
    type: 'WS_MESSAGE',
    gatewayId,
    data: {
      type: 'event',
      event: 'chat',
      payload: { state: 'final' }
    }
  }).catch(() => {});
}

// ── WebSocket 管理 ───────────────────────────────────────────────────────────

/**
 * OpenClaw Gateway WS 協議：
 * 1. 建立 WS 連線（無 token 在 URL）
 * 2. onopen → 送 {type:'req', id, method:'connect', params:{...auth:{token}}}
 * 3. 等待 {id, ok:true} 回應（connect.challenge event 忽略不回應）
 * 4. 之後送 {type:'req', id, method:'chat.send', params:{sessionKey, message, ...}}
 * 5. 聆聽 event: 'agent' stream:'assistant' → data.delta（文字串流）
 *              event: 'chat' state:'final' → 結束信號
 */
async function wsConnect(gatewayId, url, apiKey) {
  // 檢查是否使用 Proxy 代理模式（httpUrl 有填且 hubUsername 有填，或 wsUrl 為空）
  const gw = await getGateway(gatewayId);
  if (gw?.httpUrl && (gw?.hubUsername || !gw?.wsUrl)) {
    console.log('[Hub] using HTTP proxy mode for', gatewayId);
    hubMode.set(gatewayId, true);
    const token = await hubLogin(gatewayId);
    if (token) {
      updateGatewayStatus(gatewayId, 'connected');
      if (!modelsFetched.get(gatewayId)) {
        modelsFetched.set(gatewayId, true);
        fetchAndStoreModels(gatewayId);
      }
      return { success: true, status: 'connected' };
    }
    updateGatewayStatus(gatewayId, 'error');
    return { success: false, error: 'Hub 登入失敗' };
  }

  // 直連 WS 模式
  hubMode.delete(gatewayId);

  if (wsConnections.has(gatewayId)) {
    const existing = wsConnections.get(gatewayId);
    if (existing.readyState === WebSocket.OPEN) {
      return { success: true, status: 'already_connected' };
    }
    existing.close();
    wsConnections.delete(gatewayId);
  }

  wsPending.set(gatewayId, new Map());

  return new Promise((resolve) => {
    let ws;
    try {
      ws = new WebSocket(url); // token 不放 URL，放 connect request
    } catch (e) {
      resolve({ success: false, error: e.message });
      return;
    }

    const timeout = setTimeout(() => {
      ws.close();
      resolve({ success: false, error: '連線逾時（15s）' });
    }, 15000);

    ws.onmessage = (event) => {
      let data;
      try { data = JSON.parse(event.data); } catch { return; }

      console.log('[WS RX]', JSON.stringify(data).slice(0, 150));

      if (data.type === 'event') {
        // connect.challenge 是 Gateway 推送的事件，完全忽略不回應
        // 認證透過 connect request 的 params.auth.token 處理（allowInsecureAuth）
        if (data.event === 'connect.challenge') return;
        dispatchWsEvent(gatewayId, data);
        return;
      }

      // Request/Response 配對（by id）
      const pending = wsPending.get(gatewayId);
      if (pending && data.id) {
        const p = pending.get(data.id);
        if (p) {
          pending.delete(data.id);
          if (data.ok !== false) p.res(data.payload ?? {});
          else p.rej(new Error(data.error?.message ?? 'Gateway error'));
        }
      }
    };

    ws.onopen = () => {
      console.log('[WS] opened', gatewayId);
      wsConnections.set(gatewayId, ws);

      // 送出 connect request
      const connectId = crypto.randomUUID();
      const pending = wsPending.get(gatewayId);
      const connectPromise = new Promise((res, rej) => {
        pending.set(connectId, { res, rej });
      });

      ws.send(JSON.stringify({
        type: 'req',
        id: connectId,
        method: 'connect',
        params: {
          minProtocol: 3, maxProtocol: 3,
          client: { id: 'openclaw-control-ui', version: '1.0', platform: 'web', mode: 'webchat' },
          role: 'operator',
          scopes: ['operator.admin'],
          auth: apiKey ? { token: apiKey } : {},
        }
      }));

      connectPromise.then(() => {
        clearTimeout(timeout);
        console.log('[WS] connect OK', gatewayId);
        updateGatewayStatus(gatewayId, 'connected');
        setupWsAlarm(gatewayId);
        if (!modelsFetched.get(gatewayId)) {
          modelsFetched.set(gatewayId, true);
          fetchAndStoreModels(gatewayId);
        }
        resolve({ success: true, status: 'connected' });
      }).catch((err) => {
        clearTimeout(timeout);
        console.log('[WS] connect FAILED', gatewayId, err.message);
        ws.close();
        resolve({ success: false, error: `Connect failed: ${err.message}` });
      });
    };

    ws.onerror = (e) => {
      clearTimeout(timeout);
      console.log('[WS] error', gatewayId, e.message || e);
      updateGatewayStatus(gatewayId, 'error');
      resolve({ success: false, error: 'WebSocket error' });
    };

    ws.onclose = (e) => {
      console.log('[WS] closed', gatewayId, e.code, e.reason);
      wsConnections.delete(gatewayId);
      // Reject 所有等待中的 requests（避免 Promise 永久懸空）
      const pending = wsPending.get(gatewayId);
      if (pending) {
        for (const p of pending.values()) p.rej(new Error('WebSocket closed'));
        pending.clear();
      }
      wsPending.delete(gatewayId);
      updateGatewayStatus(gatewayId, 'disconnected');

      // origin not allowed 等永久錯誤不重連
      if (e.reason && (e.reason.includes('origin') || e.reason.includes('not allowed'))) {
        console.log('[WS] permanent error, not reconnecting');
        return;
      }
      scheduleReconnect(gatewayId);
    };
  });
}

function dispatchWsEvent(gatewayId, data) {
  chrome.runtime.sendMessage({
    type: 'WS_MESSAGE',
    gatewayId,
    data
  }).catch(() => {});
}

async function wsDisconnect(gatewayId) {
  const ws = wsConnections.get(gatewayId);
  if (ws) {
    ws.close();
    wsConnections.delete(gatewayId);
    wsPending.delete(gatewayId);
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

async function chatSend({ gatewayId, message, model, runId, tabContext, sessionId }) {
  // Hub 代理模式
  if (hubMode.get(gatewayId)) {
    return hubChatSend({ gatewayId, message, model, runId, tabContext, sessionId });
  }

  let ws = wsConnections.get(gatewayId);
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    const { gateways } = await chrome.storage.local.get('gateways');
    const gw = gateways?.find(g => g.id === gatewayId);
    if (gw) {
      const result = await wsConnect(gatewayId, gw.wsUrl, gw.apiKey);
      if (!result.success) return { success: false, error: '無法連線至 Gateway' };
      // 如果 wsConnect 切換到了 Hub 模式
      if (hubMode.get(gatewayId)) {
        return hubChatSend({ gatewayId, message, model, runId, tabContext, sessionId });
      }
      ws = wsConnections.get(gatewayId);
    } else {
      return { success: false, error: 'Gateway 不存在' };
    }
  }

  const pending = wsPending.get(gatewayId);
  if (!pending) return { success: false, error: 'WS 未初始化' };

  const reqId = crypto.randomUUID();
  const sessionKey = sessionId ? `agent:main:${sessionId}` : `agent:main:default`;

  const chatPromise = new Promise((res, rej) => {
    pending.set(reqId, { res, rej });
    // 55 秒 timeout（Gateway 沒有回應 chat.send 時）
    setTimeout(() => {
      if (pending.has(reqId)) {
        pending.delete(reqId);
        rej(new Error('Chat request timed out'));
      }
    }, 55000);
  });

  ws.send(JSON.stringify({
    type: 'req',
    id: reqId,
    method: 'chat.send',
    params: {
      sessionKey,
      message,
      idempotencyKey: runId,
      attachments: [],
    }
  }));

  try {
    await chatPromise; // Gateway 回應 { runId, status: 'started' }
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
      const result = await wsConnect(gatewayId, gw.wsUrl, gw.apiKey);
      if (result.success) reconnectAttempts.delete(gatewayId);
    }
  }, delay);
}

// ── 連線後自動抓取 openclaw.json 並更新模型列表 ────────────────────────────────

async function fetchAndStoreModels(gatewayId) {
  const gw = await getGateway(gatewayId);
  if (!gw?.httpUrl) return;

  let json;
  try {
    const res = await fetch(`${gw.httpUrl}/openclaw.json`, {
      headers: buildHeaders(gw),
      signal: AbortSignal.timeout(8000)
    });
    if (!res.ok) return;
    json = await res.json();
  } catch (e) {
    return;
  }

  const models = [];
  const modelIdSet = new Set();

  // 從 models.providers 讀取詳細模型
  const providers = json?.models?.providers;
  if (providers) {
    for (const [providerId, providerData] of Object.entries(providers)) {
      for (const model of (providerData.models || [])) {
        const id = `${providerId}/${model.id}`;
        if (!modelIdSet.has(id)) {
          models.push({ id, name: model.name || model.id });
          modelIdSet.add(id);
        }
      }
    }
  }

  // 補充 agents.defaults.models（如 MiniMax-M2.5）
  const agentModels = json?.agents?.defaults?.models;
  if (agentModels) {
    for (const [modelId, meta] of Object.entries(agentModels)) {
      if (!modelIdSet.has(modelId)) {
        const alias = meta?.alias;
        models.push({ id: modelId, name: alias ? `${modelId} (${alias})` : modelId });
        modelIdSet.add(modelId);
      }
    }
  }

  if (models.length === 0) return;

  await chrome.storage.local.set({ importedModels: models });
  chrome.runtime.sendMessage({ type: 'MODELS_UPDATED', models }).catch(() => {});
}
