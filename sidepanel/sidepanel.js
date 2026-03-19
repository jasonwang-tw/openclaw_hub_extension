/**
 * OpenClaw Hub - Side Panel Script
 */

// ── 狀態 ─────────────────────────────────────────────────────────────────────
let activeGateway = null;
let activeChatId = null;
let chatSessions = [];
let tabContextData = null;
let isStreaming = false;
let currentStreamBubble = null;

// ── 初始化 ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', async () => {
  lucide.createIcons();
  await loadState();
  bindEvents();
  listenBackground();
});

async function loadState() {
  const data = await chrome.storage.local.get([
    'gateways', 'activeGatewayId', 'chatSessions', 'activeChatId', 'settings', 'importedModels'
  ]);

  chatSessions = data.chatSessions || [];
  activeChatId = data.activeChatId;

  // 套用主題
  if (data.settings?.theme === 'light') {
    document.body.classList.replace('dark', 'light');
  }

  // 載入模型列表（優先使用匯入的模型）
  const sel = document.getElementById('modelSelect');
  if (data.importedModels?.length) {
    sel.innerHTML = data.importedModels.map(m =>
      `<option value="${escHtml(m.id)}">${escHtml(m.name)}</option>`
    ).join('');
  }

  // 套用預設 model
  if (data.settings?.defaultModel) {
    sel.value = data.settings.defaultModel;
  }

  const gateways = data.gateways || [];
  const activeId = data.activeGatewayId;
  activeGateway = gateways.find(g => g.id === activeId) || gateways[0] || null;

  if (!activeGateway) {
    showNoGateway(true);
    return;
  }

  showNoGateway(false);
  document.getElementById('gatewayName').textContent = activeGateway.name;

  // 確認 WS 連線
  await connectGateway();

  // 載入聊天
  if (!activeChatId) {
    createNewSession();
  } else {
    renderCurrentSession();
  }
}

async function connectGateway() {
  if (!activeGateway) return;
  setStatus('connecting');
  const result = await bgMsg({
    type: 'WS_CONNECT',
    gatewayId: activeGateway.id,
    url: activeGateway.wsUrl,
    apiKey: activeGateway.apiKey
  });
  setStatus(result.success ? 'connected' : 'error');
}

// ── UI 控制 ──────────────────────────────────────────────────────────────────

function showNoGateway(show) {
  document.getElementById('noGateway').style.display = show ? 'flex' : 'none';
  document.getElementById('chatMain').style.display = show ? 'none' : 'flex';
  document.querySelector('.input-area').style.display = show ? 'none' : 'flex';
}

function setStatus(status) {
  const dot = document.getElementById('statusDot');
  dot.className = `status-dot ${status}`;
}

// ── 事件綁定 ─────────────────────────────────────────────────────────────────

function bindEvents() {
  // 傳送訊息
  document.getElementById('sendBtn').addEventListener('click', sendMessage);
  document.getElementById('messageInput').addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  // 自動調整高度
  document.getElementById('messageInput').addEventListener('input', autoResizeTextarea);

  // 新對話
  document.getElementById('btnNewChat').addEventListener('click', createNewSession);

  // 歷史紀錄
  document.getElementById('btnHistory').addEventListener('click', toggleHistory);
  document.getElementById('btnCloseHistory').addEventListener('click', toggleHistory);

  // Tab 內容
  document.getElementById('btnTabContext').addEventListener('click', captureTabContext);
  document.getElementById('btnRemoveContext').addEventListener('click', removeTabContext);

  // 設定
  document.getElementById('btnOptions').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // 無 Gateway 前往設定
  document.getElementById('btnGoOptions').addEventListener('click', () => {
    chrome.runtime.openOptionsPage();
  });

  // Model 切換
  document.getElementById('modelSelect').addEventListener('change', async (e) => {
    const { settings = {} } = await chrome.storage.local.get('settings');
    settings.defaultModel = e.target.value;
    await chrome.storage.local.set({ settings });
  });

  // 重新載入模型按鈕
  document.getElementById('btnRefreshModels').addEventListener('click', async () => {
    const { importedModels } = await chrome.storage.local.get('importedModels');
    if (!importedModels?.length) {
      chrome.runtime.openOptionsPage();
      return;
    }
    const sel = document.getElementById('modelSelect');
    const current = sel.value;
    sel.innerHTML = importedModels.map(m =>
      `<option value="${m.id}">${m.name}</option>`
    ).join('');
    if ([...sel.options].some(o => o.value === current)) sel.value = current;
  });
}

function autoResizeTextarea() {
  const ta = document.getElementById('messageInput');
  ta.style.height = 'auto';
  ta.style.height = Math.min(ta.scrollHeight, 120) + 'px';
}

