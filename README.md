# AI Knowledge Vault

**AI-independent, Portable, Searchable, Verifiable and Continuously Evolving Personal Knowledge System.**

這是一套不依賴單一 AI 平台的個人知識資產庫。它的用途是保存 Claude Design、Claude、ChatGPT、Gemini 等工具產生的研究成果，包括 HTML、ZIP 專案、PDF、Markdown 與圖片，並且做到以下幾件事：

- 原始檔不可變保存，可用 SHA-256 驗證。
- 可分類、可全文搜尋（含繁體中文）、可安全預覽。
- 可完整匯出，並能在乾淨環境還原。
- 未來加入跨文章 AI 問答、知識圖譜與知識缺口分析。

> **目前狀態：Phase 0 完成，Phase 1A 進行中。** 已有架構文件、資料庫遷移、儲存抽象層、背景工作佇列、App Shell，以及管理者登入。
> 匯入、閱讀、搜尋、分享、備份**尚未實作**，介面上以「規劃中」明確標示。
> 實際進度以 [`task.md`](task.md) 與 [`docs/HANDOFF.md`](docs/HANDOFF.md) 為準。

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

尚未實作：

- 匯入
- 閱讀與預覽
- 搜尋
- 分享
- 匯出與還原
- 所有 AI 功能

已知限制：

- S3 adapter 只在 moto 模擬器上驗證過，尚未在真實 R2 上驗證，待 staging 部署時確認。
- 加密匯出是規劃中的 P1A-ENC。

## 給接手的 Agent

請先讀 [`AGENTS.md`](AGENTS.md)、[`active-plan.md`](active-plan.md)、[`task.md`](task.md)、[`docs/HANDOFF.md`](docs/HANDOFF.md)。
