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

/** SQL safety (docs/SECURITY.md §11), shared by every file-scoped no-restricted-syntax. */
const SQL_RULES = [
  {
    selector: "MemberExpression[object.name='sql'][property.name='raw']",
    message: "sql.raw is banned outside migrations (docs/SECURITY.md §11).",
  },
  {
    // The sql tag reads cooked strings: '\S' reaches Postgres as 'S'. Pass such text as a
    // parameter or use a POSIX class ([[:space:]]) instead.
    selector: "TaggedTemplateExpression[tag.name='sql'] TemplateElement[value.raw=/\\\\/]",
    message: "No backslashes in sql`` templates: the tag drops them (use a parameter).",
  },
];

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
      "no-restricted-syntax": ["error", ...SQL_RULES],
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
    // Reading mode renders untrusted documents: no HTML strings may reach the DOM here
    // (docs/SECURITY.md §5 "Reading mode"). Restates the global SQL rules, which a
    // file-scoped no-restricted-syntax would otherwise replace.
    files: ["src/components/reader/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-syntax": [
        "error",
        ...SQL_RULES,
        {
          selector: "JSXAttribute[name.name='dangerouslySetInnerHTML']",
          message: "Reading mode never injects HTML (docs/SECURITY.md §5).",
        },
        {
          selector:
            "AssignmentExpression > MemberExpression.left[property.name=/^(innerHTML|outerHTML)$/]",
          message: "Reading mode never injects HTML (docs/SECURITY.md §5).",
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
