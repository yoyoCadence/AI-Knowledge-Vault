import type { Metadata } from "next";
import { FutureFeature } from "@/components/layout/future-feature";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("nav.knowledgeMap") };

export default function KnowledgeMapPage() {
  return (
    <FutureFeature
      title={t("nav.knowledgeMap")}
      phase="Phase 3（Knowledge Intelligence）"
      summary="以知識主題、主張（Claim）與證據建立可解釋的知識關聯；AI 推論的關聯需人工確認，不會被當成已證實的事實。"
      bullets={[
        "Knowledge Topics 與階層",
        "supports / contradicts 等關聯（附信心與證據）",
        "知識覆蓋率與缺口分析",
        "研究優先順序與 Prompt 產生器",
      ]}
    />
  );
}
