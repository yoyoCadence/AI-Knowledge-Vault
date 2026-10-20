# AI Knowledge Vault — Product Specification（產品規格）

> 本文件是 Master Specification 的結構化版本，是需求的唯一真實來源（single source of truth）。
> 需求以 ID 標示（FR = Functional Requirement，NFR = Non-functional Requirement），
> 供 Roadmap、Test Plan 與程式碼註解追溯。架構層面的取捨見 `ARCHITECTURE_REVIEW.md` 與 `DECISIONS.md`。

## 1. Product Vision

**AI-independent, Portable, Searchable, Verifiable and Continuously Evolving Personal Knowledge System.**
不依賴單一 AI 平台、資料可攜、全文可搜尋、重要結論可追溯來源，並能持續分析與演化的個人知識系統。

### 1.1 問題

- Claude Design 等工具的成果是 HTML 或完整 ZIP 專案，分散在不同 AI 帳號、對話與本機資料夾。
- 缺少統一的分類、搜尋、閱讀介面，無法建立研究之間的關聯。
- 研究可能重複或互相矛盾，也看不出尚未研究的重要領域。
- 單一 AI 平台可能關閉、停權或改變政策；生成作品常缺少 Prompt、研究過程與來源。

### 1.2 五大核心能力

| 代號 | 能力         | 說明                                         | 首次交付    |
| ---- | ------------ | -------------------------------------------- | ----------- |
| A    | Archive      | 保存原始研究成果與必要背景資料               | Phase 1A    |
| B    | Library      | 分類、閱讀、搜尋、收藏、版本、分享           | Phase 1B    |
| C    | Intelligence | 跨文章問答、語意搜尋、關聯、矛盾與重複偵測   | Phase 2–3   |
| D    | Discovery    | 覆蓋程度、知識缺口、被忽略的假設、跨領域機會 | Phase 3     |
| E    | Portability  | 完整匯出、獨立備份、還原、跨 AI 模型使用     | Phase 1A 起 |

### 1.3 不可妥協的產品原則（Product Principles）

| ID   | 原則                                     | 如何落實                                                                       |
| ---- | ---------------------------------------- | ------------------------------------------------------------------------------ |
| P-1  | 原始檔案不可因解析、分類或 AI 分析被覆寫 | 內容定址 storage key、條件式寫入、DB trigger 禁止修改 `file_assets` 不可變欄位 |
| P-2  | AI 不是閱讀與保存的必要條件              | Phase 1 完全沒有 AI 依賴；AI 模組在沒有 API Key 時停用                         |
| P-3  | 使用者擁有全部資料                       | 可攜式匯出格式（不依賴本系統即可解讀）                                         |
| P-4  | 預設 Private                             | `artifacts.visibility` 預設 `private`                                          |
| P-5  | 公開分享必須由使用者主動授權             | 分享需明確操作與確認；安全檢查只是輔助                                         |
| P-6  | AI 結論與原始資料、驗證事實區分          | 資料模型區分 source type（Phase 2+）                                           |
| P-7  | 逐階段增加功能但不破壞既有資料           | 只用版本化 migration；extraction 可重跑                                        |
| P-8  | 可驗證的備份與還原                       | 自動化 export → restore 測試                                                   |
| P-9  | 不產生新的單點依賴                       | 所有外部服務走 adapter；備份到獨立目的地                                       |
| P-10 | 避免過度工程化                           | Modular monolith、Postgres job queue、無獨立向量資料庫                         |

## 2. Personas

- **Owner / Admin（現階段唯一使用者）**：大量使用 Claude、ChatGPT、Gemini 產生研究；需要跨裝置私人知識庫、批次匯入歷史作品、偶爾公開分享單篇作品。
- **Link Viewer**：透過分享連結閱讀單篇作品的訪客，不需登入，只能看到被授權的內容。
- **Future Collaborator**：未來共享 workspace 的協作者（資料模型保留 workspace 邊界，MVP 不實作）。
- **Successor Agent**：接手開發的 AI Agent 或工程師，只依賴 repo 內文件即可工作。

## 3. Scope

### 3.1 In scope（依 Phase）

見 `ROADMAP.md`。Phase 0、1A、1B 為 MVP。

### 3.2 Out of scope（初期非目標）

社群功能（留言、按讚）、付費訂閱、多人即時共同編輯、爬取 AI 平台私人聊天、執行 ZIP 中任意程式、自動發佈到社群平台、訓練自有 LLM、獨立向量資料庫叢集、完整 SaaS 多租戶與計費。

## 4. Functional Requirements

### 4.1 Auth & Access（FR-AUTH）

