# OpenClaw Hub Chrome Extension

> OpenClaw Gateway 管理控制台 Chrome 擴充功能

**版本：1.0.0**

## 功能特色

相較於競品 [OpenClaw Copilot](https://chromewebstore.google.com/detail/openclaw-copilot/bfpnaggikhabdgbnhnngdfldkbinncdf)，本擴充功能提供更完整的功能：

| 功能 | OpenClaw Hub | OpenClaw Copilot |
|------|:---:|:---:|
| Side Panel 側邊欄聊天 | ✅ | ✅ |
| Tab 頁面內容擷取 | ✅ | ✅ |
| WebSocket Gateway 連線 | ✅ | ✅ |
| **多 Gateway 管理** | ✅ | ❌ |
| **Skills 市場（安裝/移除）** | ✅ | ❌ |
| **用量統計圖表** | ✅ | ❌ |
| **多對話 Session 管理** | ✅ | ❌ |
| **深色/淺色主題** | ✅ | ❌ |
| 斷線自動重連 | ✅ | ❌ |

## 安裝方式

### 1. 產生圖示

```bash
node scripts/create_icons.js
```

### 2. 載入至 Chrome

1. 開啟 `chrome://extensions/`
2. 開啟右上角「開發人員模式」
3. 點擊「載入未封裝項目」
4. 選擇此資料夾 `openclaw_hub_extension/`

## 使用說明

### 基本設定

1. 點擊 Chrome 工具列的 🦞 圖示開啟側邊欄
2. 點擊 ⚙️ 前往設定頁面
3. 在「Gateway」分頁新增你的 OpenClaw Gateway：
   - **WebSocket URL**：`ws://127.0.0.1:18789`（預設）
   - **HTTP URL**：`http://127.0.0.1:18789`

### 聊天功能

- 點擊 📄 擷取當前頁面內容附加至訊息
- 使用 `/new` 開始新對話
- 點擊 📋 查看對話歷史
- Enter 傳送，Shift+Enter 換行

### Skills 管理

在設定頁面 → Skills 分頁：
- **已安裝**：查看已安裝的 Skills，可移除
- **市場**：從 [openclaw/clawhub](https://github.com/openclaw/clawhub) 瀏覽並安裝

## 專案結構

```
openclaw_hub_extension/
├── manifest.json          # MV3 設定檔
├── background.js          # Service Worker（WS 管理、訊息路由）
├── sidepanel/
│   ├── sidepanel.html     # 側邊欄 UI
│   ├── sidepanel.js       # 聊天邏輯
│   └── sidepanel.css      # 樣式（深色主題）
├── options/
│   ├── options.html       # 設定頁面
│   ├── options.js         # Gateway / Skills / Usage / Settings
│   └── options.css        # 設定頁面樣式
├── icons/                 # 圖示（執行 create_icons.js 產生）
├── scripts/
│   └── create_icons.js    # 純 Node.js 圖示產生器
└── package.json
```

## 技術架構

- **Manifest V3**（MV3）Chrome Extension
- **Vanilla JS**（無框架，無建置步驟）
- **Background Service Worker** 管理 WebSocket 連線池
- **chrome.sidePanel API** 側邊欄 UI
- **chrome.storage.local** 取代 Prisma/SQLite
- **WebSocket keepalive** 透過 chrome.alarms（每 25 秒 ping）
- **指數退避重連**（最多 5 次，最長 30 秒間隔）

## Changelog

## [1.0.0] - 2026-03-16
### Added
- 初始版本：由 openclaw_hub Next.js 專案改寫為 Chrome Extension
- Side Panel 側邊欄聊天介面
- 多 Gateway 管理（CRUD + 健康檢查）
- Skills 市場（從 GitHub clawhub 瀏覽/安裝）
- 用量統計圖表（依模型分類、每日趨勢）
- Tab 頁面內容擷取傳入對話
- 多 Session 對話歷史
- 深色/淺色主題切換
- 斷線自動重連（指數退避）
- WS Keepalive（chrome.alarms）
