import { describe, expect, it } from "vitest";
import { ACTIONS, roleAllows, slugify } from "@/modules/auth";

describe("role policy", () => {
  it("owner may do everything", () => {
    expect(ACTIONS.every((action) => roleAllows("owner", action))).toBe(true);
  });

  it("editor may manage content but not restore backups or administer the workspace", () => {
    expect(roleAllows("editor", "library:write")).toBe(true);
    expect(roleAllows("editor", "import:create")).toBe(true);
    expect(roleAllows("editor", "backup:export")).toBe(true);
    expect(roleAllows("editor", "backup:restore")).toBe(false);
    expect(roleAllows("editor", "workspace:admin")).toBe(false);
  });

  it("viewer may only read", () => {
    expect(ACTIONS.filter((action) => roleAllows("viewer", action))).toEqual(["library:read"]);
  });
});

describe("slugify", () => {
  it.each([
    ["Yoyo.Harizon", "yoyo-harizon"],
    ["  ", "vault"],
    ["研究者", "vault"],
    ["a".repeat(60), "a".repeat(40)],
  ])("%j → %j", (input, expected) => {
    expect(slugify(input)).toBe(expected);
  });
});
