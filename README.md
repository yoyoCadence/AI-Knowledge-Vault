# AI Knowledge Vault

**AI-independent, Portable, Searchable, Verifiable and Continuously Evolving Personal Knowledge System.**

這是一套不依賴單一 AI 平台的個人知識資產庫。它的用途是保存 Claude Design、Claude、ChatGPT、Gemini 等工具產生的研究成果，包括 HTML、ZIP 專案、PDF、Markdown 與圖片，並且做到以下幾件事：

- 原始檔不可變保存，可用 SHA-256 驗證。
- 可分類、可全文搜尋（含繁體中文）、可安全預覽。
- 可完整匯出，並能在乾淨環境還原。
- 未來加入跨文章 AI 問答、知識圖譜與知識缺口分析。

> **目前狀態：Phase 0 與 Phase 1A 完成（加密匯出除外），接下來是 Phase 1B。** 已完成：
>
> - 管理者登入
> - 完整的匯入流程：網頁拖曳上傳 → 背景處理 → 匯入報告
> - 知識庫卡片列表
> - 作品詳細頁：目錄、引用來源、版本、原始檔下載
> - 可攜式匯出、經過驗證的還原（介面與 CLI）、完整性檢查
>
> 匯入涵蓋 HTML、Claude Design 文件與 ZIP、Markdown、TXT、PDF、圖片。
>
> - 安全預覽：HTML 與 Claude Design／靜態網站在獨立網域的沙箱中顯示，停用所有指令碼
> - 閱讀模式：所有文件以擷取後的文字重新排版閱讀，附可點選的目錄
>
> - 繁體中文全文搜尋：標題、摘要與內文，結果附上標示關鍵字的片段
>
> - 分享連結：分享前自動檢查疑似敏感內容；可分別允許閱讀、預覽、下載，設定期限，隨時撤銷
>   實際進度以 [`task.md`](task.md) 與 [`docs/HANDOFF.md`](docs/HANDOFF.md) 為準。

## 產品能力（規劃）

| 能力         | 內容                                                            | 階段     |
| ------------ | --------------------------------------------------------------- | -------- |
| Archive      | 原始檔不可變保存、SHA-256、批次匯入、重試不重複                 | Phase 1A |
| Portability  | 可攜式匯出（manifest + `sha256sum` 相容 checksums）、可驗證還原 | Phase 1A |
| Library      | 分類、標籤、閱讀模式、安全預覽、繁中全文搜尋、分享連結          | Phase 1B |
| Intelligence | 語意搜尋、附可驗證引用的 RAG 問答、可替換 AI Provider           | Phase 2  |
| Discovery    | 知識主題、主張與證據、覆蓋率與缺口分析、研究建議                | Phase 3  |

完整需求見 [`docs/PRODUCT_SPEC.md`](docs/PRODUCT_SPEC.md)，階段與驗收標準見 [`docs/ROADMAP.md`](docs/ROADMAP.md)。

## 技術架構

Modular monolith，同一份程式碼產生兩個 process：

- `web`：Next.js 16 App Router，負責 UI、REST API，以及獨立的預覽 Origin。
- `worker`：長駐的 Node.js 背景工作程序，透過 PostgreSQL job queue 取得工作，具 lease、重試與回復機制。

| 層       | 技術                                                                  |
| -------- | --------------------------------------------------------------------- |
| Runtime  | Node.js 22 LTS、pnpm 10、TypeScript 6（strict）                       |
| Web      | Next.js 16.4、React 19.3、Tailwind CSS 4、Radix（shadcn/ui 風格元件） |
| Database | PostgreSQL（Neon）+ Drizzle ORM，版本化 SQL migration                 |
| Storage  | `StorageAdapter`：Cloudflare R2／S3 相容，或本機檔案系統（開發用）    |
| Auth     | Better Auth（Email + Password、無公開註冊）— Phase 1A                 |
| Tests    | Vitest（unit + 真實 PostgreSQL integration）、Playwright（E2E）       |

詳見 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)，架構決策見 [`docs/DECISIONS.md`](docs/DECISIONS.md)。

## 安裝與啟動（本機開發）

需求：Node.js ≥ 22.12、pnpm 10、PostgreSQL 16（本機或 Docker）。

```bash
pnpm install

# 1. 環境變數
cp .env.example .env.local
#    為三個 secret 各產生不同的隨機值：openssl rand -base64 48

# 2. 資料庫（範例：本機 Postgres）
createdb vault_dev && createdb vault_test
pnpm db:migrate

# 3. 建立管理者（不開放公開註冊；密碼以隱藏輸入提示，或用 ADMIN_PASSWORD 環境變數）
ADMIN_EMAIL=you@example.com ADMIN_NAME="Your Name" pnpm admin:create

# 4. 啟動
pnpm dev          # Web：http://localhost:3000/login（預覽 Origin：http://127.0.0.1:3000）
pnpm worker:dev   # 背景工作程序（另開一個終端機）
```

`http://localhost:3000/api/health` 會回報資料庫與儲存是否可用。

