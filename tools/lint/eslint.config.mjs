import tseslint from "typescript-eslint";

const root = new URL("../..", import.meta.url).pathname;

export default tseslint.config(
  {
    ignores: ["dist/**", ".sst/**", "node_modules/**", "openapi/**", "tools/**"],
  },
  {
    files: ["src/**/*.ts"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: `${root}/tsconfig.json`,
        tsconfigRootDir: root,
      },
    },
    rules: {
      "@typescript-eslint/no-floating-promises": "error",
      "@typescript-eslint/no-misused-promises": "error",
      "@typescript-eslint/no-explicit-any": "off",
      "@typescript-eslint/no-non-null-assertion": "off",
    },
  },
  {
    files: ["tests/**/*.ts"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: `${root}/tsconfig.json`,
        tsconfigRootDir: root,
      },
    },
    rules: {
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
  {
    files: ["infra/**/*.ts", "sst.config.ts"],
    plugins: { "@typescript-eslint": tseslint.plugin },
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        project: `${root}/tsconfig.sst.json`,
        tsconfigRootDir: root,
      },
    },
    rules: {
      "@typescript-eslint/no-misused-promises": "error",
    },
  },
);
