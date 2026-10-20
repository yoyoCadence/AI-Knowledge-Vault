import type { Metadata } from "next";
import { FutureFeature } from "@/components/layout/future-feature";
import { t } from "@/lib/i18n";

export const metadata: Metadata = { title: t("nav.publicShowcase") };

export default function ShowcasePage() {
  return (
    <FutureFeature
      title={t("nav.publicShowcase")}
      phase="Phase 1B（單篇分享）／Phase 4（公開作品集）"
      summary="所有作品預設為私人。只有你主動設定為 Unlisted 或 Public 並建立分享連結後，作品才能被他人閱讀。"
      bullets={[
        "可撤銷、可設定到期日的分享連結",
        "閱讀、預覽、下載原始檔權限分離（預設不允許下載）",
        "分享前的敏感資訊檢查（輔助，最終由你確認）",
        "公開作品集頁面（Phase 4）",
      ]}
    />
  );
}