| ID        | 需求                                                                  | Phase  |
| --------- | --------------------------------------------------------------------- | ------ |
| FR-AUTH-1 | Email + Password 登入；無公開註冊；初始管理者經伺服器端 CLI 建立      | 1A     |
| FR-AUTH-2 | Session 使用 HttpOnly、Secure（正式環境）、SameSite=Lax Cookie        | 1A     |
| FR-AUTH-3 | 登入嘗試限制（rate limiting），跨 instance 有效                       | 1A     |
| FR-AUTH-4 | 登出；撤銷其他裝置 Session                                            | 1A     |
| FR-AUTH-5 | 每個 API 皆在 server 端驗證身分與 object-level 權限（workspace 邊界） | 1A     |
| FR-AUTH-6 | Passkey、MFA、OAuth（可選，不得成為唯一登入方式）                     | Future |

### 4.2 Import（FR-IMP）

| ID        | 需求                                                                  | Phase                   |
| --------- | --------------------------------------------------------------------- | ----------------------- |
| FR-IMP-1  | 支援 HTML、ZIP、PDF、Markdown、TXT、PNG/JPG/WEBP                      | 1A                      |
| FR-IMP-2  | 單檔、多檔拖曳、多檔選取、批次上傳，顯示上傳進度                      | 1A（API）/1B（完整 UI） |
| FR-IMP-3  | 匯入時可指定 Research Project / Collection                            | 1A                      |
| FR-IMP-4  | 至少 50 個合法小型作品的批次匯入；有界併發                            | 1A                      |
| FR-IMP-5  | 部分成功、部分失敗；單一錯誤不使整批失敗                              | 1A                      |
| FR-IMP-6  | 重試失敗項目；重試不產生重複資料                                      | 1A                      |
| FR-IMP-7  | 相同 Hash → 不建立新版本，回報既有作品                                | 1A                      |
| FR-IMP-8  | 相同作品新版本 → 依確定性規則建立新 Version                           | 1A                      |
| FR-IMP-9  | 疑似重複內容 → 只標示「疑似」，不自動合併                             | 1A                      |
| FR-IMP-10 | 匯入報告：每個項目的結果、原因與錯誤細節（非 "Something went wrong"） | 1A                      |
| FR-IMP-11 | 已上傳但未完成處理的檔案可恢復；過期 staging 檔案安全清理             | 1A                      |
| FR-IMP-12 | DOCX、PPTX、EPUB、Git、URL Import、Browser Extension                  | Future                  |

### 4.3 Preservation & Files（FR-FILE）

| ID        | 需求                                                 | Phase |
| --------- | ---------------------------------------------------- | ----- |
| FR-FILE-1 | 原始檔 Immutable；保存 SHA-256、大小、MIME、原始檔名 | 1A    |
| FR-FILE-2 | 原始檔可完整下載；下載內容 Hash 可驗證               | 1A    |
| FR-FILE-3 | 定期完整性檢查（重新計算 Hash 比對）                 | 1A    |
| FR-FILE-4 | 刪除作品不得誤刪仍被引用的 File Asset                | 1A    |

### 4.4 Preview（FR-PRV）

| ID       | 需求                                                                                            | Phase    |
| -------- | ----------------------------------------------------------------------------------------------- | -------- |
| FR-PRV-1 | 匯入時分類 Type A（Static HTML）/B（Static Website ZIP）/C（Framework Source）/D（Unsupported） | 1A       |
| FR-PRV-2 | 安全預覽：獨立 Origin、iframe sandbox、嚴格 CSP、不執行不可信 JS                                | 1B       |
| FR-PRV-3 | Type C 顯示 Build Required，可下載原始專案，可附加封面                                          | 1B       |
| FR-PRV-4 | Claude Design 匯出（`.dc.html` + `support.js`）辨識與縮圖擷取                                   | 1A       |
| FR-PRV-5 | 隔離建置（Trusted Build Sandbox）                                                               | Phase 3+ |

### 4.5 Library & Reading（FR-LIB）

