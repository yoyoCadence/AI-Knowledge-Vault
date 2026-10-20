import type { Metadata } from "next";
import { FutureFeature } from "@/components/layout/future-feature";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("nav.importBackup") };

export default function ImportPage() {
  return (
    <FutureFeature
      title={t("nav.importBackup")}
      phase="Phase 1A（Preservation Core）"
      summary="批次匯入 HTML、ZIP、PDF、Markdown、TXT 與圖片；原始檔不可變保存並以 SHA-256 驗證；可攜式匯出與可驗證的還原。"
      bullets={[
        "拖曳或多選批次上傳與進度",
        "部分失敗不影響其他項目，可重試",
        "可攜式匯出（manifest + checksums）",
        "從匯出檔還原與完整性檢查",
      ]}
    />
  );
}
