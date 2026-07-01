import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      "app/frontend/node_modules/**",
      "app/frontend/dist/**",
      "app/build/**",
      "app/target/**",
    ],
  },
  js.configs.recommended,
  {
    files: ["app/scripts/**/*.js", "app/scripts/**/*.mjs"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
  {
    files: ["app/frontend/src/**/*.{js,jsx}"],
    languageOptions: {
      ecmaVersion: "latest",
      sourceType: "module",
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
      globals: {
        ...globals.browser,
        BigInt: "readonly",
      },
    },
    rules: {
      "no-empty": ["error", { allowEmptyCatch: true }],
      "no-unused-vars": ["error", { varsIgnorePattern: "^[A-Z][A-Za-z0-9]*$" }],
    },
  },
];