| ID       | 需求                                                                                                           | Phase               |
| -------- | -------------------------------------------------------------------------------------------------------------- | ------------------- |
| FR-LIB-1 | Library 首頁：搜尋框、最近新增、最近閱讀、收藏、分類、作品數、保存狀態、匯入入口                               | 1B                  |
| FR-LIB-2 | Artifact Card（縮圖、標題、摘要、分類、標籤、來源模型、日期、閱讀狀態、可見性），Grid/List                     | 1B                  |
| FR-LIB-3 | Artifact Detail：預覽、閱讀模式、目錄、標籤、專案、版本、筆記、來源資訊、下載、分享設定                        | 1B                  |
| FR-LIB-4 | Reading Mode 來自 Extracted Content（不顯示未處理 HTML），手機友善                                             | 1B                  |
| FR-LIB-5 | Collections（階層分類 + 自訂集合，一作品可屬多集合）                                                           | 1B                  |
| FR-LIB-6 | Tags（多標籤、搜尋、合併、大小寫/全半形正規化避免重複）                                                        | 1B                  |
| FR-LIB-7 | Source Metadata（平台、模型、Prompt、URL、研究日期、作者、參考來源、變更摘要、審閱狀態），允許 Unknown，不硬猜 | 1A（資料）/1B（UI） |
| FR-LIB-8 | Notes 與 Reading Status（未讀/閱讀中/已讀）、收藏                                                              | 1B                  |
| FR-LIB-9 | Visibility（public/unlisted/private）與 Sensitivity（normal/sensitive/restricted）為獨立維度                   | 1A（資料）/1B（UI） |

### 4.6 Search（FR-SRCH）

| ID        | 需求                                                       | Phase |
| --------- | ---------------------------------------------------------- | ----- |
| FR-SRCH-1 | 全文搜尋：標題、描述、標籤、正文、筆記                     | 1B    |
| FR-SRCH-2 | 繁體中文與英文；部分關鍵字；以實際繁中測試驗證             | 1B    |
| FR-SRCH-3 | 篩選（分類、日期、來源模型）、排序、片段、關鍵字 Highlight | 1B    |
| FR-SRCH-4 | 搜尋一律套用權限；私人內容不出現在公開 API                 | 1B    |
| FR-SRCH-5 | Semantic Search（chunk embeddings）與 Hybrid Search        | 2     |

### 4.7 Sharing（FR-SHR）

| ID       | 需求                                                                                     | Phase |
| -------- | ---------------------------------------------------------------------------------------- | ----- |
| FR-SHR-1 | 隨機不可猜測、可撤銷、可設定到期日、可多個的分享連結                                     | 1B    |
| FR-SHR-2 | 權限分離：Read Preview / Read Extracted Content / Download Original（預設不允許下載）    | 1B    |
| FR-SHR-3 | 公開前輔助檢查（疑似 API Key、敏感字、私有 URL、非預期附件、外部資源），最終由使用者確認 | 1B    |
| FR-SHR-4 | Unlisted 不進 sitemap、`noindex`；UI 說明「擁有連結的人可轉發」                          | 1B    |
| FR-SHR-5 | Public Showcase                                                                          | 4     |

### 4.8 Backup / Export / Restore（FR-BAK）

| ID       | 需求                                                                               | Phase                           |
| -------- | ---------------------------------------------------------------------------------- | ------------------------------- |
| FR-BAK-1 | 可攜式匯出（manifest、schema version、originals、normalized、metadata、checksums） | 1A                              |
| FR-BAK-2 | 匯出不包含密碼雜湊、Session、Secrets、有效分享 token                               | 1A                              |
| FR-BAK-3 | 還原：格式檢查、完整性驗證、ID mapping、衝突處理、重建索引、Restore Report         | 1A                              |
| FR-BAK-4 | 自動化 export → restore 測試                                                       | 1A                              |
| FR-BAK-5 | 加密匯出（age 格式），金鑰不放在同一封存                                           | 1A-ENC（見 Roadmap）            |
| FR-BAK-6 | 獨立備份目的地與排程（3-2-1）                                                      | 1A（文件/腳本）/4（自動化排程） |

### 4.9 AI & Knowledge（FR-AI, FR-KN）— Phase 2+

設計見 `AI_RESEARCH.md`。重點：Provider Adapter、權限過濾的 RAG、可驗證引用、證據不足時拒答、Prompt Injection 防禦、敏感性控制、成本追蹤；Knowledge Topics/Edges/Claims、可解釋的覆蓋率與缺口評分、人工確認 AI 推論、研究 Prompt 產生器。

### 4.10 Operations（FR-OPS）

| ID       | 需求                                                                        | Phase               |
| -------- | --------------------------------------------------------------------------- | ------------------- |
| FR-OPS-1 | Structured logging、Error ID、Job 狀態、匯入失敗細節                        | 0/1A                |
| FR-OPS-2 | Usage Dashboard（儲存、DB 大小、Job 數、失敗 Job；AI Token/成本於 Phase 2） | 1B                  |
| FR-OPS-3 | 備份狀態與最後一次成功的完整性檢查時間                                      | 1A（資料）/1B（UI） |

## 5. Non-functional Requirements

