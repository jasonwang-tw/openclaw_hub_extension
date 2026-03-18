# OpenClaw Hub Extension

OpenClaw Gateway 管理控制台 Chrome 擴充功能，提供側邊欄聊天、多 Gateway 管理、Skills 市場與用量追蹤。

## 版本

**目前版本：1.1.0**

## 安裝 / 使用方式

```bash
# 1. 產生圖示
node scripts/create_icons.js

# 2. 開啟 chrome://extensions/
# 3. 開啟「開發人員模式」
# 4. 點擊「載入未封裝項目」→ 選擇此資料夾
```

## 功能說明

| 功能 | 說明 |
|------|------|
| Side Panel 聊天 | 側邊欄 WebSocket 串流對話，可附加頁面內容 |
| 多 Gateway 管理 | CRUD + 健康檢查 + 測試連線 |
| Skills 市場 | 從 openclaw/clawhub 瀏覽並安裝 |
| 用量統計 | 依模型分類、每日趨勢 SVG 圖表 |
| 多 Session 歷史 | 對話記錄管理 |
| 深色/淺色主題 | 可切換 |

相較競品 [OpenClaw Copilot](https://chromewebstore.google.com/detail/openclaw-copilot/bfpnaggikhabdgbnhnngdfldkbinncdf)，額外提供多 Gateway 管理、Skills 市場、用量圖表、多 Session 歷史。

## Changelog

## [1.1.0] - 2026-03-18
### Changed
- 插件圖示（icon16/48/128.png）重新設計為三道爪痕斜線風格，符合 Chrome 插件 icon 規範
- 介面 emoji 全數替換為 Lucide icons（link / puzzle / bar-chart-2 / settings / file-text / square-pen / clock / zap / refresh-cw / triangle-alert / globe）
- 品牌 logo（🦞）改用插件圖示 PNG，統一視覺識別
- 新增 `lib/lucide.min.js` 本地化（符合 MV3 CSP `script-src 'self'` 限制）
- `package.json` 新增 `lib` 腳本與更新 `pack` 指令含 lib 資料夾

## [1.0.0] - 2026-03-16
### Added
- 初始版本：由 openclaw_hub Next.js 專案改寫為 Chrome Extension (MV3)
- Side Panel 側邊欄聊天介面（含串流、Tab 頁面擷取、Session 歷史）
- Background Service Worker WebSocket 連線池（keepalive + 指數退避重連）
- 多 Gateway 管理（CRUD、健康檢查、測試連線）
- Skills 市場（從 GitHub clawhub 瀏覽 / 安裝 / 移除）
- 用量統計圖表（依模型分類、每日 SVG 趨勢圖）
- 深色 / 淺色主題切換
