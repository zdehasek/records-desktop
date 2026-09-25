import js from "@eslint/js"
import configPrettier from "eslint-config-prettier"
import * as pluginImportX from "eslint-plugin-import-x"
import pluginSolid from "eslint-plugin-solid"
import pluginUnusedImports from "eslint-plugin-unused-imports"
import globals from "globals"

export default [
  js.configs.recommended,
  {
    ignores: [
      "node_modules/",
      "frontend/dist/",
      "runtime/vendor/",
      "coverage/",
      "test-results/",
      "playwright-report/",
      ".playwright-cli/",
      ".dev/",
      ".build/"
    ]
  },
  pluginImportX.flatConfigs.recommended,
  {
    plugins: { "unused-imports": pluginUnusedImports },
    rules: {
      "no-unused-vars": "off",
      "unused-imports/no-unused-imports": "warn",
      "unused-imports/no-unused-vars": [
        "warn",
        {
          vars: "all",
          varsIgnorePattern: "^_",
          args: "after-used",
          argsIgnorePattern: "^_"
        }
      ],
      "import-x/no-duplicates": "warn",
      "import-x/no-self-import": "error",
      "import-x/no-useless-path-segments": "warn",
      "import-x/first": "warn",
      "import-x/newline-after-import": "warn",
      "import-x/no-mutable-exports": "error",
      "import-x/no-unresolved": "off",
      "import-x/named": "off"
    }
  },
  {
    files: [
      "runtime/**/*.js",
      "scripts/**/*.{js,mjs}",
      "tests/**/*.js",
      "vite.config.js",
      "playwright.config.js"
    ],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.node }
    },
    rules: {
      "no-console": "off",
      complexity: ["warn", 45]
    }
  },
  {
    files: ["tests/browser/**/*.js"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } }
  },
  {
    files: ["runtime/**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: { ...globals.node }
    },
    rules: {
      "no-console": "off",
      complexity: ["warn", 15]
    }
  },
  {
    files: ["frontend/src/**/*.js"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      globals: { ...globals.browser }
    },
    rules: {
      "no-console": "off",
      complexity: ["error", 15]
    }
  },
  {
    files: ["frontend/src/**/*.jsx"],
    plugins: { ...pluginSolid.configs["flat/recommended"].plugins },
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "module",
      parserOptions: { ecmaFeatures: { jsx: true } },
      globals: { ...globals.browser }
    },
    rules: {
      "no-console": "off",
      complexity: ["error", 15],
      "no-unassigned-vars": "off",
      ...pluginSolid.configs["flat/recommended"].rules,
      "solid/reactivity": "off",
      "solid/no-destructure": "off",
      "solid/no-react-specific-props": "off",
      "solid/components-return-once": "off",
      "solid/no-innerhtml": "off"
    }
  },
  configPrettier
]
