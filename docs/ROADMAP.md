# Roadmap

狀態：✅ 完成且驗證 · 🚧 進行中 · 📝 未開始 · ⏸ 延後（附原因）
每個任務完成的定義（Definition of Done）：程式碼 + 測試通過 + typecheck/lint/build 通過 + 文件更新 + 合併至 `main`。
即時進度以 `task.md` 為準；本文件描述階段與驗收標準。

## Phase 0 — Foundation

| ID         | 任務                                                                                         | 狀態 |
| ---------- | -------------------------------------------------------------------------------------------- | ---- |
| P0-DOCS    | 架構審查、ADR、全部規格文件、Agent 交接文件                                                  | ✅   |
| P0-TOOLING | TypeScript strict、ESLint（含模組邊界規則）、Prettier、Vitest、Playwright                    | ✅   |
| P0-ENV     | Zod 環境變數驗證、`.env.example`                                                             | ✅   |
| P0-DB      | Drizzle client、migration runner、identity/workspace/audit/jobs schema                       | ✅   |
| P0-STORAGE | StorageAdapter 介面、Local adapter、S3/R2 adapter                                            | ✅   |
| P0-JOBS    | Postgres job queue（lease、heartbeat、retry/backoff、recovery、idempotency）+ worker process | ✅   |
| P0-SHELL   | App Shell（Sidebar、主題切換、zh-TW）、Future Feature 頁面                                   | ✅   |
| P0-CI      | GitHub Actions：lint、typecheck、unit+integration（Postgres service）、build                 | ✅   |

**Exit Criteria**：專案能啟動；TypeScript/Lint/Build 正常；Migration 可運作；核心架構文件完整；模組責任界線清楚（由 lint 規則強制）。

## Phase 1A — Preservation Core

| ID                | 任務                                                                                                 | 狀態 |
| ----------------- | ---------------------------------------------------------------------------------------------------- | ---- |
| P1A-AUTH          | Better Auth（email+password、無註冊、DB rate limit、session 管理）、`admin:create` CLI、登入/登出 UI | ✅   |
| P1A-FILES         | 不可變原始檔（內容定址、條件寫入、DB trigger）、SHA-256、下載原始檔（signed URL）                    | ✅   |
| P1A-IMPORT-API    | Import batch/item API、signed upload、complete、retry、cancel、狀態機                                | ✅   |
| P1A-IMPORT-WORKER | `import.process_item`：sniff、hash、dedupe、store、classify、extract、persist                        | ✅   |
| P1A-EXTRACT       | HTML / Claude Design / Markdown / TXT / PDF / Image 抽取；sections；語言偵測                         | ✅   |
| P1A-ZIP           | 安全 ZIP 讀取（限制、traversal、symlink、bomb）、分類 A/B/C/D、預覽檔衍生                            | ✅   |
| P1A-VERSION       | 版本比對規則、疑似重複標示                                                                           | ✅   |
| P1A-RECOVERY      | staging 清理、過期處理、reconciliation                                                               | ✅   |
| P1A-IMPORT-UI     | 拖曳/多選上傳、進度、匯入報告、重試                                                                  | ✅   |
| P1A-EXPORT        | 可攜式匯出 v1（manifest、checksums.sha256、metadata、originals、normalized）                         | ✅   |
| P1A-RESTORE       | 還原（驗證、ID mapping、衝突模式、重建、報告）+ CLI                                                  | ✅   |
| P1A-INTEGRITY     | 完整性檢查 job 與狀態                                                                                | ✅   |
| P1A-ENC           | 內建 age 加密匯出                                                                                    | 📝   |

**Exit Criteria**（Master Spec §22）：

1. 可以上傳原始 HTML。 2. 可以上傳 ZIP。 3. 可以上傳 PDF。 4. 可批次匯入 50 個合法小型測試作品。
2. 原檔可完整下載。 6. Hash 可驗證。 7. 部分失敗不影響其他項目。 8. 重試不會重複建檔。
3. 匯出檔案可重新匯入。 10. 私人檔案不可被未授權取得。
   每一條對應 `TEST_PLAN.md` 的自動化測試。

## Phase 1B — Usable Knowledge Library

| ID                | 任務                                                                          | 狀態                                                         |
| ----------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------ |
| P1B-LIBRARY       | Library 首頁（最近新增/閱讀、收藏、分類、統計、保存狀態）、Grid/List Cards    | 🚧                                                           |
| P1B-DETAIL        | Artifact Detail（版本、來源資訊、下載、metadata 編輯）                        | 🚧 標題、說明、專案可編輯（PR 14）；來源資訊、可見性編輯待做 |
| P1B-PREVIEW       | 獨立 Preview Origin、token、CSP、sandbox iframe                               | ✅                                                           |
| P1B-READER        | Reading Mode（安全 Markdown renderer、TOC、手機排版）                         | ✅                                                           |
| P1B-ORG           | Research Projects、Collections（階層）、Tags（正規化、合併）                  | 🚧 Tags ✅（PR 13）、Projects ✅（PR 14）；Collections 待做  |
| P1B-NOTES         | Notes、Reading Status、Favorites                                              | 📝                                                           |
| P1B-SEARCH        | CJK bigram 全文搜尋、篩選、排序、片段 Highlight                               | ✅（PR 12–14；筆記內容待 P1B-NOTES）                         |
| P1B-SHARE         | Share links（權限分離、到期、撤銷）、分享前檢查、公開閱讀頁                   | 📝                                                           |
| P1B-OPS           | Usage Dashboard（儲存、DB、Jobs、失敗、最後完整性檢查）                       | 📝                                                           |
| P1B-E2E           | E2E：登入、批次上傳、進度、開啟作品、搜尋、改分類、筆記、分享、撤銷、匯出還原 | 📝                                                           |
| P1B-VERSION-SPLIT | 將誤判的版本拆成獨立作品                                                      | 📝                                                           |

**Exit Criteria**：可瀏覽、可搜尋內文、繁中搜尋有效、可閱讀原始內容或安全替代預覽、桌面與手機可用、未登入無法取得 Private、可公開與撤銷分享、主要功能通過 E2E。

## Phase 2 — AI Knowledge Retrieval（設計見 `AI_RESEARCH.md`）

P2-PROVIDERS（Adapter：Anthropic/OpenAI/Gemini/OpenAI-compatible）、P2-EMBED（pgvector embeddings per chunk）、P2-HYBRID、P2-RAG（引用驗證、拒答）、P2-COST（usage、預算上限）、P2-PRIVACY（敏感性閘門、外傳提示）、P2-SEARCH-OPENCC（簡繁正規化）。

**Exit Criteria**：跨文章概念搜尋；回答附實際來源；證據不足時拒絕編造；Provider 可替換；無 AI Key 時原功能不受影響。

## Phase 3 — Knowledge Intelligence

P3-TOPICS、P3-GRAPH、P3-CLAIMS、P3-CONTRADICTION、P3-DUPLICATE-RESEARCH、P3-COVERAGE、P3-GAPS、P3-SUGGESTIONS、P3-PROMPT-GEN、P3-PREVIEW-RUNTIME（受控互動預覽：vendored dc-runtime）、P3-TRUSTED-BUILD（隔離建置沙箱）。

**Exit Criteria**：每個 AI 建議有理由；缺口評分可解釋；AI 關聯可人工確認；不把 AI 猜測當已證實知識。

## Phase 4 — Evolution & Automation

Multi-model handoff、Research Context Export、自動重新分析、Knowledge Change Tracking、排程維護（定期匯出/完整性檢查）、Browser Extension、Git Import、Advanced Public Showcase。
