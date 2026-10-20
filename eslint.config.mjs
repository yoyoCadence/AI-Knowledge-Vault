import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

// Module-boundary rules enforce docs/ARCHITECTURE.md §2.
const noNextInDomain = {
  paths: [
    { name: "next", message: "Domain/infrastructure code must not depend on Next.js (ADR-001)." },
  ],
  patterns: [
    {
      group: ["next/*"],
      message: "Domain/infrastructure code must not depend on Next.js (ADR-001).",
    },
  ],
};

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "dist/**",
    "coverage/**",
    "next-env.d.ts",
    ".data/**",
    "playwright-report/**",
    "test-results/**",
  ]),
  {
    rules: {
      "react/no-danger": "error",
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": ["error", { fixStyle: "inline-type-imports" }],
      "no-restricted-syntax": [
        "error",
        {
          selector: "MemberExpression[object.name='sql'][property.name='raw']",
          message: "sql.raw is banned outside migrations (docs/SECURITY.md §11).",
        },
      ],
    },
  },
  {
    files: ["src/components/**/*.{ts,tsx}"],
    rules: {
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@/infrastructure/*", "@/modules/*", "@/worker/*"],
              allowTypeImports: true,
              message:
                "UI components must not access the database, storage or domain services (ARCHITECTURE.md §2).",
            },
          ],
        },
      ],
    },
  },
  {
    files: [
      "src/modules/**/*.ts",
      "src/infrastructure/**/*.ts",
      "src/lib/**/*.ts",
      "src/worker/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": ["error", noNextInDomain],
    },
  },
]);