## 環境變數

完整、附註解的清單在 [`.env.example`](.env.example)。必要項目：

| 變數                                                                         | 說明                                                         |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------ |
| `APP_ORIGIN` / `PREVIEW_ORIGIN`                                              | 兩者**必須不同**。不可信的預覽內容只在 `PREVIEW_ORIGIN` 提供 |
| `DATABASE_URL`                                                               | PostgreSQL 連線字串                                          |
| `BETTER_AUTH_SECRET`、`PREVIEW_TOKEN_SECRET`、`LOCAL_STORAGE_SIGNING_SECRET` | 各至少 32 字元，彼此不同                                     |
| `STORAGE_DRIVER`                                                             | `local`（開發）或 `s3`（R2）。正式環境預設拒絕 `local`       |

## 資料庫遷移

```bash
pnpm db:generate --name <change>   # 修改 schema 後產生 SQL migration（請檢查後 commit）
pnpm db:migrate                    # 套用尚未執行的 migration
```

正式環境請用 `node dist/db-migrate.mjs`，並以 `DATABASE_URL_DIRECT` 指定 Neon 的非 pooled 連線。不使用 `drizzle-kit push`。

## 測試

```bash
pnpm lint && pnpm typecheck
pnpm test               # unit + integration（integration 會重建 vault_test 資料庫 schema）
pnpm test:unit
pnpm test:integration
S3_TEST_ENDPOINT=http://127.0.0.1:5055 pnpm test   # 另外跑 S3 adapter 測試（需本機 moto_server）
pnpm build && pnpm build:node
pnpm build && pnpm test:e2e  # Playwright E2E（使用獨立的 vault_e2e 資料庫）
```

測試策略見 [`docs/TEST_PLAN.md`](docs/TEST_PLAN.md)。CI（GitHub Actions）會對每個 PR 執行格式、lint、型別、全部測試與 build。

## 部署

尚未部署。目標架構如下：

- 單一 Docker image，以 `web` 與 `worker` 兩個 process 執行。
- 外部服務為 Neon PostgreSQL 與 Cloudflare R2。
- 需要兩個網域，一個給 App、一個給預覽 Origin。
- 備份放在獨立的備份目的地。

步驟、成本限制與需要你提供的 credentials 見 [`docs/DEPLOYMENT.md`](docs/DEPLOYMENT.md)。

## 現有功能與限制（誠實清單）

可以運作且有測試的部分：

- 匯入介面：拖曳或多選、並行上傳進度、即時匯入報告、失敗重試、最近匯入紀錄
- 知識庫列表與作品詳細頁：縮圖、類型、來源平台、目錄、引用來源、版本與 SHA-256、原始檔下載
- 匯入 API 與背景處理：
  - 直傳 staging、伺服器端驗證大小與格式（magic bytes）、SHA-256
  - 內容定址且不可覆寫的原始檔保存、相同檔案去重、檔名版本比對、疑似重複標示
  - 部分失敗隔離、重試不重複建檔
- 內容抽取：HTML（含 Claude Design 樣板）、Markdown（front matter）、TXT（UTF-8／UTF-16／Big5）、PDF（逐頁）、圖片縮圖
- 安全 ZIP 解析：
  - 防護 Zip Slip、絕對路徑、symlink、加密項目、Zip Bomb（壓縮比、總量、項目數）
  - 分類 Claude Design／靜態網站／框架原始碼（不建置、不執行）／文件包
  - 不合規的 ZIP 會標示失敗，但原始檔仍保留供下載檢查
- 匯入維護工作：每小時清理過期上傳與 staging，補救中斷的工作
- 原始檔下載：5 分鐘簽章 URL，有稽核紀錄，SHA-256 可驗證
- 可攜式匯出（格式 v1）：
  - 匯出內容：metadata JSON、抽取文字（Markdown）、逐位元組相同的原始檔、`checksums.sha256`
  - 可用 `sha256sum -c` 在系統外驗證
  - 在「匯入與備份」頁建立與下載，或用 `pnpm backup:export`
  - 匯出檔保留 7 天後自動刪除
- 完整性檢查：
  - 重新計算每個原始檔的 SHA-256，標示遺失或損毀的檔案
  - 每週自動執行，也可在「匯入與備份」頁手動執行
- 還原（「匯入與備份」頁的「從備份還原」，或 `pnpm backup:restore`）：
  - 寫入任何資料前先驗證所有校驗碼，竄改的檔案會被拒絕
  - 可選「略過已存在」或「建立副本」
  - 還原後由背景工作重建文字、章節、縮圖與預覽
  - 整個流程（匯出 → 刪除 → 還原 → 比對）有自動化測試