// ── 傳送訊息 ─────────────────────────────────────────────────────────────────

async function sendMessage() {
  const input = document.getElementById('messageInput');
  const text = input.value.trim();
  if (!text || isStreaming) return;
  if (!activeGateway) return;

  // 斜線指令
  if (text.startsWith('/new')) {
    input.value = '';
    createNewSession();
    return;
  }

  const model = document.getElementById('modelSelect').value;
  const runId = crypto.randomUUID();

  // 清空輸入
  input.value = '';
  input.style.height = 'auto';

  // 顯示使用者訊息
  appendMessage('user', text);

  // 建立助理訊息 bubble
  currentStreamBubble = appendMessage('assistant', '', true);
  isStreaming = true;
  document.getElementById('sendBtn').disabled = true;

  // 儲存到 session
  addToSession({ role: 'user', content: text });

  // 傳送至 background
  const result = await bgMsg({
    type: 'CHAT_SEND',
    gatewayId: activeGateway.id,
    message: text,
    model,
    runId,
    sessionId: activeChatId,
    tabContext: tabContextData
  });

  if (!result.success) {
    currentStreamBubble.classList.remove('streaming-cursor');
    currentStreamBubble.textContent = `${result.error}`;
    currentStreamBubble.classList.add('error');
    finishStreaming();
  }
}

function finishStreaming() {
  isStreaming = false;
  document.getElementById('sendBtn').disabled = false;
  if (currentStreamBubble) {
    currentStreamBubble.classList.remove('streaming-cursor');
    const content = currentStreamBubble.textContent;
    addToSession({ role: 'assistant', content });
    saveSession();
    currentStreamBubble = null;
  }
}

// ── 背景訊息監聽 ─────────────────────────────────────────────────────────────

function listenBackground() {
  chrome.runtime.onMessage.addListener((message) => {
    if (message.type === 'WS_MESSAGE') {
      handleWsMessage(message.data);
    } else if (message.type === 'GATEWAY_STATUS_CHANGED') {
      if (activeGateway && message.gatewayId === activeGateway.id) {
        setStatus(message.status === 'connected' ? 'connected' : 'error');
      }
    } else if (message.type === 'INJECT_TEXT') {
      document.getElementById('messageInput').value = message.text;
      autoResizeTextarea();
      document.getElementById('messageInput').focus();
    } else if (message.type === 'MODELS_UPDATED') {
      const sel = document.getElementById('modelSelect');
      const current = sel.value;
      sel.innerHTML = message.models.map(m =>
        `<option value="${escHtml(m.id)}">${escHtml(m.name)}</option>`
      ).join('');
      if ([...sel.options].some(o => o.value === current)) sel.value = current;
    }
  });
}

function handleWsMessage(data) {
  if (!currentStreamBubble) return;

  // OpenClaw Gateway 事件格式：{ type:'event', event:'...', payload:{...} }
  if (data.type === 'event') {
    const p = data.payload || {};

    // 文字串流：event="agent", stream="assistant", data.delta
    if (data.event === 'agent' && p.stream === 'assistant') {
      const delta = String(p.data?.delta || '');
      if (delta) {
        currentStreamBubble.textContent += delta;
        scrollToBottom();
      }
    }

    // Agent 錯誤：event="agent", stream="lifecycle", data.phase="error"
    if (data.event === 'agent' && p.stream === 'lifecycle' && p.data?.phase === 'error') {
      if (!currentStreamBubble.textContent) {
        currentStreamBubble.textContent = '⚠️ Agent 發生錯誤';
      }
      finishStreaming();
    }

    // 最終結束信號：event="chat", state="final"
    if (data.event === 'chat' && p.state === 'final') {
      // 若串流沒有內容，從 final message 取得
      if (!currentStreamBubble.textContent) {
        const content = p.message?.content;
        const text = Array.isArray(content) ? String(content[0]?.text || '') : '';
        if (text) currentStreamBubble.textContent = text;
      }
      finishStreaming();
    }

    return;
  }

  // 舊格式 fallback（保留相容性）
  if (data.type === 'delta') {
    const chunk = data.delta?.text || data.text || data.content || '';
    currentStreamBubble.textContent += chunk;
    scrollToBottom();
  } else if (data.type === 'done') {
    finishStreaming();
  } else if (data.type === 'error') {
    currentStreamBubble.textContent = `${data.message || '發生錯誤'}`;
    finishStreaming();
  }
}

// ── 訊息渲染 ─────────────────────────────────────────────────────────────────

