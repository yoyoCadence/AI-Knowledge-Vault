import type { WorkspaceRole } from "@/infrastructure/database/schema";

/**
 * Role-based permission table (docs/SECURITY.md §7). Object-level scoping (workspace_id) is
 * enforced separately in every query; this table only answers "may this role do X at all".
 */
export const ACTIONS = [
  "library:read",
  "library:write",
  "import:create",
  "share:manage",
  "backup:export",
  "backup:restore",
  "workspace:admin",
] as const;
export type Action = (typeof ACTIONS)[number];

const GRANTS: Record<WorkspaceRole, ReadonlySet<Action>> = {
  owner: new Set(ACTIONS),
  editor: new Set<Action>([
    "library:read",
    "library:write",
    "import:create",
    "share:manage",
    "backup:export",
  ]),
  viewer: new Set<Action>(["library:read"]),
};

export function roleAllows(role: WorkspaceRole, action: Action): boolean {
  return GRANTS[role].has(action);
}
