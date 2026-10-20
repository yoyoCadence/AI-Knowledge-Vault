/** Traditional Chinese UI strings (default locale, ADR-016). Keys are stable identifiers. */
export const zhTW = {
  "app.name": "AI Knowledge Vault",
  "app.tagline": "不依賴單一 AI 平台的個人知識資產庫",

  "nav.library": "知識庫",
  "nav.collections": "收藏分類",
  "nav.knowledgeMap": "知識地圖",
  "nav.aiResearch": "AI 研究",
  "nav.publicShowcase": "公開展示",
  "nav.importBackup": "匯入與備份",
  "nav.settings": "設定",
  "nav.future": "規劃中",
  "nav.openMenu": "開啟選單",
  "nav.closeMenu": "關閉選單",

  "theme.toggle": "切換深色／淺色模式",
  "theme.light": "淺色",
  "theme.dark": "深色",
  "theme.system": "跟隨系統",

  "future.badge": "尚未提供",
  "future.title": "此功能尚在規劃中",
  "future.body": "這個頁面描述的是未來階段的功能，目前沒有任何可操作的內容。實作進度請見 Roadmap。",
  "future.phase": "預計階段",
  "future.roadmap": "查看 Roadmap 說明",

  "state.loading": "載入中…",
  "state.error.title": "發生錯誤",
  "state.error.body": "請稍後再試。如果問題持續，請提供錯誤代碼以便除錯。",
  "state.error.id": "錯誤代碼",
  "state.notFound.title": "找不到頁面",
  "state.notFound.body": "這個頁面不存在，或你沒有存取權限。",
  "state.backHome": "回到知識庫",
  "state.retry": "重試",

  "library.title": "知識庫",
  "library.empty.title": "知識庫還是空的",
  "library.empty.body":
    "匯入功能完成後，你可以把 Claude Design、ChatGPT、Gemini 等工具產生的 HTML、ZIP、PDF 與 Markdown 拖曳到這裡保存。",

  "import.title": "匯入與備份",
  "settings.title": "設定",
} as const;

export type MessageKey = keyof typeof zhTW;