function appendMessage(role, content, streaming = false) {
  const messages = document.getElementById('messages');

  // 移除 welcome
  const welcome = messages.querySelector('.welcome-msg');
  if (welcome) welcome.remove();

  const wrap = document.createElement('div');
  wrap.className = `message ${role}`;

  const bubble = document.createElement('div');
  bubble.className = 'message-bubble' + (streaming ? ' streaming-cursor' : '');
  bubble.textContent = content;

  const meta = document.createElement('div');
  meta.className = 'message-meta';
  meta.textContent = formatTime(new Date());

  wrap.appendChild(bubble);
  wrap.appendChild(meta);
  messages.appendChild(wrap);

  scrollToBottom();
  return bubble;
}

function scrollToBottom() {
  const main = document.getElementById('chatMain');
  main.scrollTop = main.scrollHeight;
}

function formatTime(date) {
  return date.toLocaleTimeString('zh-TW', { hour: '2-digit', minute: '2-digit' });
}

// ── Session 管理 ─────────────────────────────────────────────────────────────

function createNewSession() {
  const id = crypto.randomUUID();
  const session = {
    id,
    gatewayId: activeGateway?.id,
    title: '新對話',
    messages: [],
    createdAt: new Date().toISOString()
  };
  chatSessions.unshift(session);
  activeChatId = id;
  saveSession();

  // 清空 UI
  const messages = document.getElementById('messages');
  messages.innerHTML = `
    <div class="welcome-msg">
      <div class="welcome-icon"><img src="../icons/icon128.png" width="52" height="52" alt="OpenClaw Hub"></div>
      <p>OpenClaw Hub 已連線</p>
      <p class="welcome-sub">輸入訊息開始對話，或使用 <kbd>/</kbd> 呼叫指令</p>
    </div>
  `;
}

function renderCurrentSession() {
  const session = chatSessions.find(s => s.id === activeChatId);
  if (!session || session.messages.length === 0) return;

  const messages = document.getElementById('messages');
  messages.innerHTML = '';

  session.messages.forEach(m => appendMessage(m.role, m.content));
}

function addToSession(message) {
  const session = chatSessions.find(s => s.id === activeChatId);
  if (!session) return;
  session.messages.push({ ...message, timestamp: new Date().toISOString() });

  // 自動更新標題（取首條使用者訊息前 20 字）
  if (session.title === '新對話' && message.role === 'user') {
    session.title = message.content.slice(0, 20) + (message.content.length > 20 ? '…' : '');
  }
}

async function saveSession() {
  await chrome.storage.local.set({ chatSessions, activeChatId });
}

// ── 歷史紀錄 ─────────────────────────────────────────────────────────────────

function toggleHistory() {
  const panel = document.getElementById('historyPanel');
  const isVisible = panel.style.display !== 'none';

  if (!isVisible) {
    renderHistory();
  }

  panel.style.display = isVisible ? 'none' : 'flex';
}

function renderHistory() {
  const list = document.getElementById('historyList');
  list.innerHTML = '';

  chatSessions.forEach(session => {
    const item = document.createElement('div');
    item.className = 'history-item' + (session.id === activeChatId ? ' active' : '');

    item.innerHTML = `
      <div class="history-item-title">${escHtml(session.title)}</div>
      <div class="history-item-date">${formatDate(session.createdAt)}</div>
    `;

    item.addEventListener('click', () => {
      activeChatId = session.id;
      saveSession();
      renderCurrentSession();
      toggleHistory();
    });

    list.appendChild(item);
  });

  if (chatSessions.length === 0) {
    list.innerHTML = '<div style="padding:16px;text-align:center;color:var(--text3);font-size:12px">尚無對話紀錄</div>';
  }
}

function formatDate(isoStr) {
  const d = new Date(isoStr);
  return d.toLocaleDateString('zh-TW', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}

function escHtml(str) {
  return String(str).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

// ── Tab 頁面內容擷取 ──────────────────────────────────────────────────────────

async function captureTabContext() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;

  const result = await bgMsg({ type: 'GET_TAB_CONTENT', tabId: tab.id });
  if (!result.success) {
    alert('無法擷取頁面內容：' + result.error);
    return;
  }

  tabContextData = result.content;
  const bar = document.getElementById('tabContextBar');
  document.getElementById('tabContextTitle').textContent = `${result.content.title}`;
  bar.style.display = 'flex';
}

function removeTabContext() {
  tabContextData = null;
  document.getElementById('tabContextBar').style.display = 'none';
}

// ── 工具函式 ──────────────────────────────────────────────────────────────────

function bgMsg(message) {
  return chrome.runtime.sendMessage(message).catch(err => ({
    success: false,
    error: err.message
  }));
}
