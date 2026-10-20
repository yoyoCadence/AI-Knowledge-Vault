import {
  Archive,
  BookOpen,
  FolderTree,
  Globe,
  Network,
  Settings,
  Sparkles,
  type LucideIcon,
} from "lucide-react";
import type { MessageKey } from "@/lib/i18n";

export interface NavItem {
  href: string;
  labelKey: MessageKey;
  icon: LucideIcon;
  /** Future features are shown, clearly marked, and lead to an honest "not yet" page (NFR-UX-2). */
  future?: boolean;
}

/** Main navigation (Master Spec §9.1). */
export const NAV_ITEMS: NavItem[] = [
  { href: "/", labelKey: "nav.library", icon: BookOpen },
  { href: "/collections", labelKey: "nav.collections", icon: FolderTree, future: true },
  { href: "/knowledge-map", labelKey: "nav.knowledgeMap", icon: Network, future: true },
  { href: "/ai-research", labelKey: "nav.aiResearch", icon: Sparkles, future: true },
  { href: "/showcase", labelKey: "nav.publicShowcase", icon: Globe, future: true },
  { href: "/import", labelKey: "nav.importBackup", icon: Archive, future: true },
  { href: "/settings", labelKey: "nav.settings", icon: Settings, future: true },
];
