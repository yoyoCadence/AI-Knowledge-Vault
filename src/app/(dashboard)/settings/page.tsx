import type { Metadata } from "next";
import { FutureFeature } from "@/components/layout/future-feature";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("nav.settings") };

export default function SettingsPage() {
  return (
    <FutureFeature
      title={t("nav.settings")}
      phase="Phase 1A（帳號與 Session）／Phase 1B（使用量）"
      summary="管理登入裝置、Session、儲存空間與處理工作狀態。"
      bullets={[
        "檢視與撤銷登入中的 Session",
        "儲存空間與資料庫使用量",
        "背景工作與失敗紀錄",
        "最後一次完整性檢查時間",
      ]}
    />
  );
}