- 資料庫層強制：`file_assets` 不可變 trigger；仍被引用的原始檔無法刪除
- 管理者登入與登出：Email + 密碼、不開放註冊、資料庫式登入頻率限制
- 登入裝置（Session）列表與撤銷
- 稽核紀錄（audit log）
- 環境變數驗證
- 資料庫 migration
- 本機與 S3 相容的儲存抽象層，含不可覆寫的條件寫入與簽章上傳／下載 URL
- 持久化 job queue：idempotency、SKIP LOCKED 併發、lease 回復、重試退避、逾時
- 背景工作程序
- App Shell（深淺色、手機版）
- 健康檢查 API
- 預覽 Origin 的 host 隔離路由
- 安全預覽（作品詳細頁）：
  - 只在獨立的預覽網域提供，網址帶 15 分鐘的簽章 token
  - 嚴格 CSP 與 iframe sandbox，所有指令碼都不會執行；`.js` 一律以純文字提供
  - 作品刪除後立即失效

- 閱讀模式（作品詳細頁的「閱讀」）：
  - 由擷取後的內容重新排版，不顯示原始 HTML；PDF 依頁、純文字原樣、圖片以縮圖顯示
  - 目錄可點選跳到對應段落；外部連結一律以新分頁開啟、不帶來源
  - 文件中的圖片只顯示說明文字，閱讀時不會向外部載入任何東西

- 全文搜尋（知識庫頁上方的搜尋框）：
  - 支援繁體中文：以二字詞（bigram）索引，「城市熱島」只會找到相連出現的文字
  - 英文可輸入字首（`therm` 會找到 `thermal`），全形字自動轉換，可用引號指定片語
  - 只搜尋自己工作區、未刪除作品的目前版本；匯入後自動建立索引，每日自動補建遺漏的索引

- 標籤：
  - 在作品頁面輸入名稱即可加上標籤；名稱只差大小寫、全形半形或空白時視為同一個標籤
  - 點標籤可看到帶有它的所有作品，也可以在標籤內搜尋；標籤名稱本身也能被搜尋到
  - 「標籤」頁可以重新命名、合併、刪除標籤
  - 匯出的備份（格式第 2 版）包含標籤；還原時同名標籤會合併，不會重複；舊版（第 1 版）備份仍可還原

- 研究專案與篩選：
  - 「研究專案」頁可建立、改名、封存、刪除專案；在作品頁面把作品放進專案，也可以修改標題與說明
  - 知識庫與搜尋可依專案、類型、來源模型、匯入日期篩選，並依最新、最早（搜尋另有最相關、標題）排序；搜尋結果顯示總數

- 收藏分類：
  - 「收藏分類」頁可建立分類與集合，最多 7 層；可改名、搬移、刪除（底下還有子分類時不能刪）
  - 一份作品可以放進多個分類或集合（在作品頁面加入或移除）；匯入時也可以直接指定集合（API）
  - 依某個分類篩選時，會一併列出它所有子分類裡的作品
  - 匯出的備份（格式第 3 版）包含分類與集合；還原時同一位置的同名分類會合併，不會重複；第 1、2 版備份仍可還原

- 筆記與閱讀狀態：
  - 在作品頁面寫筆記（支援 Markdown，以安全方式顯示，不會執行任何 HTML）；筆記內容也能被搜尋到
  - 每位使用者各自的閱讀狀態（未讀、閱讀中、已讀）與收藏；開啟作品頁面時自動記錄為「閱讀中」
  - 知識庫上方可切換「最近開啟」「我的收藏」「未讀」，篩選面板也能依閱讀狀態與收藏篩選
  - 匯出的備份（格式第 4 版）包含筆記與閱讀狀態；第 1–3 版備份仍可還原

- 分享連結
  - 作品頁的「分享」區塊：先檢查疑似金鑰、Email、內部網址等（僅供參考），再選擇允許閱讀、安全預覽或下載原始檔、有效期限與備註
  - 網址只在建立時顯示一次（系統只保存雜湊值）；可看到每個連結的開啟次數，並隨時撤銷
  - 建立連結會把「私人」作品改為「不公開列出」；改回「私人」會撤銷所有連結
  - 公開閱讀頁不需登入，只顯示該作品，不顯示筆記、標籤等其他資料；撤銷、過期或作品改回私人後一律顯示「找不到頁面」
- 使用量與狀態（設定 → 查看使用量與狀態，限擁有者）
  - 儲存空間：原始檔、預覽檔、縮圖、尚未到期的匯出備份檔，各自的數量與大小；原始檔遺失或損毀會提醒
  - 作品與版本數、整個資料庫的大小
  - 背景工作依狀態的數量與最近失敗的工作、匯入失敗的檔案與原因
  - 備份狀態：最後一次成功匯出與完整性檢查的時間與結果，以及最近一次嘗試的狀態
  - 所有數字直接取自資料庫紀錄，沒有估算；AI 用量於 Phase 2 才提供

尚未實作：

- 所有 AI 功能

已知限制：

- S3 adapter 只在 moto 模擬器上驗證過，尚未在真實 R2 上驗證，待 staging 部署時確認。
- 加密匯出是規劃中的 P1A-ENC。

## 給接手的 Agent

請先讀 [`AGENTS.md`](AGENTS.md)、[`active-plan.md`](active-plan.md)、[`task.md`](task.md)、[`docs/HANDOFF.md`](docs/HANDOFF.md)。
