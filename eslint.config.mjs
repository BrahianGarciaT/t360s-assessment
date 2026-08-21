// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import globals from 'globals';

export default [
  {
    ignores: ['dist/**', 'node_modules/**', 'coverage/**', 'eslint.config.mjs'],
  },
  eslint.configs.recommended,
  {
    files: ['apps/**/*.ts', 'libs/**/*.ts', 'test/**/*.ts'],
    languageOptions: {
      parser: tsParser,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.jest,
      },
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    plugins: {
      '@typescript-eslint': tsPlugin,
    },
    rules: {
      ...tsPlugin.configs.recommended.rules,
      // Disabled in favor of TS-aware ambient globals (e.g. DOM lib types like
      // `Request`/`Body`) which the core rule misreports as redeclared builtins.
      'no-redeclare': 'off',
      // Same DOM-lib ambient-global class of false positive as above: the
      // base (non-TS-aware) `no-undef` rule doesn't see NestJS decorator
      // imports like `@Body()` as defined once a same-named DOM type (the
      // Fetch API `Body` interface) exists ambiently. TypeScript's own
      // compiler already catches genuinely undefined identifiers, so this
      // is the officially recommended way to avoid the false positive:
      // https://typescript-eslint.io/troubleshooting/faqs/general/#i-get-errors-from-the-no-undef-rule-about-my-typescript-types-eg-typescript-must-be-defined
      'no-undef': 'off',
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-floating-promises': 'warn',
      '@typescript-eslint/no-unsafe-argument': 'warn',
    },
  },
  eslintPluginPrettierRecommended,
];
