import {
  Archive,
  Code2,
  FileCode,
  FileImage,
  FileText,
  FileType,
  Globe,
  LayoutTemplate,
  type LucideIcon,
} from "lucide-react";

const ICONS: Record<string, LucideIcon> = {
  html_document: FileCode,
  claude_design_document: LayoutTemplate,
  static_site: Globe,
  framework_project: Code2,
  pdf: FileType,
  markdown: FileText,
  text: FileText,
  image: FileImage,
  archive_other: Archive,
};

export function KindIcon({ kind, className }: { kind: string; className?: string }) {
  const Icon = ICONS[kind] ?? FileText;
  return <Icon aria-hidden className={className} />;
}
