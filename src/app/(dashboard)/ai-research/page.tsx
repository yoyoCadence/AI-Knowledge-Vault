import type { Metadata } from "next";
import { FutureFeature } from "@/components/layout/future-feature";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("nav.aiResearch") };

export default function AiResearchPage() {
  return (
    <FutureFeature
      title={t("nav.aiResearch")}
      phase="Phase 2（AI Knowledge Retrieval）"
      summary="跨文章問答：只根據你有權限的內容回答，每個結論附上可驗證的來源；證據不足時明確回答資料不足。沒有設定 AI Provider 時，知識庫的保存、閱讀與搜尋功能完全不受影響。"
      bullets={[
        "語意搜尋與混合搜尋",
        "附引用驗證的 RAG 問答",
        "可替換的 AI Provider（Anthropic / OpenAI / Gemini）",
        "敏感內容外傳控制與成本追蹤",
      ]}
    />
  );
}
