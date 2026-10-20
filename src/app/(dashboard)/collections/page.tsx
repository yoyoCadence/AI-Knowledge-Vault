import type { Metadata } from "next";
import { FutureFeature } from "@/components/layout/future-feature";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("nav.collections") };

export default function CollectionsPage() {
  return (
    <FutureFeature
      title={t("nav.collections")}
      phase="Phase 1B（P1B-ORG）"
      summary="以階層分類與自訂集合整理作品；一份作品可以同時屬於多個集合。"
      bullets={["主分類與子分類", "自訂 Collections", "批次加入與移除", "標籤正規化與合併"]}
    />
  );
}