| ID            | 類別            | 需求                                                                                                                  |
| ------------- | --------------- | --------------------------------------------------------------------------------------------------------------------- |
| NFR-SEC-1     | Security        | 所有 mutating API：Authentication、Authorization、Validation（Zod）、Structured Errors、正確 Status Code、Audit Event |
| NFR-SEC-2     | Security        | CSRF 防護（Origin / Sec-Fetch-Site 檢查 + SameSite Cookie）                                                           |
| NFR-SEC-3     | Security        | R2 Bucket 私有；Signed URL 短效且限定物件與操作                                                                       |
| NFR-SEC-4     | Security        | Log 不含密碼、API Key、Session Token、完整私人內容                                                                    |
| NFR-SEC-5     | Security        | ZIP：Zip Slip、Zip Bomb、Symlink、Entry 數、總量、深度、巢狀封存、時間限制                                            |
| NFR-PRIV-1    | Privacy         | Restricted 內容不預設送往外部 AI Provider                                                                             |
| NFR-REL-1     | Reliability     | Job 持久化、lease/timeout/recovery、retry with backoff、idempotency                                                   |
| NFR-REL-2     | Reliability     | 正式環境不得默默使用暫存磁碟                                                                                          |
| NFR-PERF-1    | Performance     | 1,000 份作品時 Library 首頁 < 1s（伺服器端）、搜尋 p95 < 500ms                                                        |
| NFR-PERF-2    | Scale           | 資料結構可擴充至數萬份作品不需重新設計（分頁、索引、chunk-level search）                                              |
| NFR-COST-1    | Cost            | 無昂貴 SaaS 依賴；AI 分析需快取、增量、可設定預算                                                                     |
| NFR-UX-1      | UX              | 繁體中文預設、i18n-ready、RWD、Dark/Light、無障礙、清楚的 loading/empty/error 狀態                                    |
| NFR-UX-2      | UX              | 禁止假按鈕、假資料、假 AI 結論；未完成功能明確標示 Future                                                             |
| NFR-MAINT-1   | Maintainability | 模組邊界清楚；UI 不直接查 DB 或操作 Storage                                                                           |
| NFR-HANDOFF-1 | Handoff         | `active-plan.md`、`task.md`、`docs/HANDOFF.md` 隨時反映真實狀態                                                       |

## 6. User Stories & Acceptance Criteria（MVP）

### US-1 批次保存 Claude Design 作品（Scenario A）

作為擁有者，我下載 20 個 HTML/ZIP，一次拖曳上傳。

- AC-1.1 每個檔案有獨立狀態：等待上傳、處理中、成功（新作品 / 新版本 / 重複）、失敗（含原因）。
- AC-1.2 成功項目可在 Library 看到，原始檔可下載，下載檔 SHA-256 與匯入時一致。
- AC-1.3 一個損壞的 ZIP 不影響其他 19 個。
- AC-1.4 重試失敗項目不產生重複作品或版本。

### US-2 平台關閉後仍可取用（Scenario B）

- AC-2.1 所有已匯入作品可在本系統閱讀（安全預覽或閱讀模式）與下載原始檔，不需要任何 AI 平台帳號。

### US-3 自身網站故障後還原（Scenario C）

- AC-3.1 從可攜式匯出檔，在乾淨環境（空 DB + 空 Storage）還原後，原始檔、作品 Metadata、版本、分類、標籤、筆記均存在且 Hash 一致。
- AC-3.2 不依賴本系統，也能用 `sha256sum -c checksums.sha256` 驗證封存，並直接開啟 `originals/` 內的檔案。

### US-4 搜尋（Phase 1B）

- AC-4.1 搜尋「形態發生」可找到正文含此詞的作品；搜尋兩字詞（例：「胚胎」）有效；英文部分字首（「morpho」）有效。
- AC-4.2 結果顯示片段與 Highlight；未登入時搜尋 API 回 401。

### US-5 分享單篇作品（Phase 1B）

- AC-5.1 建立連結需選擇權限與到期日並確認；預設不允許下載原始檔。
- AC-5.2 撤銷後連結立即失效（回 404，不洩漏作品是否存在）。
- AC-5.3 作品改回 private 後所有連結失效。

### US-6 跨 AI 研究（Scenario D，Phase 2+）

- AC-6.1 另一模型透過匯出的 Research Context 或 API 取得有權限的內容與來源，並能分辨原始資料與 AI 推論。

## 7. Glossary

- **Research Project**：研究計畫或主題，包含多個 Artifact。
- **Artifact**：一份獨立知識作品，是管理與分享的主要單位。
- **Artifact Version**：作品的不可覆寫版本。
- **File Asset**：實際保存於 Object Storage 的不可變原始檔。
- **Derived Asset**：可重新產生的衍生物（縮圖、預覽檔）。
- **Extracted Content / Extracted Document**：正規化後供閱讀、搜尋與 AI 使用的內容。
- **Workspace**：資料擁有權與權限邊界。
